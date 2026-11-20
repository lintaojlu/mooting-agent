import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { randomUUID } from 'node:crypto';
import { commandFromPrompt } from '../src/context/index.mjs';

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
const memoryText = text => text.startsWith('Current runtime context') || text.startsWith('## 长期记忆');
export function scriptedInstruction(messages) {
  const raw = [...messages].reverse().find(message => message.role === 'user' && !memoryText(contentText(message)));
  const text = contentText(raw ?? {});
  try { const input = JSON.parse(text); if (typeof input.instruction === 'string') return input.instruction; } catch {}
  return commandFromPrompt(text);
}
export function scriptedTool(instruction) {
  if (/关闭/.test(instruction) && /说话人|面前/.test(instruction)) return 'close_speaker';
  if (/说话人|面前|社交卡片/.test(instruction)) return { name: 'social_card', arguments: { action: 'find' } };
  return undefined;
}
function continuation(result, instruction) {
  if (result.close_first) return toolChunks(result.close_first, {});
  if (result.closed && !/关闭/.test(instruction)) {
    const next = scriptedTool(instruction);
    if (next?.startsWith('open_')) return toolChunks(next, {});
  }
  return textChunks(result.say ?? result.error ?? '当前没有功能变化。');
}

/** Scripted model protocol adapter; actual DSH request/tool/continuation loop remains in use. */
export class MockRouterAdapter extends LlmAdapter {
  constructor({ hold, onHold } = {}) { super(); this.hold = hold; this.onHold = onHold; }
  async resolveModel(provider, model) { return { provider, id: model, name: 'Mock Router（规则模拟）', contextWindow: 64000, defaultMaxTokens: 1024 }; }
  async *stream(options) {
    this.onHold?.();
    if (this.hold) await this.hold;
    options.signal?.throwIfAborted();
    const last = options.messages.at(-1);
    const instruction = scriptedInstruction(options.messages);
    let chunks;
    if (last?.role === 'tool') {
      let result; try { result = JSON.parse(contentText(last)); } catch { result = {}; }
      chunks = continuation(result, instruction);
    } else {
      const tool = scriptedTool(instruction);
      chunks = tool ? (typeof tool === 'string' ? toolChunks(tool, {}) : toolChunks(tool.name, tool.arguments ?? {})) : textChunks(`模拟 Router 已处理：${instruction}`);
    }
    for (const chunk of chunks) { options.signal?.throwIfAborted(); yield chunk; }
  }
}

