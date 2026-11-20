import { configureLogging, createTrace, log, resolveDataRoot } from './index.mjs';

export const name = 'mooting-log';

export function apply(ctx) {
  const close = configureLogging({ dataRoot: resolveDataRoot(), level: process.env.MOOTING_LOG_LEVEL });
  const trace = createTrace('system');
  log('info', 'system.starting', {}, trace);
  ctx.effect(() => async () => {
    log('info', 'system.stopped', {}, trace);
    await close();
  });
}
