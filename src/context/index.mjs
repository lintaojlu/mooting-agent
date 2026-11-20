import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MENTAL_MODELS, MemoryUnavailableError, publicServiceSettings } from './hindsight.mjs';

const UTTERANCE_LIMIT = 8000;
const FRAGMENT_RAM = 400;
export const LIMITS = Object.freeze({
  profile: 500, openItems: 500, people: 3, person: 150,
  recentMs: 10 * 60_000, recentCount: 30, recentChars: 1500,
  flushCount: 20, flushChars: 2000, silenceMs: 60_000,
  cacheIntervalMs: 60_000, searchTimeoutMs: 3_000, reflectTimeoutMs: 60_000,
});
export const MEMORY_NOTE = '记忆可能滞后，以最近原话为准；没有的细节用 memory_search 去查。';
const STREAM_CONTEXT = '现场对话，说话人未确认';
const TURN_CONTEXT = 'MootingAgent 助手与用户对话';

/** Recover the command from the Router user message. Text without that section is the command itself. */
export function commandFromPrompt(prompt) {
  const text = String(prompt ?? '');
  const heading = text.lastIndexOf('## 用户指令');
  if (heading === -1) return text.trim();
  const fenced = text.slice(heading).match(/```[^\n]*\n([\s\S]*?)\n```/);
  return (fenced ? fenced[1] : text.slice(heading + '## 用户指令'.length)).trim();
}

/** Cut to at most `limit` characters (code points), marking the cut. */
export function clip(value, limit) {
  const chars = Array.from(String(value ?? '').trim());
  return chars.length > limit ? chars.slice(0, Math.max(0, limit - 1)).join('') + '…' : chars.join('');
}
const length = value => Array.from(value).length;
const normalized = value => String(value ?? '').normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '').toLowerCase();
// Punctuation and small intervening words (e.g. 对花生严重过敏) must not bypass a deletion.
function mentions(value, target) {
  const source = normalized(value), needle = normalized(target);
  if (!needle) return false;
  if (source.includes(needle)) return true;
  if (needle.length < 4) return false;
  let cursor = 0;
  for (const char of source) if (char === needle[cursor]) cursor++;
  return cursor === needle.length;
}
function correctionSubject(value) {
  return String(value).match(/^(.{1,30}?)(?:不是|是|的职业|的生日|的工作|住在|叫)/u)?.[1]?.trim() ?? '';
}

/** Classify an instruction as an explicit memory command. */
export function memoryCommand(instruction) {
  const text = String(instruction ?? '').trim().replace(/[。！!]+$/u, '');
  const take = pattern => { const match = text.match(pattern); return match?.[1]?.trim() || null; };
  const forget = take(/^(?:请|麻烦)?(?:你)?(?:帮我)?(?:忘掉|忘记|忘了|删掉|删除|不要再记|别再记)(?:关于)?(?:记忆里的|记忆中的)?[，,：:\s]*(.+)$/su);
  if (forget) return { kind: 'forget', text: forget.replace(/^(?:这件事|这个)[：:，,\s]*/u, '').replace(/(?:这件事|这条|的记忆)$/u, '').trim() || forget };
  const correct = take(/^(?:不对|错了|纠正一下|更正一下|更正|纠正)[，,：:\s]*(.+)$/su);
  if (correct) return { kind: 'correct', text: correct };
  const remember = take(/^(?:请|麻烦)?(?:你)?(?:帮我)?(?:记住|记一下|记下来|记下)[，,：:\s]*(.+)$/su);
  if (remember) return { kind: 'remember', text: remember };
  return null;
}

function localDate(at) {
  const date = new Date(at);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function localClock(at) {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString('zh-CN', { hour12: false }) : '';
}
function localStamp(at) { return `${localDate(at)} ${localClock(at)}`; }

async function writePrivate(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error.name === 'SyntaxError') return fallback; throw error; }
}
async function readLines(path) {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { const value = JSON.parse(line); return value && typeof value === 'object' ? [value] : []; } catch { return []; } });
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

/**
 * Context System on top of Hindsight.
 * Hot path (observe, compile) touches RAM only. Writes reach Hindsight through a durable outbox,
 * flushed only while the Router is idle. Three mental models are cached locally every minute.
 */
