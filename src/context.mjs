import { EventEmitter } from 'node:events';
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { CompatibleRouterAdapter } from './model-adapters.mjs';
import { readModelEnv } from './model-env.mjs';

export const MEMORY_LIMIT = 24000;
const SEGMENT_LIMIT = 8000;
const SYSTEM = `你是 MootingAgent 的 Context System。根据一段新的对话，更新长期记忆 Markdown。
只保留仍然有效的人物、偏好、事实、约定和未完成事项。合并重复，用新信息纠正被否定的旧内容，删去寒暄和一次性口令。
记忆面向后续检索，使用简短中文条目。
只输出更新后的完整 Markdown 文档，不要解释，不要代码围栏。`;

/** Join the memory snapshot and the current command into the Router user prompt. */
export function composeUserPrompt(memory, command) {
  const instruction = String(command ?? '').trim();
  const snapshot = String(memory ?? '').trim();
  if (!instruction) throw new Error('指令不能为空');
  return `## 用户之前正在聊的内容\n\`\`\`\n${snapshot}\n\`\`\`\n\n## 用户指令\n\`\`\`\n${instruction}\n\`\`\``;
}

/** Recover the command from the instruction section. Text without that section is the command itself. */
export function commandFromPrompt(prompt) {
  const text = String(prompt ?? '');
  const heading = text.lastIndexOf('## 用户指令');
  if (heading === -1) return text.trim();
  const fenced = text.slice(heading).match(/```[^\n]*\n([\s\S]*?)\n```/);
  return (fenced ? fenced[1] : text.slice(heading + '## 用户指令'.length)).trim();
}

export function normalizeMemory(value) {
  let text = String(value ?? '').trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!text) throw new Error('Context 模型未返回记忆文档');
  if (text.length > MEMORY_LIMIT) text = text.slice(0, MEMORY_LIMIT).trimEnd();
  return text.endsWith('\n') ? text : `${text}\n`;
}

