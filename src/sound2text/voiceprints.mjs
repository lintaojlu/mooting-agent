import { randomBytes } from 'node:crypto';

export const VOICEPRINT_LIMIT = 50;
export const VOICEPRINT_ENDPOINT = 'https://openspeech.bytedance.com/api/proxy/invoke';

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function checkSpeakerName(name) {
  const value = String(name ?? '').trim();
  if (!value || value.length > 32) throw fail('说话人名称需要 1–32 个字符');
  if (/[:：\r\n]/u.test(value)) throw fail('说话人名称不能包含冒号或换行');
  return value;
}

function wavDurationMs(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw fail('WAV 文件无效');
  let offset = 12, rate = 0, channels = 0, bits = 0, dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start > buffer.length) break;
    if (id === 'fmt ') {
      if (size < 16 || start + 16 > buffer.length) throw fail('WAV 文件无效');
      if (buffer.readUInt16LE(start) !== 1) throw fail('WAV 需要 PCM 编码');
      channels = buffer.readUInt16LE(start + 2);
      rate = buffer.readUInt32LE(start + 4);
      bits = buffer.readUInt16LE(start + 14);
    } else if (id === 'data') dataBytes = size;
    offset = start + size + (size % 2);
  }
  if (!rate || !channels || !bits || !dataBytes) throw fail('WAV 文件无效');
  return dataBytes / (rate * channels * (bits / 8)) * 1000;
}

function mp3DurationMs(buffer) {
  let offset = 0;
  if (buffer.toString('ascii', 0, 3) === 'ID3' && buffer.length >= 10) {
    const size = ((buffer[6] & 127) << 21) | ((buffer[7] & 127) << 14) | ((buffer[8] & 127) << 7) | (buffer[9] & 127);
    offset = 10 + size;
  }
  const bitrateTable = {
    3: { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], 3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448] },
    2: { 1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], 3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256] },
  };
  const sampleRates = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  let samples = 0, rate = 0, frames = 0;
  while (offset + 4 < buffer.length && frames < 20000) {
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) { offset += 1; continue; }
    const header = buffer.readUInt32BE(offset);
    const versionId = (header >> 19) & 3;
    const layerId = (header >> 17) & 3;
    const bitrateIndex = (header >> 12) & 15;
    const sampleIndex = (header >> 10) & 3;
    const padding = (header >> 9) & 1;
    const version = versionId === 3 ? 3 : 2;
    const layer = layerId === 3 ? 3 : layerId === 2 ? 2 : 1;
    const bitrate = versionId === 1 || layerId === 0 ? 0 : bitrateTable[version]?.[layer]?.[bitrateIndex];
    const sampleRate = sampleRates[versionId === 3 ? 3 : versionId === 2 ? 2 : 0]?.[sampleIndex];
    if (!bitrate || !sampleRate || bitrateIndex === 15 || sampleIndex === 3) { offset += 1; continue; }
    const sampleCount = layer === 3 ? 384 : version === 3 || layer === 2 ? 1152 : 576;
    const frameLength = layer === 3
      ? Math.floor((12 * bitrate * 1000 / sampleRate + padding) * 4)
      : Math.floor(sampleCount / 8 * bitrate * 1000 / sampleRate + padding);
    if (frameLength < 4 || offset + frameLength > buffer.length + 4) { offset += 1; continue; }
    samples += sampleCount; rate = sampleRate; frames += 1; offset += frameLength;
  }
  if (!frames || !rate) throw fail('无法读取 MP3 时长，请改用 WAV');
  return samples / rate * 1000;
}

