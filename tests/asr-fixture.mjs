import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { gzipSync, gunzipSync } from 'node:zlib';

/** Local-only Volcengine protocol fixture; it does not recognize real speech. */
export async function startASRFixture() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  let current; const audio = [], headers = [];
  const encode = (data, last = false) => {
    const payload = gzipSync(Buffer.from(JSON.stringify(data))), prefix = Buffer.alloc(8);
    prefix.writeInt32BE(last ? -1 : 1, 0); prefix.writeUInt32BE(payload.length, 4);
    return Buffer.concat([Buffer.from([0x11, last ? 0x93 : 0x91, 0x11, 0]), prefix, payload]);
  };
  server.on('connection', (socket, request) => {
    current = socket; headers.push(request.headers);
    socket.on('message', data => {
      const bytes = Buffer.from(data), type = bytes[1] >> 4, flags = bytes[1] & 15;
      if (type === 1) socket.send(encode({ code: 20000000 }));
      if (type === 2) {
        audio.push(gunzipSync(bytes.subarray(12)).length);
        if (flags & 2) socket.send(encode({ code: 20000000 }, true));
      }
    });
  });
  return {
    url: `ws://127.0.0.1:${server.address().port}/api/v3/sauc/bigmodel_async`, audio, headers,
    recognize({ text, start, end, definite = false, words }) {
      if (!current || current.readyState !== 1) throw new Error('ASR fixture not connected');
      current.send(encode({ result: { text, utterances: [{ text, start_time: start, end_time: end, definite, ...(words ? { words } : {}) }] } }));
    },
    disconnect() { current?.terminate(); },
    async close() { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); },
  };
}

export function fakeMicrophoneWav(seconds = 20) {
  const rate = 48000, count = rate * seconds, bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) bytes.writeInt16LE(Math.round(9000 * Math.sin(i / rate * 2 * Math.PI * 330)), 44 + i * 2);
  return bytes;
}
