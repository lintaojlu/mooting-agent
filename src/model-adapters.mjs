import { randomUUID } from 'node:crypto';
import { createTrace, currentTrace, elapsed, errorFields, failure, log, outcomeLevel } from './log/index.mjs';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { setTimeout as delay } from 'node:timers/promises';

/** Retry one transport disconnect before any response headers/output have reached the agent. */
async function fetchResponse(endpoint, request, retry) {
  for (let attempt = 0; ; attempt++) {
    try { return await fetch(endpoint, request); }
    catch (error) {
      const code = error.cause?.code ?? error.code;
      const transient = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
      if (attempt >= 1 || request.signal.aborted || !transient) throw error;
      retry(attempt + 1, error);
      await delay(200, undefined, { signal: request.signal });
    }
  }
}

const LIMIT = 2 * 1024 * 1024;
const REPLAY = 'mooting-openai-responses-v1';
const textOf = message => (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
function required(value, name) { if (typeof value !== 'string' || !value) throw new Error(`Responses ${name} 缺失`); return value; }

/** Replay native output only on the same route; project portable history on model switches. */
function inputItems(messages, model, endpoint) {
  const memorySnapshot = message => message.source?.kind === 'runtime-context' && message.source?.form === 'snapshot' && message.source?.sections?.some(section => section.name === 'mooting-memory');
  const latestMemory = messages.findLastIndex(memorySnapshot);
  return messages.flatMap((message, index) => {
    // DSH persists each changed runtime snapshot for audit; the latest snapshot supersedes
    // its predecessors. Do not send a growing archive of stale memory to the remote model.
    if (index < latestMemory && memorySnapshot(message)) return [];
    if (message.role === 'assistant') {
      const replay = message.source?.replayState?.response;
      if (replay?.protocol === REPLAY && replay.model === model && replay.endpoint === endpoint && Array.isArray(replay.output)) return replay.output;
    }
    if (message.role === 'tool') return [{ type: 'function_call_output', call_id: required(message.toolCallId ?? message.callId, 'tool call_id'), output: textOf(message) }];
    if (!['system', 'developer', 'user', 'assistant'].includes(message.role)) throw new Error(`Responses 不支持消息角色 ${message.role}`);
    const output = [];
    for (const block of message.content ?? []) {
      if (block.type === 'text') {
        if (block.text) output.push({ type: 'message', role: message.role, content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: block.text }] });
      } else if (block.type === 'tool-call' && message.role === 'assistant') {
        output.push({ type: 'function_call', call_id: required(block.id, 'function call_id'), name: required(block.name, 'function name'), arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments) });
      } else if (block.type === 'reasoning') {
        // Provider-private reasoning is not portable. Visible text and function pairs remain above.
        continue;
      } else throw new Error(`Responses 暂不支持输入内容 ${block.type}`);
    }
    return output;
  });
}

