import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { InputError } from '../tasks.mjs';
import { speakerLine } from '../sound2text/speaker-label.mjs';

const timeout = (callback, ms) => setTimeout(callback, ms).unref();

export class AndroidSpeech {
  events = new EventEmitter();
  utterances = [];
  segments = new Map();
  capture = { status: 'idle' };
  connected = false;
  status = 'stopped';
  started = 0;
  constructor(port, enqueue) { this.port = port; this.enqueue = enqueue; }
  state() {
    return { configured: this.connected, status: this.status, utterances: structuredClone(this.utterances),
      text: this.utterances.map(u => speakerLine(u.speaker, u.text)).join('\n').slice(-32000),
      capture: { ...this.capture }, ...(this.error ? { error: this.error } : {}) };
  }
  changed() { this.events.emit('change', this.state()); }
  subscribe(listener) { this.events.on('change', listener); return () => this.events.off('change', listener); }
  async start() {
    if (this.status !== 'stopped') return;
    this.status = 'starting'; this.error = undefined; this.changed();
    try {
      await this.port.call('audio.start', {}, AbortSignal.timeout(65_000));
      this.started = Date.now();
      this.utterances = []; this.segments.clear();
      this.status = 'running'; this.changed();
      this.schedule();
    } catch (error) { this.status = 'stopped'; this.changed(); throw error; }
  }
  async pause() {
    if (this.status !== 'running') return;
    this.status = 'stopping';
    clearTimeout(this.timer);
    this.changed();
    try {
      const result = await this.port.call('audio.stop', {}, AbortSignal.timeout(20_000));
      for (const event of result.events) this.ingest(event);
    } finally {
      this.flush({ force: true });
      this.stop();
    }
  }
  stop(error) {
    clearTimeout(this.timer);
    this.status = 'stopped';
    this.error = error;
    this.resetCapture();
    this.changed();
  }
  schedule() { this.timer = timeout(() => void this.poll(), 100); }
  async poll() {
    if (this.status !== 'running') return;
    try {
      const result = await this.port.call('audio.poll', {}, AbortSignal.timeout(4000));
      if (!['running', 'stopping'].includes(this.status)) return;
      for (const event of result.events) this.ingest(event);
      this.flush();
      if (this.status !== 'running') return;
      if (result.running) this.schedule();
      else this.stop(result.error);
    } catch (error) { this.stop(error.message); }
  }
  ingest(event) {
    if (!['asr', 'vpr'].includes(event.type) || !Number.isInteger(event.segment_id) || event.segment_id < 0) return;
    if (this.utterances.some(value => value.segmentId === event.segment_id)) return;
    if (event.type === 'asr' && (event.ok === false || !String(event.text ?? '').trim())) return;
    const item = this.segments.get(event.segment_id) ?? { received: Date.now() };
    item[event.type] = event;
    this.segments.set(event.segment_id, item);
    if (this.segments.size > 100) this.segments.delete(this.segments.keys().next().value);
  }
  flush({ force = false } = {}) {
    let updated = false;
    for (const [segmentId, item] of this.segments) {
      if (!item.asr || (!force && !item.vpr && Date.now() - item.received < 1200)) continue;
      this.segments.delete(segmentId);
      const { asr, vpr } = item;
      const text = asr.text.trim().slice(0, 12000);
      const start = Math.round(Number(asr.start_seconds) * 1000);
      const end = Math.round(Number(asr.end_seconds) * 1000);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      const speakerId = vpr?.known === true && vpr.speaker_id ? vpr.speaker_id : 'unknown';
      this.utterances.push({ text, speaker: vpr?.known ? vpr.display_name || speakerId : '未知说话人',
        speakerKey: speakerId === 'unknown' ? '' : speakerId, start_time: start, end_time: end,
        occurredAtMs: Math.max(1, this.started + start), segmentId, definite: true, words: [] });
      this.utterances.sort((left, right) => left.start_time - right.start_time);
      this.utterances = this.utterances.slice(-200);
      void this.enqueue('speech.archive', { speakerId, text, occurredAtMs: Math.max(1, this.started + start), segmentId })
        .catch(error => { this.error = error.message; this.changed(); });
      updated = true;
    }
    if (updated) {
      this.events.emit('text', { utterances: structuredClone(this.utterances) });
      this.changed();
    }
    if (this.capture.status === 'finishing') this.finishPreview();
  }
  audio(action) {
    if (action === 'start') return this.start();
    if (action === 'stop') return this.pause();
    if (action === 'arm') {
      if (this.status !== 'running') throw new InputError('请先开启语音输入', 409);
      if (this.capture.status !== 'idle' || this.capture.review) throw new InputError('已有待处理的语音指令', 409);
      const id = randomUUID();
      this.capture = { status: 'listening', id, boundaryMs: Date.now() - this.started };
      this.captureTimer = timeout(() => this.audio('review'), 60_000);
      this.changed();
      return;
    }
    if (action === 'review') {
      if (this.capture.status !== 'listening') throw new InputError('请先开始收集指令', 409);
      clearTimeout(this.captureTimer);
      this.capture = { ...this.capture, status: 'finishing', cutoffMs: Date.now() - this.started, deadline: Date.now() + 3000 };
      this.changed();
      return;
    }
    if (action === 'discard') { this.resetCapture(); this.changed(); return; }
    throw new InputError('无效语音操作');
  }
  resetCapture() { clearTimeout(this.captureTimer); this.capture = { status: 'idle' }; }
  async submit({ id, instruction }, submit) {
    if (!id || this.capture.id !== id || !this.capture.review) throw new InputError('这条语音指令已提交或已取消', 409);
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 2000) throw new InputError('请输入有效的语音指令', 400);
    const previous = this.capture;
    this.resetCapture();
    this.changed();
    try { return await submit(instruction); }
    catch (error) {
      if (this.capture.status === 'idle' && !this.capture.id) this.capture = previous;
      this.changed();
      throw error;
    }
  }
  finishPreview() {
    if (Date.now() < this.capture.deadline) return;
    const text = this.utterances.filter(utterance => utterance.end_time > this.capture.boundaryMs &&
      utterance.start_time < this.capture.cutoffMs).map(utterance => utterance.text).join(' ').slice(0, 2000);
    this.capture = { status: 'idle', id: this.capture.id, ...(text ? { review: text } : { error: '本次没有可确认的定稿' }) };
    this.changed();
  }
}
