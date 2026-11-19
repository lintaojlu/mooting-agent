import { fileURLToPath } from 'node:url';
import { HindsightBridge, consoleLogger } from '../src/context/hindsight.mjs';

/** Shared settings for tests that talk to a real hindsight-embed daemon (profile mooting-test, port 9078). */
export const TEST_PROFILE = 'mooting-test';
export const TEST_PORT = 9078;
export const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));

export function testBridge({ bank, ...options } = {}) {
  return new HindsightBridge({
    envPath: ENV_PATH, profile: TEST_PROFILE, port: TEST_PORT,
    bank: bank ?? `mooting-test-${process.pid}-${Date.now().toString(36)}`,
    mentalModelTrigger: { minRefreshIntervalSeconds: 0 },
    logger: process.env.MOOTING_TEST_VERBOSE ? consoleLogger : undefined,
    ...options,
  });
}

/** Run directly to warm up (download Python env and local models) and leave the test daemon running. */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bridge = testBridge({ bank: 'mooting-warmup', logger: consoleLogger });
  const started = Date.now();
  await bridge.start();
  console.log(JSON.stringify({ status: bridge.status, error: bridge.error, seconds: Math.round((Date.now() - started) / 1000) }));
  if (bridge.ready) await bridge.deleteBank().catch(() => {});
  bridge.stopped = true; clearInterval(bridge.timer);
  if (process.argv.includes('--stop')) await bridge.server.stop();
}