export class ContextSystem extends EventEmitter {
  constructor({ dataRoot, bridge = null, limits, now = () => Date.now() } = {}) {
    super();
    this.dataRoot = dataRoot ?? fileURLToPath(new URL('../../data/', import.meta.url));
    this.fragmentsPath = join(this.dataRoot, 'fragments.jsonl');
    this.outboxPath = join(this.dataRoot, 'hindsight-outbox.jsonl');
    this.cachePath = join(this.dataRoot, 'memory-cache.json');
    this.tracePath = join(this.dataRoot, 'context-trace.jsonl');
    this.trace = [];
    this.traceCount = 0;
    this.traceWrites = Promise.resolve();
    this.bridge = bridge;
    this.limits = { ...LIMITS, ...limits };
    this.now = now;
    this.fragments = [];
    this.items = [];
    this.batches = [];
    this.cache = { models: {}, explicit: [], tombstones: [], fetchedAt: null };
    this.seen = new Set();
    this.routerBusy = false;
    this.flushWanted = false;
    this.lastFlush = null;
    this.error = undefined;
    this.closed = false;
    this.writes = Promise.resolve();
    this.flushing = null;
    this.silenceTimer = null;
    this.retryTimer = null;
    this.retryDelay = 5_000;
    this.cacheTimer = null;
    this.background = new Set();
    this.ready = this.load();
  }
  async load() {
    await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    const history = await readLines(this.tracePath);
    this.traceCount = history.reduce((maximum, entry) => Math.max(maximum, Number(entry.seq) || 0), 0);
    this.trace = history.slice(-200);
    this.traceEvent('context.load.start');
    this.fragments = (await readLines(this.fragmentsPath)).filter(item => typeof item.text === 'string' && item.text.trim())
      .map(item => ({ at: typeof item.at === 'string' ? item.at : null, text: item.text })).slice(-FRAGMENT_RAM);
    for (const record of await readLines(this.outboxPath)) {
      if (record.type === 'item' && record.item) this.items.push(record.item);
      if (record.type === 'batch' && record.batch?.operationId) this.batches.push(record.batch);
    }
    const cache = await readJson(this.cachePath, null);
    if (cache && typeof cache === 'object') this.cache = { models: cache.models ?? {}, explicit: Array.isArray(cache.explicit) ? cache.explicit : [], tombstones: Array.isArray(cache.tombstones) ? cache.tombstones : [], fetchedAt: cache.fetchedAt ?? null };
    if (this.bridge) {
      this.onBridgeStatus = () => { this.traceEvent('hindsight.status', this.service()); if (this.bridge.ready) { this.refreshCache().catch(() => {}); this.flush({ reason: 'reconnect' }); } };
      this.bridge.on('status', this.onBridgeStatus);
      this.cacheTimer = setInterval(() => { this.refreshCache().catch(() => {}); }, this.limits.cacheIntervalMs);
      this.cacheTimer.unref?.();
      if (this.bridge.ready) this.onBridgeStatus();
    }
    this.traceEvent('context.load.ready', { fragments: this.fragments.length, pendingItems: this.items.length, pendingBatches: this.batches.length, cachedAt: this.cache.fetchedAt });
    this.changed();
  }
  traceEvent(type, data = {}) {
    if (this.closed) return;
    const entry = { seq: ++this.traceCount, at: new Date(this.now()).toISOString(), type, data };
    this.trace.push(entry);
    if (this.trace.length > 200) this.trace.shift();
    this.traceWrites = this.traceWrites.then(() => appendFile(this.tracePath, JSON.stringify(entry) + '\n', { mode: 0o600 })).catch(error => { this.error = `Context 轨迹写入失败：${error.message}`; this.changed(); });
    this.changed();
  }
  async traceHistory() { await this.ready; await this.traceWrites; return readLines(this.tracePath); }
  changed() { if (!this.closed) this.emit('change'); }
  service() {
    if (!this.bridge) return { status: 'disabled' };
    return { status: this.bridge.status, ...(this.bridge.error ? { error: this.bridge.error } : {}) };
  }
  /** Panel state. `memory` is the injected text for an empty command. */
  state() {
    const service = this.service();
    const models = Object.fromEntries(MENTAL_MODELS.map(model => [model.id, this.cache.models[model.id]?.updatedAt ?? null]));
    return {
      memory: this.compile('', { includeRecent: false }),
      trace: this.trace.slice(), traceCount: this.traceCount,
      fragments: this.fragments.filter(item => {
        const at = Date.parse(item.at);
        return Number.isFinite(at) && at >= this.now() - 60_000 && at <= this.now() && !this.forgotten(item.text);
      }).map(item => ({ at: item.at, text: item.text })),
      status: service.status === 'ready' ? (this.flushing ? 'updating' : 'idle') : service.status,
      configured: !['unconfigured', 'disabled'].includes(service.status),
      ...publicServiceSettings(this.bridge?.config),
      service,
      outbox: this.items.length + this.batches.reduce((sum, batch) => sum + (batch.count ?? 1), 0),
      models, cachedAt: this.cache.fetchedAt,
      lastFlush: this.lastFlush,
      updatedAt: this.cache.fetchedAt,
      ...(this.error ? { error: this.error } : service.error ? { error: service.error } : {}),
    };
  }

