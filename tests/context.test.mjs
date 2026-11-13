import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextSystem, composeUserPrompt, commandFromPrompt, normalizeMemory } from '../src/context.mjs';
import { harness } from './harness.mjs';

test('composed prompt keeps memory before the command and can recover the command', () => {
  const prompt = composeUserPrompt('  # 记忆\n- 开会  ', '总结会议');
  assert.equal(prompt, '## 用户之前正在聊的内容\n```\n# 记忆\n- 开会\n```\n\n## 用户指令\n```\n总结会议\n```');
  assert.equal(composeUserPrompt('', '开启字幕'), '## 用户之前正在聊的内容\n```\n\n```\n\n## 用户指令\n```\n开启字幕\n```');
  assert.equal(commandFromPrompt(composeUserPrompt('# 记忆\n## 用户指令\n```\n旧记录\n```', '现在的命令')), '现在的命令');
  assert.equal(normalizeMemory('```markdown\n# 记忆\n- 一项\n```'), '# 记忆\n- 一项\n');
});

test('definite utterances update MEMORY.md in order and partial text is ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mooting-context-'));
  const calls = [];
  const context = new ContextSystem({
    memoryPath: join(dir, 'MEMORY.md'),
    env: { MOOTING_CONTEXT_BASE_URL: 'http://127.0.0.1:9/v1', MOOTING_CONTEXT_MODEL: 'context-test', MOOTING_CONTEXT_API_KEY: 'test' },
    complete: async ({ memory, segment }) => { calls.push(segment); return `${memory.trim()}\n- ${segment}`; },
  });
  await context.ready;
  context.observe({ status: 'stopped', utterances: [{ text: '未连接', definite: true, start_time: 1, end_time: 2 }] });
  context.observe({ status: 'running', utterances: [
    { text: '临时草稿', definite: false, start_time: 10, end_time: 20 },
    { text: '第一句定稿。', definite: true, start_time: 10, end_time: 30 },
  ] });
  context.observe({ status: 'running', utterances: [
    { text: '第一句定稿。', definite: true, start_time: 10, end_time: 30 },
    { text: '第二句定稿。', definite: true, start_time: 40, end_time: 60 },
  ] });
  await context.idle();
  assert.deepEqual(calls, ['第一句定稿。', '第二句定稿。']);
  const memory = await readFile(context.path, 'utf8');
  assert.match(memory, /第一句定稿/);
  assert.match(memory, /第二句定稿/);
  assert.equal((await stat(context.path)).mode & 0o777, 0o600);
  assert.equal(context.state().status, 'idle');
  assert.equal(context.state().memory, memory);
  assert.deepEqual(context.state().fragments.map(item => item.text), ['第一句定稿。', '第二句定稿。']);
  const reloaded = new ContextSystem({ memoryPath: context.path, env: { MOOTING_CONTEXT_BASE_URL: '', MOOTING_CONTEXT_MODEL: '', MOOTING_CONTEXT_API_KEY: '' } });
  await reloaded.ready;
  assert.deepEqual(reloaded.state().fragments.map(item => item.text), ['第一句定稿。', '第二句定稿。']);
  await context.dispose();
  await reloaded.dispose();
});

test('missing context model does not invent a memory document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mooting-context-'));
  let called = false;
  const context = new ContextSystem({ memoryPath: join(dir, 'MEMORY.md'), env: { MOOTING_CONTEXT_BASE_URL: '', MOOTING_CONTEXT_MODEL: '', MOOTING_CONTEXT_API_KEY: '' }, complete: async () => { called = true; return '# 记忆\n'; } });
  await context.ready;
  context.observe({ status: 'running', utterances: [{ text: '你好', definite: true, start_time: 1, end_time: 2 }] });
  await context.idle();
  assert.equal(called, false);
  assert.equal(context.state().status, 'unconfigured');
  assert.equal(context.state().memory, '');
  await context.dispose();
});

test('router receives memory plus command while the stored command stays separate', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mooting-context-'));
  const context = new ContextSystem({
    memoryPath: join(dir, 'MEMORY.md'),
    env: { MOOTING_CONTEXT_BASE_URL: 'http://127.0.0.1:9/v1', MOOTING_CONTEXT_MODEL: 'context-test', MOOTING_CONTEXT_API_KEY: 'test' },
    complete: async ({ segment }) => `# 记忆\n- ${segment}\n`,
  });
  await context.ready;
  context.observe({ status: 'running', utterances: [{ text: '明天下午开会。', definite: true, start_time: 5, end_time: 20 }] });
  await context.idle();
  const h = await harness({ context });
  t.after(() => h.dispose());
  await h.runtime.submit({ instruction: '总结会议' });
  await h.runtime.idle();
  const message = h.runtime.trace.find(event => event.type === 'dsh.user/message' && event.data.source.kind === 'user').data;
  assert.equal(message.source.command, '总结会议');
  assert.equal(message.content[0].text, '## 用户之前正在聊的内容\n```\n# 记忆\n- 明天下午开会。\n```\n\n## 用户指令\n```\n总结会议\n```');
  assert.equal(h.runtime.state().context.memory.includes('明天下午开会'), true);
  await context.dispose();
});
