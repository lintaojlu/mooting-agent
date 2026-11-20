import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import MootingContext from '../src/context/plugin.mjs';
import { ContextSystem } from '../src/context/index.mjs';
import { HindsightBridge, quietLogger } from '../src/context/hindsight.mjs';

const exists = path => access(path).then(() => true, () => false);

async function mount() {
  const root = await mkdtemp(join(tmpdir(), 'mooting-context-plugin-'));
  const envPath = join(root, '.env');
  await writeFile(envPath, 'MOOTING_HINDSIGHT_ENABLED=0\n');
  const dataRoot = join(root, 'data');
  await mkdir(dataRoot, { recursive: true });
  const ctx = new Context();
  await ctx.plugin(MootingContext, { envPath, dataRoot, logger: quietLogger });
  return { ctx, dataRoot };
}

test('mooting-context plugin exposes the memory service and removes retired MEMORY.md', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mooting-context-legacy-'));
  const dataRoot = join(root, 'data');
  await mkdir(dataRoot, { recursive: true });
  await writeFile(join(dataRoot, 'MEMORY.md'), 'legacy');
  await writeFile(join(root, '.env'), 'MOOTING_HINDSIGHT_ENABLED=0\n');
  const ctx = new Context();
  await ctx.plugin(MootingContext, { envPath: join(root, '.env'), dataRoot, logger: quietLogger });
  await ctx.mootingContext.ready;
  assert.ok(ctx.mootingContext.context instanceof ContextSystem);
  assert.ok(ctx.mootingContext.bridge instanceof HindsightBridge);
  assert.equal(ctx.mootingContext.dataRoot, dataRoot);
  assert.equal(await exists(join(dataRoot, 'MEMORY.md')), false);
  await ctx.fiber.dispose();
});

test('disabled memory leaves the bridge disabled and disposal closes the context', async () => {
  const { ctx } = await mount();
  await ctx.mootingContext.ready;
  await ctx.mootingContext.bridge.start();
  assert.equal(ctx.mootingContext.bridge.status, 'disabled');
  const { context, bridge } = ctx.mootingContext;
  await ctx.fiber.dispose();
  assert.equal(context.closed, true);
  assert.equal(bridge.stopped, true);
});
