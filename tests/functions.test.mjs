import test from 'node:test';
import assert from 'node:assert/strict';
import { FunctionPanel, SPEAKER_PERSON } from '../src/functions.mjs';
import { FakeSound2text } from './fake-sound2text.mjs';

const panel = () => new FunctionPanel({ sound2text: new FakeSound2text() });

test('opening another function reports close_first and leaves the panel', async () => {
  const functions = panel();
  const opened = await functions.open('subtitle');
  assert.equal(opened.opened, true);
  const blocked = await functions.open('speaker');
  assert.equal(blocked.opened, false);
  assert.equal(blocked.close_first, 'close_subtitle');
  assert.equal(functions.active, 'subtitle');
  await functions.close('subtitle');
  const speaker = await functions.open('speaker');
  assert.equal(speaker.say, `面前是${SPEAKER_PERSON.name}，${SPEAKER_PERSON.identity}。`);
  assert.deepEqual(speaker.person.notes, [...SPEAKER_PERSON.notes]);
  assert.ok(!speaker.say.includes(SPEAKER_PERSON.notes[0]));
  assert.equal(JSON.stringify(speaker).includes('模拟'), false);
});

test('opening and closing the same function again keeps the current state', async () => {
  const functions = panel();
  await functions.open('speaker');
  const again = await functions.open('speaker');
  assert.equal(again.already, true);
  assert.equal(functions.active, 'speaker');
  const closed = await functions.close('speaker');
  assert.equal(closed.say, '说话人识别已关闭。');
  const repeat = await functions.close('speaker');
  assert.equal(repeat.already, true);
  assert.equal(functions.active, null);
});

test('a close that arrives before the open returns does not show the panel', async () => {
  const functions = panel();
  const pending = functions.open('speaker');
  const closed = functions.closeShown();
  const result = await pending;
  assert.equal(closed.stopped, false);
  assert.equal(result.cancelled, true);
  assert.equal(functions.active, null);
  assert.equal(functions.speaker.active, false);
});

test('aborting before the open returns does not show the panel', async () => {
  const functions = panel();
  const controller = new AbortController();
  const pending = functions.open('subtitle', controller.signal);
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(functions.subtitle.active, false);
});

test('stopping recognition closes the panel without a callback into the router', async () => {
  const sound = new FakeSound2text();
  const calls = [];
  const functions = new FunctionPanel({ sound2text: sound, onChange: () => calls.push(functions.active) });
  await functions.open('subtitle');
  sound.update({ status: 'stopped' });
  assert.equal(functions.active, null);
  assert.equal(functions.subtitle.active, false);
  assert.ok(calls.includes(null));
});

test('voice input must be running before subtitles open', async () => {
  const sound = new FakeSound2text();
  await sound.pause();
  const functions = new FunctionPanel({ sound2text: sound });
  const result = await functions.open('subtitle');
  assert.equal(result.opened, false);
  assert.match(result.error, /先开启语音输入/);
  assert.equal(functions.active, null);
});
