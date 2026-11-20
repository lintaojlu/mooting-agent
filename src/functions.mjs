import { log, timed } from './log/index.mjs';
import { subtitleText } from './capabilities.mjs';
import { InputError } from './tasks.mjs';

export const SPEAKER_PERSON = Object.freeze({
  name: 'John',
  identity: '空间折叠负责人；AI创业者',
  notes: Object.freeze([
    '上次聊过如何构建高时效性的AgentOS。',
    '对于新AI终端的出现坚定不移。',
    '创立了一家人文科技公司“空间折叠”。',
  ]),
});

const SAY = {
  subtitle: '实时字幕已开启。',
  speaker: `面前是${SPEAKER_PERSON.name}，${SPEAKER_PERSON.identity}。`,
  subtitleClosed: '实时字幕已关闭。',
  speakerClosed: '说话人识别已关闭。',
};

/** One on-screen function. Tools change it; frames never wake the router. */
export class FunctionPanel {
  constructor({ sound2text, onChange = () => {} } = {}) {
    this.sound2text = sound2text;
    this.onChange = onChange;
    this.subtitle = { active: false, text: '' };
    this.speaker = { active: false, person: null };
    this.active = null;
    this.handle = null;
    this.generation = 0;
    this.tail = Promise.resolve();
  }
  enqueue(op) {
    const job = this.tail.then(op, op);
    this.tail = job.then(() => {}, () => {});
    return job;
  }
  shownSay() {
    if (this.active === 'subtitle') return SAY.subtitle;
    if (this.active === 'speaker') return SAY.speaker;
    return '';
  }
  person() { return this.speaker.person ? structuredClone(this.speaker.person) : null; }
  open(kind, signal) {
    const generation = this.generation;
    return timed('function.open', () => this.enqueue(() => this.openNow(kind, signal, generation)), { kind }, {
      result: value => value.cancelled ? 'cancelled' : value.opened ? 'ok' : 'rejected',
    });
  }
  close(kind) {
    return this.enqueue(() => this.closeNow(kind));
  }
  cancelled(kind) {
    return { opened: false, cancelled: true, active: this.active, say: this.shownSay() || (kind === 'subtitle' ? SAY.subtitleClosed : SAY.speakerClosed) };
  }
  async openNow(kind, signal, generation) {
    if (signal?.aborted || this.generation !== generation) return this.cancelled(kind);
    if (this.active && this.active !== kind) {
      const close_first = this.active === 'subtitle' ? 'close_subtitle' : 'close_speaker';
      return { opened: false, active: this.active, close_first, error: this.active === 'subtitle' ? '实时字幕开着，请先调用 close_subtitle。' : '说话人识别开着，请先调用 close_speaker。' };
    }
    if (this.active === kind) return { opened: true, already: true, function: kind, say: this.shownSay(), ...(kind === 'speaker' ? { person: this.person() } : { text: this.subtitle.text }) };
    if (kind === 'subtitle' && this.sound2text?.state().status !== 'running') return { opened: false, error: '语音输入未开启，请先开启语音输入。' };
    if (signal?.aborted || this.generation !== generation) return this.cancelled(kind);
    if (kind === 'subtitle') this.beginSubtitle(signal, generation);
    else this.beginSpeaker(generation);
    if (signal?.aborted || this.generation !== generation) {
      this.rollback(generation);
      return this.cancelled(kind);
    }
    return { opened: true, already: false, function: kind, say: this.shownSay(), ...(kind === 'speaker' ? { person: this.person() } : { text: this.subtitle.text }) };
  }
  beginSubtitle(signal, generation) {
    const boundaryMs = this.sound2text.state().audioMs;
    let stopped = false;
    let unsubscribe;
    const dispose = () => { stopped = true; unsubscribe?.(); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { if (this.generation === generation) this.rollback(generation); };
    const publish = text => {
      if (stopped || this.generation !== generation || this.active !== 'subtitle') return;
      this.subtitle = { active: true, text };
      this.onChange();
    };
    unsubscribe = this.sound2text.subscribe(value => {
      if (stopped || this.generation !== generation) return;
      if (value.status !== 'running') { this.closeShown(); return; }
      publish(subtitleText(value.utterances, boundaryMs));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    this.handle = { dispose };
    this.active = 'subtitle';
    this.subtitle = { active: true, text: '' };
    this.speaker = { active: false, person: null };
    this.onChange();
    publish(subtitleText(this.sound2text.state().utterances, boundaryMs));
  }
  beginSpeaker(generation) {
    if (this.generation !== generation) return;
    this.handle = { dispose() {} };
    this.active = 'speaker';
    this.subtitle = { active: false, text: '' };
    this.speaker = { active: true, person: structuredClone(SPEAKER_PERSON) };
    this.onChange();
  }
  closeNow(kind) {
    if (this.active !== kind) return { closed: true, already: true, active: this.active, say: this.shownSay() || (kind === 'subtitle' ? SAY.subtitleClosed : SAY.speakerClosed) };
    this.clear();
    return { closed: true, already: false, active: null, say: kind === 'subtitle' ? SAY.subtitleClosed : SAY.speakerClosed };
  }
  /** Button and Esc. Does not start a router turn. Bumps generation even when the panel is empty, so an open that has not returned cannot show afterwards. */
  closeShown() {
    if (!this.active) { this.generation++; return { stopped: false }; }
    this.clear();
    return { stopped: true };
  }
  clear() {
    log('info', 'function.closed', { kind: this.active });
    this.generation++;
    const handle = this.handle;
    this.handle = null;
    this.active = null;
    this.subtitle = { active: false, text: '' };
    this.speaker = { active: false, person: null };
    handle?.dispose?.();
    this.onChange();
  }
  rollback(generation) {
    if (this.generation !== generation || !this.active) return;
    this.clear();
  }
  frame(text) {
    if (typeof text !== 'string' || text.length > 2000 || !text.trim()) throw new InputError('字幕帧需要 1–2000 字符');
    if (this.active !== 'subtitle') throw new InputError('当前没有字幕任务', 409);
    this.subtitle = { active: true, text };
    this.onChange();
  }
  async idle() { await this.tail; }
  async dispose() { this.closeShown(); await this.idle(); }
}
