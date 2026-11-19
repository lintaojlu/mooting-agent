import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const demoHome = resolve(root, process.env.MOOTING_HOME ?? '.runtime');
const profile = join(demoHome, 'profiles', 'mooting-demo');
await mkdir(profile, { recursive: true });
// Generated isolated profile. Never writes the user's Harness home/profile.
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'mooting-demo-profile', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2));
await writeFile(join(profile, 'cordis.patch.yml'), (await readFile(join(root, 'cordis.patch.yml'), 'utf8')).replace(/name: \.\/src\/([\w/-]+\.mjs)/g, (_match, file) => `name: ${JSON.stringify(join(root, 'src', file))}`));
const cli = join(root, 'vendor/node_modules/@deepseek-ai/dsh/lib/bin.js');
const child = spawn(process.execPath, [cli, '--profile', 'mooting-demo', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env: { ...process.env, DSH_HOME: demoHome } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