/** OpenAI Responses adapter only. No Chat Completions endpoint or protocol fallback. */
export class CompatibleRouterAdapter extends LlmAdapter {
  constructor({ endpoint, apiKey, model, thinking = true, role = 'router', trace = currentTrace }) {
    super(); const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Responses Base URL 必须为不带凭证和查询参数的 HTTP(S) 地址');
    this.endpoint = endpoint.replace(/\/$/, '');
    if (/\/chat\/completions$/.test(this.endpoint)) throw new Error('请使用 Responses API 的 Base URL');
    if (!this.endpoint.endsWith('/responses')) this.endpoint += '/responses';
    this.trace = trace; this.role = role;
    this.apiKey = apiKey; this.model = model; this.thinking = thinking !== false;
  }
  async resolveModel(provider, model) { return { provider, id: model, name: model, contextWindow: 32000, defaultMaxTokens: 2048 }; }
  async *stream(options) {
    const trace = this.trace() ?? createTrace('model'), started = performance.now();
    const fields = { spanId: randomUUID(), role: this.role };
    const write = (level, event, detail = {}) => log(level, `model.request.${event}`, { ...fields, ...detail, elapsedMs: elapsed(started) }, trace);
    let outcome = 'cancelled', firstToken = false, firstText = false, usage, errorInfo;
    write('debug', 'start');
    try {
      for await (const chunk of this.request(options, write)) {
        if (!firstToken && ['text-delta', 'reasoning-delta', 'tool-call-delta'].includes(chunk.type)) {
          firstToken = true;
          write('info', 'first_token', { kind: chunk.type });
        }
        if (!firstText && chunk.type === 'text-delta') {
          firstText = true;
          write('info', 'first_text');
        }
        if (chunk.type === 'usage') usage = chunk.usage;
        if (chunk.type === 'finish') outcome = 'ok';
        yield chunk;
      }
    } catch (error) {
      outcome = failure(error);
      errorInfo = errorFields(error);
      throw error;
    } finally {
      write(outcomeLevel(outcome), 'end', { ...usage, ...errorInfo, outcome });
    }
  }
  async *request(options, write) {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
    signal.throwIfAborted();
    const tools = (options.tools ?? []).map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }));
    const response = await fetchResponse(this.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.model, input: inputItems(options.messages, this.model, this.endpoint), ...(tools.length ? { tools } : {}), stream: true, max_output_tokens: options.maxTokens ?? 2048, store: false, ...(this.thinking ? {} : { reasoning: { effort: 'none' } }), include: ['reasoning.encrypted_content'] }), signal,
    }, (attempt, error) => write('warning', 'retry', { attempt, delayMs: 200, ...errorFields(error) }));
    write('debug', 'headers', { statusCode: response.status });
    if (!response.ok) throw Object.assign(new Error(`Responses 模型接口返回 HTTP ${response.status}`), { statusCode: response.status });
    const blocks = new Map(), items = new Map(); let completed, finished = false;
    function* append(key, type, value, final = false, call) {
      if (typeof value !== 'string') throw new Error('Responses delta 必须为文本');
      let block = blocks.get(key);
      if (!block) {
        block = { index: blocks.size, type, text: '', call }; blocks.set(key, block);
        yield { type: 'block-start', index: block.index, blockType: type };
      }
      if (call) block.call = call;
      let delta = value;
      if (final) {
        if (!value.startsWith(block.text)) throw new Error('Responses done 与已有增量不一致');
        delta = value.slice(block.text.length);
      }
      block.text += delta;
      if (delta || (type === 'tool-call' && !block.announced)) {
        if (type === 'tool-call') {
          yield { type: 'tool-call-delta', index: block.index, id: ToolCallId(required(block.call?.call_id, 'call_id')), name: required(block.call?.name, 'function name'), argumentsDelta: delta };
          block.announced = true;
        } else yield { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text: delta };
      }
    }
    function validateItem(item) {
      required(item?.id, 'output item.id');
      if (!['message', 'function_call', 'reasoning'].includes(item.type)) throw new Error(`Responses 不支持输出类型 ${item.type}`);
      if (item.type === 'message' && item.role !== 'assistant') throw new Error('Responses 输出 message 必须是 assistant');
      if (item.type === 'function_call') { required(item.call_id, 'call_id'); required(item.name, 'function name'); }
    }
    function* fullItem(item) {
      validateItem(item); items.set(item.id, item);
      if (item.type === 'function_call') yield* append(item.id, 'tool-call', item.arguments ?? '', true, item);
      if (item.type === 'message') for (const [index, part] of (item.content ?? []).entries()) {
        if (part.type !== 'output_text') throw new Error(`Responses 不支持 message 内容 ${part.type}`);
        yield* append(`${item.id}:text:${index}`, 'text', part.text, true);
      }
      if (item.type === 'reasoning') for (const [index, part] of (item.summary ?? []).entries()) {
        if (part.type !== 'summary_text') throw new Error(`Responses 不支持 reasoning 内容 ${part.type}`);
        yield* append(`${item.id}:reasoning:${index}`, 'reasoning', part.text, true);
      }
    }
    function* event(value) {
      if (!value || typeof value.type !== 'string') throw new Error('Responses SSE 缺少事件类型');
      if (finished) throw new Error('Responses 在终态后仍发送数据');
      if (['response.failed', 'response.incomplete', 'error', 'response.error'].includes(value.type)) throw new Error(`Responses ${value.type}：${value.response?.error?.message ?? value.error?.message ?? value.message ?? value.response?.incomplete_details?.reason ?? '请求未完成'}`);
      if (value.type === 'response.output_item.added') {
        validateItem(value.item); items.set(value.item.id, value.item);
        if (value.item.type === 'function_call') yield* append(value.item.id, 'tool-call', value.item.arguments ?? '', false, value.item);
      } else if (value.type === 'response.output_item.done') yield* fullItem(value.item);
      else if (value.type === 'response.output_text.delta' || value.type === 'response.output_text.done') {
        const item = items.get(value.item_id); if (!item || item.type !== 'message') throw new Error('Responses 文本引用未知 item.id');
        yield* append(`${value.item_id}:text:${value.content_index ?? 0}`, 'text', value.type.endsWith('.delta') ? value.delta : value.text, value.type.endsWith('.done'));
      } else if (value.type === 'response.function_call_arguments.delta' || value.type === 'response.function_call_arguments.done') {
        const item = items.get(value.item_id); if (!item || item.type !== 'function_call') throw new Error('Responses 参数引用未知 function item.id');
        yield* append(value.item_id, 'tool-call', value.type.endsWith('.delta') ? value.delta : value.arguments, value.type.endsWith('.done'), item);
      } else if (value.type === 'response.reasoning_summary_text.delta' || value.type === 'response.reasoning_summary_text.done') {
        const item = items.get(value.item_id); if (!item || item.type !== 'reasoning') throw new Error('Responses reasoning 引用未知 item.id');
        yield* append(`${value.item_id}:reasoning:${value.summary_index ?? 0}`, 'reasoning', value.type.endsWith('.delta') ? value.delta : value.text, value.type.endsWith('.done'));
      } else if (value.type === 'response.completed') {
        if (value.response?.status !== 'completed' || !Array.isArray(value.response.output)) throw new Error('Responses completed 缺少完整 output');
        completed = value.response;
        for (const item of completed.output) yield* fullItem(item);
        finished = true;
      } else if (!['response.created', 'response.in_progress', 'response.queued', 'response.content_part.added', 'response.content_part.done', 'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done', 'response.reasoning_text.delta', 'response.reasoning_text.done'].includes(value.type)) {
        throw new Error(`Responses 不支持事件 ${value.type}`);
      }
    }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let bytes = 0;
    async function read() {
      const part = await reader.read(); if (part.done) return null;
      bytes += part.value.byteLength; if (bytes > LIMIT) throw new Error('Responses 输出超过 2 MiB 上限');
      return decoder.decode(part.value, { stream: true });
    }
    try {
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        let buffer = '', data = [];
        function* line(value) {
          if (!value) { if (data.length) { const payload = data.join('\n'); data = []; if (payload !== '[DONE]') yield* event(JSON.parse(payload)); } }
          else if (value.startsWith('data:')) data.push(value.slice(5).trimStart());
        }
        for (;;) {
          const part = await read(); if (part === null) break;
          buffer += part; let end;
          while ((end = buffer.indexOf('\n')) >= 0) { yield* line(buffer.slice(0, end).replace(/\r$/, '')); buffer = buffer.slice(end + 1); }
        }
        buffer += decoder.decode(); if (buffer) yield* line(buffer.replace(/\r$/, '')); yield* line('');
        if (!finished) throw new Error('Responses 流意外结束，未收到 response.completed');
      } else {
        let json = ''; for (;;) { const part = await read(); if (part === null) break; json += part; } json += decoder.decode();
        const value = JSON.parse(json);
        if (value.object !== 'response' || value.status !== 'completed' || !Array.isArray(value.output)) throw new Error(`Responses JSON 未完成：${value.status ?? value.error?.message ?? '无效协议'}`);
        yield* event({ type: 'response.completed', response: value });
      }
    } finally { await reader.cancel(); }
    if (!blocks.size || ![...blocks.values()].some(block => block.type === 'tool-call' || (block.type === 'text' && block.text.trim()))) throw new Error('Responses 未返回文本或函数调用');
    for (const block of blocks.values()) {
      const value = block.type === 'tool-call' ? { type: 'tool-call', id: ToolCallId(required(block.call.call_id, 'call_id')), name: block.call.name, arguments: block.text } : { type: block.type, text: block.text };
      yield { type: 'block-end', index: block.index, block: value };
    }
    if (completed.usage) yield { type: 'usage', usage: { inputTokens: completed.usage.input_tokens ?? 0, outputTokens: completed.usage.output_tokens ?? 0 } };
    yield { type: 'finish', reason: { kind: [...blocks.values()].some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' }, replayState: { response: { protocol: REPLAY, model: this.model, endpoint: this.endpoint, output: completed.output } } };
  }
}
