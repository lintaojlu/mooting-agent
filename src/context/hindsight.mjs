import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HindsightServer } from '@vectorize-io/hindsight-all';
import { HindsightClient, HindsightError, sdk } from '@vectorize-io/hindsight-client';
import { readModelEnv } from '../model-env.mjs';

/** hindsight-embed is pinned; the npm wrappers carry the same version. */
export const EMBED_VERSION = '1.2.1';
export const DEFAULT_PROFILE = 'mooting';
export const DEFAULT_PORT = 9077;
export const DEFAULT_BANK = 'mooting';
export const LOCAL_EMBEDDING_MODEL = 'BAAI/bge-m3';
export const LOCAL_RERANKER_MODEL = 'hindsight-ai/hs-rerank-1';
export const RETAIN_MISSION = '保留用户本人及其身边人物的姓名、职业、关系、偏好、约定、待办、决定及原因；忽略寒暄、口令、识别噪声。';
export const PEOPLE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    people: {
      type: 'array',
      description: '用户身边的人，每人一项',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '姓名或最常用的称呼' },
          aliases: { type: 'array', items: { type: 'string' }, description: '别名、昵称、英文名' },
          occupation: { type: 'string', description: '职业或身份' },
          relation: { type: 'string', description: '与用户的关系' },
          recent: { type: 'string', description: '最近的近况或与用户的最近交集' },
        },
        required: ['name'],
      },
    },
  },
  required: ['people'],
});
export const MENTAL_MODELS = Object.freeze([
  { id: 'user-profile', name: '用户档案', sourceQuery: '用户是谁：身份、职业、所在地、偏好、习惯、表达方式' },
  { id: 'people', name: '人物关系表', sourceQuery: '用户身边的人：姓名、别名、职业、与用户的关系、近况', responseSchema: PEOPLE_SCHEMA },
  { id: 'open-items', name: '进行中事项', sourceQuery: '进行中的事项、约定、待办、未结束的话题和最近的决定' },
]);

export class MemoryUnavailableError extends Error {
  constructor(message = '记忆服务不可用') { super(message); this.name = 'MemoryUnavailableError'; }
}

const text = value => typeof value === 'string' ? value.trim() : '';

function httpURL(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} 无效`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${name} 需要不带凭证和查询参数的 HTTP(S) 地址`);
  return url.href.replace(/\/$/, '');
}

/**
 * Map MootingAgent .env onto the hindsight-embed daemon environment.
 * Only the LLM is remote by default. Embedding and reranking stay local unless their base URL is set.
 */
