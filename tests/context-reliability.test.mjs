import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextSystem, LIMITS } from '../src/context/index.mjs';

const root = () => mkdtemp(join(tmpdir(), 'mooting-durable-'));
const utter = (text, start_time = 1) => ({ text, start_time, definite: true });
function offlineBridge(overrides = {}) {
  return Object.assign(new EventEmitter(), {
    ready: false, status: 'offline',
    async listMemories() { return { items: [], total: 0 }; },
    async refreshMentalModel() {},
    async mentalModel() { throw new Error('not refreshed'); },
    ...overrides,
  });
}

test('Context trace persists complete history while state sends only a bounded live tail', async () => {
  const directory = await root();
  const context = new ContextSystem({ dataRoot: directory });
  await context.ready;
  for (let index = 0; index < 225; index++) context.traceEvent('test.step', { index });
  context.observe({ status: 'running', utterances: [utter('今天讨论王磊的原型。')] });
  context.recordTurn({ inputId: 'turn-1', user: '总结讨论', assistant: '好的' });
  await context.idle();
  const full = await context.traceHistory();
  assert.ok(full.length > 225);
  assert.equal(context.state().trace.length, 200);
  assert.equal(context.state().traceCount, full.at(-1).seq);
  assert.ok(full.some(entry => entry.type === 'speech.final' && entry.data.text.includes('王磊')));
  assert.ok(full.some(entry => entry.type === 'turn.queued' && entry.data.inputId === 'turn-1'));
  const loaded = new ContextSystem({ dataRoot: directory });
  await loaded.ready;
  assert.equal((await loaded.traceHistory()).length, full.length + 2);
  assert.equal(loaded.state().trace.length, 200);
  await context.dispose(); await loaded.dispose();
});

test('deleting the final memory still produces a replacement snapshot', async () => {
  const context = new ContextSystem({ dataRoot: await root() });
  await context.ready;
  context.command('记住我喜欢红茶');
  context.command('忘掉红茶');
  const compiled = context.compile('');
  assert.match(compiled, /之前的记忆快照已失效/);
  assert.doesNotMatch(compiled, /红茶/);
  await context.dispose();
});

test('a deletion made offline survives restart and is replayed before new retains', async () => {
  const directory = await root();
  const first = new ContextSystem({ dataRoot: directory });
  await first.ready;
  first.command('记住我对花生过敏');
  first.command('忘掉花生过敏');
  assert.equal(first.batches.length, 0, '未提交的旧内容也应取消');
  assert.equal(first.cache.tombstones[0].pending, true);
  await first.dispose();
  const calls = [];
  const bridge = offlineBridge({
    ready: true, status: 'ready',
    async deleteDocument(id) { calls.push(['delete', id]); },
    async retain(content) { calls.push(['retain', content]); return {}; },
  });
  const second = new ContextSystem({ dataRoot: directory, bridge });
  await second.ready; await second.idle();
  assert.equal(second.cache.tombstones[0].pending, false);
  assert.ok(calls.some(([kind]) => kind === 'delete'));
  assert.ok(!calls.some(([kind]) => kind === 'retain'));
  second.recordTurn({ user: '忘掉花生过敏', assistant: '好的，已忘记花生过敏。' });
  assert.equal(second.items.length, 0, '忘记指令和助手确认不能重新存回被删除的事实');
  await second.dispose();
});

test('correction immediately masks stale profile, people, recent speech and search results', async () => {
  const bridge = offlineBridge({
    async recall() { return { results: [{ text: '王磊是医生。' }, { text: '王磊是产品经理。' }] }; },
  });
  const context = new ContextSystem({ dataRoot: await root(), bridge });
  await context.ready;
  context.cache.models = {
    'user-profile': { content: '王磊是医生。\n用户住在杭州。' },
    'open-items': { content: '约王磊去医院看病。' },
    people: { people: [{ name: '王磊', occupation: '医生', aliases: [] }] },
  };
  context.observe({ status: 'running', utterances: [utter('王磊是医生。')] });
  context.command('不对，王磊是产品经理');
  const compiled = context.compile('王磊做什么工作');
  assert.match(compiled, /王磊是产品经理/);
  assert.doesNotMatch(compiled, /医生|医院/);
  assert.match(compiled, /用户住在杭州/);
  bridge.ready = true;
  const result = await context.search('王磊');
  assert.deepEqual(result.results.map(item => item.text), ['王磊是产品经理。']);
  bridge.ready = false;
  await context.dispose();
});

test('explicit memory cannot force an ordinary stream flush during a Router turn', async () => {
  const calls = [];
  const bridge = offlineBridge({ ready: true, status: 'ready', async retain(content, options) { calls.push({ content, options }); return {}; } });
  const context = new ContextSystem({ dataRoot: await root(), bridge });
  await context.ready; await context.idle();
  context.setRouterBusy(true);
  context.observe({ status: 'running', utterances: [utter('普通对话还没攒够。')] });
  context.command('记住我喜欢红茶');
  await context.idle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.async, false);
  assert.match(calls[0].content, /红茶/);
  assert.equal(context.items.length, 1);
  context.setRouterBusy(false); await context.idle();
  assert.equal(calls.length, 2);
  await context.dispose();
});

