import { registerCapabilities } from '../src/capabilities.mjs';
import { FakeSound2text } from './fake-sound2text.mjs';

/** Explicit test-only fixture. Production plugins never register these fake business results. */
export function registerMockCapabilities(manager, { frameIntervalMs = 1200 } = {}) {
  return registerCapabilities(manager, {
    sound2text: new FakeSound2text(),
    runModel: async ({ instruction, capability }) => ({ text: `[测试模型 ${capability}] ${instruction}`, model: 'test-fixture' }),
  });
}