export function loadHindsightConfig(env = {}) {
  const enabled = text(env.MOOTING_HINDSIGHT_ENABLED) !== '0';
  const portText = text(env.MOOTING_HINDSIGHT_PORT);
  const port = portText ? Number(portText) : DEFAULT_PORT;
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error('MOOTING_HINDSIGHT_PORT 必须为 1–65535 整数');
  const pick = (own, fallback) => text(env[own]) || text(env[fallback]);
  const baseURL = pick('MOOTING_HINDSIGHT_LLM_BASE_URL', 'MOOTING_CONTEXT_BASE_URL');
  const model = pick('MOOTING_HINDSIGHT_LLM_MODEL', 'MOOTING_CONTEXT_MODEL');
  const apiKey = typeof env.MOOTING_HINDSIGHT_LLM_API_KEY === 'string' && env.MOOTING_HINDSIGHT_LLM_API_KEY ? env.MOOTING_HINDSIGHT_LLM_API_KEY : typeof env.MOOTING_CONTEXT_API_KEY === 'string' ? env.MOOTING_CONTEXT_API_KEY : '';
  if (!baseURL || !model) return { enabled, configured: false, port };
  const daemonEnv = {
    HINDSIGHT_API_HOST: '127.0.0.1',
    HINDSIGHT_API_LLM_PROVIDER: 'openai',
    HINDSIGHT_API_LLM_BASE_URL: httpURL(baseURL, 'Hindsight LLM 地址'),
    HINDSIGHT_API_LLM_MODEL: model,
    HINDSIGHT_API_LLM_API_KEY: apiKey || 'none',
    HINDSIGHT_API_LLM_OUTPUT_LANGUAGE: '简体中文',
    HINDSIGHT_API_LLM_EXTRA_BODY: '{}',
    // uvx otherwise picks the first python on PATH, which may be an x86_64 build under Rosetta with no torch wheels.
    UV_PYTHON: text(env.MOOTING_HINDSIGHT_PYTHON) || text(env.UV_PYTHON) || (process.platform === 'darwin' && process.arch === 'arm64' ? 'cpython-3.12-macos-aarch64' : undefined),
  };
  const extraBody = text(env.MOOTING_HINDSIGHT_LLM_EXTRA_BODY);
  if (extraBody) {
    let body;
    try { body = JSON.parse(extraBody); } catch { throw new Error('MOOTING_HINDSIGHT_LLM_EXTRA_BODY 必须为 JSON 对象'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('MOOTING_HINDSIGHT_LLM_EXTRA_BODY 必须为 JSON 对象');
    daemonEnv.HINDSIGHT_API_LLM_EXTRA_BODY = JSON.stringify(body);
  }
  // The Python daemon ignores the macOS system proxy; model downloads from Hugging Face may need one.
  const proxy = text(env.MOOTING_HINDSIGHT_PROXY) || text(env.HTTPS_PROXY) || text(env.https_proxy);
  if (proxy) Object.assign(daemonEnv, { HTTPS_PROXY: httpURL(proxy, 'MOOTING_HINDSIGHT_PROXY'), HTTP_PROXY: httpURL(proxy, 'MOOTING_HINDSIGHT_PROXY'), NO_PROXY: 'localhost,127.0.0.1,::1' });
  const hfEndpoint = text(env.MOOTING_HF_ENDPOINT) || text(env.HF_ENDPOINT);
  if (hfEndpoint) daemonEnv.HF_ENDPOINT = httpURL(hfEndpoint, 'MOOTING_HF_ENDPOINT');
  const embeddingURL = text(env.MOOTING_EMBEDDING_BASE_URL);
  if (embeddingURL) {
    Object.assign(daemonEnv, {
      HINDSIGHT_API_EMBEDDINGS_PROVIDER: 'openai',
      HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL: httpURL(embeddingURL, 'MOOTING_EMBEDDING_BASE_URL'),
      HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL: text(env.MOOTING_EMBEDDING_MODEL) || undefined,
      HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY: env.MOOTING_EMBEDDING_API_KEY || undefined,
      HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS: text(env.MOOTING_EMBEDDING_DIMENSIONS) || undefined,
    });
  } else Object.assign(daemonEnv, { HINDSIGHT_API_EMBEDDINGS_PROVIDER: 'local', HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL: LOCAL_EMBEDDING_MODEL });
  const rerankerURL = text(env.MOOTING_RERANKER_BASE_URL);
  if (rerankerURL) {
    const provider = (text(env.MOOTING_RERANKER_PROVIDER) || 'cohere').toLowerCase();
    const fields = {
      cohere: 'BASE_URL', tei: 'URL', litellm: 'API_BASE', 'litellm-sdk': 'API_BASE',
      nvidia: 'BASE_URL', zeroentropy: 'BASE_URL', openrouter: 'BASE_URL', siliconflow: 'BASE_URL',
    };
    if (!Object.hasOwn(fields, provider)) throw new Error(`不支持远端重排 provider：${provider}；可选 ${Object.keys(fields).join('、')}`);
    const prefix = `HINDSIGHT_API_RERANKER_${provider.toUpperCase().replaceAll('-', '_')}`;
    Object.assign(daemonEnv, {
      HINDSIGHT_API_RERANKER_PROVIDER: provider,
      [`${prefix}_${fields[provider]}`]: httpURL(rerankerURL, 'MOOTING_RERANKER_BASE_URL'),
      ...(provider === 'tei' ? {} : {
        [`${prefix}_MODEL`]: text(env.MOOTING_RERANKER_MODEL) || undefined,
        [`${prefix}_API_KEY`]: env.MOOTING_RERANKER_API_KEY || undefined,
      }),
    });
  } else Object.assign(daemonEnv, { HINDSIGHT_API_RERANKER_PROVIDER: 'local', HINDSIGHT_API_RERANKER_LOCAL_MODEL: LOCAL_RERANKER_MODEL });
  return { enabled, configured: true, port, llm: { baseURL: daemonEnv.HINDSIGHT_API_LLM_BASE_URL, model }, embedding: embeddingURL ? 'remote' : 'local', reranker: rerankerURL ? 'remote' : 'local', daemonEnv };
}

/** Browser-safe view. Never includes API keys or the daemon environment. */
export function publicServiceSettings(config) {
  if (!config?.configured) {
    const empty = { configured: false, model: '', baseURL: '', hasApiKey: false };
    return { memoryModel: empty, embedding: { ...empty, mode: '未配置' } };
  }
  const key = config.daemonEnv?.HINDSIGHT_API_LLM_API_KEY;
  const memoryModel = { configured: true, model: config.llm?.model || '', baseURL: config.llm?.baseURL || '', hasApiKey: Boolean(key && key !== 'none') };
  if (config.embedding !== 'remote') return { memoryModel, embedding: { configured: true, mode: '本地', model: LOCAL_EMBEDDING_MODEL, baseURL: '', hasApiKey: false } };
  return { memoryModel, embedding: { configured: true, mode: config.localAtomic ? '本机原子服务' : '远程', model: config.daemonEnv?.HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL || '', baseURL: config.daemonEnv?.HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL || '', hasApiKey: Boolean(config.daemonEnv?.HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY) } };
}

function anySignal(signals) {
  const list = signals.filter(Boolean);
  return list.length > 1 ? AbortSignal.any(list) : list[0];
}

function abortReason(signal) { return signal.reason ?? new DOMException('操作已取消', 'AbortError'); }

/** A deadline must still work when an SDK catches AbortSignal errors or ignores the signal. */
export async function withDeadline(run, { timeoutMs, signal } = {}) {
  const controller = new AbortController();
  const combined = anySignal([controller.signal, signal]);
  let onAbort, timer;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortReason(combined));
    if (combined.aborted) onAbort();
    else combined.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) timer = setTimeout(() => controller.abort(new DOMException('记忆调用超时', 'TimeoutError')), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => { combined.throwIfAborted(); return run(combined); }), aborted]);
  } catch (error) {
    if (combined.aborted) throw abortReason(combined);
    throw error;
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', onAbort);
  }
}

