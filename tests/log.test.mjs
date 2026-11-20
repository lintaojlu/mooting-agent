import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createLogger, configureLogging, createTrace, runWithTrace, isTraceId } from '../src/log/index.mjs';
import { ContextSystem } from '../src/context/index.mjs';
import { startWeb } from '../src/web-server.mjs';
import { harness } from './harness.mjs';
import { MockRouterAdapter, scriptedInstruction, textChunks, toolChunks } from './mock-router-adapter.mjs';
import { startModelFixture } from './model-fixture.mjs';
import { startASRFixture } from './asr-fixture.mjs';
import { Sound2Text } from '../src/sound2text/service.mjs';

const rows = content => content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
async function tempRoot(t) {
  const path = await mkdtemp(join(tmpdir(), 'mooting-log-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function query(traceId, dataRoot) {
  const { stdout } = await promisify(execFile)(process.execPath, ['src/log/query.mjs', traceId, dataRoot]);
  return rows(stdout);
}

test('daily files, level filter and cross-day Trace ID lookup', async t => {
  const dataRoot = await tempRoot(t);
  let now = new Date(2026, 10, 20, 23, 59, 59);
  const logger = createLogger({ dataRoot, level: 'info', now: () => now });
  const trace = createTrace('text');
  const job = createTrace('worker', [trace.traceId]);
  logger.write('debug', 'filtered', {}, trace);
  logger.write('info', 'interaction.received', { prompt: 'PRIVATE_PROMPT' }, trace);
  now = new Date(2026, 10, 21, 0, 0, 1);
  logger.write('warning', 'worker.retry', { elapsedMs: 21, args: { key: 'PRIVATE_KEY' } }, job);
  logger.write('error', 'worker.failed', { message: 'PRIVATE_MESSAGE' }, job);
  logger.write('info', 'unrelated', {}, createTrace('text'));
  await logger.flush();
  assert.deepEqual((await readdir(join(dataRoot, 'logs'))).sort(), ['2026-11-20.log', '2026-11-21.log']);
  const timeline = await query(trace.traceId, dataRoot);
  assert.deepEqual(timeline.map(row => row.level), ['info', 'warning', 'error']);
  assert.equal(timeline[1].elapsedMs, 21);
  assert.doesNotMatch(JSON.stringify(timeline), /PRIVATE_/);
});

test('an HTTP input carries Trace ID through DSH, model, tool, SSE and memory writes', async t => {
  const dataRoot = await tempRoot(t);
  const closeLog = configureLogging({ dataRoot });
  const fixture = await startModelFixture();
  const bridge = new EventEmitter();
  Object.assign(bridge, {
    ready: true, status: 'ready',
    async mentalModel() { return {}; },
    async retain() { return {}; },
  });
  const context = new ContextSystem({ bridge, dataRoot });
  const host = await harness({ realModels: true, configPath: join(dataRoot, 'models.env'), context });
  const web = await startWeb(host.runtime, { port: 0 });
  t.after(async () => {
    await web.close();
    await host.dispose();
    await context.dispose();
    await fixture.close();
    await closeLog();
  });
  await host.runtime.configureModels({ router: { baseURL: fixture.baseURL, model: 'fixture', apiKey: 'PRIVATE_API_KEY' }, workerUsesRouter: true });
  const sse = await fetch(web.url + '/api/events');
  const submitted = await fetch(web.url + '/api/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction: '查看社交卡片 PRIVATE_TEXT' }),
  });
  assert.equal(submitted.status, 202);
  const { traceId } = await submitted.json();
  assert.ok(isTraceId(traceId));
  await host.runtime.idle();
  await context.idle();
  await delay(65);
  assert.equal(host.runtime.state().traceId, traceId);
  await sse.body.cancel();
  await closeLog();
  const timeline = await query(traceId, dataRoot);
  const stage = event => {
    const row = timeline.find(row => row.event === event);
    assert.ok(row, `Missing ${event}`);
    return row;
  };
  assert.equal(stage('web.request.end').statusCode, 202);
  assert.ok(stage('router.admission').queueMs >= 0);
  assert.ok(stage('model.request.first_token').elapsedMs >= 0);
  assert.ok(stage('agent.tool.result').elapsedMs >= 0);
  assert.equal(stage('agent.tool.result').callKey, stage('agent.tool.call').callKey);
  assert.ok(stage('interaction.end').totalMs >= stage('interaction.first_output').totalMs);
  assert.ok(timeline.some(row => row.event === 'web.sse.delivery' && row.phase === 'final' && row.outcome === 'ok'));
  assert.equal(stage('context.outbox.batch.end').outcome, 'ok');
  assert.doesNotMatch(JSON.stringify(timeline), /PRIVATE_/);
});

test('an outbox restored from disk retains its originating trace', async t => {
  const dataRoot = await tempRoot(t);
  const closeLog = configureLogging({ dataRoot });
  const trace = createTrace('text');
  const before = new ContextSystem({ dataRoot });
  await before.ready;
  runWithTrace(trace, () => before.recordTurn({ user: 'PRIVATE_TEXT', assistant: 'PRIVATE_ANSWER' }));
  await before.dispose();
  const bridge = new EventEmitter();
  Object.assign(bridge, {
    ready: true, status: 'ready',
    async mentalModel() { return {}; },
    async retain() { return {}; },
  });
  const after = new ContextSystem({ bridge, dataRoot });
  await after.ready;
  await after.idle();
  await after.dispose();
  await closeLog();
  const found = await query(trace.traceId, dataRoot);
  assert.ok(found.some(row => row.event === 'context.outbox.batch.end' && row.outcome === 'ok'));
  const [file] = await readdir(join(dataRoot, 'logs'));
  assert.doesNotMatch(await readFile(join(dataRoot, 'logs', file), 'utf8'), /PRIVATE_/);
});

test('a pending ASR draft is linked to the voice interaction that waits for it', { timeout: 10000 }, async t => {
  const dataRoot = await tempRoot(t);
  const closeLog = configureLogging({ dataRoot });
  const asr = await startASRFixture();
  const sound2text = new Sound2Text({ config: { url: asr.url, apiKey: 'PRIVATE_KEY', resourceId: 'fixture-audio' } });
  const host = await harness({ sound2text });
  const web = await startWeb(host.runtime, { port: 0 });
  t.after(async () => {
    await web.close();
    await host.dispose();
    await sound2text.dispose();
    await asr.close();
    await closeLog();
  });
  await sound2text.start();
  const captured = once(sound2text.events, 'text');
  asr.recognize({ text: 'PRIVATE_SPEECH', start: 0, end: 200 });
  await captured;
  host.runtime.setOwnerSpeaker(sound2text.state().utterances[0].speaker);
  const waiting = new Promise(resolve => {
    const listener = event => {
      if (event !== 'text') return;
      sound2text.events.off('newListener', listener);
      resolve();
    };
    sound2text.events.on('newListener', listener);
  });
  const pending = fetch(web.url + '/api/voice/interaction', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  await waiting;
  asr.recognize({ text: 'PRIVATE_SPEECH', start: 0, end: 200, definite: true });
  const { traceId } = await (await pending).json();
  assert.ok(isTraceId(traceId));
  await host.runtime.idle();
  await closeLog();
  const trace = await query(traceId, dataRoot);
  assert.ok(trace.some(row => row.traceId !== traceId && row.event === 'voice.asr.speech_detected'));
  assert.ok(trace.some(row => row.event === 'voice.asr.finalize.end' && row.elapsedMs > 0 && row.outcome === 'ok'));
  assert.ok(trace.some(row => row.event === 'interaction.end' && row.outcome === 'ok'));
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_/);
});

test('background memory reflection and its later Router report are queryable from the submitted trace', async t => {
  const dataRoot = await tempRoot(t);
  const closeLog = configureLogging({ dataRoot });
  const bridge = new EventEmitter();
  let completeReflection;
  const reflection = new Promise(resolve => { completeReflection = resolve; });
  Object.assign(bridge, {
    ready: true, status: 'ready',
    async mentalModel() { return {}; },
    async retain() { return {}; },
    async reflect() { return reflection; },
  });
  const context = new ContextSystem({ bridge, dataRoot });
  const adapter = new MockRouterAdapter();
  adapter.stream = async function* (options) {
    const instruction = scriptedInstruction(options.messages);
    if (instruction === 'PRIVATE_REFLECT' && options.messages.at(-1).role !== 'tool') {
      yield* toolChunks('memory_reflect', { query: 'PRIVATE_QUERY' });
      return;
    }
    yield* textChunks('PRIVATE_REPORT');
  };
  const host = await harness({ adapter, context });
  t.after(async () => {
    completeReflection({ text: 'PRIVATE_MEMORY' });
    await host.dispose();
    await context.dispose();
    await closeLog();
  });
  const { traceId } = await host.runtime.submit({ instruction: 'PRIVATE_REFLECT' });
  await host.runtime.activePromise;
  completeReflection({ text: 'PRIVATE_MEMORY' });
  await host.runtime.idle();
  await context.idle();
  await closeLog();
  const trace = await query(traceId, dataRoot);
  const worker = trace.find(row => row.event === 'worker.report' && row.source === 'worker');
  const delivery = trace.find(row => row.event === 'worker.report.delivering');
  assert.equal(worker?.outcome, 'ok');
  assert.ok(worker.elapsedMs >= 0);
  assert.equal(delivery?.taskId, worker.taskId);
  assert.ok(delivery.queueMs >= 0);
  assert.ok(trace.some(row => row.event === 'interaction.end' && row.source === 'memory_report' && row.outcome === 'ok'));
  assert.equal(host.runtime.state().traceId, traceId);
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_/);
});
