import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/audio-capture.js', import.meta.url), 'utf8');
const scope = { Float32Array, ArrayBuffer, DataView, setTimeout, clearTimeout }; vm.runInNewContext(source, scope);
const { PCMResampler, pcm16le, PCMPacketizer, AudioCapture } = scope.MootingAudio;
const rms = data => Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
function resample(rate, frequency, chunks = 128) {
  const converter = new PCMResampler(rate), samples = Float32Array.from({ length: rate }, (_, index) => Math.sin(2 * Math.PI * frequency * index / rate)), output = [];
  for (let index = 0; index < samples.length; index += chunks) output.push(...converter.process(samples.slice(index, index + chunks)));
  output.push(...converter.flush()); return Float32Array.from(output);
}

test('actual 48k and 44.1k input becomes exactly 16k mono samples with block-independent history', () => {
  for (const rate of [48000, 44100]) {
    const output = resample(rate, 1000), large = resample(rate, 1000, rate);
    assert.equal(output.length, 16000); assert.equal(large.length, output.length);
    assert.ok(output.every((value, index) => Math.abs(value - large[index]) < 1e-5));
    assert.ok(rms(output.slice(100, -100)) > .6);
  }
});
test('resampler suppresses out-of-band signal before downsampling', () => {
  const audible = rms(resample(48000, 1000).slice(100, -100)), high = rms(resample(48000, 12000).slice(100, -100));
  assert.ok(high < audible * .08, `out-of-band ratio ${high / audible}`);
});
test('PCM16 is signed little-endian, saturated and emitted in 200ms packets with a tail', () => {
  const bytes = pcm16le([-2, -.5, 0, .5, 2]);
  const view = new DataView(bytes); assert.deepEqual(Array.from({ length: 5 }, (_, i) => view.getInt16(i * 2, true)), [-32768, -16384, 0, 16384, 32767]);
  const packetizer = new PCMPacketizer(); assert.equal(packetizer.push(new Float32Array(1000)).length, 0);
  const packets = packetizer.push(new Float32Array(2300)); assert.equal(packets.length, 1); assert.equal(packets[0].byteLength, 6400);
  assert.equal(packetizer.flush().byteLength, 200); assert.equal(packetizer.flush(), null);
});

function environment({ denyPermission = false, serverError = false } = {}) {
  const sent = [], tracks = [], contexts = [], nodes = [], sockets = [];
  class AudioContext {
    constructor() { this.state = 'suspended'; this.sampleRate = 48000; this.audioWorklet = { addModule: async path => { assert.equal(path, '/audio-worklet.js'); } }; contexts.push(this); }
    async resume() { this.state = 'running'; } async close() { this.state = 'closed'; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  }
  class WorkletNode {
    constructor(_ctx, name) { assert.equal(name, 'sound2text-pcm'); this.port = { onmessage: null, postMessage: message => { queueMicrotask(() => this.port.onmessage?.({ data: message.type === 'checkpoint' ? { type: 'checkpoint', id: message.id, audioMs: 1234.5 } : { type: 'flushed' } })); } }; nodes.push(this); }
    connect() {} disconnect() { this.disconnected = true; }
  }
  class WebSocket {
    constructor(url) { assert.equal(url, 'ws://127.0.0.1:4317/api/sound2text/audio'); this.readyState = 0; this.bufferedAmount = 0; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(value) {
      sent.push(value); if (typeof value !== 'string') return;
      const message = JSON.parse(value);
      if (message.type === 'start') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(serverError ? { type: 'error', error: '缺少 API Key' } : { type: 'ready' }) }));
      if (message.type === 'pause') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'ack', action: 'pause' }) }));
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  return { sent, tracks, contexts, nodes, sockets, env: { setTimeout, clearTimeout, AudioContext, AudioWorkletNode: WorkletNode, WebSocket, location: { protocol: 'http:', host: '127.0.0.1:4317' }, navigator: { mediaDevices: { async getUserMedia() { if (denyPermission) { const error = new Error('denied'); error.name = 'NotAllowedError'; throw error; } const track = { stopped: false, stop() { this.stopped = true; } }; tracks.push(track); return { getTracks: () => [track] }; } } } } };
}
test('microphone opens backend stream before sending PCM and pause releases all resources', async () => {
  const fixture = environment(), states = [];
  const capture = new AudioCapture({ environment: fixture.env, onStatus: status => states.push(status) });
  await capture.start(); assert.equal(capture.status, 'running');
  assert.equal(await capture.checkpoint(), 1234.5); assert.equal(fixture.sent.length, 1);
  const bytes = new ArrayBuffer(6400); fixture.nodes[0].port.onmessage({ data: bytes }); assert.equal(fixture.sent[1], bytes);
  await capture.pause(); assert.equal(capture.status, 'idle');
  const controls = fixture.sent.filter(value => typeof value === 'string').map(value => JSON.parse(value).type);
  assert.deepEqual(controls, ['start', 'cancel_capture', 'pause']);
  assert.ok(fixture.tracks.every(track => track.stopped)); assert.ok(fixture.contexts.every(context => context.state === 'closed'));
  assert.ok(fixture.nodes[0].disconnected); assert.equal(fixture.sockets[0].readyState, 3);
  assert.deepEqual(states, ['connecting', 'running', 'stopping', 'idle']);
});
test('permission rejection and missing server config clean up devices without a mock result', async () => {
  for (const config of [{ denyPermission: true }, { serverError: true }]) {
    const fixture = environment(config), capture = new AudioCapture({ environment: fixture.env });
    await assert.rejects(capture.start(), config.denyPermission ? /麦克风权限/ : /API Key/);
    assert.equal(capture.status, 'idle'); assert.ok(fixture.tracks.every(track => track.stopped)); assert.ok(fixture.contexts.every(context => context.state === 'closed'));
  }
});
test('upload backpressure stops microphone and reports failure', async () => {
  const fixture = environment(); let reported;
  const capture = new AudioCapture({ environment: fixture.env, onError: error => { reported = error; } });
  await capture.start(); fixture.sockets[0].bufferedAmount = 300000;
  fixture.nodes[0].port.onmessage({ data: new ArrayBuffer(6400) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(capture.status, 'idle'); assert.match(reported, /上传积压/); assert.ok(fixture.tracks[0].stopped);
});
