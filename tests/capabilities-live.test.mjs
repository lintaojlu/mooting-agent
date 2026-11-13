import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCapabilities, subtitleText } from '../src/capabilities.mjs';
import CapabilitiesPlugin from '../src/capabilities-plugin.mjs';
import { TaskManager, snapshotInput } from '../src/tasks.mjs';
import { FakeSound2text } from './fake-sound2text.mjs';

function registry() {
  const capabilities = new Map();
  return { capabilities, register(value) { capabilities.set(value.id, value); return () => capabilities.delete(value.id); } };
}
const snapshot = Object.freeze({ instruction: '请解释这个概念', context: Object.freeze([{ speaker: '用户', text: '什么是红筹架构', kind: 'speech' }]) });

test('business workers forward exact instruction, Context, capability and signal to model', async () => {
  const manager = registry(), calls = [], controller = new AbortController();
  const dispose = registerCapabilities(manager, { runModel: async request => { calls.push(request); return { text: '真实模型接口结果', model: 'configured-model' }; } });
  for (const id of ['summarize_context', 'explain_term', 'general_assistant']) {
    assert.equal(manager.capabilities.get(id).executionKind, 'model');
    const handle = await manager.capabilities.get(id).start({ snapshot, signal: controller.signal });
    assert.deepEqual(handle.result, { text: '真实模型接口结果', model: 'configured-model', simulated: false });
    const request = calls.at(-1);
    assert.equal(request.instruction, snapshot.instruction); assert.equal(request.context, snapshot.context);
    assert.equal(request.capability, id); assert.equal(request.signal, controller.signal);
  }
  assert.equal(calls.length, 3); dispose(); assert.equal(manager.capabilities.size, 0);
});

