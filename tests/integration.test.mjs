import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from './harness.mjs';
import { MockRouterAdapter } from './mock-router-adapter.mjs';
import { ContextSystem } from '../src/context/index.mjs';
import { startWeb } from '../src/web-server.mjs';

const userText = event => event.data.content[0].text;

test('router answers directly and calls function tools inside the same session', async t => {
  const h = await harness(); t.after(() => h.dispose());
  await h.runtime.submit({ instruction: '解释红筹架构' }); await h.runtime.idle();
  const state = h.runtime.state();
  assert.equal(state.sessionCount, 1); assert.deepEqual(state.tasks, []);
  assert.ok(state.trace.some(e => e.type === 'router.answer' && e.data.text.includes('解释红筹架构')));
  assert.ok(!state.trace.some(e => e.type === 'dsh.tool/call'));
  await h.runtime.submit({ instruction: '识别面前说话人' }); await h.runtime.idle();
  assert.equal(h.ctx.agents.list().length, 1);
  assert.equal(h.runtime.speaker.active, true);
  assert.equal(h.runtime.subtitle.active, false);
  assert.ok(h.runtime.trace.some(e => e.type === 'dsh.tool/call' && JSON.stringify(e.data).includes('open_speaker')));
  assert.ok(!h.runtime.trace.some(e => JSON.stringify(e.data).includes('open_subtitle')));
  assert.ok(h.runtime.trace.some(e => e.type === 'dsh.tool/result'));
  assert.ok(h.runtime.trace.some(e => e.type === 'router.answer' && e.data.text.includes('面前是John')));
});

test('speaker stays open across a new command and the close button does not start a turn', async t => {
  const h = await harness(); t.after(() => h.dispose());
  await h.runtime.submit({ instruction: '识别面前说话人' }); await h.runtime.idle();
  const submitted = h.runtime.trace.filter(e => e.type === 'interaction.submitted').length;
  await h.runtime.submit({ instruction: '解释红筹架构' }); await h.runtime.idle();
  assert.equal(h.runtime.speaker.active, true);
  assert.equal(h.runtime.subtitle.active, false);
  const delivered = h.runtime.trace.filter(e => e.type === 'dsh.user/message' && e.data.source.kind === 'user').at(-1);
  assert.equal(delivered.data.source.command, '解释红筹架构');
  assert.equal(userText(delivered), '解释红筹架构');
  assert.ok(!h.runtime.trace.some(e => e.data?.source?.kind === 'mooting-task-event'));
  assert.equal((await h.runtime.interrupt()).stopped, true);
  await h.runtime.idle();
  assert.equal(h.runtime.speaker.active, false);
  assert.equal(h.runtime.trace.filter(e => e.type === 'interaction.submitted').length, submitted + 1);
  assert.equal(h.ctx.agents.list().length, 1);
});

test('a new utterance cancels the router turn before a tool can open the panel', async t => {
  let release; const hold = new Promise(resolve => { release = resolve; });
  let markHeld; const held = new Promise(resolve => { markHeld = resolve; });
  const h = await harness({ adapter: new MockRouterAdapter({ hold, onHold: markHeld }) }); t.after(() => h.dispose());
  const pending = h.runtime.submit({ instruction: '识别面前说话人' });
  await held;
  h.runtime.sound2text.update({ text: '这是新的指令', utterances: [{ text: '这是新的指令', start_time: 0, end_time: 500, definite: false }] });
  const voice = h.runtime.voiceInteraction();
  release();
  await voice; await pending; await h.runtime.idle();
  assert.equal(h.runtime.speaker.active, false);
  assert.equal(h.runtime.busy, false);
  const userMessages = h.runtime.trace.filter(event => event.type === 'dsh.user/message' && event.data.source.kind === 'user');
  assert.ok(userMessages.some(event => event.data.source.command === '这是新的指令' && userText(event).includes('## 最近1分钟原话') && userText(event).includes('这是新的指令')));
  assert.equal(h.ctx.agents.list().length, 1);
});

test('asking for subtitles does not register or call a subtitle tool', async t => {
  const h = await harness(); t.after(() => h.dispose());
  await h.runtime.sound2text.pause();
  await h.runtime.submit({ instruction: '开启字幕' }); await h.runtime.idle();
  assert.equal(h.runtime.subtitle.active, false);
  assert.deepEqual(h.runtime.state().tasks, []);
  assert.ok(!h.runtime.trace.some(event => JSON.stringify(event.data).includes('open_subtitle')));
  assert.ok(h.runtime.trace.some(event => event.type === 'router.answer' && event.data.text.includes('开启字幕')));
});

test('speaker tool opens the person card without a subtitle tool', async t => {
  const h = await harness(); t.after(() => h.dispose());
  await h.runtime.submit({ instruction: '识别面前说话人' }); await h.runtime.idle();
  assert.equal(h.runtime.subtitle.active, false);
  assert.equal(h.runtime.speaker.active, true);
  assert.equal(h.runtime.speaker.person.name, 'John');
  assert.equal(h.runtime.speaker.simulated, undefined);
  assert.ok(h.runtime.trace.some(event => event.type === 'router.answer' && event.data.text.includes('面前是John，空间折叠负责人；AI创业者。')));
  assert.ok(!h.runtime.trace.some(event => event.type === 'router.answer' && event.data.text.includes('上次聊过')));
});