/** Duration of a registration clip. PCM is read as 16 kHz, 16-bit, mono. */
export function audioDurationMs(bytes, filename = '') {
  const buffer = Buffer.from(bytes);
  const name = String(filename).toLowerCase();
  if (name.endsWith('.wav') || buffer.toString('ascii', 0, 4) === 'RIFF') return wavDurationMs(buffer);
  if (name.endsWith('.mp3') || buffer.toString('ascii', 0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return mp3DurationMs(buffer);
  if (name.endsWith('.pcm')) {
    if (!buffer.length || buffer.length % 2) throw fail('PCM 需要 16-bit 小端单声道数据');
    return buffer.length / 32;
  }
  throw fail('只支持 wav、pcm、mp3');
}

export function assertRegistrationAudio(bytes, filename) {
  if (!bytes?.length || bytes.length > 2_000_000) throw fail('音频为空或超过 2 MB');
  const duration = audioDurationMs(bytes, filename);
  if (duration < 5000 || duration > 30000) throw fail('注册音频需要 5–30 秒');
  return duration;
}

export function decodeAudio(audioBase64, filename) {
  const bytes = Buffer.from(String(audioBase64 ?? ''), 'base64');
  assertRegistrationAudio(bytes, filename);
  const lower = String(filename ?? '').toLowerCase();
  const contentType = lower.endsWith('.mp3') ? 'audio/mpeg' : lower.endsWith('.pcm') ? 'audio/L16' : 'audio/wav';
  return { bytes, contentType };
}

export function checkAudioUrl(value) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw fail('音频 URL 无效'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw fail('音频 URL 必须是 http 或 https');
  return url.toString();
}

/** Short-lived files Volcengine can download. The token is the only authorization. */
export class HostedAudio {
  constructor({ now = Date.now, ttlMs = 10 * 60 * 1000 } = {}) {
    this.now = now; this.ttlMs = ttlMs; this.files = new Map();
  }
  prune() {
    const now = this.now();
    for (const [token, file] of this.files) if (file.expires <= now) this.files.delete(token);
  }
  put(bytes, contentType) {
    this.prune();
    const token = randomBytes(24).toString('hex');
    this.files.set(token, { bytes: Buffer.from(bytes), contentType, expires: this.now() + this.ttlMs });
    return token;
  }
  get(token) {
    this.prune();
    const file = this.files.get(token);
    return file && file.expires > this.now() ? file : null;
  }
}

function publicItem(item) {
  if (!item?.SpeakId || item.Status === 2) return null;
  return { id: String(item.SpeakId), name: String(item.SpeakerName ?? '') };
}

/** Volcengine voiceprint library. Embeddings never leave this object. */
export class VoiceprintDirectory {
  constructor({ apiKey, fetchImpl = globalThis.fetch, endpoint = VOICEPRINT_ENDPOINT } = {}) {
    this.apiKey = apiKey; this.fetchImpl = fetchImpl; this.endpoint = endpoint;
  }
  async invoke(action, payload) {
    if (!this.apiKey) throw fail('请先填写 SOUND2TEXT_API_KEY', 409);
    let response, data;
    try {
      response = await this.fetchImpl(`${this.endpoint}?Action=${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.apiKey }, body: JSON.stringify(payload),
      });
      data = await response.json();
    } catch { throw fail('声纹服务暂时不可用', 502); }
    const error = data?.ResponseMetadata?.Error;
    if (!response.ok || error) throw fail(error?.Message || `声纹服务失败（HTTP ${response.status}）`, 502);
    if (data?.Result?.Code && data.Result.Code !== 1000) throw fail(`声纹服务失败（${data.Result.Code}）`, 502);
    return data?.Result ?? {};
  }
  async listAll() {
    const items = [];
    for (let page = 0; page < 100; page += 1) {
      const result = await this.invoke('ListVoiceprint', { Limit: VOICEPRINT_LIMIT, Offset: page });
      const batch = Array.isArray(result.AudioEmbedding) ? result.AudioEmbedding : [];
      for (const item of batch) { const row = publicItem(item); if (row) items.push(row); }
      const total = Number(result.TotalCount ?? items.length);
      if (!batch.length || items.length >= total) break;
    }
    return items;
  }
  async register({ name, audioUrl }) {
    const items = await this.listAll();
    if (items.length >= VOICEPRINT_LIMIT) throw fail(`声纹已有 ${items.length} 条，达到 ${VOICEPRINT_LIMIT} 条上限后不能再注册`, 409);
    const result = await this.invoke('UpdateVoiceprint', { Action: 0, SpeakerName: checkSpeakerName(name), AudioUrl: checkAudioUrl(audioUrl) });
    if (!result.SpeakId) throw fail('声纹服务没有返回声纹 ID', 502);
    return { id: String(result.SpeakId), name: checkSpeakerName(name) };
  }
  async rename({ id, name }) {
    if (!id) throw fail('缺少声纹 ID');
    const speakerName = checkSpeakerName(name);
    await this.invoke('UpdateVoiceprint', { Action: 1, SpeakId: String(id), SpeakerName: speakerName });
    return { id: String(id), name: speakerName };
  }
  async replace({ id, name, audioUrl }) {
    if (!id) throw fail('缺少声纹 ID');
    const speakerName = checkSpeakerName(name);
    await this.invoke('UpdateVoiceprint', { Action: 1, SpeakId: String(id), SpeakerName: speakerName, AudioUrl: checkAudioUrl(audioUrl) });
    return { id: String(id), name: speakerName };
  }
  async remove(id) {
    if (!id) throw fail('缺少声纹 ID');
    await this.invoke('UpdateVoiceprint', { Action: 2, SpeakId: String(id) });
    return { id: String(id), deleted: true };
  }
}