function isConnectionError(error) {
  if (!error) return false;
  const code = error.cause?.code ?? error.code;
  return (error.name === 'TypeError' && /fetch failed|network|connection/i.test(error.message)) || ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ENOTFOUND', 'EHOSTUNREACH'].includes(code);
}

/**
 * The pinned npm manager does not support cancellation of CLI subprocesses. Override only its
 * command runner so shutdown can cancel environment downloads/startup rather than waiting 30 minutes.
 */
class CancellableHindsightServer extends HindsightServer {
  constructor(options, signal) { super(options); this.lifecycleSignal = signal; }
  async runCommand(cmd, args, env, label) {
    this.lifecycleSignal.throwIfAborted();
    await new Promise((resolve, reject) => {
      // The Python CLI writes LLM credentials into the profile using the inherited umask.
      // Restrict it only while spawning so the child creates private files from its first write.
      const previousUmask = process.umask(0o077);
      let child;
      try { child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
      finally { process.umask(previousUmask); }
      let killTimer;
      const abort = () => {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
        killTimer.unref?.();
        reject(abortReason(this.lifecycleSignal));
      };
      this.lifecycleSignal.addEventListener('abort', abort, { once: true });
      // Do not echo profile arguments, which contain API keys.
      for (const stream of [child.stdout, child.stderr]) stream.on('data', () => {});
      const done = error => { clearTimeout(killTimer); this.lifecycleSignal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      child.once('error', done);
      child.once('exit', code => done(code === 0 ? null : new Error(`${label} failed with code ${code}; inspect the Hindsight profile log`)));
      if (this.lifecycleSignal.aborted) abort();
    });
  }
  async waitForReady() {
    await withDeadline(async signal => {
      while (!await this.checkHealth()) {
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, this.readyPollIntervalMs);
          signal.addEventListener('abort', done, { once: true });
          if (signal.aborted) done();
        });
        signal.throwIfAborted();
      }
    }, { timeoutMs: this.readyTimeoutMs, signal: this.lifecycleSignal });
  }
}

