import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MootingRuntime } from './runtime.mjs';
import { startWeb } from './web-server.mjs';
import { normalizeBase, publicHostList, ACCOUNTS } from './access.mjs';
import { ContextSystem } from './context.mjs';
import { UserHomes } from './user-homes.mjs';

export const name = 'mooting-agent-demo';
export const inject = ['agents', 'agentLoop', 'llm', 'tools', 'systemPrompt', 'mootingWorkers', 'mootingCapabilities', 'mootingModels', 'sound2text'];
/** Loaded exclusively through the DSH profile Loader. */
export async function apply(ctx, config = {}) {
  if (process.env.MOOTING_MODE === 'mock') throw new Error('生产原型不支持模拟模型，请在页面配置真实模型。Mock 仅限自动化测试。');
  await ctx.mootingModels.ready;
  await ctx.sound2text.ready;
  const envPath = process.env.MOOTING_HOME ? join(process.env.DSH_HOME ?? process.env.MOOTING_HOME, '.env') : fileURLToPath(new URL('../.env', import.meta.url));
  const dataRoot = fileURLToPath(new URL('../data/', import.meta.url));
  const port = Number(process.env.MOOTING_PORT ?? config.port ?? 4317);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('MOOTING_PORT 必须为 0–65535 整数');
  const basePath = normalizeBase(process.env.MOOTING_BASE_PATH ?? config.basePath ?? '');
  const publicHosts = publicHostList(process.env.MOOTING_PUBLIC_HOSTS ?? '');
  const auth = process.env.MOOTING_AUTH === '0' ? false : process.env.MOOTING_AUTH === '1' || publicHosts.length > 0;
  const homes = auth ? new UserHomes({ dataRoot, accounts: ACCOUNTS, envPath }) : null;
  const context = homes ? null : new ContextSystem({ envPath, memoryPath: join(dataRoot, 'MEMORY.md') });
  if (homes) await homes.open(); else await context.ready;
  const settings = ctx.mootingModels.state();
  const runtime = new MootingRuntime(ctx, { mode: settings.configured ? 'live' : 'unconfigured', provider: 'mooting-live', model: settings.router.model || 'unconfigured', workers: ctx.mootingWorkers, models: ctx.mootingModels, sound2text: ctx.sound2text, context, homes });
  ctx.effect(() => async () => { await runtime.dispose(); await homes?.dispose(); await context?.dispose(); });
  await runtime.initialize();
  const web = await startWeb(runtime, { port, basePath, publicHosts, auth });
  ctx.effect(() => async () => web.close());
  const publicURL = publicHosts[0] ? `https://${publicHosts[0]}${basePath}/` : web.url;
  console.log(`MOOTING_READY ${JSON.stringify({ url: web.url, publicURL, sessionId: 'mooting-main', mode: runtime.mode, auth })}`);
}
