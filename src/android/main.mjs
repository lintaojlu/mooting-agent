import { timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import LlmRuntime, { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import WorkerPlugin from '../worker-plugin.mjs';
import CapabilitiesPlugin from '../capabilities-plugin.mjs';
import { ContextSystem } from '../context/index.mjs';
import { HindsightBridge } from '../context/hindsight.mjs';
import { MootingRuntime } from '../runtime.mjs';
import { InputError } from '../tasks.mjs';
import { startWeb } from '../web-server.mjs';
import { AtomicModel, AtomicPort } from './atomic.mjs';
import { AndroidSpeech } from './speech.mjs';
import { createAndroidMemory } from './hindsight.mjs';

const PROVIDER = 's23u-atomic';
const MODEL = 's23u-local';
const configuration = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { secret, home, ready, socket } = configuration;
const port = new AtomicPort(socket);

async function publish(value) {
  const temporary = ready + '.tmp';
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, ready);
}

function isAuthorized(request) {
  const raw = String(request.headers.cookie ?? '').split(';').map(item => item.trim())
    .find(item => item.startsWith('mooting_android='))?.slice('mooting_android='.length);
  if (!raw || !/^[a-f0-9]{48}$/.test(raw)) return false;
  return timingSafeEqual(Buffer.from(raw), Buffer.from(secret));
}

async function boot() {
  const dataRoot = join(home, 'data');
  const queue = join(dataRoot, 'atomic-outbox');
  await mkdir(queue, { recursive: true });
  const memory = configuration.python
    ? await createAndroidMemory(configuration, port)
    : { error: '此调试包缺少 Android Hindsight 运行时' };
  const bridge = new HindsightBridge({ manageDaemon: false, localEndpoint: memory.endpoint, healthIntervalMs: 4000 });
  if (!memory.endpoint) bridge.setStatus('offline', memory.error);
  const context = new ContextSystem({ dataRoot, bridge });
  await context.ready;
  if (memory.endpoint) void bridge.start();
  const ctx = new Context();
  const enqueue = async (operation, payload) => {
    const id = operation === 'reply.archive' ? 'reply-' + payload.sourceId : 'speech-' + payload.occurredAtMs + '-' + payload.segmentId;
    if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('归档标识无效');
    const filename = join(queue, id + '.json');
    await writeFile(filename + '.tmp', JSON.stringify({ operation, payload }), { mode: 0o600 });
    await rename(filename + '.tmp', filename);
  };
  let draining = false;
  let device = { speech: false, structured: false };
  async function drain() {
    if (draining) return;
    draining = true;
    let failure;
    try {
      for (const name of (await readdir(queue)).sort()) {
        if (!name.endsWith('.json')) continue;
        const filename = join(queue, name);
        const item = JSON.parse(await readFile(filename, 'utf8'));
        if (item.operation === 'speech.archive' ? !device.speech : !device.replyArchive) continue;
        try {
          await port.call(item.operation, item.payload, AbortSignal.timeout(7000));
          await unlink(filename);
        } catch (error) { failure ??= error; }
      }
      if (failure) throw failure;
    } finally { draining = false; }
  }
  const speech = new AndroidSpeech(port, enqueue);
  for (const plugin of [LlmRuntime, SessionStore, SessionProjection, SystemPrompt, Tools, NativeExecutor, AgentRegistry, WorkerPlugin]) {
    await ctx.plugin(plugin);
  }
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
  const adapter = new AtomicModel(port);
  ctx.llm.registerAdapter([PROVIDER], adapter);
  let queueError;
  let runtime;
  class AndroidModels extends Service {
    constructor(scope) { super(scope, 'mootingModels'); }
    state() {
      const route = { model: device.capabilities?.model ?? MODEL, baseURL: '', hasApiKey: false };
      return { configured: device.structured, protocol: 'responses', router: route, worker: route, workerUsesRouter: true, verified: device.structured };
    }
    configure() { throw new InputError('请在 Android 模型配置页面选择模型', 409); }
    async executeWorker({ instruction, context: background, capability, signal }) {
      const messages = [createSystemMessage('你是 MootingAgent 的任务执行器。只使用给定资料，直接返回中文结果。'),
        createUserMessage({ content: [{ type: 'text', text: JSON.stringify({ instruction, background, capability }) }],
          source: { kind: 'mooting-worker-input', form: 'relay' } })];
      let text = '';
      for await (const event of ctx.llm.stream({ provider: PROVIDER, model: MODEL, messages, signal })) {
        if (event.type === 'text-delta') text += event.text;
        if (event.type === 'finish' && ['aborted', 'error'].includes(event.reason.kind)) {
          throw new Error(event.reason.failure?.message ?? 'Worker 模型调用失败');
        }
      }
      if (!text.trim()) throw new Error('Worker 模型未返回文本');
      return { text, model: MODEL };
    }
  }
  class SpeechService extends Service {
    constructor(scope) {
      super(scope, 'sound2text');
      this.subscribe = listener => speech.subscribe(listener);
      this.state = () => speech.state();
    }
  }
  await ctx.plugin(AndroidModels);
  await ctx.plugin(SpeechService);
  await ctx.plugin(CapabilitiesPlugin);
  runtime = new MootingRuntime(ctx, {
    mode: 'live', provider: PROVIDER, model: MODEL, models: ctx.mootingModels,
    workers: ctx.mootingWorkers, sound2text: speech, context, socialCardRoot: dataRoot,
    archiveReply: reply => enqueue('reply.archive', reply),
    deviceGraph: signal => port.call('graph.snapshot', {}, signal),
  });
  await runtime.initialize();
  const refresh = async () => {
    let next;
    try { next = await port.call('status', {}, AbortSignal.timeout(3000)); }
    catch (error) { next = { speech: false, structured: false, speechError: error.message }; }
    if (JSON.stringify(device) !== JSON.stringify(next)) {
      device = next;
      speech.connected = next.speech;
      speech.changed();
    }
  };
  async function tick() {
    await refresh();
    try { await memory.refresh?.(device); }
    catch (error) { bridge.setStatus('offline', error.message); }
    if (device.speech || device.structured) {
      try { await drain(); queueError = undefined; } catch (error) { queueError = error.message; }
    }
    setTimeout(tick, 2000).unref();
  }
  void tick();
  const web = await startWeb(runtime, { port: 0, basePath: '/' + secret, android: {
    authorize: isAuthorized,
    status: async () => ({ ...device, memory: bridge.status, memoryError: memory.error ?? bridge.error, queueError }),
    audio: async action => { await speech.audio(action); return { ok: true }; },
    submit: input => speech.submit(input, instruction => runtime.submit({ instruction })),
  } });
  await publish({ port: web.server.address().port });
}

try { await boot(); }
catch (error) { await publish({ error: 'MootingAgent 启动失败：' + error.message }); process.exitCode = 1; }