  // ---------- writes ----------

  persist(job) {
    const run = this.writes.then(job, job);
    this.writes = run.catch(error => { this.error = `本地记忆写入失败：${error.message}`; this.changed(); });
    return this.writes;
  }
  saveOutbox({ durable = false } = {}) {
    const lines = [...this.batches.map(batch => ({ type: 'batch', batch })), ...this.items.map(item => ({ type: 'item', item }))];
    const text = lines.map(line => JSON.stringify(line)).join('\n') + (lines.length ? '\n' : '');
    const run = this.writes.then(() => writePrivate(this.outboxPath, text));
    this.writes = run.catch(error => { this.error = `本地记忆写入失败：${error.message}`; this.changed(); });
    return durable ? run : this.writes;
  }
  saveCache({ durable = false } = {}) {
    const text = JSON.stringify(this.cache);
    const run = this.writes.then(() => writePrivate(this.cachePath, text));
    this.writes = run.catch(error => { this.error = `本地记忆写入失败：${error.message}`; this.changed(); });
    return durable ? run : this.writes;
  }
  /** Accept one information-stream snapshot. Each newly finalized utterance is readable at once and queued for Hindsight. */
  observe(snapshot) {
    if (this.closed || !['running', 'stopping'].includes(snapshot?.status)) return;
    let added = false;
    for (const utterance of snapshot.utterances ?? []) {
      if (!utterance || utterance.definite !== true || typeof utterance.text !== 'string') continue;
      const speaker = typeof utterance.speaker === 'string' ? utterance.speaker.trim() : '';
      const raw = utterance.text.trim().slice(0, UTTERANCE_LIMIT);
      const text = speaker ? `${speaker}：${raw}` : raw;
      if (!text || !Number.isFinite(utterance.start_time)) continue;
      const key = `${utterance.start_time}\0${text}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (this.seen.size > 400) this.seen.delete(this.seen.values().next().value);
      const at = new Date(this.now()).toISOString();
      const fragment = { at, text };
      this.fragments.push(fragment);
      if (this.fragments.length > FRAGMENT_RAM) this.fragments.splice(0, this.fragments.length - FRAGMENT_RAM);
      this.items.push({ kind: 'stream', at, text, ...(speaker ? { speaker } : {}), start_time: utterance.start_time });
      this.traceEvent('speech.final', { text, startTime: utterance.start_time, queued: this.items.length + this.batches.length });
      this.persist(async () => { await appendFile(this.fragmentsPath, JSON.stringify(fragment) + '\n', { mode: 0o600 }); await chmod(this.fragmentsPath, 0o600); });
      added = true;
    }
    if (!added) return;
    this.saveOutbox();
    this.armSilence();
    const stream = this.items.filter(item => item.kind === 'stream');
    if (stream.length >= this.limits.flushCount || stream.reduce((sum, item) => sum + length(item.text), 0) >= this.limits.flushChars) this.flush({ reason: 'volume' });
    this.changed();
  }
  armSilence() {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.flush({ reason: 'silence' }), this.limits.silenceMs);
    this.silenceTimer.unref?.();
  }
  /** Speech input paused or stopped. */
  voicePaused() { if (this.items.length) { this.traceEvent('speech.paused', { pending: this.items.length }); this.flush({ reason: 'voice-paused' }); } }
  /** Router turns block flushing; a turn that ends with content waiting flushes at once. */
  setRouterBusy(busy) {
    if (this.routerBusy !== !!busy) this.traceEvent(busy ? 'router.busy' : 'router.idle', { pending: this.items.length + this.batches.length });
    this.routerBusy = !!busy;
    if (!busy && (this.flushWanted || this.items.length || this.batches.length || this.cache.tombstones.some(item => item.pending))) this.flush({ reason: 'router-idle' });
  }
  /** One completed Router turn. Interrupted turns never reach here. */
  recordTurn({ inputId, user, assistant, report } = {}) {
    if (this.closed) return;
    const answer = String(assistant ?? '').trim();
    const asked = String(user ?? '').trim();
    if (!answer || (!asked && !report) || memoryCommand(asked)?.kind === 'forget') return;
    if (this.forgotten([asked, answer, report].filter(Boolean).join('\n'))) return;
    this.items.push({ kind: 'turn', at: new Date(this.now()).toISOString(), inputId: inputId || randomUUID(), user: asked, assistant: answer, ...(report ? { report: clip(report, 600) } : {}) });
    this.traceEvent('turn.queued', { inputId, user: asked, assistant: answer, report: report ? clip(report, 600) : undefined });
    this.flushWanted = true;
    this.saveOutbox();
    this.changed();
  }
  /** Seal waiting items into retain batches. Every batch gets a stable operation id so a replay never duplicates. */
  seal() {
    if (!this.items.length) return;
    const streams = new Map();
    for (const item of this.items) {
      if (item.kind === 'stream') {
        const day = localDate(item.at);
        if (!streams.has(day)) streams.set(day, []);
        streams.get(day).push(item);
      } else if (item.kind === 'turn') {
        const lines = [];
        if (item.report) lines.push(`[${localStamp(item.at)}] 后台记忆查询回报：${item.report}`);
        if (item.user) lines.push(`[${localStamp(item.at)}] 用户：${item.user}`);
        lines.push(`[${localStamp(item.at)}] 助手：${item.assistant}`);
        this.batches.push({ operationId: randomUUID(), kind: 'turn', documentId: `turn-${item.inputId}`, content: lines.join('\n'), timestamp: item.at, context: TURN_CONTEXT, count: 1 });
      }
    }
    for (const [day, list] of streams) {
      const labeled = list.some(item => item.speaker);
      const content = list.map(item => `[${localStamp(item.at)}] ${item.speaker ? item.text : `未确认说话人：${item.text}`}`).join('\n');
      this.batches.push({ operationId: randomUUID(), kind: 'stream', documentId: `stream-${day}`, updateMode: 'append', content, timestamp: list[0].at, context: labeled ? '现场对话，行首是说话人' : STREAM_CONTEXT, count: list.length });
    }
    this.items = [];
  }
  /**
   * Write waiting content to Hindsight. Requires an idle Router unless forced (process exit).
   * Failures keep the batch and retry with backoff.
   */
  flush({ force = false, explicitOnly = false, reason = 'manual' } = {}) {
    if (this.routerBusy && !force) { if (this.items.length || this.batches.length || this.cache.tombstones.some(item => item.pending)) { this.flushWanted = true; this.traceEvent('flush.deferred', { reason, pending: this.items.length + this.batches.length }); } return Promise.resolve(false); }
    if (this.flushing) { this.flushAgain = { force: this.flushAgain?.force || force, explicitOnly: this.flushAgain ? this.flushAgain.explicitOnly && explicitOnly : explicitOnly, reason }; return this.flushing; }
    this.traceEvent('flush.start', { reason, force, explicitOnly, pendingItems: this.items.length, pendingBatches: this.batches.length });
    this.flushWanted = false;
    if (!explicitOnly && reason !== 'retry') clearTimeout(this.silenceTimer);
    this.flushing = this.flushBody({ force, explicitOnly, reason }).catch(error => {
      this.error = `写入记忆失败：${error.message}`;
      this.lastFlush = { at: new Date(this.now()).toISOString(), reason, result: 'failed', error: error.message };
      this.traceEvent('flush.failed', { reason, documentId: this.currentBatch, error: error.message, pending: this.items.length + this.batches.length });
      this.scheduleRetry();
      return false;
    }).finally(() => {
      this.flushing = null;
      this.currentBatch = null;
      this.changed();
      const again = this.flushAgain; this.flushAgain = null;
      if (again && !this.closed) this.flush(again);
    });
    this.changed();
    return this.flushing;
  }
  async flushBody({ force, explicitOnly, reason }) {
    await this.ready;
    await this.writes;
    if (!this.items.length && !this.batches.length && !this.cache.tombstones.some(item => item.pending)) return true;
    if (!this.bridge?.ready) { this.lastFlush = { at: new Date(this.now()).toISOString(), reason, result: 'deferred' }; this.traceEvent('flush.offline', { reason, pending: this.items.length + this.batches.length }); return false; }
    // Acknowledgement polling must not turn freshly arriving sentences into tiny append jobs.
    // Their own volume/silence/pause/turn triggers will seal them when appropriate.
    if (!explicitOnly && reason !== 'retry') { this.seal(); this.traceEvent('flush.sealed', { reason, batches: this.batches.map(batch => ({ documentId: batch.documentId, kind: batch.kind, count: batch.count })) }); }
    await this.saveCache({ durable: true });
    await this.saveOutbox({ durable: true });
    await this.replayDeletions();
    let sent = 0;
    for (const batch of [...this.batches]) {
      if (this.routerBusy && !force) { this.flushWanted = true; break; }
      if (explicitOnly && batch.kind !== 'explicit') continue;
      this.currentBatch = batch.documentId;
      this.traceEvent('outbox.read', {
        kind: batch.kind, documentId: batch.documentId, operationId: batch.submitted ?? batch.operationId,
        content: batch.content, context: batch.context, timestamp: batch.timestamp,
        updateMode: batch.updateMode, tags: batch.tags, submitted: !!batch.submitted,
      });
      // One in-flight append per daily document preserves ordering and avoids concurrent read/modify/write.
      if (this.batches.slice(0, this.batches.indexOf(batch)).some(item => item.documentId === batch.documentId)) { this.scheduleRetry({ pending: true }); continue; }
      if (this.forgotten(batch.content)) {
        if (batch.submitted) {
          const operation = await this.bridge.operation(batch.submitted);
          if (!['completed', 'failed', 'cancelled'].includes(operation.status)) { this.scheduleRetry({ pending: true }); continue; }
          await this.bridge.deleteDocument(batch.documentId);
        }
        this.batches = this.batches.filter(item => item !== batch);
        await this.saveOutbox({ durable: true });
        continue;
      }
      if (batch.submitted) {
        this.traceEvent('retain.check', { documentId: batch.documentId, operationId: batch.submitted });
        const operation = await this.bridge.operation(batch.submitted);
        this.traceEvent('retain.status', { documentId: batch.documentId, operationId: batch.submitted, content: batch.content, status: operation.status, error: operation.error_message, response: operation });
        if (operation.status === 'failed') {
          await this.bridge.retryOperation(batch.submitted);
          this.error = '记忆抽取失败，已提交重试';
          this.scheduleRetry();
          continue;
        }
        if (operation.status !== 'completed') { this.scheduleRetry({ pending: true }); continue; }
      } else {
        this.traceEvent('retain.request', {
          kind: batch.kind, documentId: batch.documentId, operationId: batch.operationId,
          content: batch.content, context: batch.context, timestamp: batch.timestamp,
          updateMode: batch.updateMode, tags: batch.tags, async: !batch.sync,
        });
        const response = await this.bridge.retain(batch.content, {
          documentId: batch.documentId, timestamp: batch.timestamp, context: batch.context,
          ...(batch.updateMode ? { updateMode: batch.updateMode } : {}),
          ...(batch.tags ? { tags: batch.tags } : {}),
          ...(batch.sync ? { async: false } : { async: true, operationId: batch.operationId }),
        }, { timeoutMs: batch.sync ? 60_000 : 15_000 });
        this.traceEvent('retain.submitted', { kind: batch.kind, documentId: batch.documentId, operationId: response.operation_id ?? batch.operationId, count: batch.count, async: !batch.sync, updateMode: batch.updateMode, content: batch.content, response });
        if (!batch.sync && response.operation_id && this.bridge.operation) {
          batch.submitted = response.operation_id;
          await this.saveOutbox({ durable: true });
          this.scheduleRetry({ pending: true });
          continue;
        }
      }
      this.batches = this.batches.filter(item => item !== batch);
      sent += batch.count ?? 1;
      this.traceEvent('retain.completed', { documentId: batch.documentId, kind: batch.kind, operationId: batch.submitted ?? batch.operationId, count: batch.count, content: batch.content });
      await this.saveOutbox({ durable: true });
    }
    if (!this.batches.length) { this.error = undefined; this.retryDelay = 5_000; }
    this.lastFlush = { at: new Date(this.now()).toISOString(), reason, result: this.batches.some(batch => batch.submitted) ? 'processing' : 'ok', count: sent };
    this.traceEvent('flush.end', { ...this.lastFlush, pending: this.items.length + this.batches.length });
    return true;
  }
  scheduleRetry({ pending = false } = {}) {
    if (this.closed || this.retryTimer) return;
    const delay = pending ? 5_000 : this.retryDelay;
    if (!pending) this.retryDelay = Math.min(this.retryDelay * 2, 5 * 60_000);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.flush({ reason: 'retry' }); }, delay);
    this.traceEvent('flush.retry', { delayMs: delay, pending: this.items.length + this.batches.length });
    this.retryTimer.unref?.();
  }

  // ---------- explicit memories ----------

  /** Act on 记住 / 忘掉 / 纠正 commands. Local effect is immediate; Hindsight follows in the background. */
  command(instruction) {
    const parsed = memoryCommand(instruction);
    if (!parsed || this.closed) return null;
    const at = new Date(this.now()).toISOString();
    this.traceEvent(`memory.${parsed.kind}`, { text: parsed.text });
    if (parsed.kind === 'forget') {
      this.addTombstone(parsed.text, at);
    } else {
      const id = randomUUID();
      const text = parsed.kind === 'correct' ? `更正：${parsed.text}` : parsed.text;
      if (parsed.kind === 'correct') {
        const subject = correctionSubject(parsed.text);
        // A conservative subject mask prevents a stale model from contradicting the user's correction.
        if (subject) this.addTombstone(subject, at, { replacement: parsed.text });
      }
      this.cache.explicit.push({ id, at, text, kind: parsed.kind });
      if (this.cache.explicit.length > 50) this.cache.explicit.splice(0, this.cache.explicit.length - 50);
      this.batches.push({
        operationId: randomUUID(), kind: 'explicit', sync: true, documentId: `explicit-${id}`, tags: ['explicit'], timestamp: at, count: 1,
        content: `[${localStamp(at)}] 用户明确要求记住：${text}`,
        context: parsed.kind === 'correct' ? '用户纠正之前的说法，以此为准' : '用户明确要求记住',
      });
    }
    this.saveCache();
    this.saveOutbox();
    // Explicit retains use async:false even when the ordinary stream must wait for Router idle.
    this.flush({ force: true, explicitOnly: true, reason: 'explicit' });
    this.changed();
    return parsed;
  }
  track(promise) {
    const tracked = promise.catch(error => { this.error = `删除记忆失败：${error.message}`; this.changed(); }).finally(() => this.background.delete(tracked));
    this.background.add(tracked);
    return tracked;
  }
  addTombstone(text, at, { replacement } = {}) {
    const documents = this.cache.explicit.filter(item => mentions(item.text, text)).map(item => `explicit-${item.id}`);
    this.cache.explicit = this.cache.explicit.filter(item => !mentions(item.text, text));
    this.cache.tombstones.push({ id: randomUUID(), at, text, pending: true, documents, ...(replacement ? { replacement } : {}) });
    // Pending sources must obey the same deletion as the prompt and tool results.
    this.items = this.items.filter(item => !this.forgotten(item.text ?? [item.user, item.assistant, item.report].join('\n')));
    for (const batch of this.batches) {
      if (this.forgotten(batch.content)) {
        // A previously submitted operation may still finish; delete its document on replay as well.
        if (batch.submitted) this.cache.tombstones.at(-1).documents.push(batch.documentId);
        else batch.suppressed = true;
      }
    }
    this.batches = this.batches.filter(batch => !batch.suppressed);
  }
  /** Deletion intent lives in the cache until the server has applied it; reconnect replays it before retains. */
  async replayDeletions() {
    if (!this.bridge?.ready) return;
    for (const tombstone of this.cache.tombstones) {
      if (!tombstone.pending) continue;
      const documents = new Set(tombstone.documents ?? []);
      // Scan paginated source facts so Chinese BM25/recall limits cannot silently miss a matching document.
      for (let offset = 0; ; offset += 100) {
        const page = await this.bridge.listMemories({ limit: 100, offset, state: 'valid' }, { timeoutMs: 15_000 });
        for (const fact of page.items ?? []) {
          if (!this.matchesTombstone(fact.text, tombstone)) continue;
          if (fact.document_id) documents.add(fact.document_id);
          else if (fact.id && ['world', 'experience'].includes(fact.fact_type ?? fact.type)) await this.bridge.invalidateMemory(fact.id);
        }
        if (!(page.items?.length) || offset + page.items.length >= page.total) break;
      }
      for (const document of documents) {
        this.traceEvent('memory.delete.request', { documentId: document, match: tombstone.text });
        try { await this.bridge.deleteDocument(document); this.traceEvent('memory.delete.done', { documentId: document }); }
        catch (error) { if (error.statusCode !== 404 && !/not found|404/i.test(error.message)) { this.traceEvent('memory.delete.failed', { documentId: document, error: error.message }); throw error; } }
      }
      tombstone.documents = [...documents];
      // Deletions do not count as new writes in Hindsight; explicitly refresh stale derived models.
      for (const model of MENTAL_MODELS) await this.bridge.refreshMentalModel(model.id);
      tombstone.pending = false;
      try { await this.saveCache({ durable: true }); }
      catch (error) { tombstone.pending = true; throw error; }
    }
  }
  matchesTombstone(value, item) {
    return mentions(value, item.text) && !(item.replacement && normalized(value).includes(normalized(item.replacement)));
  }
  forgotten(value) {
    return this.cache.tombstones.some(item => this.matchesTombstone(value, item));
  }
  scrub(value) {
    return String(value ?? '').split(/\n|(?<=[。！？!?])/u).filter(line => !this.forgotten(line)).join('\n');
  }

  // ---------- local cache ----------

  /** Pull the three mental models into RAM and data/memory-cache.json. */
  async refreshCache() {
    await this.ready;
    if (!this.bridge?.ready || this.closed) return false;
    this.traceEvent('cache.refresh.start', { models: MENTAL_MODELS.map(model => model.id) });
    const models = { ...this.cache.models };
    for (const model of MENTAL_MODELS) {
      try {
        const value = await this.bridge.mentalModel(model.id, model.responseSchema ? 'full' : 'content', { timeoutMs: 10_000 });
        const structured = value.reflect_response?.structured_output;
        models[model.id] = {
          content: typeof value.content === 'string' ? value.content : '',
          updatedAt: value.last_refreshed_at ?? null,
          ...(model.responseSchema ? { people: Array.isArray(structured?.people) ? structured.people.filter(person => person && typeof person.name === 'string' && person.name.trim()) : [] } : {}),
        };
        this.traceEvent('cache.model', { id: model.id, updatedAt: models[model.id].updatedAt, content: models[model.id].content, people: models[model.id].people });
      } catch (error) {
        this.traceEvent('cache.model.failed', { id: model.id, error: error.message });
        if (error instanceof MemoryUnavailableError) return false;
      }
    }
    this.cache.models = models;
    this.cache.fetchedAt = new Date(this.now()).toISOString();
    await this.saveCache();
    this.traceEvent('cache.refresh.end', { fetchedAt: this.cache.fetchedAt });
    this.changed();
    return true;
  }

  // ---------- hot path ----------

  boundedRecent(lines) {
    const kept = [];
    let remaining = this.limits.recentChars;
    for (const line of lines.slice(-this.limits.recentCount).reverse()) {
      if (remaining <= 0) break;
      const part = clip(line, remaining);
      kept.unshift(part);
      remaining -= length(part) + 1;
    }
    return kept;
  }
  /** All finalized utterances from the last minute, in spoken order, for the Router user message. */
  recentSpeech(now = this.now()) {
    const since = now - 60_000;
    return this.fragments.filter(item => {
      const at = Date.parse(item.at);
      return Number.isFinite(at) && at >= since && at <= now && !this.forgotten(item.text);
    }).map(item => item.text);
  }
  recent(now = this.now()) {
    const since = now - this.limits.recentMs;
    const list = this.fragments.filter(item => { const at = Date.parse(item.at); return Number.isFinite(at) && at >= since && at <= now && !this.forgotten(item.text); });
    return this.boundedRecent(list.slice(-this.limits.recentCount).map(item => `[${localClock(item.at)}] ${item.text}`));
  }
  people(text) {
    const list = this.cache.models.people?.people ?? [];
    const hits = [];
    for (const person of list) {
      const names = [person.name, ...(Array.isArray(person.aliases) ? person.aliases : [])].filter(name => typeof name === 'string' && name.trim().length >= 1).map(name => name.trim());
      if (this.forgotten(names.join(' '))) continue;
      if (!names.some(name => text.includes(name))) continue;
      const detail = [person.relation, person.occupation].filter(Boolean).join('，');
      const aliases = Array.isArray(person.aliases) && person.aliases.length ? `（又称${person.aliases.join('、')}）` : '';
      const line = clip(`- ${person.name}${aliases}${detail ? `：${detail}` : ''}${person.recent ? `。近况：${person.recent}` : ''}`, this.limits.person);
      if (!this.forgotten(line)) hits.push(line);
      if (hits.length >= this.limits.people) break;
    }
    return hits;
  }
  /**
   * The memory block for one Router turn. RAM only: no network, no model.
   * `extra` carries on-screen sentences that preceded the command.
   * `includeRecent` is false when recent speech is already in the Router user message.
   */
  compile(command, { extra = '', includeRecent = true } = {}) {
    const instruction = String(command ?? '').trim();
    const recent = this.recent();
    const extraLines = String(extra ?? '').split('\n').map(line => line.trim()).filter(line => line && line !== instruction && !this.forgotten(line) && !recent.some(item => item.endsWith(` ${line}`)));
    const sections = [];
    const stamp = id => { const at = this.cache.models[id]?.updatedAt; return at ? `（更新于 ${localStamp(at)}）` : '（尚未刷新）'; };
    const explicit = this.cache.explicit.filter(item => !this.forgotten(item.text)).map(item => `- ${item.text}`);
    const profile = this.scrub(this.cache.models['user-profile']?.content ?? '').trim();
    const profileText = [explicit.length ? `用户明确要求记住：\n${explicit.join('\n')}` : '', profile].filter(Boolean).join('\n');
    if (profileText) sections.push(`## 用户档案${stamp('user-profile')}\n${clip(profileText, this.limits.profile)}`);
    const items = this.scrub(this.cache.models['open-items']?.content ?? '').trim();
    if (items) sections.push(`## 进行中事项${stamp('open-items')}\n${clip(items, this.limits.openItems)}`);
    const people = this.people([instruction, ...recent, ...extraLines].join('\n'));
    if (people.length) sections.push(`## 相关人物${stamp('people')}\n${people.join('\n')}`);
    const bare = value => value.replace(/^\[[^\]]*\]\s*/u, '').trim().replace(/[。！？!?\s]+$/u, '');
    const asked = bare(instruction);
    const spoken = this.boundedRecent([...recent, ...extraLines.map(line => `[屏幕] ${line}`)].filter(line => !asked || bare(line) !== asked));
    if (includeRecent && spoken.length) sections.push(`## 最近原话（更新于 ${localStamp(this.fragments.at(-1)?.at ?? this.now())}；最近10分钟）\n${spoken.join('\n')}`);
    if (!sections.length) return this.cache.tombstones.length ? `${MEMORY_NOTE}\n\n当前记忆为空。之前的记忆快照已失效，不要沿用其中的事实。` : '';
    return [MEMORY_NOTE, ...sections].join('\n\n');
  }

