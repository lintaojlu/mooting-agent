import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ContextSystem, composeUserPrompt, commandFromPrompt, memoryCommand, LIMITS, MEMORY_NOTE } from '../src/context/index.mjs';
import { loadHindsightConfig, HindsightBridge, publicServiceSettings } from '../src/context/hindsight.mjs';
import { harness } from './harness.mjs';

const dir = () => mkdtemp(join(tmpdir(), 'mooting-context-'));
const utter = (text, start) => ({ text, definite: true, start_time: start, end_time: start + 1 });

test('a labeled speaker is stored as 名字：原文 and is not marked unconfirmed', async () => {
  const root = await dir();
  const context = new ContextSystem({ dataRoot: root });
  await context.ready;
  context.observe({ status: 'running', utterances: [{ text: '你好', definite: true, start_time: 1, end_time: 2, speaker: '张三' }] });
  assert.equal(context.fragments.at(-1).text, '张三：你好');
  context.seal();
  assert.match(context.batches.at(-1).content, /张三：你好/);
  assert.equal(context.batches.at(-1).content.includes('未确认说话人'), false);
  assert.equal(context.batches.at(-1).context, '现场对话，行首是说话人');
  await context.dispose();
});

test('composed prompt can recover the command', () => {
  assert.equal(commandFromPrompt(composeUserPrompt('# 记忆', '现在的命令')), '现在的命令');
  assert.equal(commandFromPrompt('直接的命令'), '直接的命令');
});

test('hindsight config maps .env, falls back to MOOTING_CONTEXT_* and keeps embedding and rerank local by default', () => {
  assert.equal(loadHindsightConfig({}).configured, false);
  const config = loadHindsightConfig({ MOOTING_CONTEXT_BASE_URL: 'https://llm.example/v1/', MOOTING_CONTEXT_MODEL: 'ctx', MOOTING_CONTEXT_API_KEY: 'k' });
  assert.equal(config.configured, true);
  assert.equal(config.port, 9077);
  assert.equal(config.daemonEnv.HINDSIGHT_API_LLM_PROVIDER, 'openai');
  assert.equal(config.daemonEnv.HINDSIGHT_API_LLM_BASE_URL, 'https://llm.example/v1');
  assert.equal(config.daemonEnv.HINDSIGHT_API_LLM_MODEL, 'ctx');
  assert.equal(config.daemonEnv.HINDSIGHT_API_LLM_API_KEY, 'k');
  assert.equal(config.daemonEnv.HINDSIGHT_API_EMBEDDINGS_PROVIDER, 'local');
  assert.equal(config.daemonEnv.HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL, 'BAAI/bge-m3');
  assert.equal(config.daemonEnv.HINDSIGHT_API_RERANKER_PROVIDER, 'local');
  assert.equal(config.daemonEnv.HINDSIGHT_API_RERANKER_LOCAL_MODEL, 'hindsight-ai/hs-rerank-1');
  assert.equal(config.daemonEnv.HINDSIGHT_API_HOST, '127.0.0.1');
  assert.match(config.daemonEnv.HINDSIGHT_API_LLM_OUTPUT_LANGUAGE, /中文/);
  const own = loadHindsightConfig({ MOOTING_CONTEXT_BASE_URL: 'https://a/v1', MOOTING_CONTEXT_MODEL: 'a', MOOTING_HINDSIGHT_LLM_BASE_URL: 'https://b/v1', MOOTING_HINDSIGHT_LLM_MODEL: 'b', MOOTING_HINDSIGHT_PORT: '9100',
    MOOTING_EMBEDDING_BASE_URL: 'https://e/v1', MOOTING_EMBEDDING_MODEL: 'emb', MOOTING_EMBEDDING_DIMENSIONS: '1024' });
  assert.equal(own.daemonEnv.HINDSIGHT_API_LLM_BASE_URL, 'https://b/v1');
  assert.equal(own.port, 9100);
  assert.equal(own.daemonEnv.HINDSIGHT_API_EMBEDDINGS_PROVIDER, 'openai');
  assert.equal(own.daemonEnv.HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL, 'emb');
  const shown = publicServiceSettings({ ...own, daemonEnv: { ...own.daemonEnv, HINDSIGHT_API_LLM_API_KEY: 'secret-key-should-not-leak', HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY: 'secret-key-should-not-leak' } });
  assert.equal(shown.embedding.mode, '远程');
  assert.equal(shown.embedding.model, 'emb');
  assert.equal(shown.embedding.hasApiKey, true);
  assert.equal(JSON.stringify(shown).includes('secret-key-should-not-leak'), false);
  assert.equal(publicServiceSettings(config).embedding.mode, '本地');
  assert.equal(own.daemonEnv.HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS, '1024');
  assert.equal(loadHindsightConfig({ MOOTING_CONTEXT_BASE_URL: 'https://a/v1', MOOTING_CONTEXT_MODEL: 'a', MOOTING_HINDSIGHT_ENABLED: '0' }).enabled, false);
  assert.throws(() => loadHindsightConfig({ MOOTING_HINDSIGHT_PORT: 'x' }), /PORT/);
});

