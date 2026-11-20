import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCOUNTS } from '../src/access.mjs';
import { UserHomes } from '../src/user-homes.mjs';
import { ContextSystem } from '../src/context/index.mjs';
import { harness } from './harness.mjs';
import { MockRouterAdapter } from './mock-router-adapter.mjs';
import { FakeSound2text } from './fake-sound2text.mjs';

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

test('ignored workspace drafts and live social-card decisions follow the actual queue', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'mooting-card-workspace-'));
  const homes = new UserHomes({ dataRoot, accounts: ['nil', 'zoe'] });
  const sound2text = new FakeSound2text();
  let h;
  try {
    await homes.open();
    await homes.saveWorkspace('nil', {
      ownerSpeaker: '主人',
      speaker: { active: true, draft: true, person: { name: '上次未保存' } },
    });
    h = await harness({ homes, sound2text, socialCardRoot: dataRoot });
    const { runtime } = h;
    assert.deepEqual(runtime.state('nil').speaker, { active: false, person: null });
    assert.equal(homes.workspace('nil').speaker, undefined);
    assert.equal(runtime.state('nil').ownerSpeaker, '主人');

    runtime.setAudioOwner('nil', true);
    sound2text.utterances([
      { speaker: '访客一', speakerKey: 'one', definite: true, text: '初次见面', start_time: 1, end_time: 2 },
      { speaker: '访客二', speakerKey: 'two', definite: true, text: '你好', start_time: 3, end_time: 4 },
    ]);
    runtime.setAudioOwner('nil', false);
    await runtime.endDialogue('voice-paused');
    const first = runtime.state('nil').speaker;
    assert.equal(first.draft, true);
    assert.equal(first.person.name, '访客一');
    assert.equal(runtime.state('zoe').speaker.active, false);
    await assert.rejects(runtime.discardSocialCard('zoe', first.id), { status: 409 });
    assert.equal((await runtime.discardSocialCard('nil', first.id)).discarded, true);
    const second = runtime.state('nil').speaker;
    assert.equal(second.person.name, '访客二');
    await assert.rejects(runtime.discardSocialCard('nil', first.id), { status: 409 });
    assert.equal(runtime.state('nil').speaker.id, second.id);
    await runtime.discardSocialCard('nil', second.id);
    assert.equal(runtime.state('nil').speaker.active, false);
    assert.deepEqual(runtime.socialCards.list(), []);
  } finally {
    await h?.dispose();
    await homes.dispose();
    await rm(dataRoot, { recursive: true, force: true });
  }
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
  assert.deepEqual(nilState.trace.filter(item => item.type === 'interaction.submitted').map(item => item.data.instruction), ['nil 的指令']);
  assert.ok(!nilState.trace.some(item => JSON.stringify(item).includes('zoe 的指令')));
});

test('Agent Trace keeps past and current account events when DSH reuses sequence numbers after restart', async t => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'mooting-restarted-users-'));
  const context = new ContextSystem({ dataRoot });
  await context.ready;
  t.after(() => context.dispose());
  const options = { dataRoot, accounts: ['nil', 'zoe'], context };
  const oldHomes = new UserHomes(options);
  await oldHomes.open();
  const oldRuntime = await harness({ homes: oldHomes });
  await oldRuntime.runtime.submit({ instruction: '重启前的指令' }, 'nil');
  await oldRuntime.runtime.idle();
  const oldEvents = oldRuntime.runtime.state('nil').events;
  await oldRuntime.dispose();
  await oldHomes.dispose();

  const homes = new UserHomes(options);
  await homes.open();
  const { runtime, dispose } = await harness({ homes });
  t.after(async () => { await dispose(); await homes.dispose(); });
  await runtime.submit({ instruction: '另一账号的指令' }, 'zoe');
  await runtime.idle();
  assert.deepEqual(runtime.state('nil').events, oldEvents);
  // Exercise an existing log whose records were written before run IDs.
  const history = homes.logs.get('nil');
  for (const entry of history) delete entry.traceRun;
  await runtime.submit({ instruction: '重启后的文本指令' }, 'nil');
  await runtime.idle();
  const { events } = runtime.state('nil');
  assert.deepEqual(events.slice(0, oldEvents.length), oldEvents);
  assert.deepEqual(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    .map(event => event.data.source.command), ['重启前的指令', '重启后的文本指令']);
  assert.equal(new Set(events.map(event => event.seq)).size, events.length);
  const turns = events.filter(event => event.type === 'turn/start').map(event => event.data.turn);
  assert.equal(turns.length, 2);
  assert.ok(turns[1] > turns[0]);
});

test('clearing memory removes all account conversations and starts a fresh Router session', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'mooting-cleared-users-'));
  const context = new ContextSystem({ dataRoot });
  const options = { dataRoot, accounts: ['nil', 'zoe'], context };
  const homes = new UserHomes(options);
  const requests = [];
  class RecordingAdapter extends MockRouterAdapter {
    stream(options) {
      requests.push(JSON.stringify(options.messages));
      return super.stream(options);
    }
  }
  let h;
  try {
    await context.ready;
    await homes.open();
    h = await harness({ homes, adapter: new RecordingAdapter() });
    const { runtime } = h;
    runtime.setOwnerSpeaker('显示名', 'nil');
    for (const username of homes.accounts) {
      await runtime.submit({ instruction: `${username} 的旧消息` }, username);
      await runtime.idle();
      assert.ok(runtime.state(username).events.length > 0);
    }
    const previousRun = runtime.state('nil').traceRun;
    const clearing = runtime.clearMemory('nil');
    await assert.rejects(runtime.submit({ instruction: '清空期间的消息' }, 'zoe'), { status: 409 });
    await clearing;
    assert.notEqual(runtime.state('nil').traceRun, previousRun);
    assert.equal(runtime.state('nil').sessionCount, 1);
    const reopened = new UserHomes(options);
    await reopened.open();
    for (const username of homes.accounts) {
      const state = runtime.state(username);
      assert.deepEqual(state.trace, []);
      assert.deepEqual(state.events, []);
      assert.equal(state.currentContext, null);
      assert.deepEqual(reopened.logs.get(username), []);
      assert.equal(reopened.workspace(username).currentContext, null);
      await assert.rejects(readFile(join(homes.directory(username), 'session.jsonl')), { code: 'ENOENT' });
    }
    assert.equal(reopened.workspace('nil').ownerSpeaker, '显示名');
    await runtime.submit({ instruction: '清空后的新消息' }, 'nil');
    await runtime.idle();
    assert.match(requests.at(-1), /清空后的新消息/);
    assert.doesNotMatch(requests.at(-1), /旧消息/);
    assert.deepEqual(runtime.state('nil').events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
      .map(event => event.data.source.command), ['清空后的新消息']);
  } finally {
    await h?.dispose();
    await homes.dispose();
    await context.dispose();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
