import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readModelEnv } from '../src/model-env.mjs';
import { loadHindsightConfig } from '../src/context/hindsight.mjs';
import { ContextSystem, commandFromPrompt } from '../src/context/index.mjs';
import { harness } from './harness.mjs';
import { toolChunks, textChunks, MockRouterAdapter } from './mock-router-adapter.mjs';
import { testBridge, ENV_PATH, TEST_PROFILE, TEST_PORT } from './hindsight-live.mjs';

/**
 * Real Hindsight: profile mooting-test on port 9078, one bank per run, deleted afterwards.
 * Calls the real LLM configured in .env. Without that configuration the whole file is reported as skipped.
 */
const env = await readModelEnv(ENV_PATH);
const live = (() => { try { return loadHindsightConfig({ ...process.env, ...env }); } catch { return { configured: false }; } })();
const skip = live.configured && live.enabled ? false : '未配置 Hindsight LLM（MOOTING_CONTEXT_* 或 MOOTING_HINDSIGHT_LLM_*），记忆测试跳过，不算通过';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, { timeoutMs = 240_000, everyMs = 2_000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待${label}超时`);
    await wait(everyMs);
  }
}
async function settled(bridge, label) {
  await until(async () => {
    const ops = await bridge.operations();
    const failed = (ops.operations ?? []).filter(op => op.status === 'failed');
    assert.deepEqual(failed.map(op => op.error_message), [], 'Hindsight 后台任务失败');
    return !(ops.operations ?? []).some(op => ['pending', 'processing', 'running', 'queued'].includes(op.status));
  }, { label: `${label}后台任务完成`, timeoutMs: 600_000 });
}
const utter = (text, start) => ({ text, definite: true, start_time: start, end_time: start + 1 });

test('real hindsight memory', { skip, timeout: 30 * 60_000 }, async t => {
  const bridge = testBridge();
  let context;
  t.after(async () => {
    try {
      await context?.dispose();
      if (!bridge.ready && bridge.server) { await bridge.server.start(); await bridge.probe(); }
      if (bridge.ready) await bridge.deleteBank();
    } finally { await bridge.stop(); }
  });
  await bridge.start();
  assert.equal(bridge.status, 'ready', `测试守护进程未就绪：${bridge.error}`);
  const root = await mkdtemp(join(tmpdir(), 'mooting-live-'));
  context = new ContextSystem({ dataRoot: root, bridge, limits: { silenceMs: 60_000 } });
  await context.ready;
  let streamDocumentId, streamBatch;

  await t.test('stream utterances are readable at once and land in Hindsight after flush', async () => {
    context.observe({ status: 'running', utterances: [utter('我同事王磊是产品经理，大家都叫他磊哥。', 1), utter('磊哥下周五要交付语音助手的原型。', 2)] });
    assert.match(context.compile(''), /磊哥下周五/);
    context.setRouterBusy(true);
    context.voicePaused();
    await context.idle();
    assert.equal(context.state().outbox, 2, 'Router 在跑时不写');
    context.setRouterBusy(false);
    await context.idle();
    streamBatch = structuredClone(context.batches.find(batch => batch.kind === 'stream'));
    streamDocumentId = streamBatch?.documentId;
    assert.ok(streamDocumentId);
    await settled(bridge, '写入');
    await context.flush({ reason: 'reconcile' });
    assert.equal(context.state().outbox, 0);
    assert.equal(context.state().lastFlush.result, 'ok');
    const found = await context.search('王磊是做什么的');
    assert.equal(found.available, true);
    assert.ok(found.results.some(item => /产品经理/.test(item.text)), JSON.stringify(found));
  });

  await t.test('appending to the same document does not duplicate memories', async () => {
    const before = (await bridge.listMemories({ limit: 200, type: 'world' })).total;
    context.observe({ status: 'running', utterances: [utter('我住在杭州，平时喜欢喝美式咖啡。', 3)] });
    await context.flush({ reason: 'test' });
    await settled(bridge, '追加');
    await context.flush({ reason: 'reconcile' });
    const list = await bridge.listMemories({ limit: 200, type: 'world' });
    const texts = list.items.map(item => item.text);
    assert.ok(texts.some(text => /杭州/.test(text)));
    const document = await bridge.document(streamDocumentId);
    assert.equal((document.original_text.match(/我同事王磊是产品经理/g) ?? []).length, 1, '追加后的原始文档应只包含一次第一批内容');
    assert.equal((document.original_text.match(/我住在杭州/g) ?? []).length, 1, '追加内容应只出现一次');
    const replay = await bridge.retain(streamBatch.content, { documentId: streamDocumentId, operationId: streamBatch.operationId, updateMode: 'append', async: true, timestamp: streamBatch.timestamp, context: streamBatch.context });
    assert.equal((await bridge.operation(replay.operation_id)).status, 'completed');
    assert.equal((await bridge.document(streamDocumentId)).original_text, document.original_text, '相同 operation_id 重放不得再次追加原话');
    assert.ok(list.total >= before);
  });

  await t.test('outbox survives a daemon restart and replays', async () => {
    await bridge.server.stop();
    await until(async () => !(await bridge.server.checkHealth()), { label: '守护进程停止', timeoutMs: 30_000, everyMs: 500 });
    await bridge.probe();
    assert.equal(bridge.status, 'offline');
    assert.equal(context.state().status, 'offline');
    const search = await context.search('王磊');
    assert.equal(search.available, false);
    assert.match(context.compile(''), /最近原话/, '离线时仍注入最近原话');
    context.observe({ status: 'running', utterances: [utter('李娜是我大学同学，现在在协和医院当医生。', 4)] });
    await context.flush({ reason: 'offline' });
    assert.equal(context.state().outbox, 1);
    await context.idle();
    assert.match(await readFile(join(root, 'hindsight-outbox.jsonl'), 'utf8'), /李娜/);
    await bridge.server.start();
    await bridge.probe();
    assert.equal(bridge.status, 'ready');
    await until(async () => { await context.flush({ reason: 'reconcile' }); return context.state().outbox === 0; }, { label: 'outbox 重放', timeoutMs: 120_000, everyMs: 2_000 });
    await settled(bridge, '重放');
    const found = await context.search('李娜的职业');
    assert.ok(found.results.some(item => /医生/.test(item.text)), JSON.stringify(found));
  });

  await t.test('mental models refresh into the local cache and people match by name', async () => {
    for (const id of ['user-profile', 'people', 'open-items']) await bridge.refreshMentalModel(id);
    await settled(bridge, 'mental model 刷新');
    assert.equal(await context.refreshCache(), true);
    const cache = JSON.parse(await readFile(join(root, 'memory-cache.json'), 'utf8'));
    assert.ok(cache.models.people.content.length > 0, '人物关系表应有内容');
    const people = cache.models.people.people;
    console.log('people structured output', JSON.stringify(people));
    assert.ok(people.some(person => /王磊/.test(person.name) || (person.aliases ?? []).some(alias => /磊/.test(alias))), JSON.stringify(people));
    const text = context.compile('帮我问问王磊原型进度');
    assert.match(text, /## 相关人物/);
    assert.match(text.split('## 相关人物')[1], /王磊/);
    assert.match(text, /## 用户档案|## 进行中事项/);
  });

  await t.test('explicit memory is retained synchronously and a tombstone removes it from injection and search', async () => {
    context.command('记住我对花生过敏');
    assert.match(context.compile(''), /花生过敏/);
    await context.idle();
    const found = await context.search('用户对什么过敏');
    assert.ok(found.results.some(item => /花生/.test(item.text)), JSON.stringify(found));
    context.command('忘掉花生过敏');
    assert.doesNotMatch(context.compile(''), /花生过敏/);
    await context.idle();
    const after = await context.search('用户对什么过敏');
    assert.ok(!after.results.some(item => /花生过敏/.test(item.text)), JSON.stringify(after));
  });

  await t.test('memory_search times out to an empty result', async () => {
    const quick = new ContextSystem({ dataRoot: await mkdtemp(join(tmpdir(), 'mooting-live-')), bridge, limits: { searchTimeoutMs: 1 } });
    await quick.ready;
    const result = await quick.search('王磊');
    assert.deepEqual(result.results, []);
    assert.match(result.note, /超时/);
    await quick.dispose();
  });

  await t.test('router tools: memory_search inline, memory_reflect in the background wakes the Router', async sub => {
    const adapter = new MockRouterAdapter();
    const script = new Map([
      ['王磊是做什么的', [toolChunks('memory_search', { query: '王磊的职业' }), result => textChunks(result.results?.some(item => /产品经理/.test(item.text)) ? '王磊是产品经理。' : '记忆里没有。')]],
      ['总结一下王磊的事', [toolChunks('memory_reflect', { query: '总结一下王磊的情况' }), result => textChunks(result.say ?? '失败')]],
    ]);
    adapter.stream = async function* (options) {
      const last = options.messages.at(-1);
      const userText = message => (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
      const lastUser = [...options.messages].reverse().find(message => message.role === 'user' && !userText(message).startsWith(context.compile('').slice(0, 10)) && !/^记忆可能滞后|^Current runtime/.test(userText(message)));
      const instruction = commandFromPrompt(userText(lastUser ?? {}));
      if (instruction.startsWith('后台记忆回想已完成')) { yield* textChunks(instruction.includes('回想结果') ? '王磊是产品经理，下周五交付原型。' : '回想失败。'); return; }
      const steps = script.get(instruction) ?? [textChunks('好的')];
      const chunks = last?.role === 'tool' ? steps[1](JSON.parse(userText(last))) : steps[0];
      for (const chunk of chunks) yield chunk;
    };
    const h = await harness({ adapter, context });
    sub.after(() => h.dispose());
    await h.runtime.submit({ instruction: '王磊是做什么的' });
    await h.runtime.idle();
    assert.ok(h.runtime.trace.some(event => event.type === 'router.answer' && event.data.text === '王磊是产品经理。'));
    await h.runtime.submit({ instruction: '总结一下王磊的事' });
    await h.runtime.idle();
    const reflected = h.runtime.trace.filter(event => event.type === 'memory.reflect');
    assert.ok(reflected.some(event => event.data.status === 'completed' && event.data.answer), JSON.stringify(reflected));
    assert.ok(h.runtime.trace.some(event => event.type === 'router.answer' && /下周五/.test(event.data.text)), 'Worker 回报应唤醒 Router');
    assert.ok(h.runtime.trace.some(event => event.type === 'dsh.user/message' && event.data.source?.kind === 'mooting-memory-report'), 'Worker 回报应成为独立回合');
    assert.ok(context.items.some(item => item.report) || context.batches.some(item => /后台记忆查询回报/.test(item.content)), 'Worker 回报唤醒的那一轮也写入');
    await context.flush({ reason: 'test' });
    await until(async () => { await context.flush({ reason: 'reconcile' }); return context.state().outbox === 0; }, { label: 'Router 回合写入', timeoutMs: 180_000 });
  });
});

test('hindsight test settings stay off the production profile', () => {
  assert.equal(TEST_PROFILE, 'mooting-test');
  assert.equal(TEST_PORT, 9078);
});
