import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { AtomicModel, AtomicPort } from '../src/android/atomic.mjs';
import { modelRequest } from '../src/android/hindsight.mjs';
import { AndroidSpeech } from '../src/android/speech.mjs';

test('Android socket sends model tool chunks, preserves schema, and cancels a stalled stream', async t => {
  let cancelRequest, stalledRequest;
  const cancelled = new Promise(resolve => { cancelRequest = resolve; });
  const peers = new Set();
  const server = createServer(socket => {
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    socket.on('error', () => {});
    createInterface({ input: socket }).once('line', line => {
      const { id, op, input } = JSON.parse(line);
      const emit = event => socket.write(JSON.stringify(event) + '\n');
      const finish = result => { emit({ type: 'final', result }); socket.end(); };
      if (op === 'cancel') {
        cancelRequest(input.requestId);
        socket.end(JSON.stringify({ ok: true }) + '\n');
      } else if (op === 'embedding') {
        finish({ vectors: [[1, 2], [3, 4]] });
      } else if (op === 'rerank') {
        finish({ scores: [0.1, 0.9] });
      } else if (input.tools.length) {
        emit({ type: 'tool', index: 0, id: 'call-1', name: 'memory_search', delta: '{"query":"记录"}' });
        finish({});
      } else if (input.responseFormat?.type === 'json_object') {
        emit({ type: 'text', index: 0, delta: '{"facts":[]}' });
        finish({ usage: { inputTokens: 8, outputTokens: 4 } });
      } else {
        stalledRequest = id;
        emit({ type: 'text', index: 0, delta: '未完成' });
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of peers) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const port = new AtomicPort('', () => connect({ host: '127.0.0.1', port: server.address().port }));
  const adapter = new AtomicModel(port);
  const events = await Array.fromAsync(adapter.stream({ messages: [], tools: [{ name: 'memory_search' }] }));
  assert.equal(events.at(-1).reason.kind, 'tool-calls');
  assert.equal(events.find(event => event.type === 'block-end').block.arguments, '{"query":"记录"}');
  await assert.rejects(Array.fromAsync(port.events('model', { tools: [] }, AbortSignal.timeout(150))), { name: 'TimeoutError' });
  const deadline = AbortSignal.timeout(1000);
  assert.equal(await Promise.race([cancelled, new Promise((_, reject) =>
    deadline.addEventListener('abort', () => reject(deadline.reason), { once: true }))]), stalledRequest);
  const embedding = await modelRequest('embeddings', { input: ['甲', '乙'] }, port, 2);
  assert.deepEqual(embedding.data.map(item => item.embedding), [[1, 2], [3, 4]]);
  const ranking = await modelRequest('rerank', { query: '甲', texts: ['甲', '乙'] }, port, 2);
  assert.deepEqual(ranking.map(item => item.index), [1, 0]);
  const request = { messages: [{ role: 'user', content: '甲' }], response_format: { type: 'json_object' } };
  const completion = await modelRequest('chat/completions', request, port, 2);
  assert.equal(completion.choices[0].message.content, '{"facts":[]}');
});

test('Android speech joins VPR, archives once and requires confirmation before submitting', async () => {
  const archived = [];
  const speech = new AndroidSpeech({}, async (...args) => archived.push(args));
  const recognized = { type: 'asr', segment_id: 1, text: '请总结', start_seconds: 1, end_seconds: 2 };
  speech.ingest({ type: 'vpr', segment_id: 1, known: true, speaker_id: 'speaker-1', display_name: '张三' });
  speech.ingest(recognized);
  speech.flush();
  speech.ingest(recognized);
  speech.flush();
  assert.equal(speech.state().utterances[0].speaker, '张三');
  assert.equal(archived.length, 1);
  speech.capture = { status: 'finishing', id: 'capture', boundaryMs: 0, cutoffMs: 2500, deadline: 0 };
  speech.finishPreview();
  assert.equal(speech.capture.review, '请总结');
  assert.equal(await speech.submit({ id: 'capture', instruction: '请总结会议' }, value => value), '请总结会议');
  await assert.rejects(speech.submit({ id: 'capture', instruction: '请总结会议' }, value => value), /已提交/);
});
