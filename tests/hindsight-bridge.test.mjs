import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HindsightBridge, loadHindsightConfig, withDeadline } from '../src/context/hindsight.mjs';
import { ContextSystem } from '../src/context/index.mjs';

const env = { MOOTING_CONTEXT_BASE_URL: 'http://localhost:1234/v1', MOOTING_CONTEXT_MODEL: 'test' };

// This is a transport-contract test against the actual npm SDK, not a simulated memory client.
async function transport(t, handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    const pathname = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('content-type', 'application/json');
    if (pathname.endsWith('/mental-models')) {
      res.end(JSON.stringify({ items: ['user-profile', 'people', 'open-items'].map(id => ({ id })) }));
    } else if (req.url.endsWith('/banks/mooting')) res.end('{}');
    else handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const bridge = new HindsightBridge({ env, port: server.address().port, manageDaemon: false, healthIntervalMs: 60_000 });
  t.after(async () => { await bridge.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await bridge.start();
  assert.equal(bridge.status, 'ready');
  return { bridge, server, requests };
}

test('bridge deadlines preserve TimeoutError through the real SDK and leave service ready', async t => {
  const { bridge, requests } = await transport(t, () => {});
  const started = performance.now();
  await assert.rejects(bridge.recall('问题', {}, { timeoutMs: 30 }), { name: 'TimeoutError' });
  assert.ok(performance.now() - started < 500);
  assert.equal(bridge.status, 'ready');
  assert.equal(requests.some(url => url.includes('/mental-models/')), false, 'existing.items skips creating existing models');
});

test('memory_search returns results from a slow first recall and distinguishes cancellation from timeout', async t => {
  const { bridge } = await transport(t, (req, res) => {
    if (!req.url.endsWith('/memories/recall')) { res.end('{}'); return; }
    const timer = setTimeout(() => res.end(JSON.stringify({ results: [{ text: '检索成功' }] })), 3_200);
    res.once('close', () => clearTimeout(timer));
  });
  const root = await mkdtemp(join(tmpdir(), 'mooting-slow-recall-'));
  const context = new ContextSystem({ dataRoot: root, bridge });
  t.after(async () => {
    await context.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await context.ready;
  const result = await context.search('慢速检索');
  assert.equal(result.results[0]?.text, '检索成功');
  const completed = context.state().trace.find(entry => entry.type === 'memory.search.end');
  assert.ok(completed.data.elapsedMs >= 3_000);

  const signal = AbortSignal.abort(new Error('用户发来新指令'));
  assert.equal((await context.search('取消的检索', { signal })).note, '记忆检索已取消');
  context.limits.searchTimeoutMs = 50;
  assert.match((await context.search('超时的检索')).note, /检索超时/);
  const failure = context.state().trace.findLast(entry => entry.type === 'memory.search.failed');
  assert.equal(failure.data.timeoutMs, 50);
  assert.equal(bridge.status, 'ready');
});

test('bank clear quiescence cancels deferred jobs and waits for processing jobs', async t => {
  const job = '00000000-0000-4000-8000-000000000001';
  let processingChecks = 0;
  let cancelled = false;
  const { bridge } = await transport(t, (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'DELETE' && url.pathname.endsWith('/operations/' + job)) {
      cancelled = true;
      res.end('{}');
      return;
    }
    const status = url.searchParams.get('status');
    if (status === 'pending' && !cancelled) {
      res.end(JSON.stringify({ operations: [{ id: job, next_retry_at: new Date(Date.now() + 60_000).toISOString() }] }));
    } else if (status === 'processing' && processingChecks++ === 0) {
      res.end(JSON.stringify({ operations: [{ id: job, status }] }));
    } else res.end(JSON.stringify({ operations: [] }));
  });
  await bridge.waitForBankWrites();
  assert.equal(cancelled, true);
  assert.equal(processingChecks, 3);
});

test('bridge preserves user cancellation and HTTP status while classifying only connection failures offline', async t => {
  const { bridge, server } = await transport(t, (_req, res) => { res.writeHead(404); res.end('{"detail":"not found"}'); });
  await assert.rejects(bridge.operation('missing'), error => error.statusCode === 404);
  assert.equal(bridge.status, 'ready');
  const signal = AbortSignal.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(bridge.recall('问题', {}, { signal }), { name: 'AbortError' });
  assert.equal(bridge.status, 'ready');
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(bridge.recall('问题'), { name: 'MemoryUnavailableError' });
  assert.equal(bridge.status, 'offline');
});

test('hard deadline still rejects a signal-ignoring SDK operation', async () => {
  await assert.rejects(withDeadline(() => new Promise(() => {}), { timeoutMs: 10 }), { name: 'TimeoutError' });
});

test('LLM extra body forwards provider settings and validates JSON objects', () => {
  const config = loadHindsightConfig({ ...env, MOOTING_HINDSIGHT_LLM_EXTRA_BODY: '{"thinking":{"type":"disabled"}}' });
  assert.deepEqual(JSON.parse(config.daemonEnv.HINDSIGHT_API_LLM_EXTRA_BODY), { thinking: { type: 'disabled' } });
  for (const value of ['[]', 'null', '{broken']) assert.throws(() => loadHindsightConfig({ ...env, MOOTING_HINDSIGHT_LLM_EXTRA_BODY: value }), /JSON 对象/);
});

test('remote reranker configuration maps provider-specific fields and rejects unknown providers', () => {
  for (const [provider, key] of [['tei', 'TEI_URL'], ['cohere', 'COHERE_BASE_URL'], ['litellm', 'LITELLM_API_BASE'], ['litellm-sdk', 'LITELLM_SDK_API_BASE']]) {
    const config = loadHindsightConfig({ ...env, MOOTING_RERANKER_BASE_URL: 'http://localhost:8080', MOOTING_RERANKER_PROVIDER: provider });
    assert.equal(config.daemonEnv[`HINDSIGHT_API_RERANKER_${key}`], 'http://localhost:8080');
    assert.equal(config.daemonEnv.HINDSIGHT_API_RERANKER_PROVIDER, provider);
  }
  assert.throws(() => loadHindsightConfig({ ...env, MOOTING_RERANKER_BASE_URL: 'http://localhost:8080', MOOTING_RERANKER_PROVIDER: 'nonsense' }), /不支持/);
});

test('stop cancels pending calls promptly without awaiting a never-settling SDK operation', async t => {
  const { bridge } = await transport(t, () => {});
  const pending = bridge.recall('问题', {}, { timeoutMs: 60_000 });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await bridge.stop();
  await rejected;
  assert.equal(bridge.status, 'offline');
});
