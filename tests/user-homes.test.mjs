import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCOUNTS } from '../src/access.mjs';
import { UserHomes } from '../src/user-homes.mjs';
import { ContextSystem } from '../src/context/index.mjs';
import { harness } from './harness.mjs';

test('all accounts share one context; session and workspace stay per account', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'mooting-users-'));
  const context = new ContextSystem({ dataRoot });
  await context.ready;
  const homes = new UserHomes({ dataRoot, accounts: ['nil', 'zoe'], context });
  await homes.open();
  assert.equal((await stat(homes.directory('nil'))).mode & 0o777, 0o700);
  assert.equal(homes.context('nil'), context);
  assert.equal(homes.context('zoe'), context);
  assert.equal(homes.context('olsen'), undefined);
  context.observe({ status: 'running', utterances: [{ text: 'nil 的约定', definite: true, start_time: 1, end_time: 2 }] });
  await context.idle();
  assert.match(await readFile(join(dataRoot, 'fragments.jsonl'), 'utf8'), /nil 的约定/);
  await assert.rejects(readFile(join(dataRoot, 'nil', 'fragments.jsonl')), { code: 'ENOENT' });
  assert.throws(() => homes.directory('../nil'), /未知用户/);
  homes.note('nil', { id: 1, type: 'interaction.submitted', data: { instruction: '只属于 nil' } });
  homes.saveWorkspace('nil', { tasks: [{ id: 'task-nil', capability: 'general_assistant', status: 'completed' }], subtitle: { active: false, text: '' } });
  await homes.idle();
  assert.match(await readFile(join(dataRoot, 'nil', 'session.jsonl'), 'utf8'), /只属于 nil/);
  assert.match(await readFile(join(dataRoot, 'nil', 'workspace.json'), 'utf8'), /task-nil/);
  await assert.rejects(readFile(join(dataRoot, 'zoe', 'session.jsonl')), { code: 'ENOENT' });
  await homes.dispose(); await context.dispose();
});

test('known accounts are the directory names', () => {
  assert.deepEqual(ACCOUNTS, ['nil', 'zoe', 'john', 'yanyi', 'fengshuai', 'yuxia', 'zhaoxin', 'olsen']);
});

test('runtime session and workspace stay inside the acting user directory', async t => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'mooting-runtime-users-'));
  const context = new ContextSystem({ dataRoot });
  await context.ready;
  const homes = new UserHomes({ dataRoot, accounts: ['nil', 'zoe'], context });
  await homes.open();
  const h = await harness({ homes });
  t.after(async () => { await h.dispose(); await homes.dispose(); await context.dispose(); });
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
