import { MootingRuntime } from './runtime.mjs';
import { startWeb } from './web-server.mjs';
import { normalizeBase, publicHostList, ACCOUNTS } from './access.mjs';
import { UserHomes } from './user-homes.mjs';

export const name = 'mooting-agent-demo';
export const inject = ['agents', 'agentLoop', 'llm', 'tools', 'systemPrompt', 'mootingWorkers', 'mootingCapabilities', 'mootingModels', 'mootingContext', 'sound2text'];

/** Loaded exclusively through the DSH profile Loader. */
export async function apply(ctx, config = {}) {
  if (process.env.MOOTING_MODE === 'mock') throw new Error('生产原型不支持模拟模型，请在页面配置真实模型。Mock 仅限自动化测试。');
  await ctx.mootingModels.ready;
  await ctx.sound2text.ready;
  await ctx.mootingContext.ready;
  const { dataRoot, context, bridge } = ctx.mootingContext;
  const port = Number(process.env.MOOTING_PORT ?? config.port ?? 4317);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('MOOTING_PORT 必须为 0–65535 整数');
  const basePath = normalizeBase(process.env.MOOTING_BASE_PATH ?? config.basePath ?? '');
  const publicHosts = publicHostList(process.env.MOOTING_PUBLIC_HOSTS ?? '');
  const auth = process.env.MOOTING_AUTH !== '0';
  let homes, runtime;
  // Memory (Hindsight daemon + ContextSystem) is owned by the mooting-context plugin; this plugin owns only what it builds.
  ctx.effect(() => async () => {
    let failure;
    for (const close of [() => runtime?.dispose(), () => homes?.dispose()]) {
      try { await close(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  });
  homes = auth ? new UserHomes({ dataRoot, accounts: ACCOUNTS, context }) : null;
  if (homes) await homes.open();
  const settings = ctx.mootingModels.state();
  runtime = new MootingRuntime(ctx, { mode: settings.configured ? 'live' : 'unconfigured', provider: 'mooting-live', model: settings.router.model || 'unconfigured', workers: ctx.mootingWorkers, models: ctx.mootingModels, sound2text: ctx.sound2text, context, homes });
  await runtime.initialize();
  const web = await startWeb(runtime, { port, basePath, publicHosts, auth });
  ctx.effect(() => async () => web.close());
  const publicURL = publicHosts[0] ? `https://${publicHosts[0]}${basePath}/` : web.url;
  console.log(`MOOTING_READY ${JSON.stringify({ url: web.url, publicURL, sessionId: 'mooting-main', mode: runtime.mode, auth, memory: bridge.status })}`);
}
