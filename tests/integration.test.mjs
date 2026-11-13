import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { commandFromPrompt, composeUserPrompt } from '../src/context.mjs';
import { Sound2Text } from '../src/sound2text/service.mjs';
import { startWeb } from '../src/web-server.mjs';



test('real DSH loop routes, executes worker, consumes result and keeps exactly one Session', async t => {
  const h = await harness(); t.after(() => h.dispose());
  await h.runtime.submit({ instruction: '总结：我好渴，需要买水' }); await h.runtime.idle();
  const state = h.runtime.state();
  assert.equal(state.sessionCount, 1); assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].status, 'completed');
  assert.ok(state.trace.some(e => e.type === 'dsh.tool/call'));
  assert.ok(state.trace.some(e => e.type === 'dsh.tool/result'));
  assert.ok(state.trace.some(e => e.type === 'router.answer' && e.data.text.includes('我好渴')));
  await h.runtime.submit({ instruction: '解释红筹架构' }); await h.runtime.idle();
  assert.equal(h.ctx.agents.list().length, 1);
  assert.ok(h.runtime.trace.some(e => e.type === 'router.answer' && e.data.text.includes('解释红筹架构')));
});

test('real DSH starts continuous subtitle, closes directly on interaction, then coordinates report', async t => {
  const h = await harness(); t.after(() => h.dispose());
  await h.runtime.submit({ instruction: '开启字幕' }); await h.runtime.idle();
  assert.equal(h.runtime.subtitle.active, true); assert.equal(h.runtime.manager.tasks()[0].status, 'running');
  h.runtime.sound2text.update({ text: '实际 ASR 文本修订', utterances: [{ start_time: 10, end_time: 200, text: '实际 ASR 文本修订' }] }); assert.equal(h.runtime.subtitle.text, '实际 ASR 文本修订');
  await h.runtime.interrupt();
  assert.equal(h.runtime.subtitle.active, false);
  await h.runtime.idle();
  assert.equal(h.runtime.manager.tasks()[0].status, 'completed');
  const types = h.runtime.trace.map(e => e.type);
  assert.ok(types.indexOf('worker.ready') < types.indexOf('worker.stopping'));
  assert.ok(types.indexOf('worker.stopping') < types.indexOf('worker.completed'));
  assert.equal(h.ctx.agents.list().length, 1);
});

test('submitting a new command closes subtitle and includes its report in Router input', async t => {
  const h = await harness(); t.after(() => h.dispose());
  await h.runtime.submit({ instruction: '开启字幕' }); await h.runtime.idle();
  await h.runtime.submit({ instruction: '总结' }); await h.runtime.idle();
  assert.equal(h.runtime.subtitle.active, false);
  const delivered = h.runtime.trace.filter(e => e.type === 'dsh.user/message' && e.data.source.kind === 'user').at(-1).data;
  assert.equal(delivered.source.command, '总结');
  assert.equal(delivered.content[0].text, composeUserPrompt('', '总结'));
  const report = h.runtime.trace.filter(e => e.type === 'dsh.user/message' && e.data.source.kind === 'mooting-task-event').at(-1).data;
  const input = JSON.parse(report.content[0].text);
  assert.equal(input.task_events[0].status, 'completed');
  assert.equal(input.task_events[0].reason, 'user_interaction');
  assert.equal(h.runtime.manager.tasks().length, 2);
});

test('new human input interrupts Router while its Worker continues and reports later', async t => {
  let completeWorker, workerSignal;
  const result = new Promise(resolve => { completeWorker = resolve; });
  const h = await harness({ runWorker: async ({ signal }) => { workerSignal = signal; await result; return { text: '后台独立完成', model: 'fixture' }; } });
  t.after(() => h.dispose());
  await h.runtime.submit({ instruction: '总结第一条' });
  while (!workerSignal) await new Promise(resolve => setImmediate(resolve));
  await h.runtime.voiceInteraction();
  assert.equal(h.runtime.sound2text.state().capture.status, 'listening');
  assert.equal(workerSignal.aborted, false);
  completeWorker(); await h.runtime.manager.idle();
  assert.equal(h.runtime.manager.tasks()[0].status, 'completed');
  assert.ok(h.runtime.pendingReports.length > 0);
  assert.equal(h.runtime.busy, false);
  h.runtime.sound2text.commit('这是新的指令');
  await new Promise(resolve => setImmediate(resolve)); await h.runtime.idle();
  assert.equal(workerSignal.aborted, false);
  const userMessages = h.runtime.trace.filter(event => event.type === 'dsh.user/message' && event.data.source.kind === 'user');
  assert.ok(userMessages.some(event => event.data.source.command === '这是新的指令' && commandFromPrompt(event.data.content[0].text) === '这是新的指令'));
  assert.equal(h.ctx.agents.list().length, 1);
});