test('abort before execution does not call model', async () => {
  const manager = registry(), controller = new AbortController(); let calls = 0;
  registerCapabilities(manager, { runModel: async () => { calls++; return { text: 'unused' }; } });
  controller.abort();
  await assert.rejects(manager.capabilities.get('general_assistant').start({ snapshot, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('abort during model execution reaches model and suppresses late results', async () => {
  const manager = registry(), controller = new AbortController(); let received;
  registerCapabilities(manager, { runModel: async ({ signal }) => { received = signal; controller.abort(); return { text: 'late output' }; } });
  await assert.rejects(manager.capabilities.get('summarize_context').start({ snapshot, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(received, controller.signal);
});

test('model errors and missing text never become fake successful results', async () => {
  const manager = registry(), failure = new Error('provider unavailable');
  registerCapabilities(manager, { runModel: async () => { throw failure; } });
  await assert.rejects(manager.capabilities.get('explain_term').start({ snapshot }), error => error === failure);
  const empty = registry(); registerCapabilities(empty, { runModel: async () => ({ text: ' ' }) });
  await assert.rejects(empty.capabilities.get('summarize_context').start({ snapshot }), /有效文本/);
  assert.throws(() => registerCapabilities(registry()), /runModel/);
});

test('subtitle consumes real recognition updates, revisions and stops on source loss', async () => {
  const manager = registry(), sound2text = new FakeSound2text(), published = [], ended = [];
  const unregister = registerCapabilities(manager, { sound2text, runModel: async () => { throw new Error('字幕不调用模型'); } });
  const handle = await manager.capabilities.get('realtime_subtitle').start({ publish: text => published.push(text), onEnded: reason => ended.push(reason) });
  handle.begin(); assert.equal(published.length, 0);
  sound2text.update({ text: '修订后的真实字幕', utterances: [{ start_time: 10, end_time: 100, text: '修订后的真实字幕' }] }); assert.equal(published.at(-1), '修订后的真实字幕');
  await sound2text.pause(); assert.deepEqual(ended, ['sound2text_stopped']);
  sound2text.update({ text: '迟到文本' }); assert.equal(published.at(-1), '修订后的真实字幕');
  await handle.dispose(); unregister();
});

test('subtitle unavailable raises an explicit Worker error rather than fake frames', async () => {
  const manager = registry(), sound2text = new FakeSound2text(); sound2text.update({ status: 'stopped' });
  registerCapabilities(manager, { sound2text, runModel: async () => ({ text: 'unused' }) });
  await assert.rejects(manager.capabilities.get('realtime_subtitle').start({ publish() {} }), /先开启语音输入/);
});

test('production capability plugin injects model service and delegates execution', async () => {
  assert.deepEqual(CapabilitiesPlugin.inject, ['mootingWorkers', 'mootingModels', 'sound2text']);
  const manager = registry(); let request;
  const executeWorker = async value => { request = value; return { text: 'service output' }; };
  const { Context, Service } = await import('@deepseek-ai/cordis');
  const root = new Context();
  class Workers extends Service { constructor(scope) { super(scope, 'mootingWorkers'); this.manager = manager; } }
  class Models extends Service { constructor(scope) { super(scope, 'mootingModels'); this.executeWorker = executeWorker; } }
  class Sound extends Service { constructor(scope) { super(scope, 'sound2text'); this.state = () => ({ status: 'stopped' }); } }
  try {
    await root.plugin(Sound); await root.plugin(Workers); await root.plugin(Models); const fiber = root.plugin(CapabilitiesPlugin);
    await fiber;
    const result = await manager.capabilities.get('general_assistant').start({ snapshot });
    assert.equal(request.capability, 'general_assistant'); assert.equal(result.result.simulated, false);
    assert.equal(result.result.text, 'service output');
    await fiber.dispose(); assert.equal(manager.capabilities.size, 0);
  } finally { await root.fiber.dispose(); }
});




test('subtitle starts at activation time, splits sentences and accepts revisions without old transcript', () => {
  const history = [
    { start_time: 0, end_time: 900, text: '旧的句子。' },
    { start_time: 900, end_time: 1300, text: '旧词新词', words: [{ start_time: 900, text: '旧词' }, { start_time: 1100, text: '新词' }] },
    { start_time: 1400, end_time: 2000, text: '第一句。第二句！第三句？' },
  ];
  assert.equal(subtitleText(history, 1000), '新词\n第一句。\n第二句！\n第三句？');
  assert.equal(subtitleText([{ start_time: 0, end_time: 1300, text: '没有时间词就不混入旧句' }], 1000), '');
  history[2].text = '修订后的第一句。';
  assert.equal(subtitleText(history, 1000), '新词\n修订后的第一句。');
});


test('simulated speaker card stays active until closed and switches cleanly with subtitles', async () => {
  const speakers = [], subtitles = [];
  const manager = new TaskManager({ emit() {}, speaker: value => speakers.push(value), subtitle: value => subtitles.push(value) });
  registerCapabilities(manager, { sound2text: new FakeSound2text(), runModel: async () => { throw new Error('program capability must not call model'); } });
  const input = snapshotInput({ instruction: '识别面前说话人' });
  const start = capability => manager.start({ capability, execution_kind: 'program' }, input);
  try {
    const task = await start('speaker_identification');
    assert.equal(task.status, 'running'); assert.equal(task.result.simulated, true);
    assert.deepEqual(speakers.at(-1).person, {
      name: 'John',
      identity: '空间折叠负责人；AI创业者',
      notes: [
        '上次聊过如何构建高时效性的AgentOS。',
        '对于新AI终端的出现坚定不移。',
        '创立了一家人文科技公司“空间折叠”。',
      ],
    });
    assert.equal(speakers.at(-1).simulated, true); assert.equal(subtitles.length, 0);
    await manager.interrupt();
    assert.equal(speakers.at(-1).active, false); assert.equal(speakers.at(-1).person, null);
    assert.equal(manager.tasks()[0].status, 'completed');
    await start('realtime_subtitle'); assert.equal(subtitles.at(-1).active, true);
    await start('speaker_identification');
    assert.equal(subtitles.at(-1).active, false); assert.equal(speakers.at(-1).active, true);
    await start('realtime_subtitle');
    assert.equal(speakers.at(-1).active, false); assert.equal(subtitles.at(-1).active, true);
  } finally { await manager.dispose(); }
});
