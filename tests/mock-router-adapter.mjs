import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { randomUUID } from 'node:crypto';
import { commandFromPrompt } from '../src/context.mjs';

export function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, text => ({ type: 'text-delta', index: 0, text })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}
export function toolChunks(name, args, id = randomUUID()) {
  const json = JSON.stringify(args), callId = ToolCallId(id);
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: json } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}
const contentText = message => (message.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');

/** Scripted model protocol adapter; actual DSH request/tool/continuation loop remains in use. */
export class MockRouterAdapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: 'Mock Router（规则模拟）', contextWindow: 64000, defaultMaxTokens: 1024 }; }
  async *stream(options) {
    options.signal?.throwIfAborted();
    const last = options.messages.at(-1);
    let chunks;
    if (last?.role === 'tool') {
      const text = contentText(last);
      let result;
      try { result = JSON.parse(text); } catch { result = { text }; }
      const answer = result.result?.text ?? (result.status === 'running' ? '模拟实时字幕已启动。再次交互或关闭后会自行退出。' : result.error ? `任务未完成：${result.error}` : '任务已执行，结果已记录。');
      chunks = textChunks(answer);
    } else {
      const raw = [...options.messages].reverse().find(m => m.role === 'user');
      let input;
      try { input = JSON.parse(contentText(raw ?? {})); } catch { input = { instruction: commandFromPrompt(contentText(raw ?? {})) }; }
      if (input.kind === 'task_event') chunks = textChunks(input.task_events?.map(event => event.result?.text ?? event.result?.error ?? (event.status === 'running' ? '实时字幕已开启。' : '实时字幕任务已完成。')).join('\n') || '任务状态已更新。');
      else {
        const text = input.instruction ?? '';
        const capability = /字幕|subtitle/i.test(text) ? 'realtime_subtitle' : /解释|什么是|术语|explain/i.test(text) ? 'explain_term' : /总结|摘要|整理|summary/i.test(text) ? 'summarize_context' : undefined;
        chunks = capability ? toolChunks('dispatch_worker', { capability, execution_kind: capability === 'realtime_subtitle' ? 'program' : 'model', input_id: input.id })
          : textChunks('模拟 Router 支持开启字幕、解释术语、总结 Context。真实模型模式可处理更开放的指令。');
      }
    }
    for (const chunk of chunks) { options.signal?.throwIfAborted(); yield chunk; }
  }
}

