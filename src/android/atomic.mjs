import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { InputError } from '../tasks.mjs';

export class AtomicPort {
  constructor(address, dial = () => connect({ path: '\0' + address })) { this.dial = dial; }
  async *events(op, input = {}, signal) {
    signal?.throwIfAborted();
    const id = randomUUID();
    const socket = this.dial();
    let failure;
    socket.on('error', error => { failure = error; });
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('error', error => { failure = error; lines.close(); });
    socket.once('close', () => lines.close());
    const abort = () => socket.destroy();
    const cancellable = ['model', 'embedding', 'rerank', 'reply.archive'].includes(op);
    let terminal = false;
    socket.setTimeout(185_000, () => socket.destroy(new Error('原子服务请求超时')));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      socket.write(JSON.stringify({ id, op, input }) + '\n');
      for await (const line of lines) {
        signal?.throwIfAborted();
        const event = JSON.parse(line);
        terminal = event.type === 'final' || event.type === 'error' || (!cancellable && !event.type);
        if (event.type === 'error' || event.ok === false || event.result?.ok === false) {
          throw new InputError(event.error ?? event.result?.error ?? '原子能力调用失败', 503);
        }
        yield event;
        if (terminal) return;
      }
      signal?.throwIfAborted();
      throw new InputError(failure?.message ?? '原子服务连接已断开', 503);
    } finally {
      signal?.removeEventListener('abort', abort);
      lines.close();
      socket.destroy();
      if (cancellable && !terminal) {
        void this.call('cancel', { requestId: id }, AbortSignal.timeout(3000)).catch(() => {});
      }
    }
  }
  async call(op, input, signal) {
    for await (const event of this.events(op, input, signal)) {
      if (event.type === 'final' || (!event.type && !['model', 'embedding', 'rerank', 'reply.archive'].includes(op))) return event.result ?? event;
    }
    throw new InputError('原子服务连接已断开', 503);
  }
}

export class AtomicModel extends LlmAdapter {
  constructor(port) { super(); this.port = port; }
  async resolveModel(provider, model) {
    return { provider, id: model, name: 'S23U 本机模型', contextWindow: 8192, defaultMaxTokens: 2048 };
  }
  async *stream(options) {
    let finished = false;
    const blocks = new Map();
    const tools = options.tools?.map(({ name, description, parameters }) => ({ name, description, parameters }));
    const input = { messages: options.messages, tools: tools ?? [], maxTokens: options.maxTokens ?? 2048, archive: false };
    for await (const event of this.port.events('model', input, options.signal)) {
      if (event.type === 'final') {
        if (!blocks.size) throw new Error('原子模型未返回内容');
        for (const [index, block] of blocks) yield { type: 'block-end', index, block };
        if (event.result?.usage) yield { type: 'usage', usage: event.result.usage };
        const kind = [...blocks.values()].some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop';
        yield { type: 'finish', reason: { kind } };
        finished = true;
        break;
      }
      const index = event.index;
      if (!Number.isSafeInteger(index) || index < 0 || index > 255) throw new Error('原子模型的内容索引无效');
      let block = blocks.get(index);
      if (event.type === 'text') {
        if (!block) {
          block = { type: 'text', text: '' };
          blocks.set(index, block);
          yield { type: 'block-start', index, blockType: 'text' };
        }
        if (block.type !== 'text' || typeof event.delta !== 'string') throw new Error('原子模型返回无效文本');
        block.text += event.delta;
        yield { type: 'text-delta', index, text: event.delta };
      } else if (event.type === 'tool') {
        if (!event.id || !event.name || typeof event.delta !== 'string') throw new Error('原子模型返回无效工具调用');
        if (!block) {
          block = { type: 'tool-call', id: ToolCallId(event.id), name: event.name, arguments: '' };
          blocks.set(index, block);
          yield { type: 'block-start', index, blockType: 'tool-call' };
        }
        if (block.type !== 'tool-call' || block.id !== event.id || block.name !== event.name) throw new Error('原子模型的工具调用 ID 不一致');
        block.arguments += event.delta;
        yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: event.delta };
      } else throw new Error('无法识别的原子模型事件');
    }
    if (!finished) throw new Error('原子模型流意外结束');
  }
}