/**
 * Owns the hindsight-embed daemon (start, stop, health) and every client call.
 * status: unconfigured | disabled | starting | ready | offline.
 */
export class HindsightBridge extends EventEmitter {
  constructor({ env, envPath, profile = DEFAULT_PROFILE, port, bank = DEFAULT_BANK, embedVersion = EMBED_VERSION, readyTimeoutMs = 30 * 60_000, healthIntervalMs = 15_000, manageDaemon = true, localEndpoint, mentalModelTrigger, logger } = {}) {
    super();
    this.env = env; this.envPath = envPath; this.profile = profile; this.portOverride = port; this.bank = bank;
    this.embedVersion = embedVersion; this.readyTimeoutMs = readyTimeoutMs; this.healthIntervalMs = healthIntervalMs;
    this.manageDaemon = manageDaemon && !localEndpoint; this.localEndpoint = localEndpoint; this.logger = logger ?? quietLogger;
    this.mentalModelTrigger = { mode: 'delta', refreshAfterConsolidation: true, minRefreshIntervalSeconds: 600, ...mentalModelTrigger };
    this.status = 'starting'; this.error = undefined; this.config = { configured: false };
    this.stopped = false; this.timer = null; this.starting = null;
    this.lifecycle = new AbortController();
  }
  get ready() { return this.status === 'ready'; }
  get configured() { return !!this.config.configured; }
  setStatus(status, error) {
    if (this.status === status && this.error === error) return;
    this.status = status; this.error = error;
    this.emit('status', { status, error });
    if (status === 'ready') this.emit('ready');
  }
  async loadConfig() {
    if (this.localEndpoint) {
      this.config = { enabled: true, configured: true, llm: { model: this.localEndpoint.model },
        embedding: 'remote', localAtomic: true,
        daemonEnv: { HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL: this.localEndpoint.embeddingModel } };
      return this.config;
    }
    const file = this.envPath ? await readModelEnv(this.envPath) : {};
    try { this.config = loadHindsightConfig({ ...process.env, ...file, ...this.env }); }
    catch (error) { this.config = { configured: false, enabled: true }; this.setStatus('unconfigured', error.message); return this.config; }
    if (this.portOverride) this.config.port = this.portOverride;
    return this.config;
  }
  /** Start (or attach to) the daemon. Never throws: failures leave the bridge offline and health polling keeps trying. */
  start() {
    this.starting ??= this.startBody().catch(error => {
      if (!this.stopped) this.setStatus('offline', error.message);
    });
    return this.starting;
  }
  async startBody() {
    await this.loadConfig();
    if (this.stopped || this.status === 'unconfigured') return;
    if (!this.config.enabled) { this.setStatus('disabled'); return; }
    if (!this.config.configured) { this.setStatus('unconfigured', '请在 .env 中配置 MOOTING_CONTEXT_BASE_URL 和 MOOTING_CONTEXT_MODEL（或 MOOTING_HINDSIGHT_LLM_*）'); return; }
    this.baseUrl = this.localEndpoint?.url ?? `http://127.0.0.1:${this.config.port}`;
    this.client = new HindsightClient({ baseUrl: this.baseUrl, apiKey: this.localEndpoint?.apiKey, userAgent: 'mooting-agent', maxAttempts: 1 });
    this.rawClient = this.client.client;
    // hey-api catches fetch exceptions and the high-level SDK wraps them in HindsightError,
    // dropping the DOMException name and network cause. Preserve only transport errors here;
    // HTTP errors still follow the SDK path with their statusCode intact.
    this.rawClient.interceptors.error.use((error, response) => { if (!response) throw error; return error; });
    const daemonEnv = { ...this.config.daemonEnv, HINDSIGHT_EMBED_DAEMON_STARTUP_TIMEOUT: String(Math.ceil(this.readyTimeoutMs / 1000)) };
    this.server = this.localEndpoint ? {
      checkHealth: async () => {
        const signal = anySignal([this.lifecycle.signal, AbortSignal.timeout(2500)]);
        const headers = { Authorization: 'Bearer ' + this.localEndpoint.apiKey };
        try { return (await fetch(this.baseUrl + '/health', { headers, signal })).ok; }
        catch { return false; }
      },
    } : new CancellableHindsightServer({ profile: this.profile, port: this.config.port, embedVersion: this.embedVersion, env: daemonEnv, readyTimeoutMs: this.readyTimeoutMs, readyPollIntervalMs: 2_000, logger: this.logger }, this.lifecycle.signal);
    this.setStatus('starting');
    try {
      if (this.manageDaemon && !(await this.server.checkHealth())) await this.server.start();
      if (this.manageDaemon && process.platform !== 'win32') {
        // Also repair a profile created by an older run with a permissive umask.
        await chmod(join(homedir(), '.hindsight', 'profiles', `${this.profile}.env`), 0o600).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      if (this.stopped) return;
      await this.initializeBank();
      if (!this.stopped) this.setStatus('ready');
    } catch (error) {
      if (this.stopped) return;
      this.logger.warn(`[hindsight] ${error.message}`);
      this.setStatus('offline', error.message);
    }
    this.watch();
  }
  watch() {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => { this.probe().catch(() => {}); }, this.healthIntervalMs);
    this.timer.unref?.();
  }
  /** One health probe. A daemon that comes back is re-initialized before it is marked ready. */
  async probe() {
    if (this.stopped || !this.server) return this.ready;
    const healthy = await this.server.checkHealth();
    if (!healthy) { if (this.status !== 'starting') this.setStatus('offline', '记忆服务离线'); return false; }
    if (!this.ready) {
      try { await this.initializeBank(); if (!this.stopped) this.setStatus('ready'); }
      catch (error) { if (!this.stopped) this.setStatus('offline', error.message); return false; }
    }
    return true;
  }
  /** Create the bank and the three mental models. Repeatable. */
  async initializeBank() {
    const signal = anySignal([AbortSignal.timeout(30_000), this.lifecycle.signal]);
    await this.client.createBank(this.bank, { retainMission: RETAIN_MISSION, reflectMission: '你是用户的私人助理的记忆。用中文回答，只依据记忆，不编造。', signal });
    const existing = await this.client.listMentalModels(this.bank, { detail: 'metadata', signal });
    const ids = new Set((existing.items ?? []).map(item => item.id));
    for (const model of MENTAL_MODELS) {
      if (ids.has(model.id)) continue;
      await this.client.createMentalModel(this.bank, model.name, model.sourceQuery, {
        id: model.id, signal,
        trigger: { ...this.mentalModelTrigger, ...(model.responseSchema ? { responseSchema: model.responseSchema } : {}) },
      });
    }
  }
  /** Run one client call against a ready daemon with a timeout. Connection failures mark the bridge offline. */
  async call(run, { timeoutMs = 30_000, signal } = {}) {
    if (!this.ready || !this.client) throw new MemoryUnavailableError(this.status === 'unconfigured' ? '记忆未配置' : this.status === 'starting' ? '记忆服务启动中' : '记忆服务离线');
    try { return await withDeadline(combined => run(this.client, combined), { timeoutMs, signal: anySignal([signal, this.lifecycle.signal]) }); }
    catch (error) {
      if (isConnectionError(error)) { this.setStatus('offline', '记忆服务离线'); throw new MemoryUnavailableError('记忆服务离线'); }
      throw error;
    }
  }
  retain(content, options = {}, call) { return this.call((client, signal) => client.retain(this.bank, content, { ...options, signal }), call); }
  recall(query, options = {}, call) { return this.call((client, signal) => client.recall(this.bank, query, { ...options, signal }), call); }
  reflect(query, options = {}, call) { return this.call((client, signal) => client.reflect(this.bank, query, { ...options, signal }), call); }
  mentalModel(id, detail = 'content', call) { return this.call((client, signal) => client.getMentalModel(this.bank, id, { detail, signal }), call); }
  refreshMentalModel(id, call) { return this.call((client, signal) => client.refreshMentalModel(this.bank, id, { signal }), call); }
  document(documentId, call) { return this.call((client, signal) => client.getDocument(this.bank, documentId, { signal }), call); }
  deleteDocument(documentId, call) { return this.call((client, signal) => client.deleteDocument(this.bank, documentId, { signal }), call); }
  listMemories(options = {}, call) { return this.call((client, signal) => client.listMemories(this.bank, { ...options, signal }), call); }
  /** Exclude one world/experience fact from recall, consolidation and refresh (reversible on the Hindsight side). */
  invalidateMemory(memoryId, call) {
    return this.call(async (client, signal) => {
      const response = await sdk.updateMemory({ client: this.rawClient, path: { bank_id: this.bank, memory_id: memoryId }, body: { state: 'invalidated' }, signal });
      if (response.error) throw new Error(`invalidate failed: ${JSON.stringify(response.error)}`);
      return response.data;
    }, call);
  }
  /** Per-operation acknowledgements avoid the default list page dropping older submitted jobs. */
  operation(operationId, call) {
    return this.operationRequest('getOperationStatus', operationId, call);
  }
  retryOperation(operationId, call) {
    return this.operationRequest('retryOperation', operationId, call);
  }
  cancelOperation(operationId, call) {
    return this.operationRequest('cancelOperation', operationId, call);
  }
  operationRequest(method, operationId, call) {
    return this.call(async (_client, signal) => {
      const response = await sdk[method]({ client: this.rawClient, path: { bank_id: this.bank, operation_id: operationId }, signal });
      if (response.error) throw new HindsightError(`${method} failed`, response.response?.status, response.error);
      return response.data;
    }, call);
  }
  async operations(call, options = {}) {
    return this.call(async (client, signal) => {
      const response = await sdk.listOperations({ client: this.rawClient, path: { bank_id: this.bank }, query: options, signal });
      if (response.error) throw new HindsightError('listOperations failed', response.response?.status, response.error);
      return response.data;
    }, call);
  }
  deleteBank(call) { return this.call((client, signal) => client.deleteBank(this.bank, { signal }), call); }
  /** Stop health polling and, when this process owns the daemon, stop it too. */
  async stop() {
    this.stopped = true;
    this.lifecycle.abort(new DOMException('记忆服务正在停止', 'AbortError'));
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Startup's subprocess and readiness loop receive lifecycle cancellation above.
    await withDeadline(() => this.starting?.catch?.(() => {}), { timeoutMs: 3_000 }).catch(() => {});
    if (this.manageDaemon && this.server) await withDeadline(() => this.server.stop(), { timeoutMs: 6_000 }).catch(() => {});
    if (this.status === 'ready' || this.status === 'starting') this.setStatus('offline', '记忆服务已停止');
    this.removeAllListeners();
  }
}

export const quietLogger = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });
export const consoleLogger = Object.freeze({
  debug() {},
  info(message) { if (/^\[hindsight\] /.test(message)) console.log(message); },
  warn(message) { console.warn(message); },
  error(message) { console.error(message); },
});
