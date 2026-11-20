import { resolveDataRoot } from '../log/index.mjs';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Service } from '@deepseek-ai/cordis';
import { ACCOUNTS } from '../access.mjs';
import { ContextSystem } from './index.mjs';
import { HindsightBridge, consoleLogger } from './hindsight.mjs';

/** The retired whole-document memory files. Hindsight replaces them; they are deleted, not imported. */
async function removeLegacyMemory(dataRoot) {
  await rm(join(dataRoot, 'MEMORY.md'), { force: true });
  for (const account of ACCOUNTS) await rm(join(dataRoot, account, 'MEMORY.md'), { force: true });
}

/**
 * Cordis-owned memory lifecycle: the Hindsight daemon bridge and the ContextSystem built on it.
 * Public service `mootingContext`; consumers read `.context` (hot path, tools) and `.bridge` (daemon status).
 * Disposal order (context flush, then daemon stop) is owned here, after every dependent plugin has been disposed.
 */
export default class MootingContext extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'mootingContext');
    this.envPath = config.envPath ?? (process.env.MOOTING_HOME ? join(process.env.DSH_HOME ?? process.env.MOOTING_HOME, '.env') : fileURLToPath(new URL('../../.env', import.meta.url)));
    this.dataRoot = config.dataRoot ?? resolveDataRoot();
    // Hindsight starts in the background: a first start downloads the Python env and local models.
    this.bridge = new HindsightBridge({ envPath: this.envPath, logger: config.logger ?? consoleLogger });
    this.context = new ContextSystem({ dataRoot: this.dataRoot, bridge: this.bridge });
    // Ownership is registered in the constructor so a later startup failure cannot leak the daemon.
    ctx.effect(() => async () => {
      let failure;
      for (const close of [() => this.context.dispose(), () => this.bridge.stop()]) {
        try { await close(); } catch (error) { failure ??= error; }
      }
      if (failure) throw failure;
    });
    this.ready = removeLegacyMemory(this.dataRoot).then(() => this.context.ready).then(() => { this.bridge.start(); });
  }
}