test('unconfigured LLM never starts the daemon', async () => {
  const bridge = new HindsightBridge({ env: { MOOTING_CONTEXT_BASE_URL: '', MOOTING_CONTEXT_MODEL: '', MOOTING_HINDSIGHT_LLM_BASE_URL: '', MOOTING_HINDSIGHT_LLM_MODEL: '' } });
  await bridge.start();
  assert.equal(bridge.status, 'unconfigured');
  assert.equal(bridge.server, undefined);
  const context = new ContextSystem({ dataRoot: await dir(), bridge });
  await context.ready;
  assert.equal(context.state().status, 'unconfigured');
  assert.equal(context.state().configured, false);
  assert.deepEqual(await context.search('任何'), { available: false, results: [], note: '记忆服务不可用，只能依据注入的记忆和最近原话回答' });
  await context.dispose(); await bridge.stop();
});

test('memory commands are recognized', () => {
  assert.deepEqual(memoryCommand('记住我下周三去上海出差。'), { kind: 'remember', text: '我下周三去上海出差' });
  assert.deepEqual(memoryCommand('帮我记一下：王磊的生日是五月三号'), { kind: 'remember', text: '王磊的生日是五月三号' });
  assert.deepEqual(memoryCommand('忘掉上海出差这件事'), { kind: 'forget', text: '上海出差' });
  assert.deepEqual(memoryCommand('不对，王磊是产品经理'), { kind: 'correct', text: '王磊是产品经理' });
  assert.equal(memoryCommand('总结一下刚才的会议'), null);
});

test('a definite utterance is readable at once, persisted, queued, and deduplicated', async () => {
  const root = await dir();
  const context = new ContextSystem({ dataRoot: root });
  await context.ready;
  context.observe({ status: 'stopped', utterances: [utter('未连接', 1)] });
  context.observe({ status: 'running', utterances: [{ text: '临时草稿', definite: false, start_time: 5, end_time: 6 }, utter('第一句定稿。', 10)] });
  assert.match(context.compile(''), /第一句定稿/);
  // The plan's target is a P95, not a single wall-clock sample that a busy CI host can stretch.
  const samples = [];
  for (let index = 0; index < 40; index++) {
    const text = `计时句子${index}。`;
    const started = performance.now();
    context.observe({ status: 'running', utterances: [utter(text, 100 + index)] });
    assert.match(context.compile(''), new RegExp(text));
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  assert.ok(samples[Math.floor(samples.length * 0.95)] <= 100, `定稿到可读 P95 应 ≤ 100ms，实际 ${samples[Math.floor(samples.length * 0.95)]}`);
  context.observe({ status: 'running', utterances: [utter('第一句定稿。', 10), utter('第二句定稿。', 40)] });
  await context.idle();
  assert.ok(['第一句定稿。', '第二句定稿。'].every(text => context.state().fragments.some(item => item.text === text)));
  assert.equal(context.state().fragments.filter(item => item.text === '第一句定稿。').length, 1, '重复定稿只记一次');
  assert.equal(context.state().outbox, 42);
  assert.equal((await stat(join(root, 'fragments.jsonl'))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(root, 'hindsight-outbox.jsonl'), 'utf8')).trim().split('\n').length, 42);
  assert.doesNotMatch(context.compile(''), /临时草稿|未连接/);
  const reloaded = new ContextSystem({ dataRoot: root });
  await reloaded.ready;
  assert.deepEqual(reloaded.state().fragments.map(item => item.text), context.state().fragments.map(item => item.text));
  assert.equal(reloaded.state().outbox, 42, 'outbox 落盘后重启仍在');
  await context.dispose(); await reloaded.dispose();
});