test('subtitle Worker reports unavailable ASR to Router instead of outputting fake text', async t => {
  const h = await harness(); t.after(() => h.dispose());
  await h.runtime.sound2text.pause();
  await h.runtime.submit({ instruction: '开启字幕' }); await h.runtime.idle();
  assert.equal(h.runtime.subtitle.active, false);
  assert.equal(h.runtime.manager.tasks()[0].status, 'failed');
  assert.ok(h.runtime.trace.some(event => event.type === 'router.answer' && event.data.text.includes('先开启语音输入')));
  assert.ok(!h.runtime.trace.some(event => event.type === 'subtitle.frame'));
});

test('HTTP static, API, SSE and origin checks use real runtime', async t => {
  const h = await harness(); const web = await startWeb(h.runtime, { port: 0 });
  t.after(async () => { await web.close(); await h.dispose(); });
  const health = await fetch(web.url + '/api/health').then(r => r.json()); assert.equal(health.sessionCount, 1);
  const html = await fetch(web.url + '/').then(r => r.text()); assert.ok(html.includes('信息流') && html.includes('context片段'));
  const css = await fetch(web.url + '/styles.css'); assert.equal(css.status, 200);
  const abort = new AbortController();
  const events = await fetch(web.url + '/api/events', { signal: abort.signal });
  const reader = events.body.getReader(); const initial = await reader.read();
  assert.ok(new TextDecoder().decode(initial.value).includes('mooting-main')); abort.abort();
  const response = await fetch(web.url + '/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction: '总结' }) });
  assert.equal(response.status, 202); await h.runtime.idle();
  const state = await fetch(web.url + '/api/state').then(r => r.json()); assert.equal(state.tasks[0].status, 'completed');
  const invalid = await fetch(web.url + '/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(invalid.status, 400);
  const denied = await fetch(web.url + '/api/interaction', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' }, body: '{}' }); assert.equal(denied.status, 403);
});


test('button capture with shifted ASR finals reaches Context and Router once', async t => {
  const sound = new Sound2Text({ config: { apiKey: 'test', resourceId: 'test' } }); await sound.ready;
  sound.status = 'running'; sound.sequence = 1; sound.socket = { bufferedAmount: 0, send() {}, terminate() {} };
  const h = await harness({ sound2text: sound }); t.after(async () => { await h.dispose(); await sound.dispose(); });
  await h.runtime.voiceInteraction({ boundaryMs: 0 });
  const audio = Buffer.alloc(32000); for (let i = 0; i < audio.length; i += 2) audio.writeInt16LE(6000, i);
  sound.pushAudio(audio);
  sound.handleResult({ result: { utterances: [{ text: '总结一下刚才的观', start_time: 100, end_time: 900, definite: false }] } });
  await h.runtime.voiceInteraction({ boundaryMs: 1000 });
  assert.equal(h.runtime.currentContext, null);
  sound.handleResult({ result: { utterances: [{ text: '总结一下刚才的观点。', start_time: 80, end_time: 1000, definite: true }] } });
  await new Promise(resolve => setImmediate(resolve)); await h.runtime.idle();
  const state = h.runtime.state();
  assert.equal(state.currentContext.instruction, '总结一下刚才的观点。');
  assert.equal(state.currentContext.context[0].text, '总结一下刚才的观点。');
  assert.equal(state.trace.filter(event => event.type === 'interaction.submitted').length, 1);
  assert.ok(state.events.some(event => event.type === 'user/message' && event.data.content[0].text.includes('总结一下刚才的观点。')));
  assert.equal(state.tasks[0].capability, 'summarize_context');
  assert.ok(state.trace.some(event => event.type === 'voice.capture' && event.data.status === 'finishing'));
});