  // ---------- on-demand tools ----------

  /** memory_search: recall with a hard timeout. Never throws. */
  async search(query, { signal } = {}) {
    const text = String(query ?? '').trim();
    this.traceEvent('memory.search.start', { query: text });
    if (!text) { this.traceEvent('memory.search.end', { query: text, results: [], note: '查询为空' }); return { available: true, results: [], note: '查询为空' }; }
    if (!this.bridge?.ready) { this.traceEvent('memory.search.unavailable', { query: text, status: this.service().status }); return { available: false, results: [], note: this.bridge ? '记忆服务不可用，只能依据注入的记忆和最近原话回答' : '记忆服务未启用' }; }
    try {
      const found = await this.bridge.recall(text, { budget: 'mid', maxTokens: 2048 }, { timeoutMs: this.limits.searchTimeoutMs, signal });
      const results = (found.results ?? []).filter(item => typeof item.text === 'string' && !this.forgotten(item.text)).slice(0, 12)
        .map(item => ({ text: item.text, type: item.type ?? undefined, when: item.occurred_start ?? item.mentioned_at ?? undefined }));
      this.traceEvent('memory.search.end', { query: text, results });
      return { available: true, results };
    } catch (error) {
      this.traceEvent('memory.search.failed', { query: text, error: error.message });
      if (error.name === 'TimeoutError' || error.name === 'AbortError') return { available: true, results: [], note: '记忆检索超时，结果为空，可稍后重试或改用 memory_reflect' };
      return { available: false, results: [], note: error instanceof MemoryUnavailableError ? error.message : `记忆检索失败：${error.message}` };
    }
  }
  /** memory_reflect body, run by the Worker. Throws on failure so the Worker reports it. */
  async reflect(query, { signal } = {}) {
    const text = String(query ?? '').trim();
    if (!text) throw new Error('查询为空');
    this.traceEvent('memory.reflect.start', { query: text });
    if (!this.bridge?.ready) { this.traceEvent('memory.reflect.unavailable', { query: text, status: this.service().status }); throw new MemoryUnavailableError(this.bridge ? undefined : '记忆服务未启用'); }
    try {
      const answer = await this.bridge.reflect(text, { budget: 'mid' }, { timeoutMs: this.limits.reflectTimeoutMs, signal });
      const result = { query: text, answer: this.scrub(answer.text ?? '').trim() || '记忆里没有相关内容。' };
      this.traceEvent('memory.reflect.end', result);
      return result;
    } catch (error) { this.traceEvent('memory.reflect.failed', { query: text, error: error.message }); throw error; }
  }

  async idle() {
    await this.ready;
    while (this.flushing || this.background.size) { await this.flushing; await Promise.all([...this.background]); }
    await this.writes;
    await this.traceWrites;
  }
  /** Process exit: force one last flush regardless of the Router, then stop timers. */
  async dispose() {
    if (this.closed) return;
    await this.ready.catch(() => {});
    clearTimeout(this.silenceTimer); clearTimeout(this.retryTimer); clearInterval(this.cacheTimer);
    this.retryTimer = null;
    if (this.items.length || this.batches.length) await this.flush({ force: true, reason: 'exit' }).catch(() => {});
    this.traceEvent('context.dispose', { pending: this.items.length + this.batches.length });
    await this.idle().catch(() => {});
    this.closed = true;
    clearTimeout(this.retryTimer);
    if (this.bridge && this.onBridgeStatus) this.bridge.off('status', this.onBridgeStatus);
    this.removeAllListeners();
  }
}
