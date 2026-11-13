import { parseEnv } from 'node:util';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

const KEYS = ['MOOTING_PROTOCOL', 'MOOTING_BASE_URL', 'MOOTING_MODEL', 'MOOTING_API_KEY', 'MOOTING_WORKER_BASE_URL', 'MOOTING_WORKER_MODEL', 'MOOTING_WORKER_API_KEY'];
export async function readModelEnv(path) {
  try { return parseEnv(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function quote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('模型配置不能包含换行或空字符');
  for (const delimiter of ["'", '"', '`']) if (!value.includes(delimiter)) return delimiter + value + delimiter;
  throw new Error('模型配置不能同时包含所有引号类型');
}
/** Replace owned variables only; preserve comments and unrelated environment entries. */
export async function writeModelEnv(path, config) {
  let text = ''; try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Remove full assignments, including quoted multiline values, without touching other entries.
  const names = KEYS.join('|');
  const pattern = new RegExp('^[ \\t]*(?:export[ \\t]+)?(?:' + names + ')[ \\t]*=[ \\t]*(?:"[^"]*"|\'[^\']*\'|`[^`]*`|[^\\r\\n]*)(?:[ \\t]*#[^\\r\\n]*)?\\r?\\n?', 'gm');
  const retained = text.replace(pattern, '').replace(/\s*$/, '');
  const values = {
    MOOTING_PROTOCOL: 'responses', MOOTING_BASE_URL: config.router.baseURL, MOOTING_MODEL: config.router.model, MOOTING_API_KEY: config.router.apiKey,
    MOOTING_WORKER_BASE_URL: config.worker?.baseURL ?? '', MOOTING_WORKER_MODEL: config.worker?.model ?? '', MOOTING_WORKER_API_KEY: config.worker?.apiKey ?? '',
  };
  const assignments = Object.entries(values).map(([key, value]) => `${key}=${quote(value)}`).join('\n');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, (retained ? retained + '\n\n' : '') + assignments + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
}
