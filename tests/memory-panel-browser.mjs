import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startModelFixture } from './model-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const home = await mkdtemp(join(tmpdir(), 'mooting-memory-browser-'));
const dataRoot = join(home, 'data');
await mkdir(dataRoot);
await symlink(join(root, 'vendor', 'node_modules'), join(home, 'node_modules'), 'dir');
const at = new Date().toISOString();
await writeFile(join(dataRoot, 'memory-cache.json'), JSON.stringify({ models: { 'user-profile': { content: '用户喜欢简短回复。', updatedAt: at }, people: { content: '', people: [], updatedAt: at }, 'open-items': { content: '周五交付原型。', updatedAt: at } }, fetchedAt: at }));
await writeFile(join(dataRoot, 'fragments.jsonl'), JSON.stringify({ at, text: '王磊明天交付语音助手原型。' }) + '\n');
await writeFile(join(dataRoot, 'context-trace.jsonl'), Array.from({ length: 215 }, (_, index) => JSON.stringify({ seq: index + 1, at, type: 'fixture.step', data: { index } })).join('\n') + '\n');
const fixture = await startModelFixture();
await writeFile(join(home, '.env'), `MOOTING_BASE_URL='${fixture.baseURL}'\nMOOTING_MODEL='browser-router'\nMOOTING_API_KEY='fixture-browser-key'\nMOOTING_HINDSIGHT_ENABLED='0'\n`);
const children = [];
function launch(command, args, options = {}) { const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options }); children.push(child); return child; }
function output(child, pattern) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('启动超时：' + text.slice(-2000))), 30_000);
    const data = chunk => { text += chunk; const match = text.match(pattern); if (match) { clearTimeout(timer); resolve(match[1]); } };
    child.stdout.on('data', data); child.stderr.on('data', data);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`提前退出 ${code}: ${text.slice(-2000)}`)); });
  });
}
let ws;
try {
  const app = launch(process.execPath, ['src/start.mjs'], { cwd: root, env: { ...process.env, MOOTING_HOME: home, MOOTING_DATA_ROOT: dataRoot, MOOTING_PORT: '0', MOOTING_AUTH: '0' } });
  const ready = JSON.parse(await output(app, /MOOTING_READY (\{[^\n]+\})/));
  const chrome = launch('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(home, 'chrome')}`, 'about:blank']);
  const debuggerURL = new URL(await output(chrome, /DevTools listening on (ws:\/\/[^\s]+)/));
  const target = await fetch(`http://${debuggerURL.host}/json/new?${encodeURIComponent(ready.url)}`, { method: 'PUT' }).then(res => res.json());
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', event => { const reply = JSON.parse(event.data); const callback = pending.get(reply.id); if (callback) { pending.delete(reply.id); reply.error ? callback.reject(new Error(JSON.stringify(reply.error))) : callback.resolve(reply.result); } });
  function cdp(method, params = {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 10_000); pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } }); ws.send(JSON.stringify({ id, method, params })); });
  }
  async function evaluate(expression) { const reply = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails)); return reply.result.value; }
  for (let n = 0; ; n++) {
    if (await evaluate(`document.querySelector('#context-status')?.textContent === '记忆已关闭'`)) break;
    if (n >= 100) throw new Error('Context 状态未显示');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await evaluate(`document.querySelector('#context-fragment-title').textContent`), '最近原话');
  assert.match(await evaluate(`document.querySelector('#context-snapshot').textContent`), /王磊明天/);
  const injected = await evaluate(`document.querySelector('#context-injected').textContent`);
  assert.match(injected, /用户档案[\s\S]*用户喜欢简短回复/);
  assert.match(injected, /进行中事项[\s\S]*周五交付原型/);
  assert.doesNotMatch(injected, /王磊明天交付语音助手原型/, '一分钟原话属于用户消息，不属于记忆系统提示');
  assert.match(await evaluate(`document.querySelector('#context-memory-info').textContent`), /积压 0 条.*档案.*人物.*事项/);
  await fetch(ready.url + '/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction: '总结会议' }) });
  for (let n = 0; ; n++) {
    const state = await fetch(ready.url + '/api/state').then(res => res.json());
    if (!state.busy && state.context.outbox > 0) {
      const memory = state.events.find(event => event.type === 'user/message' && event.data.source?.kind === 'runtime-context');
      assert.match(JSON.stringify(memory), /用户喜欢简短回复/);
      assert.doesNotMatch(JSON.stringify(memory), /王磊明天交付语音助手原型/);
      const user = state.events.find(event => event.type === 'user/message' && event.data.source?.kind === 'user');
      assert.match(user.data.content[0].text, /## 最近1分钟原话[\s\S]*王磊明天交付语音助手原型[\s\S]*## 用户指令/);
      break;
    }
    if (n >= 100) throw new Error('Router 回合未完成');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const trace = await fetch(ready.url + '/api/context/trace').then(res => res.json());
  assert.ok(trace.entries.length > 215, '轨迹 API 必须返回超过 SSE 窗口的完整历史');
  assert.ok(trace.entries.some(entry => entry.type === 'fixture.step' && entry.data.index === 0));
  assert.ok(trace.entries.some(entry => entry.type === 'context.load.ready'));
  assert.ok(trace.entries.some(entry => entry.type === 'turn.queued'));
  const read = trace.entries.find(entry => entry.type === 'memory.read');
  assert.ok(read, '需要记录实际缓存读取');
  assert.match(read.data.injected, /用户档案[\s\S]*用户喜欢简短回复/);
  assert.match(read.data.userPrompt, /最近1分钟原话[\s\S]*王磊明天/);
  await evaluate(`document.querySelector('#context-trace-view').scrollIntoView()`);
  assert.ok(Number(await evaluate(`document.querySelectorAll('#context-trace-rows tr').length`)) >= trace.entries.length, '完整 Context 轨迹应渲染到独立面板');
  assert.match(await evaluate(`[...document.querySelectorAll('#context-trace-rows tr')].find(row => row.textContent.includes('读取并注入 Router'))?.textContent || ''`), /用户喜欢简短回复/);
  const shown = await evaluate(`(() => { const row = [...document.querySelectorAll('#context-trace-rows tr')].find(row => row.textContent.includes('读取并注入 Router')); if (!row) return ''; row.querySelector('summary').click(); return row.querySelector('.context-trace-content')?.textContent || ''; })()`);
  assert.match(shown, /用户档案[\s\S]*用户喜欢简短回复/);
  assert.equal(await evaluate(`document.querySelector('#trace-title').textContent`), 'Agent Trace');
  // Desktop: Context is its own full-width row, below output/control/Router and above the trace.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  const rows = await evaluate(`(() => { const box = id => { const r = document.getElementById(id).closest('section').getBoundingClientRect(); return { x:r.x, y:r.y, w:r.width, h:r.height }; }; const lab = document.querySelector('.lab-grid').getBoundingClientRect(); return { output:box('output-title'), stream:box('inform-stream-title'), router:box('agent-title'), context:box('context-title'), contextTrace:box('context-trace-title'), trace:box('trace-title'), labW:lab.width, streamTextH:document.getElementById('inform_stream').getBoundingClientRect().height, columns:[...document.querySelectorAll('.context-body > *')].map(e => e.getBoundingClientRect().top) }; })()`);
  assert.ok(rows.stream.y >= rows.output.y && rows.router.y >= rows.stream.y + rows.stream.h - 1, '信息流必须位于 Router 上方');
  assert.ok(rows.streamTextH <= 70, `信息流应更窄：${rows.streamTextH}`);
  assert.equal(rows.context.h, 0, 'Context 面板暂时隐藏');
  assert.ok(rows.contextTrace.y >= Math.max(rows.output.y + rows.output.h, rows.router.y + rows.router.h) - 1, 'Context System Trace 应在输出与 Router 所在行之后');
  assert.ok(rows.trace.y >= rows.contextTrace.y + rows.contextTrace.h - 1, 'Agent Trace 应在 Context System Trace 之后');
  assert.equal(rows.columns.length, 2);
  assert.ok(rows.columns.every(top => Math.abs(top - rows.columns[0]) <= 1), '桌面宽度下 Context 两块内容应并排');
  const clipped = await evaluate(`(() => { const el = document.getElementById('context-injected'); return { scroll: el.scrollHeight, client: el.clientHeight, text: el.textContent }; })()`);
  assert.ok(clipped.scroll <= clipped.client + 1 || clipped.client >= 400, `注入记忆被截断且未达到可滚动上限：${clipped.scroll}/${clipped.client}`);
  const wide = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(root, 'artifacts', 'memory-panel-desktop.png'), Buffer.from(wide.data, 'base64'));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.documentElement.scrollWidth > window.innerWidth'), false);
  assert.equal(await evaluate(`document.querySelector('.context-panel').getBoundingClientRect().height`), 0, 'Context 面板暂时隐藏');
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await writeFile(join(root, 'artifacts', 'memory-panel.png'), Buffer.from(screenshot.data, 'base64'));
  console.log('PASS: real Loader + Chrome; compact speech above Router, full Context System Trace history, separate Agent Trace, desktop and mobile layout');
} finally {
  ws?.close(); await fixture.close();
  await Promise.all(children.map(child => new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) return resolve(); const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); timer.unref(); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); })));
}