test('persisted memory is injected beside the instruction', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mooting-memory-'));
  await writeFile(join(dir, 'memory-cache.json'), JSON.stringify({ models: { 'user-profile': { content: '- 用户喜欢短句', updatedAt: null } } }));
  const context = new ContextSystem({ dataRoot: dir });
  await context.ready;
  const h = await harness({ context }); t.after(async () => { await h.dispose(); await context.dispose(); });
  await h.runtime.submit({ instruction: '总结会议' }); await h.runtime.idle();
  const users = h.runtime.trace.filter(event => event.type === 'dsh.user/message');
  const command = users.find(event => event.data.source.kind === 'user');
  assert.equal(userText(command), '总结会议');
  assert.ok(!userText(command).includes('用户喜欢短句'));
  const memory = users.find(event => event.data.source.kind === 'runtime-context');
  assert.ok(memory, '长期记忆应作为 runtime context 进入会话');
  assert.ok(userText(memory).includes('用户喜欢短句'));
});

test('Context trace endpoint returns the full persisted history while SSE remains bounded', async t => {
  const context = new ContextSystem({ dataRoot: await mkdtemp(join(tmpdir(), 'mooting-context-trace-')) });
  await context.ready;
  for (let index = 0; index < 210; index++) context.traceEvent('test.step', { index });
  const h = await harness({ context });
  const web = await startWeb(h.runtime, { port: 0 });
  t.after(async () => { await web.close(); await h.dispose(); await context.dispose(); });
  const state = await fetch(web.url + '/api/state').then(response => response.json());
  assert.equal(state.context.trace.length, 200);
  const full = await fetch(web.url + '/api/context/trace').then(response => response.json());
  assert.ok(full.entries.length > 210);
  assert.equal(full.entries.at(-1).seq, state.context.traceCount);
  assert.deepEqual(full.entries.find(entry => entry.type === 'test.step' && entry.data.index === 0)?.data, { index: 0 });
});

