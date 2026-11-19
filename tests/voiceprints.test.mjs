import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { VoiceprintDirectory, HostedAudio, audioDurationMs, assertRegistrationAudio, VOICEPRINT_LIMIT } from '../src/sound2text/voiceprints.mjs';
import { speakerLabel } from '../src/sound2text/speaker-label.mjs';
import { startWeb } from '../src/web-server.mjs';

function wav(seconds, rate = 16000) {
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function mp3(frames) {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x00;
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

test('speaker labels keep registered names and number anonymous speakers', () => {
  assert.equal(speakerLabel(''), '说话人 1');
  assert.equal(speakerLabel('0'), '说话人 1');
  assert.equal(speakerLabel('speaker_2'), '说话人 2');
  assert.equal(speakerLabel('张三'), '张三');
});

test('registration audio accepts 5–30 seconds of wav, pcm and mp3', () => {
  assert.ok(Math.abs(audioDurationMs(wav(6), 'a.wav') - 6000) < 1);
  assert.equal(audioDurationMs(Buffer.alloc(16000 * 2 * 8), 'a.pcm'), 8000);
  const clip = mp3(200);
  assert.ok(audioDurationMs(clip, 'a.mp3') > 5000);
  assert.throws(() => assertRegistrationAudio(wav(4), 'short.wav'), /5–30/);
  assert.throws(() => assertRegistrationAudio(wav(31), 'long.wav'), /5–30/);
});

test('voiceprint directory strips embeddings, matches the newest 50, and blocks the 51st registration', async () => {
  const calls = [];
  const rows = Array.from({ length: 51 }, (_, index) => ({ SpeakId: `id-${index}`, SpeakerName: `人${index}`, Embedding: [1, 2, 3], Status: 1 }));
  const directory = new VoiceprintDirectory({
    apiKey: 'secret',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (body.Limit) return { ok: true, json: async () => ({ Result: { Code: 1000, TotalCount: rows.length, AudioEmbedding: rows.slice(body.Offset * body.Limit, body.Offset * body.Limit + body.Limit) } }) };
      if (body.Action === 0) return { ok: true, json: async () => ({ Result: { Code: 1000, SpeakId: 'new' } }) };
      return { ok: true, json: async () => ({ Result: { Code: 1000 } }) };
    },
  });
  const items = await directory.listAll();
  assert.equal(items.length, 51);
  assert.equal(items[0].id, 'id-0');
  assert.equal(JSON.stringify(items).includes('Embedding'), false);
  await assert.rejects(directory.register({ name: '新的人', audioUrl: 'https://example.com/a.wav' }), /50/);
  rows.length = 1;
  const created = await directory.register({ name: '李四', audioUrl: 'https://example.com/a.wav' });
  assert.deepEqual(created, { id: 'new', name: '李四' });
  assert.equal(calls.some(call => call.Action === 0 && call.AudioUrl === 'https://example.com/a.wav'), true);
  assert.equal(JSON.stringify(calls).includes('secret'), false);
  assert.equal(VOICEPRINT_LIMIT, 50);
});

test('hosted registration audio expires and the management routes do not return embeddings', async t => {
  let now = 0;
  const hosted = new HostedAudio({ now: () => now, ttlMs: 1000 });
  const token = hosted.put(wav(6), 'audio/wav');
  assert.equal(hosted.get(token).contentType, 'audio/wav');
  now = 1000;
  assert.equal(hosted.get(token), null);
  const calls = [];
  const runtime = new EventEmitter();
  runtime.ctx = { agents: { list: () => [{}] } };
  runtime.state = () => ({});
  runtime.sound2text = { async pause() {}, voiceprints: () => new VoiceprintDirectory({ apiKey: 'secret', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.Limit) return { ok: true, json: async () => ({ Result: { Code: 1000, TotalCount: 1, AudioEmbedding: [{ SpeakId: 'vp-1', SpeakerName: '张三', Embedding: [9], Status: 1 }] } }) };
    if (body.Action === 2) return { ok: true, json: async () => ({ Result: { Code: 1000 } }) };
    return { ok: true, json: async () => ({ Result: { Code: 1000, SpeakId: 'vp-2' } }) };
  } }) };
  const web = await startWeb(runtime, { port: 0 });
  t.after(() => web.close());
  const listed = await fetch(web.url + '/api/voiceprints').then(response => response.json());
  assert.deepEqual(listed.items, [{ id: 'vp-1', name: '张三' }]);
  assert.equal(listed.canRegister, true);
  assert.equal(JSON.stringify(listed).includes('Embedding'), false);
  const local = await fetch(web.url + '/api/voiceprints/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '李四', audioBase64: wav(6).toString('base64'), filename: 'a.wav' }) });
  assert.equal(local.status, 400);
  assert.match((await local.json()).error, /公网音频 URL/);
  const created = await fetch(web.url + '/api/voiceprints/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '李四', audioUrl: 'https://cdn.example/a.wav' }) });
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), { id: 'vp-2', name: '李四' });
  const page = await fetch(web.url + '/voiceprints.html');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /声纹/);
  const removed = await fetch(web.url + '/api/voiceprints/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'vp-1' }) });
  assert.equal(removed.status, 200);
  assert.equal(calls.some(call => call.Action === 2 && call.SpeakId === 'vp-1'), true);
});
