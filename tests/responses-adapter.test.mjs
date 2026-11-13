import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CompatibleRouterAdapter } from '../src/model-adapters.mjs';

const textItem = (text = '回答') => ({ id: 'msg-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const callItem = { id: 'fc-item-123', type: 'function_call', call_id: 'call-456', name: 'dispatch_worker', arguments: '{"capability":"general_assistant"}', status: 'completed' };
const reasoning = { id: 'rs-1', type: 'reasoning', encrypted_content: 'encrypted-test-payload', summary: [{ type: 'summary_text', text: '思考摘要' }] };
const complete = output => ({ id: 'resp-1', object: 'response', status: 'completed', output, usage: { input_tokens: 11, output_tokens: 9 } });
const event = (type, fields = {}) => ({ type, ...fields });
async function fixture(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const bytes = []; for await (const byte of req) bytes.push(byte);
    const value = JSON.parse(Buffer.concat(bytes)); requests.push({ path: req.url, value });
    await handler(res, value);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { adapter: new CompatibleRouterAdapter({ endpoint: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-key', model: 'response-model' }), requests };
}
function send(res, events) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const value of events) res.write('event: ' + value.type + '\r\ndata: ' + JSON.stringify(value) + '\r\n\r\n'); res.end('data: [DONE]\n\n'); }
const options = (messages = [{ role: 'user', content: [{ type: 'text', text: '你好' }] }]) => ({ messages, tools: [{ name: 'dispatch_worker', description: '执行任务', parameters: { type: 'object' } }], maxTokens: 512 });
const collect = adapter => Array.fromAsync(adapter.stream(options()));

test('Responses request uses /v1/responses and converts role messages, functions and outputs without chat fields', async t => {
  const { adapter, requests } = await fixture(t, res => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(complete([textItem()]))); });
  await Array.fromAsync(adapter.stream(options([
    { role: 'system', content: [{ type: 'text', text: 'system' }] },
    { role: 'developer', content: [{ type: 'text', text: 'developer' }] },
    { role: 'user', content: [{ type: 'text', text: 'question' }] },
    { role: 'assistant', content: [{ type: 'text', text: '先执行' }, { type: 'tool-call', id: 'call-old', name: 'dispatch_worker', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'call-old', content: [{ type: 'text', text: '{"ok":true}' }] },
  ])));
  const { path, value } = requests[0]; assert.equal(path, '/v1/responses');
  assert.equal(value.stream, true); assert.equal(value.store, false); assert.equal(value.max_output_tokens, 512);
  assert.equal(value.reasoning, undefined);
  assert.equal(value.messages, undefined); assert.equal(value.max_tokens, undefined);
  assert.deepEqual(value.tools[0], { type: 'function', name: 'dispatch_worker', description: '执行任务', parameters: { type: 'object' }, strict: false });
  assert.deepEqual(value.input.slice(0, 4).map(item => [item.role, item.content[0].type]), [['system', 'input_text'], ['developer', 'input_text'], ['user', 'input_text'], ['assistant', 'output_text']]);
  assert.deepEqual(value.input[4], { type: 'function_call', call_id: 'call-old', name: 'dispatch_worker', arguments: '{}' });
  assert.deepEqual(value.input[5], { type: 'function_call_output', call_id: 'call-old', output: '{"ok":true}' });
});

test('disabled thinking sends Responses reasoning effort none and still accepts a text answer', async t => {
  const { adapter, requests } = await fixture(t, res => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(complete([textItem()]))); });
  const quiet = new CompatibleRouterAdapter({ endpoint: adapter.endpoint, apiKey: 'fixture-key', model: 'response-model', thinking: false });
  const chunks = await collect(quiet);
  assert.deepEqual(requests[0].value.reasoning, { effort: 'none' });
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), '回答');
});

test('streamed function arguments retain call_id (not item.id), reconcile done and preserve encrypted reasoning replay', async t => {
  const { adapter, requests } = await fixture(t, res => send(res, [
    event('response.output_item.added', { item: { ...reasoning, summary: [] } }),
    event('response.reasoning_summary_text.delta', { item_id: reasoning.id, summary_index: 0, delta: '思考' }),
    event('response.reasoning_summary_text.delta', { item_id: reasoning.id, summary_index: 0, delta: '摘要' }),
    event('response.reasoning_summary_text.done', { item_id: reasoning.id, summary_index: 0, text: '思考摘要' }),
    event('response.output_item.done', { item: reasoning }),
    event('response.output_item.added', { item: { ...callItem, arguments: '', status: 'in_progress' } }),
    event('response.function_call_arguments.delta', { item_id: callItem.id, delta: '{"capability":' }),
    event('response.function_call_arguments.delta', { item_id: callItem.id, delta: '"general_assistant"}' }),
    event('response.function_call_arguments.done', { item_id: callItem.id, arguments: callItem.arguments }),
    event('response.output_item.done', { item: callItem }),
    event('response.completed', { response: complete([reasoning, callItem]) }),
  ]));
  const chunks = await collect(adapter), deltas = chunks.filter(c => c.type === 'tool-call-delta');
  assert.ok(deltas.length >= 3); assert.ok(deltas.every(c => c.id === callItem.call_id));
  assert.equal(deltas.map(c => c.argumentsDelta).join(''), callItem.arguments);
  assert.equal(chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), '思考摘要');
  const blocks = chunks.filter(c => c.type === 'block-end').map(c => c.block), finish = chunks.at(-1);
  assert.equal(finish.reason.kind, 'tool-calls'); assert.equal(blocks[1].id, callItem.call_id);
  assert.deepEqual(finish.replayState.response.output, [reasoning, callItem]);
  await Array.fromAsync(adapter.stream(options([
    { role: 'assistant', source: { replayState: finish.replayState }, content: blocks },
    { role: 'tool', toolCallId: callItem.call_id, content: [{ type: 'text', text: 'result' }] },
  ])));
  assert.deepEqual(requests[1].value.input, [reasoning, callItem, { type: 'function_call_output', call_id: callItem.call_id, output: 'result' }]);
});

