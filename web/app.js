(function (root) {
  'use strict';
  function submission(instruction) {
    if (typeof instruction !== 'string' || !instruction.trim()) throw new Error('请先输入一条指令。');
    if (instruction.length > 4000) throw new Error('指令上限 4000 字符。');
    return { instruction: instruction.trim() };
  }
  function validateConfig(value) {
    if (!value || typeof value.configured !== 'boolean' || typeof value.workerUsesRouter !== 'boolean' || !value.router || !value.worker) throw new Error('模型配置响应不符合约定。');
    for (const route of [value.router, value.worker]) if (typeof route.baseURL !== 'string' || typeof route.model !== 'string' || typeof route.hasApiKey !== 'boolean') throw new Error('模型配置字段不符合约定。');
    return value;
  }
  function validateState(value) {
    if (!value || typeof value.sessionId !== 'string' || !['unconfigured', 'live', 'mock'].includes(value.mode) || typeof value.busy !== 'boolean' || !Array.isArray(value.events) || !Array.isArray(value.trace) || !Array.isArray(value.tasks) || !value.subtitle || typeof value.subtitle.active !== 'boolean' || typeof value.subtitle.text !== 'string') throw new Error('服务端状态不符合约定。');
    if (!value.context || typeof value.context.memory !== 'string' || typeof value.context.configured !== 'boolean' || !['idle', 'updating', 'error', 'unconfigured'].includes(value.context.status)) throw new Error('Context 状态不符合约定。');
    if (value.context.fragments !== undefined && (!Array.isArray(value.context.fragments) || value.context.fragments.some(item => !item || typeof item.text !== 'string'))) throw new Error('Context 片段不符合约定。');
    if (value.speaker && (typeof value.speaker.active !== 'boolean' || (value.speaker.active && value.speaker.person !== null && (!value.speaker.person || ['name', 'identity'].some(key => typeof value.speaker.person[key] !== 'string') || !Array.isArray(value.speaker.person.notes) || value.speaker.person.notes.some(note => typeof note !== 'string'))))) throw new Error('说话人状态不符合约定。');
    validateConfig(value.modelConfig); return value;
  }
  function latestRouterAnswer(trace) {
    let answer = '';
    for (const event of trace) {
      if (event.type === 'interaction.submitted' || event.type === 'router.error') answer = '';
      if (event.type === 'router.answer' && typeof event.data?.text === 'string') answer = event.data.text;
    }
    return answer;
  }
  function captureFeedback(value) {
    const capture = value?.sound2text?.capture;
    if (capture?.error) return { text: capture.error, error: true };
    if (capture?.status === 'listening') return { text: '正在聆听，请说出指令…', error: false };
    if (capture?.status === 'finishing') return { text: '正在等待语音识别完成…', error: false };
    return null;
  }
  function blockText(content) {
    if (!Array.isArray(content)) return '';
    return content.filter(block => block && block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('').trim();
  }
  function instructionText(content) {
    const raw = blockText(content);
    if (!raw) return '';
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.instruction === 'string' && parsed.instruction.trim()) return parsed.instruction.trim();
    } catch {}
    return raw;
  }
  function routerDialogue(value) {
    const turns = [];
    for (const event of value.events ?? []) {
      const data = event?.data ?? {};
      if (event.type === 'user/message' && data.source?.kind === 'user') {
        const command = typeof data.source.command === 'string' ? data.source.command.trim() : '';
        const text = command || instructionText(data.content);
        if (text) turns.push({ role: 'user', text });
      } else if (event.type === 'assistant/message') {
        const text = blockText(data.message?.content);
        if (text) turns.push({ role: 'assistant', text });
      }
    }
    const partial = value.busy && typeof value.stream?.text === 'string' ? value.stream.text : '';
    if (partial) {
      const last = turns.at(-1);
      if (!(last?.role === 'assistant' && last.text === partial)) turns.push({ role: 'assistant', text: partial, streaming: true });
    } else if (!turns.some(turn => turn.role === 'assistant')) {
      const answer = latestRouterAnswer(value.trace);
      if (answer) turns.push({ role: 'assistant', text: answer });
    }
    if (value.busy && !partial) turns.push({ role: 'status', text: 'Thinking' });
    return turns;
  }
  function functionPanel(value) {
    if (value.speaker?.active) return { kind: 'speaker', text: '' };
    if (value.subtitle?.active) return { kind: 'subtitle', text: value.subtitle.text || '' };
    return { kind: null, text: '' };
  }
  function commandPanel(value) {
    const capture = value?.sound2text?.capture;
    const open = capture?.status === 'listening' || capture?.status === 'finishing';
    if (!open) return { open: false, text: '' };
    const boundary = Number(capture.boundaryMs);
    const limit = Number.isFinite(capture.cutoffMs) ? capture.cutoffMs : Infinity;
    const parts = [];
    if (Number.isFinite(boundary)) {
      for (const utterance of value.sound2text?.utterances ?? []) {
        if (!utterance || typeof utterance.text !== 'string' || !(utterance.end_time > boundary) || utterance.start_time > limit) continue;
        if (utterance.start_time >= boundary) { parts.push(utterance.text); continue; }
        const words = (utterance.words ?? []).filter(word => word && Number.isFinite(word.start_time) && word.start_time >= boundary && word.start_time <= limit);
        if (words.length) parts.push(words.map(word => word.text ?? word.word ?? '').join(''));
      }
    }
    const text = parts.join('').trim();
    if (text) return { open: true, text };
    return { open: true, text: capture.status === 'finishing' ? '正在等待语音识别完成…' : '正在聆听，请说出指令…' };
  }
  function contextPanel(value) {
    const context = value?.context;
    if (!context) return { text: '尚未形成记忆。', status: '等待信息流' };
    const fragments = Array.isArray(context.fragments) ? context.fragments.filter(item => item && typeof item.text === 'string' && item.text.trim()) : [];
    const text = fragments.length ? fragments.map(item => {
      const when = Date.parse(item.at);
      const clock = Number.isFinite(when) ? new Date(when).toLocaleTimeString('zh-CN', { hour12: false }) : '';
      return (clock ? clock + '\n' : '') + item.text.trim();
    }).join('\n\n') : context.status === 'updating' ? '正在整理这段对话…' : '尚未形成记忆。';
    const status = context.status === 'updating' ? '整理中' : context.status === 'error' ? '更新失败' : context.status === 'unconfigured' ? '未配置' : context.configured ? '已同步' : '等待信息流';
    return { text, status, error: context.error || '' };
  }
  const OPENINGS = ['已准备好做你的co-pilot！', '我在。想先做点什么？', '随时可以开始。', '今天想一起搞定什么？', '准备好了，把指令交给我。'];
  let openingIndex = 0;
  function outputContent(value) {
    if (value.lastError) return { text: '执行失败：' + value.lastError, streaming: false };
    const turns = routerDialogue(value);
    if (!turns.length) {
      if (!value.modelConfig.configured) return { text: '请先在 .env 中配置模型并重启应用。', streaming: false };
      const text = OPENINGS[openingIndex % OPENINGS.length];
      return { text, streaming: false, turns: [{ role: 'assistant', text }] };
    }
    return { text: turns.map(turn => turn.text).join('\n'), streaming: turns.some(turn => turn.streaming), turns };
  }
  function modelSubmission(values) {
    const route = prefix => ({ baseURL: values[prefix + 'BaseURL'].trim(), model: values[prefix + 'Model'].trim(), apiKey: values[prefix + 'ApiKey'] });
    const router = route('router');
    if (!router.baseURL || !router.model) throw new Error('请填写 Router 的 Base URL 和模型名称。');
    const result = { router, workerUsesRouter: !!values.workerUsesRouter };
    if (!result.workerUsesRouter) { result.worker = route('worker'); if (!result.worker.baseURL || !result.worker.model) throw new Error('请填写 Worker 的 Base URL 和模型名称。'); }
    return result;
  }
  function audioState(value, localStatus = 'idle') {
    const sound = value?.sound2text;
    const remote = sound?.status ?? 'idle';
    const active = localStatus !== 'idle' || ['connecting', 'running', 'stopping'].includes(remote);
    const capturing = sound?.capture?.status ?? 'idle';
    const busyAudio = ['connecting', 'stopping'].includes(localStatus);
    return { active, running: localStatus === 'running' && remote === 'running', readOnly: active, busyAudio, capturing,
      label: localStatus === 'connecting' || remote === 'connecting' ? '正在开启语音…' : localStatus === 'stopping' || remote === 'stopping' ? '正在停止语音…' : active ? '语音输入中' : remote === 'error' ? '语音不可用' : '语音未开启' };
  }
  function interactionRequest(value, _instruction, localStatus = 'idle') {
    if (!audioState(value, localStatus).running) throw new Error('请先开启语音输入。');
    return { path: '/api/voice/interaction', body: {} };
  }
  root.MootingUI = { captureFeedback, audioState, interactionRequest, submission, validateState, validateConfig, modelSubmission, latestRouterAnswer, routerDialogue, outputContent, functionPanel, commandPanel, contextPanel };
  if (typeof document === 'undefined') return;
  openingIndex = Math.floor(Math.random() * OPENINGS.length);
  const $ = id => document.getElementById(id);
  function renderClock() {
    const now = new Date();
    const clock = $('output-title');
    clock.textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    clock.dateTime = now.toISOString();
  }
  renderClock();
  const clockTimer = setInterval(renderClock, 10000);
  let state, config, source, connected = false, dictating = false, closing = false, saving = false, generation = 0, configLoaded = false, formDirty = false;
  let audio, localAudioStatus = 'idle', lastSoundError = '', lastCaptureError = '';
  const captureClass = root.MootingAudio?.AudioCapture;
  if (captureClass) audio = new captureClass({ onStatus: status => { localAudioStatus = status; controls(); }, onError: message => notice(message, true) });
  function notice(message, error = false) { $('notice').textContent = message; $('notice').hidden = !message; $('notice').classList.toggle('error', error); }
  function controls() {
    const configured = config?.configured === true || state?.mode === 'mock';
    const subtitleActive = !!state?.subtitle.active, speakerActive = !!state?.speaker?.active, voice = audioState(state, localAudioStatus);
    const dictateBusy = dictating && voice.capturing === 'finishing';
    $('submit-button').disabled = !connected || dictateBusy || !configured || !voice.running || voice.busyAudio || voice.capturing === 'finishing';
    $('submit-button').setAttribute('aria-label', '口述指令');
    $('save-model').disabled = saving || !!state?.busy;
    $('audio-toggle').disabled = !connected || localAudioStatus === 'stopping' || !audio;
    $('audio-toggle').setAttribute('aria-pressed', String(voice.active));
    $('audio-toggle').setAttribute('aria-label', voice.active ? '暂停语音输入' : '开启语音输入');
    $('audio-toggle').title = voice.active ? '暂停语音输入' : '开启语音输入';
    $('audio-toggle').querySelector('.play-symbol').toggleAttribute('hidden', voice.active);
    $('audio-toggle').querySelector('.pause-symbol').toggleAttribute('hidden', !voice.active);
    $('esc-button').disabled = !connected || closing || !(subtitleActive || speakerActive);
    $('esc-button').setAttribute('aria-label', '关闭功能面板');
    $('inform_stream').readOnly = true;
    const text = state?.sound2text?.text;
    if (typeof text === 'string' && $('inform_stream').value !== text.slice(-12000)) {
      $('inform_stream').value = text.slice(-12000);
      $('inform_stream').scrollTop = $('inform_stream').scrollHeight;
    }
  }

  function toggleWorker() { const separate = !$('worker-uses-router').checked; $('worker-settings').hidden = !separate; for (const id of ['worker-base-url', 'worker-model']) $(id).required = separate; }
  function displayConfig(value, populate = false) {
    config = validateConfig(value);
    $('config-status').textContent = config.configured ? '已配置' : '未配置';
    if (populate && !formDirty) {
      for (const prefix of ['router', 'worker']) {
        $(prefix + '-base-url').value = config[prefix].baseURL;
        $(prefix + '-model').value = config[prefix].model;
        $(prefix + '-api-key').value = '';
        $(prefix + '-api-key').placeholder = config[prefix].hasApiKey ? '已设置，留空保留' : '无密钥可留空';
      }
      $('worker-uses-router').checked = config.workerUsesRouter; toggleWorker();
    }
    configLoaded = true; controls();
  }
  const FOLLOW_THRESHOLD = 25;
  function bindTailFollow(element) {
    if (!element || element.__tailFollow) return;
    let following = true;
    let frame = 0;
    let readerIntent = false;
    const gap = () => element.scrollHeight - element.clientHeight - element.scrollTop;
    const stick = () => {
      frame = 0;
      if (!element.isConnected) return;
      if (readerIntent) { readerIntent = false; following = gap() <= FOLLOW_THRESHOLD; }
      if (!following) return;
      const floor = Math.max(0, element.scrollHeight - element.clientHeight);
      if (floor - element.scrollTop <= 1) return;
      element.scrollTop = floor;
    };
    const schedule = () => {
      if (!following || frame) return;
      frame = requestAnimationFrame(stick);
    };
    element.addEventListener('scroll', () => { readerIntent = false; following = gap() <= FOLLOW_THRESHOLD; }, { passive: true });
    element.addEventListener('wheel', event => { if (event.deltaY < 0) readerIntent = true; }, { passive: true });
    element.addEventListener('keydown', event => { if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') readerIntent = true; });
    const mutations = new MutationObserver(() => { if (resize && element.firstElementChild) resize.observe(element.firstElementChild); schedule(); });
    let resize;
    if (typeof ResizeObserver !== 'undefined') {
      resize = new ResizeObserver(schedule);
      resize.observe(element);
      if (element.firstElementChild) resize.observe(element.firstElementChild);
    }
    mutations.observe(element, { subtree: true, childList: true, characterData: true });
    element.__tailFollow = { disconnect() { mutations.disconnect(); resize?.disconnect(); if (frame) cancelAnimationFrame(frame); element.__tailFollow = null; } };
    schedule();
  }
  let trajectoryPane = null;
  function aiAvatar() {
    const mark = document.createElement('span');
    mark.className = 'output-avatar';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '(ovo)';
    return mark;
  }
  function renderOutput(output) {
    const node = $('output-text');
    const turns = output.turns;
    if (!turns) {
      if (node.dataset.mode !== 'plain' || node.textContent !== output.text) {
        node.dataset.mode = 'plain';
        delete node.dataset.signature;
        node.replaceChildren();
        node.textContent = output.text;
      }
      return;
    }
    const signature = turns.map(turn => turn.role + '\0' + turn.text).join('\n');
    if (node.dataset.mode === 'dialogue' && node.dataset.signature === signature) return;
    node.dataset.mode = 'dialogue';
    node.dataset.signature = signature;
    node.replaceChildren();
    for (const turn of turns) {
      const spoken = turn.role === 'assistant' || turn.role === 'status';
      const line = document.createElement(spoken ? 'div' : 'p');
      line.className = 'output-turn output-turn-' + turn.role + (turn.streaming ? ' is-streaming' : '');
      if (spoken) {
        const body = document.createElement('p');
        body.className = 'output-turn-body' + (turn.role === 'status' ? ' thinking' : '');
        body.textContent = turn.text;
        line.append(aiAvatar(), body);
      } else line.textContent = turn.text;
      node.append(line);
    }
  }
  function followScrollports() {
    bindTailFollow($('interaction-window'));
    bindTailFollow($('function-window'));
    bindTailFollow($('command-panel'));
    bindTailFollow($('context-snapshot'));
    bindTailFollow($('agent-conversation'));
    bindTailFollow($('worker-conversation'));
    const pane = $('trajectory-view')?.querySelector('[data-trajectory-scroll]');
    if (pane === trajectoryPane) return;
    trajectoryPane?.__tailFollow?.disconnect();
    trajectoryPane = pane;
    if (pane) bindTailFollow(pane);
  }
  function renderViews() {
    const views = root.MootingDSHViews;
    if (!views || typeof views.renderConversation !== 'function' || typeof views.renderTrajectory !== 'function' || typeof views.renderWorkers !== 'function') {
      $('views-error').textContent = 'DSH 对话与轨迹组件未加载。可展开原始事件查看数据；请检查 /dsh-views.js 和 /dsh-views.css。';
      $('views-error').hidden = false; followScrollports(); return;
    }
    try {
      views.renderConversation($('agent-conversation'), { events: state.events, stream: state.stream, busy: state.busy });
      views.renderWorkers($('worker-conversation'), { events: state.events, tasks: state.tasks, busy: state.busy });
      views.renderTrajectory($('trajectory-view'), { events: state.events, stream: state.stream, busy: state.busy });
      $('views-error').hidden = true;
    } catch (error) { $('views-error').textContent = 'DSH 组件渲染失败：' + error.message; $('views-error').hidden = false; }
    followScrollports();
  }
  function applyState(value) {
    state = validateState(value); displayConfig(state.modelConfig, !configLoaded);
    $('agent-status').textContent = state.busy ? '执行中' : state.events.length ? '已结束本轮' : '等待输入';
    $('worker-status').textContent = state.tasks.some(task => ['starting', 'running', 'stopping'].includes(task.status)) ? '运行中' : state.tasks.length ? '任务已结束' : '等待任务';
    const memory = contextPanel(state);
    $('context-snapshot').textContent = memory.text;
    $('context-status').textContent = memory.status;
    $('context-status').title = memory.error;
    const answer = latestRouterAnswer(state.trace), speakerActive = !!state.speaker?.active, active = state.subtitle.active || speakerActive;
    const fn = functionPanel(state), command = commandPanel(state);
    $('output-stage').classList.toggle('is-split', !!fn.kind);
    $('output-stage').classList.toggle('is-command', command.open);
    $('function-panel').setAttribute('aria-hidden', String(!fn.kind));
    $('function-panel').classList.toggle('is-speaker', speakerActive);
    $('command-panel').setAttribute('aria-hidden', String(!command.open));
    $('function-text').hidden = fn.kind !== 'subtitle';
    $('function-text').textContent = fn.kind === 'subtitle' ? fn.text : '';
    $('command-text').textContent = command.text;
    $('interaction-window').classList.toggle('subtitle-active', active);
    const output = outputContent(state);
    const feedback = captureFeedback(state);
    $('display-mode').textContent = !active && feedback && !feedback.error ? (state.sound2text.capture.status === 'listening' ? '聆听中' : '等待识别') : speakerActive ? '说话人识别中 · 模拟' : active ? '字幕运行中' : state.lastError ? '失败' : output.streaming ? '生成中' : state.busy ? 'Thinking' : answer ? '' : '等待输入';
    renderOutput(output);
    $('output-text').hidden = false;
    $('speaker-card').hidden = !speakerActive;
    const person = state.speaker?.person;
    $('speaker-card-title').textContent = person?.name ?? '正在识别…';
    $('speaker-identity').textContent = person?.identity ?? '—';
    if (speakerActive) $('function-window').scrollTop = 0;
    renderSpeakerNotes(person?.notes);
    $('output-text').classList.toggle('thinking', !output.turns && output.text === 'Thinking' && state.busy && !active && !state.lastError);
    $('display-mode').classList.toggle('thinking', state.busy && !active && !state.lastError && !output.streaming);
    $('output-text').classList.toggle('is-streaming', output.streaming);
    $('trace-count').textContent = String(state.events.length);
    $('raw-events').textContent = JSON.stringify({ events: state.events, tasks: state.tasks, trace: state.trace }, null, 2);
    if (feedback?.error) {
      const key = state.sound2text.capture.id + ':' + feedback.text;
      if (key !== lastCaptureError) { lastCaptureError = key; notice(feedback.text, true); }
    } else if (state.sound2text?.capture?.status === 'listening' && lastCaptureError) { lastCaptureError = ''; notice(''); }
    if (state.sound2text?.error && state.sound2text.error !== lastSoundError) { lastSoundError = state.sound2text.error; notice(lastSoundError, true); }
    renderViews(); controls();
  }
  function renderSpeakerNotes(notes) {
    const target = $('speaker-notes');
    target.replaceChildren();
    if (!Array.isArray(notes) || notes.length === 0) { target.textContent = '—'; return; }
    const list = document.createElement('ul');
    for (const note of notes) {
      const item = document.createElement('li');
      item.textContent = note;
      list.append(item);
    }
    target.append(list);
  }
  function api(path) {
    const base = String(root.mootingBase || '').replace(/\/$/, '');
    return base + path;
  }
  async function request(path, body) {
    const response = await fetch(api(path), { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 401) { location.assign(api('/login')); throw new Error('请先登录'); }
    if (!response.ok) { let message; try { message = (await response.json()).error; } catch {} throw new Error(message || '请求失败（HTTP ' + response.status + '）'); }
    return response.json();
  }
  async function connect() {
    const current = ++generation; source?.close(); connected = false; controls();
    try {
      const value = await request('/api/model/config'); if (current !== generation) return; displayConfig(value, true);
      const next = await request('/api/state'); if (current !== generation) return; applyState(next);
      if (typeof EventSource === 'undefined') throw new Error('当前浏览器不支持 SSE。');
      source = new EventSource(api('/api/events'));
      const receive = event => { if (current !== generation) return; try { applyState(JSON.parse(event.data)); connected = true; controls(); } catch (error) { connected = false; notice(error.message, true); controls(); } };
      source.addEventListener('data', receive); source.onmessage = receive;
      source.onopen = () => { if (current === generation) { connected = true; controls(); } };
      source.onerror = () => { if (current !== generation) return; fetch(api('/api/state')).then(response => { if (response.status === 401) location.assign(api('/login')); }); connected = false; notice('实时连接中断，正在重连；不会切换为模拟模型。', true); controls(); };
    } catch (error) { if (current === generation) { connected = false; notice(error.message, true); controls(); } }
  }
  $('close-settings').addEventListener('click', () => $('model-settings').close());
  $('model-form').addEventListener('input', () => { formDirty = true; });
  $('worker-uses-router').addEventListener('change', toggleWorker);
  $('model-form').addEventListener('submit', async event => {
    event.preventDefault(); if (saving || state?.busy) return;
    try {
      const body = modelSubmission({ routerBaseURL: $('router-base-url').value, routerModel: $('router-model').value, routerApiKey: $('router-api-key').value, workerUsesRouter: $('worker-uses-router').checked, workerBaseURL: $('worker-base-url').value, workerModel: $('worker-model').value, workerApiKey: $('worker-api-key').value });
      saving = true; controls();
      const result = await request('/api/model/config', body); formDirty = false; displayConfig(result, true);
      $('config-feedback').textContent = '已保存，未验证连接。'; notice(''); applyState(await request('/api/state'));
    } catch (error) { $('config-feedback').textContent = error.message; }
    finally { saving = false; controls(); }
  });
  let confirmChain = Promise.resolve();
  async function sendConfirm() {
    const voice = audioState(state, localAudioStatus);
    if (!connected || !voice.running || voice.busyAudio || voice.capturing === 'finishing' || !(config?.configured === true || state?.mode === 'mock')) return;
    try {
      const next = interactionRequest(state, '', localAudioStatus);
      dictating = true; controls(); notice('');
      next.body.boundaryMs = await audio.checkpoint();
      await request(next.path, next.body);
      applyState(await request('/api/state'));
    } catch (error) { notice(error.message, true); }
    finally { dictating = false; controls(); }
  }
  $('submit-form').addEventListener('submit', event => {
    event.preventDefault(); if ($('submit-button').disabled) return;
    confirmChain = confirmChain.then(sendConfirm, sendConfirm);
  });
  async function closeFunction() {
    if ($('esc-button').disabled || !(state?.subtitle?.active || state?.speaker?.active)) return;
    try {
      closing = true; controls(); notice('');
      await request('/api/interaction', {});
      applyState(await request('/api/state'));
    } catch (error) { notice(error.message, true); }
    finally { closing = false; controls(); }
  }
  $('esc-button').addEventListener('click', () => { closeFunction(); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.repeat || $('model-settings').open) return;
    if ($('esc-button').disabled) return;
    event.preventDefault();
    closeFunction();
  });
  $('audio-toggle').addEventListener('click', async () => {
    if (!audio || !connected) return;
    try {
      if (audio.status !== 'idle' || audioState(state).active) await audio.pause();
      else {
        if (!state?.sound2text?.configured) throw new Error('请先在 .env 填写 sound2text 的 API Key 和资源 ID。');
        notice(''); await audio.start();
      }
      applyState(await request('/api/state'));
    } catch (error) { notice(error.message, true); controls(); }
  });
  window.addEventListener('beforeunload', () => { clearInterval(clockTimer); source?.close(); audio?.pause(); });
  controls(); connect();
})(globalThis);
