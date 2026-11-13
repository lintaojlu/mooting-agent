import { gzipSync, gunzipSync } from 'node:zlib';

export const AUDIO_BYTES_PER_MS = 32;
export const AUDIO_PACKET_BYTES = 6400;
const LIMIT = 2 * 1024 * 1024;

/** Official Volcengine v1 framing: four-byte header, signed sequence, payload size, gzip body. */
export function encodeRequest(payload, sequence, { audio = false, last = false } = {}) {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 0x7fffffff) throw new Error('sound2text invalid sequence');
  const compressed = gzipSync(audio ? payload : Buffer.from(JSON.stringify(payload)));
  const header = Buffer.from([0x11, (audio ? 0x20 : 0x10) | (last ? 3 : 1), 0x11, 0]);
  const prefix = Buffer.alloc(8); prefix.writeInt32BE(last ? -sequence : sequence, 0); prefix.writeUInt32BE(compressed.length, 4);
  return Buffer.concat([header, prefix, compressed]);
}

export function decodeResponse(value) {
  const bytes = Buffer.from(value);
  if (bytes.length < 8 || bytes.length > LIMIT) throw new Error('sound2text invalid frame length');
  const version = bytes[0] >> 4, headerBytes = (bytes[0] & 15) * 4;
  if (version !== 1 || headerBytes < 4 || headerBytes > bytes.length) throw new Error('sound2text unsupported header');
  const type = bytes[1] >> 4, flags = bytes[1] & 15, serialization = bytes[2] >> 4, compression = bytes[2] & 15;
  if (![9, 15].includes(type) || ![0, 1].includes(compression) || serialization !== 1) throw new Error('sound2text unsupported response');
  let offset = headerBytes, sequence, event, code = 0;
  function int(signed = false) { if (offset + 4 > bytes.length) throw new Error('sound2text truncated frame'); const n = signed ? bytes.readInt32BE(offset) : bytes.readUInt32BE(offset); offset += 4; return n; }
  if (flags & 1) sequence = int(true);
  if (flags & 4) event = int(true);
  if (type === 15) code = int(true);
  const length = int(); if (offset + length !== bytes.length) throw new Error('sound2text inconsistent payload size');
  let payload = bytes.subarray(offset); if (compression === 1) payload = gunzipSync(payload, { maxOutputLength: LIMIT });
  const data = JSON.parse(payload.toString('utf8'));
  return { data, sequence, event, code, terminal: !!(flags & 2) };
}

export function createInitPayload(endWindowMs = 800) {
  return { user: { uid: 'mooting-agent' }, audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 }, request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_nonstream: true, show_utterances: true, result_type: 'full', end_window_size: endWindowMs } };
}
