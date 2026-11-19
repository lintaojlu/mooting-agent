import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HindsightBridge, loadHindsightConfig, withDeadline } from '../src/context/hindsight.mjs';

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
