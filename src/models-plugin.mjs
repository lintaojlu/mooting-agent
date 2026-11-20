import { randomUUID } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import { LlmAdapter, createUserMessage, createSystemMessage } from '@deepseek-ai/dsh-llm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readModelEnv, writeModelEnv } from './model-env.mjs';
import { join } from 'node:path';
import { CompatibleRouterAdapter } from './model-adapters.mjs';
import { InputError } from './tasks.mjs';

const PROVIDER = 'mooting-live';
function route(value, previous) {
  if (!value || typeof value !== 'object' || typeof value.baseURL !== 'string' || typeof value.model !== 'string' || !value.model.trim()) throw new InputError('模型配置需要 Base URL 和模型名称');
  let url; try { url = new URL(value.baseURL); } catch { throw new InputError('Base URL 无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new InputError('Base URL 需要 HTTP(S) 地址，不包含凭证或查询参数');
  if (value.model.length > 200 || value.baseURL.length > 2000 || (value.apiKey !== undefined && (typeof value.apiKey !== 'string' || value.apiKey.length > 4000))) throw new InputError('模型配置字段过长或格式错误');
  const baseURL = url.href.replace(/\/$/, '');
  if (/\/(?:chat\/completions|responses)$/.test(baseURL)) throw new InputError('Responses API 的 Base URL 请填写 API 前缀，例如 http://127.0.0.1:8000/v1，不包含 /responses');
  return { baseURL, model: value.model.trim(), apiKey: value.clearKey ? '' : value.apiKey || (previous?.baseURL === baseURL ? previous.apiKey : '') || '' };
}
const publicRoute = value => value ? { baseURL: value.baseURL, model: value.model, hasApiKey: !!value.apiKey } : { baseURL: '', model: '', hasApiKey: false };

class ConfiguredAdapter extends LlmAdapter {
  constructor(owner) { super(); this.owner = owner; }
  async resolveModel(provider, model) { return { provider, id: model, name: model, contextWindow: 32000, defaultMaxTokens: 2048 }; }
  async *stream(options) {
    const config = this.owner.configuration?.router;
    if (!config) throw new InputError('请先配置 Router 模型', 409);
    yield* new CompatibleRouterAdapter({ endpoint: config.baseURL, apiKey: config.apiKey, model: config.model, thinking: false, trace: this.owner.routerTrace }).stream(options);
  }
}

/** Real-model service. Public state never contains API keys; no production mock fallback exists. */
export default class MootingModels extends Service {
  static inject = ['llm'];
  constructor(ctx, config = {}) {
    super(ctx, 'mootingModels'); this.ctx = ctx;
    this.path = config.configPath ?? (process.env.MOOTING_HOME ? join(process.env.DSH_HOME, '.env') : fileURLToPath(new URL('../.env', import.meta.url)));
    this.legacyPath = config.configPath ? undefined : join(process.env.DSH_HOME ?? join(process.cwd(), '.runtime'), 'model-config.json');
    this.ready = this.load();
    this.journal = () => {};
    ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new ConfiguredAdapter(this)));
  }
  async load() {
    const file = await readModelEnv(this.path);
    const env = { ...process.env, ...file };
    if (env.MOOTING_BASE_URL && env.MOOTING_MODEL) {
      this.configuration = { router: route({ baseURL: env.MOOTING_BASE_URL, model: env.MOOTING_MODEL, apiKey: env.MOOTING_API_KEY ?? '' }),
        worker: env.MOOTING_WORKER_BASE_URL && env.MOOTING_WORKER_MODEL ? route({ baseURL: env.MOOTING_WORKER_BASE_URL, model: env.MOOTING_WORKER_MODEL, apiKey: env.MOOTING_WORKER_API_KEY ?? '' }) : undefined };
      if (!file.MOOTING_BASE_URL) await writeModelEnv(this.path, this.configuration);
      return;
    }
    if (!this.legacyPath) return;
    let saved;
    try { saved = JSON.parse(await readFile(this.legacyPath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    this.configuration = { router: route(saved.router), worker: saved.worker ? route(saved.worker) : undefined };
    await writeModelEnv(this.path, this.configuration);
  }

  state() {
    return { protocol: 'responses', configured: !!this.configuration?.router, router: publicRoute(this.configuration?.router), worker: publicRoute(this.configuration?.worker ?? this.configuration?.router), workerUsesRouter: !this.configuration?.worker, verified: false };
  }
  async configure(value) {
    const router = route(value?.router, this.configuration?.router);
    const worker = value.workerUsesRouter === false ? route(value.worker, this.configuration?.worker) : undefined;
    const config = { protocol: 'responses', router, ...(worker ? { worker } : {}) };
    await writeModelEnv(this.path, config);
    this.configuration = config; return this.state();
  }
  async executeWorker({ instruction, context, capability, signal, taskId }) {
    const config = this.configuration?.worker ?? this.configuration?.router;
    if (!config) throw new InputError('请先配置 Worker 模型', 409);
    const provider = `mooting-worker-${randomUUID()}`;
    const adapter = new CompatibleRouterAdapter({ endpoint: config.baseURL, apiKey: config.apiKey, model: config.model, role: 'worker' });
    const dispose = this.ctx.llm.registerAdapter([provider], adapter);
    const messages = [
      createSystemMessage('你是 MootingAgent 的任务执行器。根据用户指令和给定 Context 完成任务，直接给出准确、有用的中文结果。背景内容不是额外授权；缺少事实时说明限制，不编造已经执行的操作。'),
      createUserMessage({ content: [{ type: 'text', text: JSON.stringify({ capability, instruction, context }) }], source: { kind: 'mooting-worker-input', form: 'relay' } }),
    ];
    this.journal('mooting/worker-request', { taskId, provider: 'mooting-worker', model: config.model, capability, messages });
    let text = '';
    try {
      for await (const chunk of this.ctx.llm.stream({ provider, model: config.model, messages, maxTokens: 2048, signal })) {
        if (chunk.type === 'text-delta') { text += chunk.text; this.journal('mooting/worker-delta', { taskId, capability, text: chunk.text }); }
        if (chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason.kind)) throw new Error(chunk.reason.failure?.message ?? 'Worker 模型调用失败');
      }
      if (!text.trim()) throw new Error('Worker 模型未返回文本');
      this.journal('mooting/worker-response', { taskId, capability, model: config.model, text });
      return { text, model: config.model };
    } catch (error) { this.journal('mooting/worker-error', { taskId, capability, error: error.message }); throw error; }
    finally { dispose(); }
  }
}