test('all finalized speech from the last minute is returned in order, without older or draft speech', async () => {
  const now = Date.now();
  const context = new ContextSystem({ dataRoot: await dir(), now: () => now });
  await context.ready;
  context.fragments = [{ at: new Date(now - 60_001).toISOString(), text: '过期话。' }];
  for (let index = 0; index < 36; index++) context.fragments.push({ at: new Date(now - 59_000 + index * 1000).toISOString(), text: `一分钟内第${index}句。` });
  assert.equal(context.recentSpeech().length, 36, '用户消息不沿用旧的30句注入上限');
  assert.equal(context.recentSpeech()[0], '一分钟内第0句。');
  assert.equal(context.recentSpeech().at(-1), '一分钟内第35句。');
  assert.doesNotMatch(context.recentSpeech().join('\n'), /过期话/);
  assert.deepEqual(context.state().fragments.map(item => item.text), context.recentSpeech());
  assert.equal(context.state().memory, '');
  await context.dispose();
});

test('compile reads only RAM, respects every section limit, and matches people by name and alias', async () => {
  const root = await dir();
  const now = Date.now();
  await writeFile(join(root, 'memory-cache.json'), JSON.stringify({
    fetchedAt: new Date(now).toISOString(),
    models: {
      'user-profile': { content: '用户是创业者。'.repeat(200), updatedAt: new Date(now).toISOString() },
      'open-items': { content: '周五交付原型。'.repeat(200), updatedAt: new Date(now).toISOString() },
      people: { content: '', updatedAt: new Date(now).toISOString(), people: [
        { name: '王磊', aliases: ['磊哥'], occupation: '产品经理', relation: '同事', recent: '在做语音项目。'.repeat(40) },
        { name: '李娜', aliases: [], occupation: '医生', relation: '朋友', recent: '' },
        { name: '赵敏', aliases: ['Min'], occupation: '律师', relation: '表姐', recent: '' },
        { name: '陈晨', aliases: [], occupation: '设计师', relation: '同学', recent: '' },
        { name: '周杰', aliases: [], occupation: '歌手', relation: '偶像', recent: '' },
      ] },
    },
  }));
  const fragments = [];
  for (let index = 0; index < 60; index++) fragments.push({ at: new Date(now - (60 - index) * 1000).toISOString(), text: `第${index}句，磊哥说了很多话。`.padEnd(40, '嗯') });
  fragments.unshift({ at: new Date(now - 20 * 60_000).toISOString(), text: '二十分钟前的话' });
  await writeFile(join(root, 'fragments.jsonl'), fragments.map(item => JSON.stringify(item)).join('\n') + '\n');
  const context = new ContextSystem({ dataRoot: root });
  await context.ready;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('compile 不应发网络请求'); };
  try {
    const times = [];
    let text = '';
    for (let index = 0; index < 200; index++) { const started = performance.now(); text = context.compile('帮我约李娜、陈晨和 Min 吃饭'); times.push(performance.now() - started); }
    times.sort((a, b) => a - b);
    assert.ok(times[Math.floor(times.length * 0.95)] <= 10, `compile P95 应 ≤ 10ms，实际 ${times[Math.floor(times.length * 0.95)]}`);
    assert.ok(text.startsWith(MEMORY_NOTE));
    const section = name => text.split('\n\n## ').find(part => part.startsWith(name) || part.startsWith(`## ${name}`)) ?? '';
    const body = name => section(name).split('\n').slice(1).join('\n');
    assert.match(section('用户档案'), /更新于/);
    assert.ok(Array.from(body('用户档案')).length <= LIMITS.profile);
    assert.ok(Array.from(body('进行中事项')).length <= LIMITS.openItems);
    const people = body('相关人物').split('\n');
    assert.equal(people.length, 3, '最多 3 人');
    assert.ok(people.every(line => Array.from(line).length <= LIMITS.person));
    assert.ok(people.some(line => line.includes('王磊')), '最近原话里的别名「磊哥」应命中王磊');
    assert.ok(!people.some(line => line.includes('周杰')));
    const recent = body('最近原话').split('\n');
    assert.ok(recent.length <= LIMITS.recentCount);
    assert.ok(Array.from(recent.join('\n')).length <= LIMITS.recentChars);
    assert.doesNotMatch(text, /二十分钟前的话/);
  } finally { globalThis.fetch = originalFetch; }
  await context.dispose();
});

