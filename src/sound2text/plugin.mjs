import { Service } from '@deepseek-ai/cordis';
import { Sound2Text } from './service.mjs';

/** Cordis-owned ASR lifecycle. Public service delegates to the independently testable engine. */
export default class Sound2TextPlugin extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'sound2text');
    this.engine = new Sound2Text({ configPath: config.configPath });
    this.events = this.engine.events;
    this.ready = this.engine.ready;
    ctx.effect(() => async () => this.engine.dispose());
  }
  state() { return this.engine.state(); }
  start(owner) { return this.engine.start(owner); }
  pushAudio(buffer) { return this.engine.pushAudio(buffer); }
  pause(reason) { return this.engine.pause(reason); }
  subscribe(listener) { return this.engine.subscribe(listener); }
  armCapture(boundaryMs) { return this.engine.armCapture(boundaryMs); }
  finishCapture(reason, boundaryMs) { return this.engine.finishCapture(reason, boundaryMs); }
  cancelCapture(reason) { return this.engine.cancelCapture(reason); }
}
