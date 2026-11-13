import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskManager, snapshotInput } from '../src/tasks.mjs';
import { registerMockCapabilities } from './mock-capabilities.mjs';
import { CompatibleRouterAdapter } from '../src/model-adapters.mjs';
import { MockRouterAdapter } from './mock-router-adapter.mjs';

const input = () => snapshotInput({ instruction: '开启字幕' });

test('sole instruction becomes a detached immutable Context snapshot', () => {
  const original = { instruction: ' 总结会议内容 ' };
  const value = snapshotInput(original); original.instruction = 'changed';
  assert.equal(value.instruction, '总结会议内容');
  assert.deepEqual(value.context, [{ speaker: '用户', text: '总结会议内容', kind: 'speech', at: value.at }]);
  assert.equal(value.trigger, 'instruction_submit');
  assert.ok(Object.isFrozen(value.context[0])); assert.ok(Object.isFrozen(value.context));
  assert.throws(() => snapshotInput({ instruction: '' }));
  assert.throws(() => snapshotInput({ instruction: 'a'.repeat(4001) }));
  assert.throws(() => snapshotInput({ instruction: '总结', context: [] }), /自动组装/);
});

test('subtitle stays running after ready and directly exits on interaction with no late frames', async () => {
  const events = [], displays = [];
  const manager = new TaskManager({ emit: (type, data, id) => events.push({ type, data, id }), subtitle: state => displays.push(state) });
  const unregister = registerMockCapabilities(manager, { frameIntervalMs: 10000 });
  const task = await manager.start({ capability: 'realtime_subtitle', execution_kind: 'program' }, input());
  assert.equal(task.status, 'running'); assert.equal(displays.at(-1).text, '');
  await manager.interrupt();
  assert.equal(manager.tasks()[0].status, 'completed'); assert.equal(displays.at(-1).active, false);
  assert.ok(events.findIndex(e => e.type === 'worker.stopping') < events.findIndex(e => e.type === 'worker.completed'));
  assert.throws(() => manager.frame('迟到帧'), /没有字幕任务/);
  unregister(); assert.deepEqual(manager.capabilities(), []); await manager.dispose();
});

test('unregistered capabilities and unsupported execution kinds have no side effects', async () => {
  const manager = new TaskManager({ emit() {}, subtitle() {} });
  registerMockCapabilities(manager);
  await assert.rejects(manager.start({ capability: 'shell', execution_kind: 'program' }, input()));
  await assert.rejects(manager.start({ capability: 'summarize_context', execution_kind: 'cloud' }, input()));
  assert.deepEqual(manager.tasks(), []);
});

test('terminal state is committed only after asynchronous resource cleanup', async () => {
  let release; const done = new Promise(resolve => { release = resolve; });
  const manager = new TaskManager({ emit() {}, subtitle() {} });
  manager.register({ id: 'continuous', continuous: true, async start() { return { dispose: () => done }; } });
  const task = await manager.start({ capability: 'continuous', execution_kind: 'program' }, input());
  const stopping = manager.interrupt(); assert.equal(manager.tasks()[0].status, 'stopping');
  release(); await stopping; assert.equal(manager.tasks()[0].status, 'completed'); assert.ok(task.id);
});

test('mock model emits native tool call and consumes worker result on continuation', async () => {
  const adapter = new MockRouterAdapter();
  const first = await Array.fromAsync(adapter.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input()) }] }] }));
  const call = first.find(e => e.type === 'block-end').block;
  assert.equal(call.name, 'dispatch_worker'); assert.equal(JSON.parse(call.arguments).capability, 'realtime_subtitle');
  const next = await Array.fromAsync(adapter.stream({ messages: [{ role: 'tool', content: [{ type: 'text', text: JSON.stringify({ status: 'running' }) }] }] }));
  assert.ok(next.filter(e => e.type === 'text-delta').map(e => e.text).join('').includes('模拟'));
});

test('abort during capability startup disposes the returned handle before terminal state', async () => {
  let disposed = false; const controller = new AbortController();
  const manager = new TaskManager({ emit() {}, subtitle() {} });
  manager.register({ id: 'slow', async start() { controller.abort(); return { async dispose() { disposed = true; } }; } });
  await assert.rejects(manager.start({ capability: 'slow', execution_kind: 'program' }, input(), controller.signal));
  assert.equal(disposed, true); assert.equal(manager.tasks()[0].status, 'cancelled');
});

test('new interaction during subtitle startup prevents ready and disposes stale handle', async () => {
  let resolveStart; let disposed = false; const events = [];
  const ready = new Promise(resolve => { resolveStart = resolve; });
  const manager = new TaskManager({ emit: type => events.push(type), subtitle() {} });
  manager.register({ id: 'slow_subtitle', continuous: true, async start() { await ready; return { async dispose() { disposed = true; } }; } });
  let current = true;
  const starting = manager.start({ capability: 'slow_subtitle', execution_kind: 'program' }, input(), undefined, { isCurrent: () => current });
  current = false; resolveStart(); await assert.rejects(starting, /打断/);
  assert.equal(disposed, true); assert.equal(manager.tasks()[0].status, 'cancelled'); assert.ok(!events.includes('worker.ready'));
});

test('live model errors are not silently replaced with mock results', async () => {
  const adapter = new CompatibleRouterAdapter({ endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
  await assert.rejects(Array.fromAsync(adapter.stream({ messages: [], signal: AbortSignal.timeout(100) })));
});
