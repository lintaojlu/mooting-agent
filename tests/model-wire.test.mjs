import test from 'node:test';
import assert from 'node:assert/strict';
import { CompatibleRouterAdapter } from '../src/model-adapters.mjs';
import { harness } from './harness.mjs';
import { startModelFixture } from './model-fixture.mjs';

test('Responses adapter completes a DSH function-call round trip with native replay', async t => {
  const fixture = await startModelFixture(); t.after(() => fixture.close());
  const adapter = new CompatibleRouterAdapter({ endpoint: fixture.baseURL, model: 'fixture-model' });
  const h = await harness({ adapter, mode: 'live' }); t.after(() => h.dispose());
  await h.runtime.socialCards.create({ name: 'John', position: '空间折叠负责人', company: '空间折叠', school: '', topic: '' }, 'vp-john');
  h.runtime.lastSpeakerKey = 'vp-john';
  await h.runtime.submit({ instruction: '识别面前说话人' }); await h.runtime.idle();
  const requests = fixture.requests;
  assert.equal(requests.length, 2); assert.equal(requests[0].messages, undefined);
  assert.ok(requests[0].tools.some(tool => tool.name === 'social_card'));
  assert.ok(!requests[0].tools.some(tool => tool.name === 'open_speaker' || tool.name === 'open_subtitle' || tool.name === 'close_subtitle'));
  const tool = requests[1].input.at(-1); assert.equal(tool.type, 'function_call_output'); assert.equal(tool.call_id, 'fixture-1');
  assert.equal(JSON.parse(tool.output).say, '面前是John，空间折叠负责人，空间折叠。');
  assert.ok(requests[1].input.some(item => item.type === 'function_call' && item.name === 'social_card' && item.call_id === tool.call_id));
  assert.ok(requests[1].input.some(item => item.type === 'reasoning' && item.encrypted_content === 'fixture-encrypted-1'));
  assert.ok(h.runtime.trace.some(e => e.type === 'router.answer' && e.data.text.includes('面前是John')));
  assert.equal(h.ctx.agents.list().length, 1);
});