test('stream text and reasoning done events do not duplicate already streamed content', async t => {
  const { adapter } = await fixture(t, res => send(res, [
    event('response.output_item.added', { item: { ...textItem(), content: [] } }),
    event('response.output_text.delta', { item_id: 'msg-1', content_index: 0, delta: '回' }),
    event('response.output_text.delta', { item_id: 'msg-1', content_index: 0, delta: '答' }),
    event('response.output_text.done', { item_id: 'msg-1', content_index: 0, text: '回答' }),
    event('response.output_item.done', { item: textItem() }),
    event('response.completed', { response: complete([textItem()]) }),
  ]));
  const chunks = await collect(adapter); assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), '回答');
  assert.equal(chunks.at(-1).reason.kind, 'stop'); assert.deepEqual(chunks.find(c => c.type === 'usage').usage, { inputTokens: 11, outputTokens: 9 });
});

test('same-protocol JSON output supports functions and encrypted reasoning', async t => {
  const { adapter } = await fixture(t, res => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(complete([reasoning, callItem]))); });
  const chunks = await collect(adapter); assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  assert.equal(chunks.find(c => c.type === 'tool-call-delta').id, 'call-456');
});

for (const [label, events] of [
  ['provider failure', [event('response.failed', { response: { error: { message: 'provider denied' } } })]],
  ['incomplete', [event('response.incomplete', { response: { incomplete_details: { reason: 'max_output_tokens' } } })]],
  ['error event', [event('error', { message: 'bad request' })]],
  ['truncated EOF', [event('response.output_item.added', { item: { ...textItem(), content: [] } }), event('response.output_text.delta', { item_id: 'msg-1', delta: 'partial' })]],
  ['unsupported output', [event('response.completed', { response: complete([{ id: 'web-1', type: 'web_search_call' }]) })]],
  ['mismatched done', [event('response.output_item.added', { item: { ...textItem(), content: [] } }), event('response.output_text.delta', { item_id: 'msg-1', delta: 'prefix' }), event('response.completed', { response: complete([textItem('different')]) })]],
]) test(`Responses rejects ${label} without successful finish`, async t => {
  const { adapter } = await fixture(t, res => send(res, events)); const seen = [];
  await assert.rejects(async () => { for await (const chunk of adapter.stream(options())) seen.push(chunk); });
  assert.ok(!seen.some(c => c.type === 'finish'));
});

test('Responses JSON Chat Completions payload is rejected instead of protocol fallback', async t => {
  const { adapter } = await fixture(t, res => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'fake' } }] })); });
  await assert.rejects(collect(adapter), /JSON 未完成/);
});

test('abort interrupts an in-progress Responses stream', async t => {
  const { adapter } = await fixture(t, res => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('event: response.created\ndata: {"type":"response.created"}\n\n'); });
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 50); t.after(() => clearTimeout(timeout));
  await assert.rejects(Array.fromAsync(adapter.stream({ ...options(), signal: controller.signal })), error => error.name === 'AbortError');
});

test('oversized response is rejected', async t => {
  const { adapter } = await fixture(t, res => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(' '.repeat(2097153)); });
  await assert.rejects(collect(adapter), /2 MiB/);
});

test('model and endpoint switches keep visible history and tool pairs without foreign reasoning', async t => {
  const { adapter, requests } = await fixture(t, res => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(complete([textItem()]))); });
  const first = await collect(adapter), replay = first.at(-1).replayState;
  const foreign = { ...replay, response: { ...replay.response, output: [reasoning, callItem, textItem('旧回答')] } };
  const blocks = [{ type: 'reasoning', text: '不能移植的推理摘要' }, { type: 'tool-call', id: callItem.call_id, name: callItem.name, arguments: callItem.arguments }, { type: 'text', text: '旧回答' }];
  for (const change of [{ model: 'other-model' }, { endpoint: adapter.endpoint + '/other' }, { protocol: 'legacy' }]) {
    await Array.fromAsync(adapter.stream(options([
      { role: 'user', content: [{ type: 'text', text: '旧问题' }] },
      { role: 'assistant', source: { replayState: { response: { ...foreign.response, ...change } } }, content: blocks },
      { role: 'tool', toolCallId: callItem.call_id, content: [{ type: 'text', text: '已执行的结果' }] },
      { role: 'user', content: [{ type: 'text', text: '新问题' }] },
    ])));
    const input = requests.at(-1).value.input;
    assert.ok(!input.some(item => item.type === 'reasoning' || item.encrypted_content));
    assert.ok(!JSON.stringify(input).includes('不能移植的推理摘要'));
    assert.ok(input.some(item => item.type === 'function_call' && item.call_id === callItem.call_id && !item.id));
    assert.ok(input.some(item => item.type === 'function_call_output' && item.call_id === callItem.call_id));
    assert.ok(input.some(item => item.content?.[0]?.text === '旧回答'));
    assert.equal(input.at(-1).content[0].text, '新问题');
  }
  await Array.fromAsync(adapter.stream(options([{ role: 'assistant', content: blocks }, { role: 'user', content: [{ type: 'text', text: '继续' }] }])));
  assert.ok(!requests.at(-1).value.input.some(item => item.type === 'reasoning'));
});
