import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
const sandbox = {}; vm.runInNewContext(app, sandbox); const ui = sandbox.MootingUI;
const plain = value => JSON.parse(JSON.stringify(value));
const config = configured => ({ configured, workerUsesRouter: true, router: { baseURL: '', model: '', hasApiKey: false }, worker: { baseURL: '', model: '', hasApiKey: false } });
const state = () => ({ sessionId: 'main', mode: 'unconfigured', busy: false, events: [], trace: [], tasks: [], subtitle: { active: false, text: '' }, modelConfig: config(false), currentContext: null, context: { memory: '', status: 'idle', configured: false, updatedAt: null } });

test('sole business submission contains only instruction', () => {
  assert.deepEqual(plain(ui.submission(' 开启字幕 ')), { instruction: '开启字幕' });
  assert.throws(() => ui.submission(' ')); assert.throws(() => ui.submission('a'.repeat(4001)));
  assert.equal((html.match(/<textarea\b/g) || []).length, 1);
  assert.doesNotMatch(html, /id="(?:context-input|frame-input)"/);
});
test('state accepts explicit unconfigured mode and requires actual DSH events', () => {
  assert.equal(ui.validateState(state()).mode, 'unconfigured');
  assert.throws(() => ui.validateState({ ...state(), events: undefined }), /状态/);
  assert.throws(() => ui.validateState({ ...state(), mode: 'automatic-mock' }), /状态/);
  assert.throws(() => ui.validateState({ ...state(), modelConfig: {} }), /配置/);
});
test('interaction page has no settings entry or toolbar', () => {
  assert.doesNotMatch(html + app, /open-settings/);
  assert.doesNotMatch(html, /class="toolbar"/);
  assert.equal(ui.outputContent(state()).text, '请先在 .env 中配置模型并重启应用。');
  const ready = state(); ready.modelConfig = config(true);
  assert.deepEqual(plain(ui.outputContent(ready)), { text: '已准备好做你的co-pilot！', streaming: false, turns: [{ role: 'assistant', text: '已准备好做你的co-pilot！' }] });
  assert.match(html, /output-turn-assistant[\s\S]*\(ovo\)[\s\S]*已准备好做你的co-pilot！/);
  assert.doesNotMatch(html + app, /暂无对话/);
});
test('model settings preserve blank keys and distinguish Worker reuse from separate route', () => {
  const values = { routerBaseURL: ' http://localhost:8000/v1 ', routerModel: ' local ', routerApiKey: '', workerUsesRouter: true };
  assert.deepEqual(plain(ui.modelSubmission(values)), { router: { baseURL: 'http://localhost:8000/v1', model: 'local', apiKey: '' }, workerUsesRouter: true });
  assert.deepEqual(plain(ui.modelSubmission({ ...values, workerUsesRouter: false, workerBaseURL: 'https://worker.example/v1', workerModel: 'worker', workerApiKey: 'test' })).worker, { baseURL: 'https://worker.example/v1', model: 'worker', apiKey: 'test' });
  assert.throws(() => ui.modelSubmission({ ...values, routerModel: '' }), /Router/);
});
test('input-output row and Context Router Worker row use DSH views', () => {
  for (const title of ['控制面板', '>Context<', '>Router<', '>Worker<', '执行轨迹']) assert.ok(html.includes(title));
  assert.doesNotMatch(html, />输出面板</);
  assert.match(html, /class="output-clock"/);
  assert.match(html, /class="battery-icon"/);
  assert.match(css, /\.output-panel \.panel-heading \{[^}]*border-bottom:0/);
  assert.match(css, /\.output-text \{[^}]*font-size:16px[^}]*font-weight:400[^}]*line-height:normal/);
  assert.match(css, /\.output-status \{[^}]*font-size:16px/);
  assert.match(css, /\.panel-heading \{[^}]*min-height:49px; padding:12px 17px/);
  assert.doesNotMatch(css, /\.output-status \{[^}]*(?:min-height|padding)\s*:/);
  assert.match(css, /\.battery-icon \{[^}]*width:2cap[^}]*height:1cap/);
  assert.match(css, /\.thinking::before \{[^}]*width:1em[^}]*height:1em/);
  assert.ok(html.indexOf('id="output-title"') < html.indexOf('id="input-title"'));
  const lab = html.slice(html.indexOf('<div class="lab-grid">'), html.indexOf('<div class="detail-grid">'));
  assert.ok(lab.indexOf('id="output-title"') < lab.indexOf('id="input-title"'));
  assert.equal(lab.indexOf('id="trace-title"'), -1);
  assert.ok(html.indexOf('id="worker-title"') < html.indexOf('id="trace-title"'));
  assert.ok(html.indexOf('id="trace-title"') < html.indexOf('id="trajectory-view"') && html.indexOf('id="trajectory-view"') < html.indexOf('id="raw-events"'));
  assert.match(css, /\.lab-grid \{[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
  assert.doesNotMatch(css, /\.lab-grid \{[^}]*100% \/ 6/);
  assert.match(css, /\.trace-panel \{[^}]*margin-top:18px/);
  assert.match(css, /#trajectory-view\.dsh-view \{[^}]*height:560px[^}]*filter:none/);
  assert.match(css, /@media \(max-width:800px\) \{\s*\.workspace \{[^}]*\}\s*\.lab-grid,\.detail-grid,\.config-grid \{ grid-template-columns:minmax\(0,1fr\); \}/);
  assert.match(html, /<div class="detail-grid">[\s\S]*id="context-title"[\s\S]*id="agent-title"[\s\S]*id="worker-title"[\s\S]*<\/div>/);
  assert.match(css, /\.detail-grid \{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.equal(lab.indexOf('id="inform_stream"'), -1);
  const context = html.slice(html.indexOf('class="panel context-panel"'), html.indexOf('id="agent-title"'));
  assert.ok(context.indexOf('id="inform-stream-title"') >= 0 && context.indexOf('>信息流<') < context.indexOf('id="inform_stream"') && context.indexOf('id="inform_stream"') < context.indexOf('id="context-fragment-title"') && context.indexOf('>context片段<') < context.indexOf('id="context-snapshot"'));
  assert.match(html, /<pre id="context-snapshot"/);
  assert.match(css, /\.audio-toggle \{[^}]*width:48px; height:48px[^}]*background:transparent/);
  assert.match(css, /\.audio-toggle::before \{[^}]*width:calc\(34px \* 19\.5 \/ 24\)[^}]*height:calc\(34px \* 19\.5 \/ 24\)/);
  assert.match(css, /\.esc-button,\.primary-button \{[^}]*height:calc\(34px \* 19\.5 \/ 24\)[^}]*background:#171717/);
  const form = html.match(/<form id="submit-form"[\s\S]*?<\/form>/)[0];
  assert.equal((form.match(/<button\b/g) || []).length, 1);
  assert.doesNotMatch(form, /textarea|id="inform_stream"|id="audio-toggle"/);
  assert.ok(html.indexOf('src="/dsh-views.js"') < html.indexOf('src="/app.js"'));
  assert.ok(html.includes('href="/dsh-views.css"'));
  assert.match(app, /renderConversation\(\$\('agent-conversation'\), \{ events: state\.events, stream: state\.stream, busy: state\.busy \}\)/);
  assert.match(app, /renderTrajectory\(\$\('trajectory-view'\), \{ events: state\.events, stream: state\.stream, busy: state\.busy \}\)/);
  assert.match(app, /renderWorkers\(\$\('worker-conversation'\)/);
  assert.match(app, /DSH 对话与轨迹组件未加载/);
  assert.equal((html.match(/<form id="submit-form"[\s\S]*?<\/form>/)[0].match(/<button\b/g) || []).length, 1);
  assert.doesNotMatch(html, /interact-button|data-preset/);
  assert.match(html, /id="submit-button"[^>]*disabled>confirm</);
  assert.ok(html.indexOf('id="submit-button"') < html.indexOf('id="esc-button"'));
  assert.match(html, /id="inform_stream"[^>]*readonly/);
  assert.doesNotMatch(html + app, /🔘/);
});
test('only Router final answer is presented as interaction result', () => {
  assert.equal(ui.latestRouterAnswer([{ type: 'router.answer', data: { text: '最终结果' } }, { type: 'worker.report', data: { text: '工作中' } }, { type: 'router.plan', data: { text: '计划' } }]), '最终结果');
  assert.equal(ui.latestRouterAnswer([{ type: 'router.answer', data: { text: '旧结果' } }, { type: 'interaction.submitted' }, { type: 'router.error', data: { error: '失败' } }]), '');
});
test('output shows the router dialogue, streamed text, then the committed exchange, without reasoning leakage', () => {
  const value = state(); value.modelConfig = config(true); value.busy = true;
  value.stream = { text: '你', reasoning: '内部推理' };
  assert.equal(ui.outputContent(value).text, '你');
  assert.equal(ui.outputContent(value).streaming, true);
  assert.equal(ui.outputContent(value).turns.at(-1).role, 'assistant');
  value.stream.text = '你好'; assert.equal(ui.outputContent(value).text, '你好');
  value.stream = null; value.busy = false; value.trace = [{ type: 'router.answer', data: { text: '你好。' } }];
  assert.deepEqual(plain(ui.outputContent(value)), { text: '你好。', streaming: false, turns: [{ role: 'assistant', text: '你好。' }] });
  value.events = [
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: JSON.stringify({ instruction: '开启实时字幕' }) }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '内部推理' }, { type: 'text', text: '实时字幕已开启。' }] } } },
    { type: 'user/message', data: { source: { kind: 'mooting-task-event' }, content: [{ type: 'text', text: JSON.stringify({ instruction: '后台任务状态已更新' }) }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '实时字幕任务已完成。' }] } } },
  ];
  assert.deepEqual(plain(ui.outputContent(value).turns.map(turn => ({ role: turn.role, text: turn.text }))), [
    { role: 'user', text: '开启实时字幕' },
    { role: 'assistant', text: '实时字幕已开启。' },
    { role: 'assistant', text: '实时字幕任务已完成。' },
  ]);
  assert.doesNotMatch(ui.outputContent(value).text, /内部推理|后台任务状态已更新/);
  value.events.unshift({ type: 'user/message', data: { source: { kind: 'user', command: '只显示命令' }, content: [{ type: 'text', text: '## 用户之前正在聊的内容\n```\n用户喜欢短句\n```\n\n## 用户指令\n```\n只显示命令\n```' }] } });
  assert.equal(ui.outputContent(value).turns[0].text, '只显示命令');
  assert.doesNotMatch(ui.outputContent(value).text, /用户喜欢短句/);
  value.context = { memory: '# 记忆\n', fragments: [{ at: '2026-11-13T02:00:00.000Z', text: '第一句定稿。' }, { at: '2026-11-13T02:01:00.000Z', text: '第二句定稿。' }], status: 'idle', configured: true, updatedAt: '2026-11-13T00:00:00.000Z' };
  const history = ui.contextPanel(value).text;
  assert.ok(history.indexOf('第一句定稿。') >= 0 && history.indexOf('第一句定稿。') < history.indexOf('第二句定稿。'));
  assert.equal(ui.contextPanel(value).status, '已同步');
  value.context = { memory: '', status: 'updating', configured: true, updatedAt: null };
  assert.equal(ui.contextPanel(value).status, '整理中');
  value.busy = true; value.stream = { text: '正在补充', reasoning: '仍不展示' };
  assert.equal(ui.outputContent(value).turns.at(-1).text, '正在补充');
  assert.equal(ui.outputContent(value).streaming, true);
  value.stream = null; value.lastError = '连接失败';
  assert.equal(ui.outputContent(value).text, '执行失败：连接失败');
  value.subtitle = { active: true, text: '这是实时字幕...' };
  assert.equal(ui.outputContent(value).text, '执行失败：连接失败');
  assert.deepEqual(plain(ui.functionPanel(value)), { kind: 'subtitle', text: '这是实时字幕...' });
  assert.match(app, /bindTailFollow\(\$\('interaction-window'\)\)/);
  assert.match(app, /bindTailFollow\(\$\('function-window'\)\)/);
  assert.match(app, /bindTailFollow\(\$\('command-panel'\)\)/);
  assert.match(app, /output-turn-/);
  assert.match(app, /textContent = '\(ovo\)'/);
  assert.match(html, /class="command-mark"[^>]*>\(ovo\)</);
  assert.match(css, /\.output-turn-user \{[^}]*max-width:calc\(100% - 3em\)/);
  assert.match(css, /\.output-avatar \{[^}]*font-size:1em/);
  assert.match(html, /id="agent-panel"[^>]*aria-label="agent panel"/);
  assert.match(html, /aria-label="function panel"/);
  assert.match(html, /aria-label="command panel"/);
  assert.match(html, /id="esc-button"[^>]*>esc</);
  assert.match(css, /\.esc-button \{[^}]*width:calc\(34px \* 19\.5 \/ 24\)/);
  assert.match(css, /\.function-panel \{[^}]*transform:translateX\(100%\)/);
  assert.match(css, /\.output-stage\.is-split \.function-panel \{[^}]*transform:translateX\(0\)/);
  assert.match(css, /\.command-shell \{[^}]*transform:translateY\(calc\(100% \+ 24px\)\)/);
  assert.match(css, /\.output-stage\.is-command \.command-shell \{[^}]*transform:translateY\(0\)/);
  assert.match(css, /\.command-mark \{[^}]*left:50%[^}]*transform:translate\(-50%,-50%\)/);
  assert.match(app, /\$\('esc-button'\)\.addEventListener\('click'/);
  assert.match(app, /event\.key !== 'Escape'/);
});
test('all element bindings exist and secrets are never refilled from public config', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]); assert.equal(ids.length, new Set(ids).size);
  for (const match of app.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), match[1]);
  for (const prefix of ['router', 'worker']) for (const suffix of ['base-url', 'model', 'api-key']) assert.ok(ids.includes(prefix + '-' + suffix));
  assert.match(app, /\$\(prefix \+ '-api-key'\)\.value = ''/);
  assert.match(app, /已保存，未验证连接/);
  assert.match(html, /type="password"/);
});
test('network operations are backend-only and submit requires model configuration', () => {
  for (const path of ['/api/model/config', '/api/state', '/api/events', '/api/submit', '/api/interaction']) assert.ok(app.includes("'" + path + "'"));
  assert.match(app, /config\?\.configured === true/);
  assert.match(app, /addEventListener\('data', receive\)/);
  assert.match(app, /不会切换为模拟模型/);
});
test('voice mode locks text entry and routes all capture controls through backend coordination', () => {
  const value = state(); value.modelConfig = config(true); value.busy = true;
  value.sound2text = { configured: true, status: 'running', text: '实时识别', capture: { status: 'idle' } };
  assert.equal(ui.audioState(value, 'running').readOnly, true);
  assert.equal(ui.audioState(value, 'running').running, true);
  assert.deepEqual(plain(ui.interactionRequest(value, '', 'running')), { path: '/api/voice/interaction', body: {} });
  value.sound2text.capture.status = 'listening';
  assert.equal(ui.interactionRequest(value, '', 'running').path, '/api/voice/interaction');
  value.subtitle.active = true;
  assert.deepEqual(plain(ui.interactionRequest(value, '不应发送', 'running')), { path: '/api/interaction', body: {} });
  value.subtitle.active = false; value.sound2text.status = 'stopped';
  assert.equal(ui.audioState(value).readOnly, false);
  assert.deepEqual(plain(ui.interactionRequest(value, '新指令')), { path: '/api/submit', body: { instruction: '新指令' } });
  assert.deepEqual(plain(ui.interactionRequest(value, '')), { path: '/api/interaction', body: { intent: 'interrupt' } });
});
test('microphone uses SVG playback controls and dedicated PCM worklet resources', () => {
  assert.match(html, /id="audio-toggle"/); assert.match(html, /class="play-symbol"/); assert.match(html, /class="pause-symbol"/);
  assert.match(html, /src="\/audio-capture.js"/); assert.match(app, /\$\('inform_stream'\)\.readOnly = true/);
  assert.match(app, /\/api\/voice\/interaction/); assert.match(app, /sound2text\?\.configured/);
  assert.doesNotMatch(app, /MediaRecorder|audio\/webm/);
});
test('black-white functional layout excludes decorative branding', () => {
  assert.doesNotMatch(html, /PERSONAL AGENT LAB|当前唯一 Session|mooting-main|让上下文成为行动|class="brand|slogan/);
  assert.doesNotMatch(app, /\.innerHTML|\.outerHTML|insertAdjacentHTML|eval\(/);
  assert.doesNotMatch(css, /@import|https?:\/\//);
  const waveguide = new Set(['54ff83', '07100b', '243c2c', '1b3022', '8bc99c']);
  for (const [, value] of css.matchAll(/#([\da-f]{6})\b/gi)) assert.ok(waveguide.has(value) || (value.slice(0, 2) === value.slice(2, 4) && value.slice(2, 4) === value.slice(4, 6)));
  assert.match(css, /max-width:620px/); assert.match(css, /prefers-reduced-motion/);
});


test('speaker card owns the output and close button bypasses text and voice capture', () => {
  const value = state(); value.speaker = { active: true, person: { name: 'John', identity: '空间折叠负责人；AI创业者', notes: ['上次聊过如何构建高时效性的AgentOS。'] }, simulated: true };
  value.busy = true; value.stream = { text: 'Router confirmation' };
  assert.equal(ui.functionPanel(value).kind, 'speaker');
  assert.equal(ui.outputContent(value).text, 'Router confirmation');
  assert.deepEqual(plain(ui.interactionRequest(value, '识别面前说话人', 'running')), { path: '/api/interaction', body: {} });
  assert.equal(ui.validateState(value), value);
  assert.throws(() => ui.validateState({ ...value, speaker: { active: true, person: { name: 'missing fields' } } }), /说话人状态/);
  value.speaker.active = false;
  assert.equal(ui.functionPanel(value).kind, null);
  assert.equal(ui.outputContent(value).text, 'Router confirmation');
});


test('voice capture gives progress feedback and exposes timeout instead of silently retaining an old result', () => {
  const value = state(); value.trace = [{ type: 'router.answer', data: { text: '旧结果' } }];
  value.sound2text = { capture: { status: 'listening', id: 'new-capture' } };
  assert.equal(ui.commandPanel(value).open, true);
  assert.equal(ui.commandPanel(value).text, '正在聆听，请说出指令…');
  assert.equal(ui.outputContent(value).text, '旧结果');
  value.sound2text.capture.status = 'finishing';
  assert.equal(ui.commandPanel(value).text, '正在等待语音识别完成…');
  value.sound2text.capture = { status: 'listening', id: 'bounded', boundaryMs: 1000 };
  value.sound2text.utterances = [
    { text: '之前的话', start_time: 0, end_time: 500 },
    { text: '之前现在', start_time: 800, end_time: 1500, words: [{ text: '之前', start_time: 800 }, { text: '现在', start_time: 1100 }] },
    { text: '的指令', start_time: 1600, end_time: 1900 },
  ];
  assert.equal(ui.commandPanel(value).text, '现在的指令');
  value.sound2text.capture = { status: 'idle', error: '识别未完成，请重试', id: 'new-capture' };
  assert.equal(ui.commandPanel(value).open, false);
  assert.deepEqual(plain(ui.captureFeedback(value)), { text: '识别未完成，请重试', error: true });
  value.sound2text.capture = { status: 'idle', text: '完整指令' };
  assert.equal(ui.captureFeedback(value), null);
});
