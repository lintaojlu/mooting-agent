import { Service } from '@deepseek-ai/cordis';
import { registerCapabilities } from './capabilities.mjs';

/** Register real model workers and the sound2text subtitle subscriber. */
export default class MootingCapabilities extends Service {
  static inject = ['mootingWorkers', 'mootingModels', 'sound2text'];
  constructor(ctx, config = {}) {
    super(ctx, 'mootingCapabilities');
    ctx.effect(() => registerCapabilities(ctx.mootingWorkers.manager, {
      sound2text: ctx.sound2text,
      runModel: request => ctx.mootingModels.executeWorker(request),
    }));
  }
}
