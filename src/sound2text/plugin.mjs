import { Service } from '@deepseek-ai/cordis';
import { Sound2Text } from './service.mjs';
import { VoiceprintDirectory, VOICEPRINT_LIMIT, assertRegistrationAudio } from './voiceprints.mjs';

/** Cordis-owned ASR lifecycle. Public service delegates to the independently testable engine. */
export default class Sound2TextPlugin extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'sound2text');
    this.engine = new Sound2Text({ configPath: config.configPath, loadVoiceprints: () => this.matchIds() });
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
  voiceprints() {
    const apiKey = this.engine.config?.apiKey;
    if (!apiKey) throw Object.assign(new Error('请先填写 SOUND2TEXT_API_KEY'), { status: 409 });
    return new VoiceprintDirectory({ apiKey });
  }
  enrollmentClip(startMs, endMs) { return this.engine.enrollmentClip(startMs, endMs); }
  voiceEndMs() { return this.engine.voiceEndMs(); }
  /** Register a saved speaker from kept PCM. The hosted URL is supplied by the web layer. */
  async registerFromPcm(name, clip, { audioUrl } = {}) {
    assertRegistrationAudio(clip, 'card.pcm');
    if (!audioUrl) throw Object.assign(new Error('声纹注册需要可下载的音频地址'), { status: 409 });
    return this.voiceprints().register({ name, audioUrl });
  }
  async matchIds() {
    const items = await this.voiceprints().listAll();
    return items.slice(0, VOICEPRINT_LIMIT).map(item => item.id);
  }
}