test('submitted async retain stays durable until the server reports completion', async () => {
  const directory = await root();
  let retained = 0, status = 'processing';
  const bridge = offlineBridge({
    ready: true, status: 'ready',
    async retain() { retained++; return { operation_id: 'server-job' }; },
    async operation() { return { status }; },
  });
  const context = new ContextSystem({ dataRoot: directory, bridge });
  await context.ready; await context.idle();
  context.observe({ status: 'running', utterances: [utter('后台抽取要等完成。')] });
  await context.flush();
  assert.equal(context.state().outbox, 1);
  const persisted = await readFile(join(directory, 'hindsight-outbox.jsonl'), 'utf8');
  assert.match(persisted, /server-job/);
  await context.flush();
  assert.equal(retained, 1, '已提交的任务只检查状态，不重复追加');
  status = 'completed';
  await context.flush();
  assert.equal(context.state().outbox, 0);
  assert.equal((await readFile(join(directory, 'hindsight-outbox.jsonl'), 'utf8')).trim(), '');
  await context.dispose();
});

test('recent budget applies to the combined RAM and on-screen background, including a long last utterance', async () => {
  const context = new ContextSystem({ dataRoot: await root() });
  await context.ready;
  context.observe({ status: 'running', utterances: [utter('长'.repeat(4000))] });
  assert.ok(context.recent().length > 0, '单句超长时仍保留截断后的最近一句');
  const text = context.compile('总结', { extra: Array.from({ length: 100 }, (_, i) => `${i}屏幕上的话`.repeat(30)).join('\n') });
  const body = text.split('## 最近原话')[1].split('\n').slice(1).join('\n');
  assert.ok(Array.from(body).length <= LIMITS.recentChars);
  assert.ok(body.split('\n').length <= LIMITS.recentCount);
  await context.dispose();
});

test('acknowledgement polling leaves a new small stream batch for its normal triggers', async () => {
  let retained = 0;
  const bridge = offlineBridge({
    ready: true, status: 'ready',
    async retain() { return { operation_id: `job-${++retained}` }; },
    async operation() { return { status: 'completed' }; },
  });
  const context = new ContextSystem({ dataRoot: await root(), bridge });
  await context.ready; await context.idle();
  context.observe({ status: 'running', utterances: [utter('第一批语音')] });
  await context.flush({ reason: 'volume' });
  context.observe({ status: 'running', utterances: [utter('下一批的第一句', 2)] });
  const silenceTimer = context.silenceTimer;
  await context.flush({ reason: 'retry' });
  assert.equal(retained, 1, '确认完成不会另发一个小批次');
  assert.equal(context.items.length, 1, '新句子保留在未封批区域');
  assert.equal(context.silenceTimer, silenceTimer, '状态检查不能取消静默触发');
  assert.equal(context.retryDelay, 5000, '正常状态检查不能抬高失败退避');
  await context.dispose();
});

test('cache persistence failure blocks a remote write until durable storage recovers', async () => {
  let retains = 0;
  const bridge = offlineBridge({ ready: true, status: 'ready', async retain() { retains++; return {}; } });
  const context = new ContextSystem({ dataRoot: await root(), bridge });
  await context.ready; await context.idle();
  const cachePath = context.cachePath;
  context.cachePath = join(context.dataRoot, 'missing-directory', 'memory-cache.json');
  context.command('记住我喜欢红茶');
  await context.idle();
  assert.equal(retains, 0);
  assert.equal(context.state().outbox, 1);
  assert.equal(context.lastFlush.result, 'failed');
  context.cachePath = cachePath;
  await context.flush();
  assert.equal(retains, 1);
  assert.equal(context.state().outbox, 0);
  await context.dispose();
});

test('a failed derived-model refresh keeps the tombstone pending for replay', async () => {
  let failRefresh = true, refreshes = 0;
  const bridge = offlineBridge({
    ready: true, status: 'ready',
    async refreshMentalModel() { refreshes++; if (failRefresh) throw new Error('refresh unavailable'); },
  });
  const context = new ContextSystem({ dataRoot: await root(), bridge });
  await context.ready; await context.idle();
  context.command('忘掉上海出差');
  await context.idle();
  assert.equal(context.cache.tombstones[0].pending, true);
  failRefresh = false;
  await context.flush();
  assert.equal(context.cache.tombstones[0].pending, false);
  assert.equal(refreshes, 4);
  await context.dispose();
});

test('the finalized tail arriving during ASR stopping is preserved', async () => {
  const context = new ContextSystem({ dataRoot: await root() });
  await context.ready;
  context.observe({ status: 'stopping', utterances: [utter('暂停时的最后一句。')] });
  assert.match(context.compile(''), /暂停时的最后一句/);
  await context.dispose();
});