test('HTTP static, API, SSE and origin checks use real runtime', async t => {
  const h = await harness(); const web = await startWeb(h.runtime, { port: 0 });
  t.after(async () => { await web.close(); await h.dispose(); });
  const health = await fetch(web.url + '/api/health').then(r => r.json()); assert.equal(health.sessionCount, 1);
  const html = await fetch(web.url + '/').then(r => r.text()); assert.ok(html.includes('信息流') && html.includes('最近原话'));
  const css = await fetch(web.url + '/styles.css'); assert.equal(css.status, 200);
  const abort = new AbortController();
  const events = await fetch(web.url + '/api/events', { signal: abort.signal });
  const reader = events.body.getReader(); const initial = await reader.read();
  assert.ok(new TextDecoder().decode(initial.value).includes('mooting-main')); abort.abort();
  const response = await fetch(web.url + '/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction: '总结' }) });
  assert.equal(response.status, 202); await h.runtime.idle();
  const state = await fetch(web.url + '/api/state').then(r => r.json());
  assert.deepEqual(state.tasks, []);
  assert.ok(state.trace.some(event => event.type === 'router.answer' && event.data.text.includes('总结')));
  const invalid = await fetch(web.url + '/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(invalid.status, 400);
  const denied = await fetch(web.url + '/api/interaction', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' }, body: '{}' }); assert.equal(denied.status, 403);
});

test('captured voice keeps all last-minute speech in the user message but executes only the captured command', async t => {
  const context = new ContextSystem({ dataRoot: await mkdtemp(join(tmpdir(), 'mooting-voice-minute-')) });
  await context.ready;
  const h = await harness({ context }); t.after(async () => { await h.dispose(); await context.dispose(); });
  h.runtime.sound2text.events.emit('text', { utterances: [
    { text: '先打开面前说话人。', definite: true, start_time: 10 },
    { text: '会议里提到的王磊是产品经理。', definite: true, start_time: 20 },
    { text: '请总结会议。', definite: true, start_time: 30 },
  ] });
  h.runtime.sound2text.events.emit('instruction', { text: '请总结会议。', id: 'captured-minute' });
  for (let count = 0; !h.runtime.trace.some(event => event.type === 'interaction.submitted'); count++) {
    if (count > 20) throw new Error('未收到定稿指令');
    await new Promise(resolve => setImmediate(resolve));
  }
  await h.runtime.idle();
  const user = h.runtime.trace.find(event => event.type === 'dsh.user/message' && event.data.source.kind === 'user').data;
  assert.equal(user.source.command, '请总结会议。');
  assert.match(user.content[0].text, /先打开面前说话人。[\s\S]*会议里提到的王磊是产品经理。[\s\S]*## 用户指令\n```\n请总结会议。/);
  assert.equal(h.runtime.speaker.active, false, '背景中的旧开关要求不是本轮授权');
  assert.equal(h.runtime.trace.some(event => event.type === 'dsh.tool/call'), false);
  assert.ok(h.runtime.trace.some(event => event.type === 'router.answer' && event.data.text.includes('请总结会议')));
});

test('right button submits one minute of speech for Router command extraction, including a draft', async t => {
  const h = await harness(); t.after(() => h.dispose());
  h.runtime.sound2text.update({ text: '' });
  assert.deepEqual(await h.runtime.voiceInteraction(), { skipped: true });
  assert.equal(h.runtime.currentContext, null);
  h.runtime.sound2text.update({ text: '前面已经说完。总结一下刚才的观' });
  await h.runtime.voiceInteraction();
  await h.runtime.idle();
  const state = h.runtime.state();
  assert.equal(state.currentContext.instruction, '前面已经说完。总结一下刚才的观');
  assert.equal(state.currentContext.extractCommand, true);
  assert.deepEqual(state.currentContext.context.map(item => item.text), ['前面已经说完。', '总结一下刚才的观']);
  assert.equal(state.trace.filter(event => event.type === 'interaction.submitted').length, 1);
  const delivered = state.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user' && event.data.source.command === '前面已经说完。总结一下刚才的观');
  assert.match(delivered.data.content[0].text, /## 最近1分钟原话[\s\S]*前面已经说完。\n总结一下刚才的观[\s\S]*## 待提取指令/);
  assert.ok(!state.events.some(event => event.type === 'user/message' && event.data.source?.kind === 'runtime-context' && event.data.content[0].text.includes('前面已经说完。')));
  assert.deepEqual(state.tasks, []);
  assert.ok(state.trace.some(event => event.type === 'router.answer' && event.data.text.includes('总结一下刚才的观')));
});

test('legacy voice extraction excludes utterances older than one audio minute', async t => {
  const h = await harness(); t.after(() => h.dispose());
  h.runtime.sound2text.update({ audioMs: 120_000, text: '一小时前的字幕。现在总结。', utterances: [
    { text: '旧的说话人请求。', start_time: 50_000, end_time: 55_000, definite: true },
    { text: '现在总结。', start_time: 119_000, end_time: 119_500, definite: true },
  ] });
  await h.runtime.voiceInteraction(); await h.runtime.idle();
  const delivered = h.runtime.trace.find(event => event.type === 'dsh.user/message' && event.data.source.kind === 'user').data;
  assert.match(delivered.content[0].text, /现在总结/);
  assert.doesNotMatch(delivered.content[0].text, /旧的说话人请求/);
  assert.equal(delivered.source.command, '现在总结。');
});

test('right button uses the last minute, without treating older fragments as a command', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mooting-fragments-'));
  await writeFile(join(dir, 'memory-cache.json'), JSON.stringify({ models: { 'open-items': { content: '- 已有约定', updatedAt: null } } }));
  const old = new Date(Date.now() - 61_000).toISOString();
  const at = new Date().toISOString();
  await writeFile(join(dir, 'fragments.jsonl'), [
    { at: old, text: '过期的旧话。' },
    { at, text: '第一句定稿。' },
    { at, text: '再加一句。' },
  ].map(item => JSON.stringify(item)).join('\n') + '\n');
  const context = new ContextSystem({ dataRoot: dir });
  await context.ready;
  const h = await harness({ context }); t.after(async () => { await h.dispose(); await context.dispose(); });
  h.runtime.sound2text.update({ text: '前面已经说完。总结一下刚才的观' });
  await h.runtime.voiceInteraction();
  await h.runtime.idle();
  const state = h.runtime.state();
  assert.equal(state.currentContext.instruction, '前面已经说完。总结一下刚才的观');
  assert.deepEqual(state.currentContext.context.map(item => item.text), ['第一句定稿。', '再加一句。', '前面已经说完。', '总结一下刚才的观']);
  const delivered = state.events.find(event => event.type === 'user/message' && event.data.source?.kind === 'user');
  const prompt = delivered.data.content[0].text;
  assert.equal(delivered.data.source.command, '前面已经说完。总结一下刚才的观');
  for (const text of ['第一句定稿。', '再加一句。', '前面已经说完。', '总结一下刚才的观']) assert.ok(prompt.includes(text));
  assert.doesNotMatch(prompt, /过期的旧话/);
  assert.match(prompt, /## 待提取指令/);
  const background = state.events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'runtime-context').at(-1);
  assert.ok(background.data.content[0].text.includes('已有约定'));
  assert.doesNotMatch(background.data.content[0].text, /第一句定稿|前面已经说完/);
});

test('opening the function panel shows the speaker card without a router turn', async t => {
  const h = await harness(); t.after(() => h.dispose());
  const submitted = h.runtime.trace.filter(event => event.type === 'interaction.submitted').length;
  const opened = await h.runtime.showSpeaker();
  assert.equal(opened.opened, true);
  assert.equal(h.runtime.speaker.active, true);
  assert.equal(h.runtime.speaker.person.name, 'John');
  assert.equal(h.runtime.trace.filter(event => event.type === 'interaction.submitted').length, submitted);
});
