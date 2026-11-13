import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync, gunzipSync } from 'node:zlib';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { encodeRequest, decodeResponse, createInitPayload } from '../src/sound2text/protocol.mjs';
import { Sound2Text } from '../src/sound2text/service.mjs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountSound2text } from '../src/sound2text/http-ws.mjs';

function response(data, { terminal = false, error = 0 } = {}) {
  const payload = gzipSync(Buffer.from(JSON.stringify(data))), header = Buffer.from([0x11, error ? 0xf0 : terminal ? 0x93 : 0x91, 0x11, 0]);
  const prefix = Buffer.alloc(error ? 8 : 8); prefix.writeInt32BE(error || (terminal ? -1 : 1), 0); prefix.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, prefix, payload]);
}
function clientPacket(buffer) { const b = Buffer.from(buffer); return { type: b[1] >> 4, flags: b[1] & 15, seq: b.readInt32BE(4), bytes: gunzipSync(b.subarray(12)) }; }
function pcm(ms, loud = false) { const b = Buffer.alloc(ms * 32); if (loud) for (let i = 0; i < b.length; i += 2) b.writeInt16LE(6000, i); return b; }
async function fixture(t, extra = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  const packets = [], headers = []; let cloud;
  server.on('connection', (socket, req) => {
    cloud = socket; headers.push(req.headers);
    socket.on('message', data => { const packet = clientPacket(data); packets.push(packet); if (packet.type === 1) socket.send(response({ code: 20000000 })); if (packet.flags === 3) socket.send(response({}, { terminal: true })); });
  });
  const sound = new Sound2Text({ config: { apiKey: 'fixture-secret', resourceId: 'volc.seedasr.sauc.duration', url: `ws://127.0.0.1:${server.address().port}`, finalWaitMs: 50, ...extra } });
  await sound.ready;
  t.after(async () => { await sound.dispose(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  return { sound, packets, headers, send(data) { cloud.send(response({ result: data })); }, error() { cloud.send(response({ message: 'denied' }, { error: 45000001 })); }, get cloud() { return cloud; } };
}
const utterance = (text, start, end, definite = true, words) => ({ text, start_time: start, end_time: end, definite, ...(words ? { words } : {}) });
const turn = () => new Promise(resolve => setImmediate(resolve));

 test('official framing encodes init/audio/negative terminal sequence and validates response sizes', () => {
  const init = encodeRequest(createInitPayload(), 1); assert.deepEqual([...init.subarray(0, 4)], [0x11, 0x11, 0x11, 0]);
  assert.equal(init.readInt32BE(4), 1); assert.equal(JSON.parse(clientPacket(init).bytes).audio.rate, 16000);
  const audio = encodeRequest(pcm(200), 2, { audio: true }); assert.equal(audio[1], 0x21); assert.equal(clientPacket(audio).bytes.length, 6400);
  const last = encodeRequest(Buffer.alloc(0), 3, { audio: true, last: true }); assert.equal(last[1], 0x23); assert.equal(last.readInt32BE(4), -3);
  assert.equal(decodeResponse(response({ result: { text: '好' } })).data.result.text, '好');
  assert.equal(decodeResponse(response({}, { terminal: true })).terminal, true);
  assert.equal(decodeResponse(response({}, { error: 123 })).code, 123);
  assert.throws(() => decodeResponse(Buffer.alloc(2))); assert.throws(() => decodeResponse(Buffer.concat([response({}), Buffer.from([1])])));
});

test('real local cloud socket uses API-key headers, 200ms PCM packets, partial revisions and terminal pause', async t => {
  const f = await fixture(t), events = []; f.sound.subscribe(value => events.push(value));
  await f.sound.start('owner'); assert.equal(f.sound.state().status, 'running');
  assert.equal(f.headers[0]['x-api-key'], 'fixture-secret'); assert.ok(f.headers[0]['x-api-request-id']);
  f.sound.pushAudio(pcm(100)); f.sound.pushAudio(pcm(100));
  await turn(); await turn(); assert.equal(f.packets.filter(p => p.type === 2)[0].bytes.length, 6400);
  f.send({ text: '红', utterances: [utterance('红', 0, 200, false)] }); await once(f.sound.events, 'text');
  f.send({ text: '红筹', utterances: [utterance('红筹', 0, 300)] }); await once(f.sound.events, 'text');
  assert.equal(f.sound.state().utterances.length, 1); assert.equal(f.sound.state().text, '红筹'); assert.ok(!JSON.stringify(f.sound.state()).includes('fixture-secret'));
  await f.sound.pause(); assert.equal(f.sound.state().status, 'stopped'); assert.equal(f.packets.at(-1).flags, 3);
});

test('acoustic silence merges stable multi-utterance command and emits exactly once', async t => {
  const { sound } = await fixture(t), instructions = []; await sound.start(); sound.events.on('instruction', x => instructions.push(x));
  sound.armCapture(); sound.pushAudio(pcm(200, true));
  sound.handleResult({ result: { text: '帮我记录明天开会', utterances: [utterance('帮我记录', 0, 100), utterance('明天开会', 100, 200)] } });
  sound.pushAudio(pcm(1500));
  assert.equal(instructions.length, 1); assert.equal(instructions[0].text, '帮我记录明天开会'); assert.equal(sound.state().capture.status, 'idle');
  sound.handleResult({ result: { utterances: [utterance('明天开会', 100, 200)] } }); assert.equal(instructions.length, 1);
});

test('silence waits for final revision, manual end excludes pre-button words', async t => {
  const { sound } = await fixture(t); await sound.start(); sound.pushAudio(pcm(200, true)); sound.armCapture(); sound.pushAudio(pcm(200, true));
  const instructions = []; sound.events.on('instruction', x => instructions.push(x));
  const words = [{ text: '之前', start_time: 0, end_time: 190 }, { text: '之后', start_time: 210, end_time: 390 }];
  sound.handleResult({ result: { utterances: [utterance('之前之后', 0, 400, false, words)] } }); sound.finishCapture();
  assert.equal(sound.state().capture.status, 'finishing'); assert.equal(instructions.length, 0);
  sound.handleResult({ result: { utterances: [utterance('之前之后', 0, 400, true, words)] } });
  assert.equal(instructions[0].text, '之后');
});

test('missing word timing across boundary aborts safely, no incomplete command', async t => {
  const { sound } = await fixture(t); await sound.start(); sound.pushAudio(pcm(200)); sound.armCapture(); sound.pushAudio(pcm(200, true)); sound.finishCapture();
  sound.handleResult({ result: { utterances: [utterance('不能截字符串', 0, 400)] } });
  assert.equal(sound.state().capture.status, 'idle'); assert.match(sound.state().capture.error, /词时间戳/);
});

test('network absence is not silence; no-speech and final wait timers never submit drafts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sound = new Sound2Text({ config: { apiKey: 'x', resourceId: 'x', noSpeechMs: 10000, maxCommandMs: 60000, finalWaitMs: 3000 } }); await sound.ready;
  sound.status = 'running'; sound.sequence = 2; sound.socket = { bufferedAmount: 0, send() {} }; const instructions = []; sound.events.on('instruction', e => instructions.push(e));
  sound.armCapture(); t.mock.timers.tick(10000); assert.match(sound.capture.error, /等待语音超时/);
  sound.armCapture(); sound.pushAudio(pcm(200, true)); t.mock.timers.tick(2000); assert.equal(sound.capture.status, 'listening');
  sound.finishCapture(); t.mock.timers.tick(3000); assert.match(sound.capture.error, /识别未完成/); assert.equal(instructions.length, 0);
  sound.cancelCapture(); t.mock.timers.reset();
});

test('max command duration finalizes stable command, pause cancels unfinished input', async t => {
  const { sound } = await fixture(t, { maxCommandMs: 1000 }); await sound.start(); let count = 0; sound.events.on('instruction', () => count++);
  sound.armCapture(); sound.handleResult({ result: { utterances: [utterance('完整命令', 0, 1000)] } }); sound.pushAudio(pcm(1000, true));
  assert.equal(count, 1); assert.equal(sound.capture.reason, 'max_duration');
  sound.armCapture(); sound.pushAudio(pcm(100, true)); await sound.pause(); assert.equal(count, 1); assert.match(sound.capture.error, /中止/);
});

test('cloud errors and audio backlog stop stream and cancel capture', async t => {
  const f = await fixture(t); await f.sound.start(); f.sound.armCapture(); f.error(); await once(f.sound.events, 'error');
  assert.equal(f.sound.status, 'error'); assert.equal(f.sound.capture.status, 'idle');
  const sound = new Sound2Text({ config: { apiKey: 'x', resourceId: 'x' } }); await sound.ready; sound.status = 'running'; sound.socket = { bufferedAmount: 999999, terminate() {} };
  assert.throws(() => sound.pushAudio(pcm(200)), /积压/); assert.equal(sound.status, 'error');
});

test('sample checkpoints handle future PCM and past transport arrival without pre-button speech', async t => {
  const { sound } = await fixture(t); await sound.start(); const instructions = []; sound.events.on('instruction', x => instructions.push(x));
  sound.armCapture(200); sound.pushAudio(pcm(200, true)); assert.equal(sound.capture.heardSpeech, false);
  sound.pushAudio(pcm(200, true)); sound.finishCapture('manual', 500);
  sound.handleResult({ result: { utterances: [utterance('之前之后', 0, 500, true, [{ text: '之前', start_time: 0, end_time: 190 }, { text: '之后', start_time: 210, end_time: 490 }])] } });
  assert.equal(instructions.length, 0); sound.pushAudio(pcm(100));
  assert.equal(instructions[0].text, '之后'); assert.equal(instructions[0].reason, 'manual');
  sound.pushAudio(pcm(100, true)); sound.armCapture(550); assert.equal(sound.capture.heardSpeech, true);
  assert.equal(sound.capture.lastVoiceMs, 600); sound.cancelCapture();
  assert.throws(() => sound.armCapture(1100), /边界/); assert.throws(() => sound.armCapture(-1), /边界/);
});

test('manual end rejects a word or sentence extending beyond the end checkpoint', async t => {
  const { sound } = await fixture(t); await sound.start(); const instructions = []; sound.events.on('instruction', value => instructions.push(value));
  sound.armCapture(); sound.pushAudio(pcm(500, true)); sound.finishCapture('manual', 500);
  sound.handleResult({ result: { utterances: [utterance('结束前后', 0, 700, true, [{ text: '结束前', start_time: 0, end_time: 400 }, { text: '跨界词', start_time: 450, end_time: 700 }])] } });
  assert.equal(instructions.length, 0); assert.match(sound.capture.error, /截断在词中/);
  sound.armCapture(); sound.pushAudio(pcm(200, true)); sound.finishCapture('manual', 700);
  sound.handleResult({ result: { utterances: [utterance('超过边界但以前被容差放行', 500, 750)] } });
  assert.equal(instructions.length, 0); assert.match(sound.capture.error, /词时间戳/);
});

test('subscriptions include stopped and error transitions and can be disposed', async t => {
  const { sound } = await fixture(t); const states = []; const unsubscribe = sound.subscribe(state => states.push(state.status));
  await sound.start(); await sound.pause(); assert.ok(states.includes('running')); assert.equal(states.at(-1), 'stopped');
  const count = states.length; unsubscribe(); sound.changed(); assert.equal(states.length, count);
});

test('missing configuration fails explicitly without connecting', async () => {
  const sound = new Sound2Text({ config: { apiKey: '', resourceId: '' } }); await sound.ready;
  await assert.rejects(sound.start(), /SOUND2TEXT_API_KEY/); assert.equal(sound.socket, undefined);
});

test('browser socket protects Origin and ownership, exposes no capture bypass', async t => {
  const { sound } = await fixture(t); const http = createServer(); const dispose = mountSound2text(http, sound);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve)); const host = `127.0.0.1:${http.address().port}`, url = `ws://${host}/api/sound2text/audio`;
  t.after(async () => { await dispose(); await new Promise(resolve => http.close(resolve)); });
  const denied = new WebSocket(url, { origin: 'https://other.example' }); const [error] = await once(denied, 'error'); assert.match(error.message, /403/);
  const socket = new WebSocket(url, { origin: `http://${host}` }); await once(socket, 'open');
  const messages = []; socket.on('message', data => messages.push(JSON.parse(data)));
  socket.send(JSON.stringify({ type: 'start' }));
  while (!messages.some(x => x.type === 'ready')) await turn();
  const second = new WebSocket(url, { origin: `http://${host}` }); const [busy] = await once(second, 'error'); assert.match(busy.message, /409/);
  socket.send(JSON.stringify({ type: 'capture' })); while (!messages.some(x => x.type === 'error')) await turn(); assert.equal(sound.capture.status, 'idle');
  sound.armCapture(); sound.pushAudio(pcm(200, true)); sound.finishCapture();
  let submitted = 0; sound.events.on('instruction', () => submitted++);
  socket.send(JSON.stringify({ type: 'cancel_capture' }));
  while (sound.capture.status !== 'idle') await turn();
  sound.handleResult({ result: { utterances: [utterance('暂停不应提交', 0, 200)] } });
  assert.equal(submitted, 0);
  socket.send(pcm(200)); socket.send(JSON.stringify({ type: 'pause' })); while (!messages.some(x => x.type === 'ack')) await turn(); assert.equal(sound.status, 'stopped'); socket.close();
});


