import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCOUNTS } from '../src/access.mjs';
import { UserHomes } from '../src/user-homes.mjs';
import { harness } from './harness.mjs';

test('each account stores memory in its own data directory', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'mooting-users-'));
  const homes = new UserHomes({
    dataRoot, accounts: ['nil', 'zoe'],
    env: { MOOTING_CONTEXT_BASE_URL: 'http://127.0.0.1:9/v1', MOOTING_CONTEXT_MODEL: 'context-test', MOOTING_CONTEXT_API_KEY: 'test' },
    complete: async ({ segment }) => `# 记忆\n- ${segment}\n`,
  });
  await homes.open();
  assert.equal((await stat(homes.directory('nil'))).mode & 0o777, 0o700);
  assert.equal(homes.context('nil').path, join(dataRoot, 'nil', 'MEMORY.md'));
  assert.equal(homes.context('zoe').path, join(dataRoot, 'zoe', 'MEMORY.md'));
  homes.context('nil').observe({ status: 'running', utterances: [{ text: 'nil 的约定', definite: true, start_time: 1, end_time: 2 }] });
  homes.context('zoe').observe({ status: 'running', utterances: [{ text: 'zoe 的约定', definite: true, start_time: 3, end_time: 4 }] });
  await homes.context('nil').idle();
  await homes.context('zoe').idle();
  const nil = await readFile(homes.context('nil').path, 'utf8');
  const zoe = await readFile(homes.context('zoe').path, 'utf8');
  assert.match(nil, /nil 的约定/);
  assert.doesNotMatch(nil, /zoe/);
  assert.match(zoe, /zoe 的约定/);
  assert.doesNotMatch(zoe, /nil/);
  assert.match(await readFile(join(dataRoot, 'nil', 'fragments.jsonl'), 'utf8'), /nil 的约定/);
  assert.match(await readFile(join(dataRoot, 'zoe', 'fragments.jsonl'), 'utf8'), /zoe 的约定/);
  assert.equal(homes.context('olsen'), undefined);
  assert.throws(() => homes.directory('../nil'), /未知用户/);
  homes.note('nil', { id: 1, type: 'interaction.submitted', data: { instruction: '只属于 nil' } });
  homes.saveWorkspace('nil', { tasks: [{ id: 'task-nil', capability: 'general_assistant', status: 'completed' }], subtitle: { active: false, text: '' } });
  await homes.idle();
  assert.match(await readFile(join(dataRoot, 'nil', 'session.jsonl'), 'utf8'), /只属于 nil/);
  assert.match(await readFile(join(dataRoot, 'nil', 'workspace.json'), 'utf8'), /task-nil/);
  await assert.rejects(readFile(join(dataRoot, 'zoe', 'session.jsonl')), { code: 'ENOENT' });
  await homes.dispose();
});

test('known accounts are the directory names', () => {
  assert.deepEqual(ACCOUNTS, ['nil', 'zoe', 'john', 'yanyi', 'fengshuai', 'yuxia', 'zhaoxin', 'olsen']);
});

test('runtime session and workspace stay inside the acting user directory', async t => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'mooting-runtime-users-'));
  const homes = new UserHomes({ dataRoot, accounts: ['nil', 'zoe'], env: { MOOTING_CONTEXT_BASE_URL: '', MOOTING_CONTEXT_MODEL: '', MOOTING_CONTEXT_API_KEY: '' } });
  await homes.open();
  const h = await harness({ homes });
  t.after(async () => { await h.dispose(); await homes.dispose(); });
  await h.runtime.submit({ instruction: 'nil 的指令' }, 'nil');
  await h.runtime.idle();
  await h.runtime.submit({ instruction: 'zoe 的指令' }, 'zoe');
  await h.runtime.idle();
  await homes.idle();
  const nil = await readFile(join(dataRoot, 'nil', 'session.jsonl'), 'utf8');
  const zoe = await readFile(join(dataRoot, 'zoe', 'session.jsonl'), 'utf8');
  assert.match(nil, /nil 的指令/);
  assert.doesNotMatch(nil, /zoe 的指令/);
  assert.match(zoe, /zoe 的指令/);
  assert.doesNotMatch(zoe, /nil 的指令/);
  assert.match(await readFile(join(dataRoot, 'nil', 'workspace.json'), 'utf8'), /nil 的指令/);
  const nilState = h.runtime.state('nil');
  assert.equal(nilState.sessionId, 'mooting-nil');
  assert.equal(nilState.subtitle.text, '');
  assert.ok(nilState.trace.some(item => JSON.stringify(item).includes('nil 的指令')));
  assert.ok(!nilState.trace.some(item => JSON.stringify(item).includes('zoe 的指令')));
});
