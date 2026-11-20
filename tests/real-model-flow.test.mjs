import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from './harness.mjs';
import { startModelFixture } from './model-fixture.mjs';
import { startWeb } from '../src/web-server.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mooting-real-model-'));
  const fixture = await startModelFixture(); t.after(() => fixture.close());
  const h = await harness({ realModels: true, configPath: join(dir, 'model-config.json') }); t.after(() => h.dispose());
  return { h, fixture, dir };
}

test('production is unconfigured by default and never runs a scripted Router', async t => {
  const { h } = await setup(t);
  assert.equal(h.runtime.state().mode, 'unconfigured');
  await assert.rejects(h.runtime.submit({ instruction: '解释红筹架构' }), /先.*配置/);
  assert.deepEqual(h.runtime.state().tasks, []);
});

test('one router request answers an open instruction and does not call another model', async t => {
  const { h, fixture, dir } = await setup(t);
  const config = await h.runtime.configureModels({ router: { baseURL: fixture.baseURL, model: 'router-model', apiKey: 'fixture-only-secret' }, workerUsesRouter: false, worker: { baseURL: fixture.baseURL, model: 'worker-model' } });
  assert.equal(config.configured, true); assert.equal(config.router.hasApiKey, true);
  assert.ok(!JSON.stringify(config).includes('fixture-only-secret'));
  const permissions = await stat(join(dir, 'model-config.json')); assert.equal(permissions.mode & 0o777, 0o600);
  await h.runtime.submit({ instruction: '帮我写一封简短邀请函' }); await h.runtime.idle();
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].model, 'router-model');
  assert.ok(fixture.requests.every(r => r.stream === true && r.tools?.length));
  const state = h.runtime.state(); assert.equal(state.sessionCount, 1);
  assert.deepEqual(state.tasks, []);
  assert.ok(!state.events.some(e => String(e.type).startsWith('mooting/worker')));
  assert.ok(state.trace.some(e => e.type === 'router.answer' && e.data.text.includes('测试模型接口已处理：帮我写一封简短邀请函')));
  assert.ok(state.events.find(e => e.type === 'assistant/message').data.stream.some(e => e.type === 'reasoning-chunks'));
  assert.ok(!JSON.stringify(state).includes('fixture-only-secret'));
  const retained = await h.runtime.configureModels({ router: { baseURL: fixture.baseURL, model: 'router-model', apiKey: '' }, workerUsesRouter: true });
  assert.equal(retained.router.hasApiKey, true); assert.ok((await readFile(join(dir, 'model-config.json'), 'utf8')).includes('fixture-only-secret'));
});

test('switch Router models and endpoints without clearing the Session or leaking foreign reasoning', async t => {
  const { h, fixture } = await setup(t);
  await h.runtime.configureModels({ router: { baseURL: fixture.baseURL, model: 'model-a' }, workerUsesRouter: true });
  await h.runtime.submit({ instruction: '识别面前说话人' }); await h.runtime.idle();
  assert.equal(h.runtime.lastError, null);
  const original = h.runtime.agent, oldEvents = original.session.snapshotEvents().length;
  await h.runtime.configureModels({ router: { baseURL: fixture.baseURL, model: 'model-b' }, workerUsesRouter: true });
  await h.runtime.submit({ instruction: '识别面前说话人' }); await h.runtime.idle();
  assert.equal(h.runtime.lastError, null); assert.equal(h.runtime.agent, original);
  assert.ok(original.session.snapshotEvents().length > oldEvents);
  const firstB = fixture.requests.find(request => request.model === 'model-b');
  assert.ok(firstB); assert.ok(!firstB.input.some(item => item.type === 'reasoning'));
  assert.ok(firstB.input.some(item => item.type === 'function_call_output'));
  const lastB = fixture.requests.filter(request => request.model === 'model-b').at(-1);
  assert.ok(lastB.input.some(item => item.type === 'reasoning'));
  const second = await startModelFixture(); t.after(() => second.close());
  await h.runtime.configureModels({ router: { baseURL: second.baseURL, model: 'model-b' }, workerUsesRouter: true });
  await h.runtime.submit({ instruction: '更换服务后继续' }); await h.runtime.idle();
  assert.equal(h.runtime.lastError, null); assert.equal(h.runtime.agent, original);
  assert.ok(!second.requests[0].input.some(item => item.type === 'reasoning'));
  assert.equal(h.ctx.agents.list().length, 1);
});

test('provider failure is visible and does not reuse earlier answers or switch to mock', async t => {
  const { h, fixture } = await setup(t);
  await h.runtime.configureModels({ router: { baseURL: fixture.baseURL, model: 'router-model' }, workerUsesRouter: true });
  await h.runtime.submit({ instruction: '解释一个术语' }); await h.runtime.idle();
  fixture.fail(true);
  await h.runtime.submit({ instruction: '新的请求' }); await h.runtime.idle();
  assert.equal(h.runtime.mode, 'live'); assert.ok(h.runtime.lastError);
  assert.deepEqual(h.runtime.state().tasks, []);
  assert.ok(h.runtime.trace.at(-1).type.includes('error'));
});

test('model settings API never exposes credentials and rejects cross-origin changes', async t => {
  const { h, fixture } = await setup(t); const web = await startWeb(h.runtime, { port: 0 }); t.after(() => web.close());
  const save = await fetch(web.url + '/api/model/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ router: { baseURL: fixture.baseURL, model: 'router-model', apiKey: 'fixture-secret' }, workerUsesRouter: true }) });
  assert.equal(save.status, 200); assert.ok(!(await save.text()).includes('fixture-secret'));
  const get = await fetch(web.url + '/api/model/config').then(r => r.json()); assert.equal(get.router.model, 'router-model'); assert.equal(get.router.hasApiKey, true);
  const denied = await fetch(web.url + '/api/model/config', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' }, body: '{}' }); assert.equal(denied.status, 403);
});


test('speaker card opens from the router tool and the close button adds no input', async t => {
  const { h, fixture } = await setup(t);
  await h.runtime.socialCards.create({ name: 'John', position: '空间折叠负责人', company: '空间折叠', school: '', topic: '' }, 'vp-john');
  await h.runtime.configureModels({ router: { baseURL: fixture.baseURL, model: 'router-model' }, workerUsesRouter: true });
  await h.runtime.submit({ instruction: '识别面前说话人' }); await h.runtime.idle();
  const state = h.runtime.state();
  assert.equal(state.speaker.active, true); assert.equal(state.speaker.person.name, 'John');
  assert.equal(state.speaker.simulated, undefined);
  assert.equal(state.subtitle.active, false); assert.deepEqual(state.tasks, []);
  assert.ok(fixture.requests.every(request => request.tools?.length));
  assert.ok(state.trace.some(event => event.type === 'router.answer' && event.data.text.includes('面前是John，空间折叠负责人')));
  const inputs = state.trace.filter(event => event.type === 'interaction.submitted').length;
  assert.equal((await h.runtime.interrupt()).stopped, true); await h.runtime.idle();
  assert.equal(h.runtime.state().speaker.active, false); assert.equal(h.runtime.state().speaker.person, null);
  assert.equal(h.runtime.state().trace.filter(event => event.type === 'interaction.submitted').length, inputs);
});
