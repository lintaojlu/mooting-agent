import test from 'node:test';
import assert from 'node:assert/strict';
import { CompatibleRouterAdapter } from '../src/model-adapters.mjs';
import { harness } from './harness.mjs';
import { startModelFixture } from './model-fixture.mjs';

test('Responses adapter completes a DSH function-call round trip with native replay', async t => {
  const fixture = await startModelFixture(); t.after(() => fixture.close());
  const adapter = new CompatibleRouterAdapter({ endpoint: fixture.baseURL, model: 'fixture-model' });
  const h = await harness({ adapter, mode: 'live' }); t.after(() => h.dispose());
  await h.runtime.submit({ instruction: '总结：需要买水' }); await h.runtime.idle();
  const requests = fixture.requests;
  assert.equal(requests.length, 3); assert.equal(requests[0].messages, undefined);
  assert.equal(requests[0].tools[0].name, 'dispatch_worker');
  const tool = requests[1].input.at(-1); assert.equal(tool.type, 'function_call_output'); assert.equal(tool.call_id, 'fixture-1');
  assert.ok(['starting', 'running', 'completed'].includes(JSON.parse(tool.output).status));
  assert.ok(requests[1].input.some(item => item.type === 'function_call' && item.call_id === tool.call_id));
  assert.ok(requests[1].input.some(item => item.type === 'reasoning' && item.encrypted_content === 'fixture-encrypted-1'));
  assert.ok(h.runtime.trace.some(e => e.type === 'router.answer' && e.data.text.includes('需要买水')));
  assert.equal(h.ctx.agents.list().length, 1);
});