test('resident ASR reloads credentials from dotenv before reconnecting', async t => {
  const f = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), 'sound2text-reload-')), path = join(dir, '.env');
  const save = key => writeFile(path, `SOUND2TEXT_API_KEY='${key}'\nSOUND2TEXT_RESOURCE_ID='fixture-resource'\nSOUND2TEXT_WS_URL='${f.sound.config.url}'\n`);
  await save('old-test-key');
  const sound = new Sound2Text({ configPath: path }); await sound.ready;
  t.after(() => sound.dispose());
  await save('new-test-key');
  await sound.start(); assert.equal(f.headers.at(-1)['x-api-key'], 'new-test-key');
  await sound.pause(); await save('rotated-test-key');
  await sound.start(); assert.equal(f.headers.at(-1)['x-api-key'], 'rotated-test-key');
  assert.ok(!JSON.stringify(sound.state()).includes('rotated-test-key'));
});

test('HTTP handshake refusal preserves the useful status instead of generic connection failure', async t => {
  const server = createServer((_req, res) => { res.writeHead(403); res.end('denied'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sound = new Sound2Text({ config: { apiKey: 'fixture-private-key', resourceId: 'fixture', url: `ws://127.0.0.1:${server.address().port}` } });
  t.after(async () => { await sound.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await assert.rejects(sound.start(), /HTTP 403/);
  assert.match(sound.state().error, /API Key/);
  assert.ok(!JSON.stringify(sound.state()).includes('fixture-private-key'));
});


test('shifted final timestamps replace drafts and unblock a complete command exactly once', async t => {
  const { sound } = await fixture(t); await sound.start(); const instructions = [];
  sound.events.on('instruction', value => instructions.push(value));
  sound.armCapture(); sound.pushAudio(pcm(1000, true));
  sound.handleResult({ result: { utterances: [utterance('总结一下刚才的观', 100, 900, false)] } });
  sound.finishCapture(); assert.equal(instructions.length, 0);
  sound.handleResult({ result: { utterances: [utterance('总结一下刚才的观点。', 80, 1000)] } });
  assert.equal(instructions.length, 1); assert.equal(instructions[0].text, '总结一下刚才的观点。');
  assert.equal(sound.capture.status, 'idle'); assert.equal(sound.utterances.length, 1);
  sound.handleResult({ result: { utterances: [utterance('迟到的旧草稿', 100, 1050, false)] } });
  assert.equal(sound.utterances.length, 1); assert.equal(sound.utterances[0].definite, true);
  assert.equal(instructions.length, 1);
});

test('shifted drafts and split finals preserve neighboring sentences and wait for a real final tail', async t => {
  const { sound } = await fixture(t); await sound.start(); const instructions = [];
  sound.events.on('instruction', value => instructions.push(value));
  sound.armCapture(); sound.pushAudio(pcm(1000, true));
  sound.handleResult({ result: { utterances: [utterance('总结旧稿', 10, 300, false)] } });
  sound.handleResult({ result: { utterances: [utterance('总结新稿', 20, 400, false)] } });
  assert.equal(sound.utterances.length, 1);
  sound.finishCapture();
  sound.handleResult({ result: { utterances: [utterance('总结一下', 0, 400), utterance('刚才的观', 420, 900, false)] } });
  assert.equal(instructions.length, 0); assert.equal(sound.capture.status, 'finishing');
  sound.handleResult({ result: { utterances: [utterance('刚才的观点。', 400, 1000)] } });
  assert.equal(instructions[0].text, '总结一下刚才的观点。'); assert.equal(sound.utterances.length, 2);
});

test('revised start across the button boundary still excludes background words', async t => {
  const { sound } = await fixture(t); await sound.start(); const instructions = [];
  sound.events.on('instruction', value => instructions.push(value));
  sound.pushAudio(pcm(200)); sound.armCapture(); sound.pushAudio(pcm(800, true));
  sound.handleResult({ result: { utterances: [utterance('背景总结', 50, 900, false)] } });
  sound.finishCapture();
  sound.handleResult({ result: { utterances: [utterance('背景总结一下刚才的观点', 0, 1000, true, [
    { text: '背景', start_time: 0, end_time: 190 }, { text: '总结一下刚才的观点', start_time: 220, end_time: 1000 },
  ])] } });
  assert.equal(instructions.length, 1); assert.equal(instructions[0].text, '总结一下刚才的观点');
});
