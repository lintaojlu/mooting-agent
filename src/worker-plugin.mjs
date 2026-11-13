import { Service } from '@deepseek-ai/cordis';
import { EventEmitter } from 'node:events';
import { TaskManager } from './tasks.mjs';

/** Session-free worker service. Reversible capability registration is owned by capability plugins. */
export default class MootingWorkers extends Service {
  constructor(ctx) {
    super(ctx, 'mootingWorkers');
    this.events = new EventEmitter();
    this.manager = new TaskManager({
      emit: (type, data, taskId) => this.events.emit('worker-event', { type, data, taskId }),
      subtitle: value => this.events.emit('subtitle', value),
      speaker: value => this.events.emit('speaker', value),
    });
    ctx.effect(() => async () => { await this.manager.dispose(); this.events.removeAllListeners(); });
  }
}