export function loadContextConfig(env = {}) {
  const baseURL = typeof env.MOOTING_CONTEXT_BASE_URL === 'string' ? env.MOOTING_CONTEXT_BASE_URL.trim() : '';
  const model = typeof env.MOOTING_CONTEXT_MODEL === 'string' ? env.MOOTING_CONTEXT_MODEL.trim() : '';
  const apiKey = typeof env.MOOTING_CONTEXT_API_KEY === 'string' ? env.MOOTING_CONTEXT_API_KEY : '';
  if (!baseURL && !model && !apiKey) return { configured: false };
  if (!baseURL || !model) throw new Error('Context 模型需要同时配置 MOOTING_CONTEXT_BASE_URL 和 MOOTING_CONTEXT_MODEL');
  let url;
  try { url = new URL(baseURL); } catch { throw new Error('MOOTING_CONTEXT_BASE_URL 无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('MOOTING_CONTEXT_BASE_URL 需要不带凭证和查询参数的 HTTP(S) 地址');
  return { configured: true, baseURL: url.href.replace(/\/$/, ''), model, apiKey };
}

async function completeWithModel({ config, memory, segment, signal }) {
  const adapter = new CompatibleRouterAdapter({ endpoint: config.baseURL, apiKey: config.apiKey, model: config.model });
  const messages = [
    createSystemMessage(SYSTEM),
    createUserMessage({ content: [{ type: 'text', text: `当前记忆：\n${memory.trim() || '（空）'}\n\n新的对话：\n${segment}` }], source: { kind: 'user' } }),
  ];
  let text = '';
  for await (const chunk of adapter.stream({ provider: 'mooting-context', model: config.model, messages, maxTokens: 2048, signal })) {
    if (chunk.type === 'text-delta') text += chunk.text;
    if (chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) throw new Error(chunk.reason.failure?.message ?? 'Context 模型调用失败');
  }
  if (!text.trim()) throw new Error('Context 模型未返回记忆文档');
  return text;
}

/**
 * First-version context system.
 * Definite conversation segments from the information stream are consolidated by an LLM into that user's data/<username>/MEMORY.md.
 * Layered retrieval and lifecycle eviction stay behind remember() / read(); this version serves the whole document.
 */
export class ContextSystem extends EventEmitter {
  constructor({ memoryPath, envPath, env, complete } = {}) {
    super();
    this.path = memoryPath ?? fileURLToPath(new URL('../data/MEMORY.md', import.meta.url));
    this.envPath = envPath;
    this.env = env;
    this.complete = complete ?? completeWithModel;
    this.memory = '';
    this.fragments = [];
    this.pending = null;
    this.fragmentsPath = join(dirname(this.path), 'fragments.jsonl');
    this.status = 'idle';
    this.error = undefined;
    this.updatedAt = null;
    this.config = { configured: false };
    this.seen = new Set();
    this.closed = false;
    this.chain = Promise.resolve();
    this.ready = this.load();
  }
  async load() {
    const file = this.envPath ? await readModelEnv(this.envPath) : {};
    this.config = loadContextConfig({ ...process.env, ...file, ...this.env });
    try { this.memory = await readFile(this.path, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
      const lines = (await readFile(this.fragmentsPath, 'utf8')).split('\n').filter(Boolean);
      this.fragments = lines.flatMap(line => {
        try {
          const item = JSON.parse(line);
          return item && typeof item.text === 'string' && item.text.trim() ? [{ at: typeof item.at === 'string' ? item.at : null, text: item.text }] : [];
        } catch { return []; }
      }).slice(-200);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.changed();
  }
  changed() { this.emit('change'); }
  state() {
    const fragments = this.fragments.map(item => ({ at: item.at, text: item.text }));
    if (this.pending) fragments.push({ at: this.pending.at, text: this.pending.text, pending: true });
    return { memory: this.memory, fragments, status: this.status, configured: !!this.config?.configured, updatedAt: this.updatedAt, ...(this.error ? { error: this.error } : {}) };
  }
  async read() { await this.ready; return this.memory; }
  /** Accept one information-stream snapshot. Only newly finalized utterances become a conversation segment. */
  observe(snapshot) {
    if (this.closed || snapshot?.status !== 'running') return;
    for (const utterance of snapshot.utterances ?? []) {
      if (!utterance || utterance.definite !== true || typeof utterance.text !== 'string') continue;
      const text = utterance.text.trim().slice(0, SEGMENT_LIMIT);
      if (!text || !Number.isFinite(utterance.start_time)) continue;
      const key = `${utterance.start_time}\0${text}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (this.seen.size > 400) this.seen.delete(this.seen.values().next().value);
      this.enqueue(text);
    }
  }
  enqueue(segment) {
    this.chain = this.chain.then(() => this.consolidate(segment)).catch(error => {
      this.pending = null;
      this.status = 'error';
      this.error = error.message || '记忆更新失败';
      this.changed();
    });
  }
  async consolidate(segment) {
    await this.ready;
    if (this.closed) return;
    if (!this.config.configured) {
      this.status = 'unconfigured';
      this.error = '请在 .env 中配置 MOOTING_CONTEXT_BASE_URL 和 MOOTING_CONTEXT_MODEL';
      this.changed();
      return;
    }
    this.pending = { at: new Date().toISOString(), text: segment };
    this.status = 'updating';
    this.error = undefined;
    this.changed();
    const text = await this.complete({ config: this.config, memory: this.memory, segment, signal: undefined });
    if (this.closed) return;
    const document = normalizeMemory(text);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, document, { mode: 0o600 });
    await chmod(this.path, 0o600);
    this.memory = document;
    const fragment = { at: this.pending?.at ?? new Date().toISOString(), text: segment };
    this.fragments.push(fragment);
    if (this.fragments.length > 200) this.fragments.splice(0, this.fragments.length - 200);
    await appendFile(this.fragmentsPath, JSON.stringify(fragment) + '\n', { mode: 0o600 });
    await chmod(this.fragmentsPath, 0o600);
    this.pending = null;
    this.status = 'idle';
    this.updatedAt = fragment.at;
    this.changed();
  }
  async idle() { await this.ready; await this.chain; }
  async dispose() { this.closed = true; await this.chain.catch(() => {}); this.removeAllListeners(); }
}