test('explicit memories and tombstones apply to the injected text immediately', async () => {
  const root = await dir();
  await writeFile(join(root, 'memory-cache.json'), JSON.stringify({ models: { 'open-items': { content: '- 下周三去上海出差\n- 周五交付原型', updatedAt: null } } }));
  const context = new ContextSystem({ dataRoot: root });
  await context.ready;
  context.observe({ status: 'running', utterances: [utter('我们下周三去上海出差吧。', 1)] });
  assert.deepEqual(context.command('记住我对花生过敏'), { kind: 'remember', text: '我对花生过敏' });
  assert.match(context.compile('今晚吃什么'), /我对花生过敏/);
  context.command('忘掉上海出差');
  const text = context.compile('今晚吃什么');
  assert.doesNotMatch(text, /上海出差/);
  assert.match(text, /周五交付原型/);
  context.command('忘掉花生过敏');
  assert.doesNotMatch(context.compile(''), /花生过敏/);
  await context.idle();
  const cache = JSON.parse(await readFile(join(root, 'memory-cache.json'), 'utf8'));
  assert.equal(cache.tombstones.length, 2);
  assert.equal(cache.explicit.length, 0);
  await context.dispose();
});

test('flush waits for an idle Router; every trigger fires; exit forces a flush', async () => {
  const calls = [];
  const bridge = Object.assign(new (await import('node:events')).EventEmitter(), {
    ready: true, status: 'ready',
    async retain(content, options) { calls.push({ content, options }); return { success: true }; },
    async mentalModel() { throw new Error('no cache in this test'); },
  });
  const root = await dir();
  const context = new ContextSystem({ dataRoot: root, bridge, limits: { silenceMs: 40, flushCount: 3, flushChars: 100000 } });
  await context.ready;
  // volume
  context.observe({ status: 'running', utterances: [utter('一', 1), utter('二', 2), utter('三', 3)] });
  await context.idle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.documentId.startsWith('stream-'), true);
  assert.equal(calls[0].options.updateMode, 'append');
  assert.equal(calls[0].options.async, true);
  assert.equal(calls[0].options.context, '现场对话，说话人未确认');
  assert.match(calls[0].content, /未确认说话人：一[\s\S]*未确认说话人：三/);
  // silence
  context.observe({ status: 'running', utterances: [utter('四', 4)] });
  await new Promise(resolve => setTimeout(resolve, 80)); await context.idle();
  assert.equal(calls.length, 2);
  // voice paused
  context.observe({ status: 'running', utterances: [utter('五', 5)] });
  context.voicePaused(); await context.idle();
  assert.equal(calls.length, 3);
  // router busy blocks, idle flushes
  context.setRouterBusy(true);
  context.observe({ status: 'running', utterances: [utter('六', 6), utter('七', 7), utter('八', 8)] });
  context.voicePaused();
  await new Promise(resolve => setTimeout(resolve, 80)); await context.idle();
  assert.equal(calls.length, 3, 'Router 在跑时不写');
  context.recordTurn({ inputId: 'abc', user: '总结一下', assistant: '好的' });
  context.setRouterBusy(false); await context.idle();
  assert.equal(calls.length, 5);
  const turn = calls.find(call => call.options.documentId === 'turn-abc');
  assert.match(turn.content, /用户：总结一下[\s\S]*助手：好的/);
  assert.equal(turn.options.context, 'MootingAgent 助手与用户对话');
  // exit
  context.setRouterBusy(true);
  context.observe({ status: 'running', utterances: [utter('九', 9)] });
  await context.dispose();
  assert.equal(calls.length, 6, '退出时强制写入，不等 Router');
  assert.equal((await readFile(join(root, 'hindsight-outbox.jsonl'), 'utf8')).trim(), '');
});

