import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import WebSocket from 'ws';
import { AUDIO_BYTES_PER_MS, AUDIO_PACKET_BYTES, encodeRequest, decodeResponse, createInitPayload } from './protocol.mjs';
import { readSpeakerId, speakerLabel, speakerLine } from './speaker-label.mjs';

export const DEFAULT_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
function number(value, fallback, min, max, name) { const n = value === undefined || value === '' ? fallback : Number(value); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`sound2text ${name} 配置无效`); return n; }
export async function loadConfig(path = process.env.MOOTING_HOME ? join(process.env.DSH_HOME ?? process.env.MOOTING_HOME, '.env') : fileURLToPath(new URL('../../.env', import.meta.url))) {
  let saved = {}; try { saved = parseEnv(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const env = { ...process.env, ...saved };
  return { apiKey: env.SOUND2TEXT_API_KEY ?? '', resourceId: env.SOUND2TEXT_RESOURCE_ID ?? '', url: env.SOUND2TEXT_WS_URL || DEFAULT_URL,
    endWindowMs: number(env.SOUND2TEXT_END_WINDOW_MS, 800, 300, 5000, 'END_WINDOW_MS'), silenceMs: number(env.SOUND2TEXT_COMMAND_SILENCE_MS, 1500, 300, 10000, 'COMMAND_SILENCE_MS'),
    noSpeechMs: number(env.SOUND2TEXT_NO_SPEECH_MS, 10000, 100, 120000, 'NO_SPEECH_MS'), maxCommandMs: number(env.SOUND2TEXT_MAX_COMMAND_MS, 60000, 1000, 300000, 'MAX_COMMAND_MS'), finalWaitMs: number(env.SOUND2TEXT_FINAL_WAIT_MS, 3000, 100, 30000, 'FINAL_WAIT_MS') };
}

/** Shared ASR stream and server-authoritative command capture. No credential enters public state. */
export class Sound2Text {
  constructor({ config, configPath, WebSocketImpl = WebSocket, now = () => Date.now(), rmsThreshold = .012, loadVoiceprints } = {}) {
    this.events = new EventEmitter(); this.events.on('error', () => {});
    this.WebSocketImpl = WebSocketImpl; this.now = now; this.rmsThreshold = rmsThreshold;
    this.status = 'stopped'; this.text = ''; this.utterances = []; this.audioMs = 0; this.pending = Buffer.alloc(0); this.recentAudio = []; this.capture = { status: 'idle' }; this.owner = null;
    this.loadVoiceprints = loadVoiceprints; this.voiceprintNotice = '';
    this.reloadConfig = config === undefined ? () => loadConfig(configPath) : undefined;
    this.ready = Promise.resolve(config ?? loadConfig(configPath)).then(value => { this.config = { endWindowMs: 800, silenceMs: 1500, noSpeechMs: 10000, maxCommandMs: 60000, finalWaitMs: 3000, url: DEFAULT_URL, ...value }; return this; });
  }
  state() { return { configured: !!(this.config?.apiKey && this.config?.resourceId), resourceId: this.config?.resourceId || '', endpoint: this.config?.url || '', status: this.status, text: this.text, utterances: structuredClone(this.utterances), audioMs: this.audioMs, capture: { ...this.capture }, ...(this.voiceprintNotice ? { voiceprintNotice: this.voiceprintNotice } : {}), ...(this.error ? { error: this.error } : {}) }; }
  changed() { this.events.emit('change', this.state()); }
  subscribe(listener) { this.events.on('change', listener); return () => this.events.off('change', listener); }
  fail(error) {
    const message = error instanceof Error ? error.message : String(error);
    this.error = message; this.status = 'error'; this.cancelCapture('识别连接异常，指令已中止'); this.pending = Buffer.alloc(0);
    this.events.emit('error', { error: message }); this.changed(); this.initialReject?.(new Error(message)); this.owner = null; this.socket?.terminate();
  }
  async start(owner) {
    await this.ready;
    if (this.owner && owner && this.owner !== owner) throw new Error('语音输入已由其他页面占用');
    if (this.status === 'running') return this.state();
    if (this.status === 'connecting' || this.status === 'stopping') throw new Error('语音服务正在切换状态');
    if (this.reloadConfig) this.config = await this.reloadConfig();
    if (!this.state().configured) { this.error = '请先填写 SOUND2TEXT_API_KEY 和 SOUND2TEXT_RESOURCE_ID'; this.changed(); throw new Error(this.error); }
    const url = new URL(this.config.url); if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('sound2text WS_URL 无效');
    this.voiceprintNotice = '';
    let voiceprints = [];
    if (this.loadVoiceprints) {
      try {
        const loaded = await Promise.race([Promise.resolve(this.loadVoiceprints()), new Promise((_, reject) => setTimeout(() => reject(new Error('声纹库超时')), 8000))]);
        voiceprints = Array.isArray(loaded) ? loaded : [];
      } catch { this.voiceprintNotice = '这次没有声纹匹配'; voiceprints = []; }
    }
    this.owner = owner ?? this.owner; this.error = undefined; this.status = 'connecting'; this.text = ''; this.utterances = []; this.audioMs = 0; this.pending = Buffer.alloc(0); this.recentAudio = []; this.sequence = 1; this.changed();
    const socket = this.socket = new this.WebSocketImpl(this.config.url, { headers: { 'X-Api-Key': this.config.apiKey, 'X-Api-Resource-Id': this.config.resourceId, 'X-Api-Request-Id': randomUUID() }, maxPayload: 2 * 1024 * 1024, handshakeTimeout: 10000 });
    socket.on('message', (data, binary) => { if (this.socket !== socket) return; try { if (!binary) throw new Error('ASR 返回非二进制消息'); const packet = decodeResponse(data); if (packet.code) throw new Error(`ASR 服务错误 ${packet.code}`); if (packet.data?.code && packet.data.code !== 20000000 && packet.data.code !== 1000) throw new Error(`ASR 服务错误 ${packet.data.code}`); this.initialResolve?.(); this.handleResult(packet.data); if (packet.terminal) { this.terminalResolve?.(); if (this.status === 'running') this.fail(new Error('ASR 流已结束，请重新开启语音输入')); } } catch (error) { this.fail(error); } });
    socket.on('error', error => { if (this.socket === socket && this.status !== 'error') {
      const detail = String(error.message ?? '连接失败').split(this.config.apiKey).join('[REDACTED]').slice(0, 240);
      this.fail(new Error(`ASR 连接失败${error.code ? `（${error.code}）` : ''}：${detail}`));
    } });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      const status = response.statusCode;
      const hint = [401, 403].includes(status) ? '请检查 API Key、资源 ID 和服务授权' : status === 429 ? '请求或并发额度受限' : '服务拒绝 WebSocket 握手';
      this.fail(new Error(`ASR 握手失败（HTTP ${status}）：${hint}`));
    });
    socket.on('close', () => { if (this.socket === socket && !['stopping', 'stopped', 'error'].includes(this.status)) this.fail(new Error('ASR 连接已断开')); });
    try {
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('ASR 连接超时')), 10000); socket.once('open', () => { clearTimeout(timer); resolve(); }); socket.once('error', error => { clearTimeout(timer); reject(new Error(this.error ?? `ASR 连接失败：${error.code ?? error.message}`)); }); socket.once('close', () => { clearTimeout(timer); reject(new Error('ASR 连接已关闭')); }); });
      let initialTimer;
      const initialized = new Promise((resolve, reject) => { this.initialResolve = resolve; this.initialReject = reject; initialTimer = setTimeout(() => reject(new Error('ASR 初始化响应超时')), 10000); });
      socket.send(encodeRequest(createInitPayload(this.config.endWindowMs, voiceprints), this.sequence++));
      try { await initialized; } finally { clearTimeout(initialTimer); this.initialResolve = undefined; this.initialReject = undefined; }
      if (this.status === 'error') throw new Error(this.error);
      if (this.socket !== socket || this.status !== 'connecting') throw new Error('ASR 启动已中止');
      this.status = 'running'; this.changed(); return this.state();
    } catch (error) { this.fail(error); throw error; }
  }
  pushAudio(value) {
    if (this.status !== 'running') throw new Error('sound2text 未运行');
    const buffer = Buffer.from(value);
    if (!buffer.length || buffer.length % 2 || buffer.length > 64000) throw new Error('音频必须为有界 PCM16 单声道 16kHz 数据');
    if (this.socket.bufferedAmount > 256000 || this.pending.length + buffer.length > 128000) { this.fail(new Error('语音上传积压，已停止采集')); throw new Error(this.error); }
    // Voice detection is acoustic and sample-time based. No transcript timer is treated as silence.
    for (let offset = 0; offset < buffer.length; offset += 640) {
      const part = buffer.subarray(offset, Math.min(offset + 640, buffer.length));
      const startMs = this.audioMs;
      this.audioMs += part.length / AUDIO_BYTES_PER_MS;
      this.recentAudio.push({ startMs, endMs: this.audioMs, buffer: Buffer.from(part) });
      this.recentAudio = this.recentAudio.filter(frame => frame.endMs >= this.audioMs - 500);
      if (['listening', 'finishing'].includes(this.capture.status)) {
        const end = this.capture.cutoffMs ?? this.audioMs;
        this.observeVoice(part, startMs, this.capture.boundaryMs, end);
        if (this.capture.status === 'listening' && this.audioMs >= this.capture.boundaryMs) {
          if (this.audioMs - this.capture.boundaryMs >= this.config.maxCommandMs) this.finishCapture('max_duration');
          else if (this.capture.heardSpeech && this.audioMs - this.capture.lastVoiceMs >= this.config.silenceMs) this.finishCapture('silence');
        }
      }
    }
    this.pending = Buffer.concat([this.pending, buffer]);
    while (this.pending.length >= AUDIO_PACKET_BYTES) { const packet = this.pending.subarray(0, AUDIO_PACKET_BYTES); this.pending = this.pending.subarray(AUDIO_PACKET_BYTES); this.socket.send(encodeRequest(packet, this.sequence++, { audio: true })); }
    this.tryFinalize();
  }
  checkpoint(value) {
    const boundary = value === undefined ? this.audioMs : value;
    const ahead = boundary - this.audioMs;
    // Confirm travels over HTTP while PCM is still in flight on the audio socket.
    // Past audio is limited to the 400ms lookback; future audio may be the whole upload budget.
    if (!Number.isFinite(boundary) || boundary < 0 || ahead < -400 || ahead > 8000) throw new Error('音频按钮时间边界无效或与音频流不同步');
    return boundary;
  }
  observeVoice(buffer, startMs, boundaryMs, endMs) {
    const first = Math.max(0, Math.ceil((boundaryMs - startMs) * 16));
    const last = Math.min(buffer.length / 2, Math.floor((endMs - startMs) * 16));
    if (last <= first) return;
    let power = 0; for (let i = first; i < last; i++) { const sample = buffer.readInt16LE(i * 2) / 32768; power += sample * sample; }
    if (Math.sqrt(power / (last - first)) >= this.rmsThreshold) { this.capture.heardSpeech = true; this.capture.lastVoiceMs = startMs + last / 16; }
  }
  handleResult(data) {
    const result = data?.result; if (!result) return;
    const incoming = Array.isArray(result.utterances) ? result.utterances : [];
    let cursor = 0;
    for (const u of incoming) {
      // The live API omits start_time on the first utterance of a result. Keep it at the previous end.
      const start = Number.isFinite(u.start_time) ? u.start_time : cursor;
      const end = Number.isFinite(u.end_time) ? u.end_time : start;
      if (typeof u.text !== 'string' || start < 0 || end < start) continue;
      cursor = Math.max(cursor, end);
      const normalized = { text: u.text.slice(0, 16000), speaker: speakerLabel(readSpeakerId(u)), start_time: start, end_time: end, definite: u.definite === true, words: Array.isArray(u.words) ? u.words.slice(0, 2000) : [] };
      const overlaps = entry => entry.start_time === normalized.start_time || (entry.start_time < normalized.end_time && normalized.start_time < entry.end_time);
      // ASR may adjust start times when revising or finalizing a segment. A final
      // segment supersedes overlapping drafts; late drafts cannot undo a final.
      if (!normalized.definite && this.utterances.some(entry => entry.definite && overlaps(entry))) continue;
      this.utterances = this.utterances.filter(entry => entry.start_time !== normalized.start_time && (entry.definite || !overlaps(entry)));
      this.utterances.push(normalized);
    }
    this.utterances.sort((a, b) => a.start_time - b.start_time); this.utterances = this.utterances.slice(-200);
    this.text = this.utterances.map(u => speakerLine(u.speaker, u.text)).filter(Boolean).join('\n').slice(-32000);
    this.events.emit('text', { text: this.text, utterances: structuredClone(this.utterances), audioMs: this.audioMs }); this.tryFinalize(); this.changed();
  }
  armCapture(boundaryMs) {
    if (this.status !== 'running') throw new Error('请先开启语音输入');
    if (this.capture.status !== 'idle') throw new Error('已经在采集指令');
    const boundary = this.checkpoint(boundaryMs);
    this.capture = { status: 'listening', id: randomUUID(), boundaryMs: boundary, heardSpeech: false, lastVoiceMs: boundary };
    for (const frame of this.recentAudio) this.observeVoice(frame.buffer, frame.startMs, boundary, this.audioMs);
    this.noSpeechTimer = setTimeout(() => { if (this.capture.status === 'listening' && !this.capture.heardSpeech) this.cancelCapture('等待语音超时，未提交指令'); }, this.config.noSpeechMs);
    this.maxTimer = setTimeout(() => { if (this.capture.status === 'listening') this.finishCapture('max_duration'); }, this.config.maxCommandMs);
    this.events.emit('capture', { ...this.capture }); this.changed(); return { ...this.capture };
  }
  finishCapture(reason = 'manual', endBoundaryMs) {
    if (this.capture.status !== 'listening') return { ...this.capture };
    const cutoffMs = this.checkpoint(endBoundaryMs);
    if (cutoffMs < this.capture.boundaryMs) throw new Error('指令结束边界早于开始边界');
    clearTimeout(this.noSpeechTimer); clearTimeout(this.maxTimer);
    if (!this.capture.heardSpeech && cutoffMs <= this.audioMs) { this.cancelCapture('没有有效语音，未提交指令'); return { ...this.capture }; }
    this.capture = { ...this.capture, status: 'finishing', endMs: this.capture.lastVoiceMs, cutoffMs, reason };
    this.events.emit('capture', { ...this.capture }); this.changed();
    const lag = Math.max(0, cutoffMs - this.audioMs);
    this.finalTimer = setTimeout(() => this.expireCapture(), lag + this.config.finalWaitMs);
    this.tryFinalize(); return { ...this.capture };
  }
  commandText(capture, { allowGap = false } = {}) {
    if (this.audioMs < capture.cutoffMs) return { wait: true };
    if (!capture.heardSpeech) return { cancel: '没有有效语音，未提交指令' };
    capture.endMs = Math.min(capture.lastVoiceMs, capture.cutoffMs);
    const relevant = this.utterances.filter(u => u.end_time > capture.boundaryMs && u.start_time <= capture.endMs);
    if (!relevant.length || relevant.some(u => !u.definite)) return { wait: true };
    if (!allowGap && Math.max(...relevant.map(u => u.end_time)) + 100 < capture.endMs) return { wait: true };
    const parts = [];
    for (const u of relevant) {
      if (u.start_time >= capture.boundaryMs && u.end_time <= capture.cutoffMs) { parts.push(speakerLine(u.speaker, u.text)); continue; }
      const words = u.words.filter(w => Number.isFinite(w.start_time) && Number.isFinite(w.end_time));
      if (!words.length) return { cancel: '识别分句跨越按钮边界且缺少词时间戳，请重新说完整指令' };
      if (words.some(w => w.start_time >= capture.boundaryMs && w.start_time < capture.cutoffMs && w.end_time > capture.cutoffMs)) return { cancel: '结束时仍在说话，指令截断在词中，请重新说完整指令' };
      const selected = words.filter(w => w.start_time >= capture.boundaryMs && w.start_time <= capture.endMs && w.end_time <= capture.cutoffMs);
      parts.push(speakerLine(u.speaker, selected.map(w => w.text ?? w.word ?? '').join('')));
    }
    const text = parts.filter(Boolean).join('\n').trim();
    return text ? { text } : { wait: true };
  }
  settle(result) {
    if (!result || result.wait) return;
    if (result.cancel) { this.cancelCapture(result.cancel); return; }
    const capture = this.capture;
    clearTimeout(this.finalTimer);
    this.capture = { status: 'idle', id: capture.id, boundaryMs: capture.boundaryMs, reason: capture.reason, text: result.text };
    this.events.emit('capture', { ...this.capture }); this.changed(); this.events.emit('instruction', { text: result.text, id: capture.id, reason: capture.reason });
  }
  expireCapture() {
    if (this.capture.status !== 'finishing') return;
    const result = this.commandText(this.capture, { allowGap: true });
    if (result.wait) this.cancelCapture('识别未完成，请重试');
    else this.settle(result);
  }
  tryFinalize() {
    if (this.capture.status !== 'finishing') return;
    this.settle(this.commandText(this.capture));
  }
  cancelCapture(reason = 'cancelled') {
    clearTimeout(this.noSpeechTimer); clearTimeout(this.maxTimer); clearTimeout(this.finalTimer);
    if (this.capture.status !== 'idle') { this.capture = { status: 'idle', id: this.capture.id, boundaryMs: this.capture.boundaryMs, reason, error: reason }; this.events.emit('capture', { ...this.capture }); this.changed(); }
    return { ...this.capture };
  }
  pause(reason = 'paused') {
    if (this.pausing) return this.pausing;
    this.pausing = this.stop(reason).finally(() => { this.pausing = undefined; });
    return this.pausing;
  }
  async stop(reason) {
    await this.ready; this.cancelCapture('语音采集已暂停，未完成指令已中止');
    if (this.status === 'stopped') return this.state();
    this.status = 'stopping'; this.changed(); const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      const tail = new Promise(resolve => { this.terminalResolve = resolve; });
      socket.send(encodeRequest(this.pending, this.sequence++, { audio: true, last: true })); this.pending = Buffer.alloc(0);
      let timer; await Promise.race([tail, new Promise(resolve => { timer = setTimeout(resolve, this.config.finalWaitMs); })]); clearTimeout(timer);
    }
    this.terminalResolve = undefined; this.socket = undefined; socket?.terminate(); this.status = 'stopped'; this.owner = null; this.changed(); return this.state();
  }
  async dispose() { await this.pause('shutdown'); this.events.removeAllListeners(); }
}
