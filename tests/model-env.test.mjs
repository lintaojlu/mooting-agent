import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readModelEnv, writeModelEnv } from '../src/model-env.mjs';

test('dotenv preserves unrelated variables, replaces multiline owned entries and round-trips secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mooting-env-')), path = join(dir, '.env');
  await writeFile(path, '# custom settings\nOTHER_TOKEN="untouched"\nexport MOOTING_API_KEY="old\nmultiline"\nMOOTING_MODEL=old\n');
  const config = { router: { baseURL: 'http://localhost:8000/v1', model: 'new-model', apiKey: 'test # $ key " quote' }, worker: { baseURL: 'https://worker.example/v1', model: 'worker', apiKey: 'worker-test-key' } };
  await writeModelEnv(path, config);
  const env = await readModelEnv(path), text = await readFile(path, 'utf8');
  assert.equal(env.OTHER_TOKEN, 'untouched'); assert.ok(text.includes('# custom settings'));
  assert.equal(env.MOOTING_API_KEY, config.router.apiKey); assert.equal(env.MOOTING_WORKER_API_KEY, config.worker.apiKey);
  assert.equal(env.MOOTING_PROTOCOL, 'responses'); assert.ok(!text.includes('multiline'));
  assert.equal((text.match(/^MOOTING_API_KEY=/gm) ?? []).length, 1);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeModelEnv(path, { router: config.router });
  assert.equal((await readModelEnv(path)).MOOTING_WORKER_API_KEY, '');
});