test('failed retain stays in the outbox and replays with the same operation id', async () => {
  const calls = [];
  let fail = true;
  const { EventEmitter } = await import('node:events');
  const bridge = Object.assign(new EventEmitter(), {
    ready: true, status: 'ready',
    async retain(content, options) { calls.push(options.operationId); if (fail) throw new Error('boom'); return {}; },
    async mentalModel() { throw new Error('x'); },
  });
  const root = await dir();
  const context = new ContextSystem({ dataRoot: root, bridge });
  await context.ready;
  context.observe({ status: 'running', utterances: [utter('要重放的话', 1)] });
  await context.flush({ reason: 'test' });
  assert.equal(context.state().outbox, 1);
  assert.equal(context.state().lastFlush.result, 'failed');
  clearTimeout(context.retryTimer); context.retryTimer = null;
  fail = false;
  await context.flush({ reason: 'test' });
  assert.equal(context.state().outbox, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1], '重放使用同一个 operation_id');
  await context.dispose();
});

test('Router user prompt contains every finalized sentence within one minute, not only the last sentence', async t => {
  const current = Date.now();
  const context = new ContextSystem({ dataRoot: await dir(), now: () => current });
  await context.ready;
  context.fragments = [{ at: new Date(current - 60_001).toISOString(), text: '过期原话。' }, ...Array.from({ length: 36 }, (_, index) => ({ at: new Date(current - 59_000 + index * 1000).toISOString(), text: `原话第${index}句。` }))];
  const h = await harness({ context }); t.after(async () => { await h.dispose(); await context.dispose(); });
  await h.runtime.submit({ instruction: '总结这一分钟' }); await h.runtime.idle();
  const user = h.runtime.trace.find(event => event.type === 'dsh.user/message' && event.data.source.kind === 'user').data;
  const prompt = user.content[0].text;
  assert.equal(user.source.command, '总结这一分钟');
  for (let index = 0; index < 36; index++) assert.match(prompt, new RegExp(`原话第${index}句`));
  assert.doesNotMatch(prompt, /过期原话/);
  assert.match(prompt, /## 用户指令\n```\n总结这一分钟\n```/);
});

test('router receives the compiled memory as runtime context, not inside the command', async t => {
  const root = await dir();
  await writeFile(join(root, 'memory-cache.json'), JSON.stringify({ models: { 'user-profile': { content: '用户喜欢短句', updatedAt: null } } }));
  const context = new ContextSystem({ dataRoot: root });
  await context.ready;
  context.observe({ status: 'running', utterances: [utter('明天下午开会。', 5)] });
  const h = await harness({ context });
  t.after(async () => { await h.dispose(); await context.dispose(); });
  await h.runtime.submit({ instruction: '总结会议' });
  await h.runtime.idle();
  const message = h.runtime.trace.find(event => event.type === 'dsh.user/message' && event.data.source.kind === 'user').data;
  assert.equal(message.source.command, '总结会议');
  assert.match(message.content[0].text, /## 最近1分钟原话[\s\S]*明天下午开会。/);
  assert.match(message.content[0].text, /## 用户指令\n```\n总结会议\n```/);
  const memory = h.runtime.trace.find(event => event.type === 'dsh.user/message' && event.data.source.kind === 'runtime-context').data;
  assert.doesNotMatch(memory.content[0].text, /明天下午开会/);
  assert.match(memory.content[0].text, /用户喜欢短句/);
  assert.match(memory.content[0].text, /memory_search/);
  await context.idle();
  assert.equal(context.items.filter(item => item.kind === 'turn').length + context.batches.filter(batch => batch.kind === 'turn').length, 1, 'turn/end 时写入这一轮');
});

test('an interrupted turn is not recorded', async t => {
  let release;
  const { MockRouterAdapter } = await import('./mock-router-adapter.mjs');
  const adapter = new MockRouterAdapter({ hold: new Promise(resolve => { release = resolve; }) });
  const context = new ContextSystem({ dataRoot: await dir() });
  await context.ready;
  const h = await harness({ adapter, context });
  t.after(async () => { release(); await h.dispose(); await context.dispose(); });
  await h.runtime.submit({ instruction: '第一条会被打断' });
  await new Promise(resolve => setTimeout(resolve, 20));
  adapter.hold = undefined;
  const second = h.runtime.submit({ instruction: '第二条' });
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  await second;
  await h.runtime.idle();
  const turns = context.items.filter(item => item.kind === 'turn');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].user, '第二条');
});
