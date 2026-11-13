import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const capture = await readFile(new URL('../web/audio-capture.js', import.meta.url), 'utf8');
const worklet = (await readFile(new URL('../web/audio-worklet.js', import.meta.url), 'utf8')).replace("import './audio-capture.js';", '');

test('worklet checkpoints flush audio before exact sample boundary without stopping stream', () => {
  const messages = []; let Processor;
  class Base { constructor() { this.port = { postMessage: data => messages.push(data), onmessage: null }; } }
  const scope = { Float32Array, ArrayBuffer, DataView, sampleRate: 48000, AudioWorkletProcessor: Base, registerProcessor: (name, value) => { assert.equal(name, 'sound2text-pcm'); Processor = value; } };
  vm.runInNewContext(capture, scope); vm.runInNewContext(worklet, scope);
  const processor = new Processor(), block = new Float32Array(128).fill(.2), silent = new Float32Array(128);
  for (let index = 0; index < 25; index++) processor.process([[block]], [[silent]]);
  assert.ok(silent.every(value => value === 0), 'microphone is never played back');
  processor.port.onmessage({ data: { type: 'checkpoint', id: 7 } });
  assert.ok(messages[0] instanceof ArrayBuffer);
  const checkpoint = messages.at(-1); assert.equal(checkpoint.type, 'checkpoint'); assert.equal(checkpoint.id, 7);
  assert.equal(checkpoint.audioMs, Math.floor(3200 / 3) / 16);
  const count = messages.length;
  for (let index = 0; index < 75; index++) processor.process([[block]], [[silent]]);
  assert.ok(messages.length > count, 'capture keeps uploading after a checkpoint');
  processor.port.onmessage({ data: { type: 'flush' } });
  assert.equal(messages.at(-1).type, 'flushed');
  const final = messages.length; processor.process([[block]], [[silent]]); assert.equal(messages.length, final);
});
