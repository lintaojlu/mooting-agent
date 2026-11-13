import { Context, Service } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { MockRouterAdapter } from './mock-router-adapter.mjs';
import { MootingRuntime } from '../src/runtime.mjs';
import WorkerPlugin from '../src/worker-plugin.mjs';
import CapabilitiesPlugin from '../src/capabilities-plugin.mjs';
import ModelsPlugin from '../src/models-plugin.mjs';
import { FakeSound2text } from './fake-sound2text.mjs';

/** Test-only mounting. The application itself always starts via a DSH profile. */
export async function harness({ adapter = new MockRouterAdapter(), mode = 'mock', realModels = false, configPath, runWorker, sound2text = new FakeSound2text(), context, homes } = {}) {
  const ctx = new Context();
  for (const plugin of [LlmRuntime, SessionStore, SessionProjection, SystemPrompt, Tools, NativeExecutor, AgentRegistry]) await ctx.plugin(plugin);
  await ctx.plugin(AgentLoop, { agents: [] });
  if (realModels) { await ctx.plugin(ModelsPlugin, { configPath }); await ctx.mootingModels.ready; }
  else {
    ctx.llm.registerAdapter(['mooting-mock'], adapter);
    class TestModels extends Service { constructor(scope) { super(scope, 'mootingModels'); this.executeWorker = runWorker ?? (async ({ instruction }) => ({ text: `[测试模型] ${instruction}`, model: 'test-fixture' })); } }
    await ctx.plugin(TestModels);
  }
  class TestSound2text extends Service { constructor(scope) { super(scope, 'sound2text'); this.state = () => sound2text.state(); this.subscribe = listener => sound2text.subscribe(listener); } }
  await ctx.plugin(TestSound2text);
  await ctx.plugin(WorkerPlugin);
  await ctx.plugin(CapabilitiesPlugin, { frameIntervalMs: 20 });
  const config = realModels ? ctx.mootingModels.state() : undefined;
  const runtime = new MootingRuntime(ctx, { mode: realModels ? config.configured ? 'live' : 'unconfigured' : mode,
    provider: realModels ? 'mooting-live' : 'mooting-mock', model: realModels ? config.router.model || 'unconfigured' : 'scripted-router',
    workers: ctx.mootingWorkers, sound2text, context, homes, ...(realModels ? { models: ctx.mootingModels } : {}) });
  await runtime.initialize();
  return { ctx, runtime, async dispose() { await runtime.dispose(); await ctx.fiber.dispose(); } };
}
