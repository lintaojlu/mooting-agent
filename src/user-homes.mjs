import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { InputError } from './tasks.mjs';
import { ContextSystem } from './context.mjs';

/** One directory per account. Memory, fragments, session log and workspace all stay inside data/<username>/. */
export class UserHomes {
  constructor({ dataRoot, accounts, envPath, env, complete } = {}) {
    if (!dataRoot) throw new Error('缺少数据目录');
    if (!Array.isArray(accounts) || accounts.length === 0) throw new Error('缺少用户列表');
    this.dataRoot = resolve(dataRoot);
    this.accounts = Object.freeze([...accounts]);
    this.envPath = envPath;
    this.env = env;
    this.complete = complete;
    this.contexts = new Map();
    this.logs = new Map();
    this.workspaces = new Map();
    this.chains = new Map();
  }
  directory(username) {
    if (!this.accounts.includes(username)) throw new InputError('未知用户', 403);
    const dir = resolve(this.dataRoot, username);
    if (dir !== this.dataRoot && !dir.startsWith(this.dataRoot + sep)) throw new InputError('未知用户', 403);
    return dir;
  }
  async open() {
    for (const username of this.accounts) {
      const dir = this.directory(username);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      this.logs.set(username, await readJsonLines(join(dir, 'session.jsonl')));
      this.workspaces.set(username, await readJson(join(dir, 'workspace.json')));
      const context = new ContextSystem({ memoryPath: join(dir, 'MEMORY.md'), envPath: this.envPath, env: this.env, complete: this.complete });
      this.contexts.set(username, context);
    }
    await Promise.all([...this.contexts.values()].map(context => context.ready));
  }
  context(username) {
    return this.contexts.get(username);
  }
  workspace(username) {
    return this.workspaces.get(username) ?? {};
  }
  note(username, record) {
    if (!this.logs.has(username)) return;
    const list = this.logs.get(username);
    list.push(record);
    if (list.length > 600) list.splice(0, list.length - 600);
    this.enqueue(username, async () => {
      const path = join(this.directory(username), 'session.jsonl');
      await appendFile(path, JSON.stringify(record) + '\n', { mode: 0o600 });
      await chmod(path, 0o600);
    });
  }
  saveWorkspace(username, workspace) {
    if (!this.workspaces.has(username)) return;
    this.workspaces.set(username, workspace);
    this.enqueue(username, async () => {
      const path = join(this.directory(username), 'workspace.json');
      await writeFile(path, JSON.stringify(workspace), { mode: 0o600 });
      await chmod(path, 0o600);
    });
  }
  enqueue(username, job) {
    const chain = (this.chains.get(username) ?? Promise.resolve()).then(job, job);
    this.chains.set(username, chain.catch(() => {}));
  }
  async idle() {
    await Promise.all([...this.chains.values()]);
  }
  async dispose() {
    await this.idle();
    await Promise.all([...this.contexts.values()].map(context => context.dispose()));
    this.contexts.clear();
  }
}

async function readJsonLines(path) {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).flatMap(line => {
      try { const value = JSON.parse(line); return value && typeof value === 'object' ? [value] : []; } catch { return []; }
    }).slice(-600);
  } catch (error) { if (error.code !== 'ENOENT') throw error; return []; }
}
async function readJson(path) {
  try { const value = JSON.parse(await readFile(path, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return {}; }
}
