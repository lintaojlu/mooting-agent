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
    if (!value.context || typeof value.context.memory !== 'string' || typeof value.context.configured !== 'boolean' || !['idle', 'updating', 'error', 'unconfigured', 'disabled', 'starting', 'ready', 'offline'].includes(value.context.status)) throw new Error('Context 状态不符合约定。');
    if (value.context.fragments !== undefined && (!Array.isArray(value.context.fragments) || value.context.fragments.some(item => !item || typeof item.text !== 'string'))) throw new Error('Context 片段不符合约定。');
    if (value.speaker && (typeof value.speaker.active !== 'boolean' || (value.speaker.active && value.speaker.person !== null && (!value.speaker.person || typeof value.speaker.person.name !== 'string' || !Array.isArray(value.speaker.person.notes) || value.speaker.person.notes.some(note => typeof note !== 'string'))))) throw new Error('说话人状态不符合约定。');
    if (typeof value.ownerSpeaker !== 'string' || !value.ownerSpeaker.trim()) throw new Error('主人显示名不符合约定。');
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
      } else if (event.type === 'user/message' && data.source?.kind === 'mooting-memory-report') {
        // A finished background recall wakes the Router; show it as a status line, not as something the user said.
        turns.push({ role: 'status', text: '记忆回想完成' });
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
    return { kind: null, text: '' };
  }
  function mainCaption(value) {
    const text = value?.sound2text?.text;
    return typeof text === 'string' ? text : '';
  }
  function lastSentence(text) {
    const parts = String(text ?? '').split(/(?<=[。！？!?])\s*|\n+/u).map(part => part.trim()).filter(Boolean);
    return parts.at(-1) ?? '';
  }
  function plainReply(text) {
    return String(text ?? '').replace(/\*\*/g, '');
  }
  function agentPresence(open, phase, value) {
    if (!open || !value) return { mode: 'hidden', text: '' };
    const partial = value.busy ? plainReply(value.stream?.text ?? '') : '';
    if (partial) return { mode: 'stream', text: partial };
    if (phase === 'wait' || value.busy) return { mode: 'pending', text: value.busy ? '正在处理指令' : '已收到，正在处理' };
    return { mode: 'card', text: '' };
  }
  function feedStream(queue, incoming) {
    const target = plainReply(incoming);
    const held = String(queue?.shown ?? '') + String(queue?.queued ?? '');
    if (target.startsWith(held)) return { shown: String(queue?.shown ?? ''), queued: String(queue?.queued ?? '') + target.slice(held.length) };
    return { shown: '', queued: target };
  }
  function drainStream(queue, count) {
    const chars = Array.from(String(queue?.queued ?? ''));
    const take = chars.slice(0, count).join('');
    return { shown: String(queue?.shown ?? '') + take, queued: chars.slice(count).join('') };
  }
  function drainCount(queuedLength) {
    if (queuedLength > 32) return 4;
    if (queuedLength > 8) return 2;
    return 1;
  }
  function agentCard(value) {
    const partial = value?.busy ? plainReply(value?.stream?.text ?? '') : '';
    if (partial) return { text: partial, live: true };
    if (value?.busy) return { text: '正在处理指令', live: true };
    if (value?.lastError) return { text: '执行失败：' + value.lastError, live: false };
    return { text: plainReply(latestRouterAnswer(value?.trace)), live: false };
  }
  function transcriptLines(text) {
    return String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean);
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
        if (utterance.start_time >= boundary) parts.push(utterance.speaker ? `${utterance.speaker}：${utterance.text}` : utterance.text);
        else {
          const words = (utterance.words ?? []).filter(word => word && Number.isFinite(word.start_time) && word.start_time >= boundary && word.start_time <= limit);
          if (words.length) {
            const text = words.map(word => word.text ?? word.word ?? '').join('');
            parts.push(utterance.speaker ? `${utterance.speaker}：${text}` : text);
          }
        }
      }
    }
    const text = parts.join(value.sound2text.utterances?.some(item => item?.speaker) ? '\n' : '').trim();
    if (text) return { open: true, text };
    return { open: true, text: capture.status === 'finishing' ? '正在等待语音识别完成…' : '正在聆听，请说出指令…' };
  }
  function contextPanel(value) {
    const context = value?.context;
    if (!context) return { text: '还没有识别到原话。', status: '等待信息流' };
    const fragments = Array.isArray(context.fragments) ? context.fragments.filter(item => item && typeof item.text === 'string' && item.text.trim()) : [];
    const text = fragments.length ? fragments.map(item => {
      const when = Date.parse(item.at);
      const clock = Number.isFinite(when) ? new Date(when).toLocaleTimeString('zh-CN', { hour12: false }) : '';
      return (clock ? clock + '\n' : '') + item.text.trim();
    }).join('\n\n') : context.status === 'updating' ? '正在写入记忆…' : '还没有识别到原话。';
    const labels = { updating: '写入中', error: '更新失败', unconfigured: '记忆未配置', disabled: '记忆已关闭', starting: '记忆服务启动中', offline: '记忆服务离线' };
    const status = labels[context.status] || (context.outbox > 0 ? context.lastFlush?.result === 'processing' ? '后台整理中' : '等待写入' : context.configured ? '已同步' : '等待信息流');
    const injected = typeof context.memory === 'string' && context.memory.trim() ? context.memory.trim() : '当前没有可注入的记忆。';
    return { text, status, error: context.error || '', info: memoryInfo(context), injected };
  }
  /** One line under the Context badge: outbox backlog, mental model refresh times, last flush. */
  function memoryInfo(context) {
    if (!context || context.outbox === undefined) return '';
    const clock = at => { const when = Date.parse(at); return Number.isFinite(when) ? new Date(when).toLocaleTimeString('zh-CN', { hour12: false }) : '—'; };
    const names = { 'user-profile': '档案', people: '人物', 'open-items': '事项' };
    const models = Object.entries(context.models || {}).map(([id, at]) => (names[id] || id) + ' ' + (at ? clock(at) : '—')).join(' · ');
    const flush = context.lastFlush ? '上次写入 ' + clock(context.lastFlush.at) + (context.lastFlush.result === 'ok' ? '' : context.lastFlush.result === 'failed' ? '（失败）' : context.lastFlush.result === 'processing' ? '（后台处理中）' : '（等待服务）') : '尚未写入';
    return ['积压 ' + context.outbox + ' 条', models, flush].filter(Boolean).join('｜');
  }
  function contextTraceSummary(entry) {
    const labels = { 'memory.read': '读取并注入 Router', 'outbox.read': '读取待写批次', 'retain.request': '写入 Hindsight 请求', 'speech.final': '语音定稿', 'speech.paused': '语音暂停', 'turn.queued': '回合入队', 'router.busy': 'Router 执行中', 'router.idle': 'Router 空闲', 'flush.start': '开始写入', 'flush.deferred': '等待 Router 空闲', 'flush.offline': '记忆服务离线', 'flush.sealed': '封装批次', 'flush.end': '写入结束', 'flush.failed': '写入失败', 'flush.retry': '安排重试', 'retain.submitted': '提交 Hindsight', 'retain.check': '检查写入状态', 'retain.status': '写入状态', 'retain.completed': '写入完成', 'cache.refresh.start': '开始刷新缓存', 'cache.model': '模型缓存更新', 'cache.model.failed': '模型缓存失败', 'cache.refresh.end': '缓存刷新完成', 'hindsight.status': '记忆服务状态', 'memory.search.start': '开始检索', 'memory.search.end': '检索完成', 'memory.search.failed': '检索失败', 'memory.search.unavailable': '检索不可用', 'memory.reflect.start': '开始回想', 'memory.reflect.end': '回想完成', 'memory.reflect.failed': '回想失败', 'memory.reflect.unavailable': '回想不可用' };
    const data = entry?.data ?? {};
    const content = entry?.type === 'memory.read' ? data.injected : data.content ?? data.text ?? data.answer;
    const preview = typeof content === 'string' ? content.replace(/\s+/g, ' ').trim().slice(0, 180) : '';
    return { at: entry?.at ?? '', type: entry?.type ?? '', label: labels[entry?.type] || entry?.type || '未知事件',
      detail: [data.documentId, data.id, data.reason, data.status, preview || data.query, data.error].filter(Boolean).join(' · '),
      content: typeof content === 'string' ? content : '', data };
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
  root.MootingUI = { captureFeedback, audioState, interactionRequest, submission, validateState, validateConfig, modelSubmission, latestRouterAnswer, routerDialogue, outputContent, functionPanel, mainCaption, lastSentence, agentPresence, feedStream, drainStream, drainCount, agentCard, transcriptLines, commandPanel, contextPanel, memoryInfo, contextTraceSummary };
  if (typeof document === 'undefined') return;
  openingIndex = Math.floor(Math.random() * OPENINGS.length);
  const $ = id => document.getElementById(id);
  function renderClock() {
    const now = new Date();
    const date = $('output-date');
    date.textContent = (now.getMonth() + 1) + '/' + now.getDate() + ' 周' + '日一二三四五六'[now.getDay()];
    date.dateTime = now.toISOString();
    const clock = $('output-title');
    clock.textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    clock.dateTime = now.toISOString();
  }
  renderClock();
  const clockTimer = setInterval(renderClock, 10000);
  let state, config, source, connected = false, dictating = false, closing = false, saving = false, generation = 0, configLoaded = false, formDirty = false;
  let agentOpen = false, agentPhase = 'idle';
  let audio, localAudioStatus = 'idle', lastSoundError = '', lastCaptureError = '', lastVoiceprintNotice = '';
  const captureClass = root.MootingAudio?.AudioCapture;
  if (captureClass) audio = new captureClass({ onStatus: status => { localAudioStatus = status; controls(); }, onError: message => notice(message, true) });
  function notice(message, error = false) { $('notice').textContent = message; $('notice').hidden = !message; $('notice').classList.toggle('error', error); }
  function controls() {
    const configured = config?.configured === true || state?.mode === 'mock';
    const speakerActive = !!state?.speaker?.active, voice = audioState(state, localAudioStatus);
    const draft = !!state?.speaker?.draft;
    const dictateBusy = dictating && voice.capturing === 'finishing';
    $('submit-button').disabled = !connected || dictateBusy || !configured || !voice.running || voice.busyAudio || voice.capturing === 'finishing';
    $('submit-button').setAttribute('aria-label', '右键');
    const agentLabel = agentOpen ? '关闭 agent 面板' : '打开 agent 面板';
    $('open-agent').disabled = !connected;
    $('open-agent').textContent = agentLabel;
    $('open-agent').setAttribute('aria-label', agentLabel);
    $('open-agent').setAttribute('aria-pressed', String(agentOpen));
    const functionOpen = speakerActive;
    const functionLabel = functionOpen ? '关闭功能面板' : '打开功能面板';
    $('open-function').disabled = !connected || closing || (functionOpen && draft);
    $('open-function').textContent = functionLabel;
    $('open-function').setAttribute('aria-label', functionLabel);
    $('open-function').setAttribute('aria-pressed', String(functionOpen));
    $('save-model').disabled = saving || !!state?.busy;
    $('audio-toggle').disabled = !connected || localAudioStatus === 'stopping' || !audio;
    $('audio-toggle').setAttribute('aria-pressed', String(voice.active));
    $('audio-toggle').setAttribute('aria-label', voice.active ? '暂停语音输入' : '开启语音输入');
    $('audio-toggle').title = voice.active ? '暂停语音输入' : '开启语音输入';
    $('audio-toggle').querySelector('.play-symbol').toggleAttribute('hidden', voice.active);
    $('audio-toggle').querySelector('.pause-symbol').toggleAttribute('hidden', !voice.active);
    const name = String($('speaker-name-input')?.value ?? '').trim();
    $('save-social-card').disabled = !connected || closing || !draft || !name;
    $('discard-social-card').disabled = !connected || closing || !draft;
    $('inform_stream').readOnly = true;
    const text = state?.sound2text?.text;
    if (typeof text === 'string' && $('inform_stream').value !== text.slice(-12000)) {
      $('inform_stream').value = text.slice(-12000);
      $('inform_stream').scrollTop = $('inform_stream').scrollHeight;
    }
  }

  function displayConfig(value, populate = false) {
    config = validateConfig(value);
    $('config-status').textContent = config.configured ? '已配置' : '未配置';
    if (populate && !formDirty) {
      $('router-base-url').value = config.router.baseURL;
      $('router-model').value = config.router.model;
      $('router-api-key').value = '';
      $('router-api-key').placeholder = config.router.hasApiKey ? '已设置，留空保留' : '无密钥可留空';
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
  let contextTraceEntries = new Map();
  function traceRow(entry) {
    const record = contextTraceSummary(entry);
    const row = document.createElement('tr'); row.dataset.seq = String(entry.seq);
    const time = document.createElement('time');
    time.dateTime = record.at;
    const date = Date.parse(record.at);
    time.textContent = Number.isFinite(date) ? new Date(date).toLocaleString('zh-CN', { hour12: false }) : '—';
    const when = document.createElement('td'); when.append(time);
    const stage = document.createElement('td'); stage.textContent = record.label;
    const detail = document.createElement('td');
    const disclosure = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = record.detail || record.type;
    const raw = document.createElement('pre'); raw.textContent = JSON.stringify(record.data, null, 2);
    disclosure.append(summary);
    if (record.content) {
      const content = document.createElement('pre');
      content.className = 'context-trace-content';
      content.textContent = record.content;
      disclosure.append(content);
    }
    disclosure.append(raw); detail.append(disclosure);
    row.append(when, stage, detail);
    return row;
  }
  function renderContextTrace(entries) {
    const rows = $('context-trace-rows');
    if (!Array.isArray(entries) || !entries.length) return;
    const unseen = entries.filter(entry => Number.isInteger(entry?.seq) && !contextTraceEntries.has(entry.seq));
    if (!unseen.length) return;
    for (const entry of unseen) contextTraceEntries.set(entry.seq, entry);
    const ordered = [...contextTraceEntries.values()].sort((left, right) => left.seq - right.seq);
    const lastShown = Number(rows.lastElementChild?.dataset.seq ?? 0);
    if (unseen.some(entry => entry.seq <= lastShown)) rows.replaceChildren(...ordered.map(traceRow));
    else for (const entry of unseen.sort((left, right) => left.seq - right.seq)) {
      const row = traceRow(entry); row.dataset.seq = String(entry.seq); rows.append(row);
    }
    $('context-trace-count').textContent = String(Math.max(state?.context?.traceCount ?? 0, contextTraceEntries.size));
  }
  let trajectoryPane = null;
  function paintTranscript(text) {
    const node = $('main-text');
    const lines = transcriptLines(text);
    node.replaceChildren(...lines.map((line, index) => {
      const row = document.createElement('p');
      row.className = 'transcript-line' + (index === lines.length - 1 ? ' is-latest' : '');
      row.textContent = line;
      return row;
    }));
  }
  function paintAgent(text) {
    const node = $('output-text');
    let body = node.querySelector('.output-turn-body');
    if (!body) {
      node.replaceChildren();
      body = document.createElement('p');
      body.className = 'output-turn-body';
      node.append(body);
    }
    const value = plainReply(text);
    if (body.textContent !== value) body.textContent = value;
    node.scrollTop = node.scrollHeight;
    requestAnimationFrame(() => { if (node.isConnected) node.scrollTop = node.scrollHeight; });
  }
  let streamShown = '';
  let streamQueued = '';
  let streamTimer = null;
  function stopStream() {
    if (streamTimer) clearTimeout(streamTimer);
    streamTimer = null;
  }
  function resetStream() {
    stopStream();
    streamShown = '';
    streamQueued = '';
  }
  function pumpStream() {
    if (!streamQueued) { streamTimer = null; return; }
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const count = motion ? Array.from(streamQueued).length : drainCount(Array.from(streamQueued).length);
    const next = drainStream({ shown: streamShown, queued: streamQueued }, count);
    streamShown = next.shown;
    streamQueued = next.queued;
    paintAgent(streamShown);
    streamTimer = streamQueued ? setTimeout(pumpStream, 32) : null;
  }
  function pushStream(target) {
    const next = feedStream({ shown: streamShown, queued: streamQueued }, target);
    streamShown = next.shown;
    streamQueued = next.queued;
    if (!streamTimer && streamQueued) pumpStream();
  }
  function revealAgent(text) {
    resetStream();
    streamShown = plainReply(text);
    paintAgent(streamShown);
  }
  function renderAgent() {
    const presence = agentPresence(agentOpen, agentPhase, state);
    $('output-stage').classList.toggle('is-agent', agentOpen);
    $('agent-panel').setAttribute('aria-hidden', String(!agentOpen));
    const showCard = presence.mode === 'card' || presence.mode === 'stream';
    $('agent-pending').hidden = presence.mode !== 'pending';
    $('interaction-window').hidden = !showCard;
    if (presence.mode === 'hidden' || presence.mode === 'pending') {
      resetStream();
      if (presence.mode === 'pending') {
        if (state.busy) agentPhase = 'live';
        $('agent-pending-text').textContent = presence.text;
      }
      return;
    }
    if (presence.mode === 'stream') {
      if (state.busy) agentPhase = 'live';
      pushStream(presence.text);
      return;
    }
    const finishing = agentPhase === 'live' || streamQueued || streamTimer;
    if (agentPhase === 'live') agentPhase = 'idle';
    if (finishing) pushStream(agentCard(state).text);
    else revealAgent(agentCard(state).text);
  }
  function followScrollports() {
    bindTailFollow($('main-column'));
    bindTailFollow($('interaction-window'));
    bindTailFollow($('main-panel'));
    bindTailFollow($('function-window'));
    bindTailFollow($('context-snapshot'));
    bindTailFollow($('context-trace-view'));
    const pane = $('trajectory-view')?.querySelector('[data-trajectory-scroll]');
    if (pane === trajectoryPane) return;
    trajectoryPane?.__tailFollow?.disconnect();
    trajectoryPane = pane;
    if (pane) bindTailFollow(pane);
  }
  function renderViews() {
    const views = root.MootingDSHViews;
    if (!views || typeof views.renderTrajectory !== 'function') {
      $('views-error').textContent = 'DSH 轨迹组件未加载。可展开原始事件查看数据；请检查 /dsh-views.js 和 /dsh-views.css。';
      $('views-error').hidden = false; followScrollports(); return;
    }
    try {
      const stream = state.stream;
      views.renderTrajectory($('trajectory-view'), { events: state.events, stream, busy: state.busy });
      $('views-error').hidden = true;
    } catch (error) { $('views-error').textContent = 'DSH 组件渲染失败：' + error.message; $('views-error').hidden = false; }
    followScrollports();
  }
  function applyState(value) {
    state = validateState(value); displayConfig(state.modelConfig, !configLoaded);
    const memory = contextPanel(state);
    $('context-snapshot').textContent = memory.text;
    $('context-injected').textContent = memory.injected;
    $('context-status').textContent = memory.status;
    $('context-status').title = memory.error;
    $('context-memory-info').textContent = memory.info;
    $('context-memory-info').hidden = !memory.info;
    renderServiceSettings(state);
    renderContextTrace(state.context.trace);
    $('context-trace-count').textContent = String(Math.max(state.context.traceCount ?? 0, contextTraceEntries.size));
    const speakerActive = !!state.speaker?.active;
    const fn = functionPanel(state);
    $('output-stage').classList.toggle('is-function', !!fn.kind);
    $('function-panel').setAttribute('aria-hidden', String(!fn.kind));
    $('function-panel').classList.toggle('is-speaker', speakerActive);
    paintTranscript(mainCaption(state));
    renderAgent();
    $('speaker-card').hidden = !speakerActive;
    const person = state.speaker?.person;
    $('speaker-card-title').textContent = '社交卡片';
    renderSpeakerCard(person, !!state.speaker?.draft, state.speaker?.error);
    if (speakerActive) $('function-window').scrollTop = 0;
    renderSpeakerNotes(person?.notes);
    const feedback = captureFeedback(state);
    $('trace-count').textContent = String(state.events.length);
    $('raw-events').textContent = JSON.stringify({ events: state.events, tasks: state.tasks, trace: state.trace }, null, 2);
    if (feedback?.error) {
      const key = state.sound2text.capture.id + ':' + feedback.text;
      if (key !== lastCaptureError) { lastCaptureError = key; notice(feedback.text, true); }
    } else if (state.sound2text?.capture?.status === 'listening' && lastCaptureError) { lastCaptureError = ''; notice(''); }
    if (state.sound2text?.error && state.sound2text.error !== lastSoundError) { lastSoundError = state.sound2text.error; notice(lastSoundError, true); }
    else if (state.sound2text?.voiceprintNotice && state.sound2text.voiceprintNotice !== lastVoiceprintNotice) { lastVoiceprintNotice = state.sound2text.voiceprintNotice; notice(lastVoiceprintNotice, false); }
    const ownerInput = $('owner-speaker');
    if (ownerInput && document.activeElement !== ownerInput) ownerInput.value = state.ownerSpeaker;
    renderViews(); controls();
  }
  function renderSpeakerCard(person, draft, error) {
    const value = key => String(person?.[key] ?? '');
    const fields = { name: value('name'), position: value('position'), company: value('company'), school: value('school'), mbti: value('mbti'), topic: value('topic'), savedAt: value('savedAt') };
    const show = (id, text) => { const node = $(id); if (node) node.textContent = text || '—'; };
    const fill = (id, text) => { const node = $(id); if (node && document.activeElement !== node) node.value = text; };
    show('speaker-name', fields.name || (draft ? '' : '正在识别…'));
    show('speaker-position', fields.position);
    show('speaker-company', fields.company);
    show('speaker-school', fields.school);
    show('speaker-mbti', fields.mbti);
    show('speaker-topic', fields.topic);
    show('speaker-saved', fields.savedAt ? new Date(fields.savedAt).toLocaleString('zh-CN', { hour12: false }) : '');
    fill('speaker-name-input', fields.name);
    fill('speaker-position-input', fields.position);
    fill('speaker-company-input', fields.company);
    fill('speaker-school-input', fields.school);
    fill('speaker-mbti-input', fields.mbti);
    fill('speaker-topic-input', fields.topic);
    for (const key of ['name', 'position', 'company', 'school', 'mbti', 'topic']) {
      $(`speaker-${key}`).hidden = draft;
      $(`speaker-${key}-input`).hidden = !draft;
    }
    $('speaker-saved').hidden = draft;
    const warning = $('speaker-error');
    warning.textContent = error || '';
    warning.hidden = !error;
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
      if (Array.isArray(next.context?.trace)) request('/api/context/trace').then(history => {
        if (current === generation) renderContextTrace(history.entries);
      }).catch(error => { if (current === generation) $('context-trace-count').title = `完整轨迹加载失败：${error.message}`; });
      if (typeof EventSource === 'undefined') throw new Error('当前浏览器不支持 SSE。');
      source = new EventSource(api('/api/events'));
      const receive = event => { if (current !== generation) return; try { applyState(JSON.parse(event.data)); connected = true; controls(); } catch (error) { connected = false; notice(error.message, true); controls(); } };
      source.addEventListener('data', receive); source.onmessage = receive;
      source.onopen = () => { if (current === generation) { connected = true; controls(); } };
      source.onerror = () => { if (current !== generation) return; fetch(api('/api/state')).then(response => { if (response.status === 401) location.assign(api('/login')); }); connected = false; notice('实时连接中断，正在重连；不会切换为模拟模型。', true); controls(); };
    } catch (error) { if (current === generation) { connected = false; notice(error.message, true); controls(); } }
  }
  function showSettings(panel) {
    for (const button of document.querySelectorAll('[data-settings-panel]')) {
      const selected = button.dataset.settingsPanel === panel;
      if (selected) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
      document.getElementById(`settings-${button.dataset.settingsPanel}`).hidden = !selected;
    }
    const dialog = $('model-settings');
    if (!dialog.open) dialog.showModal();
    if (panel === 'voiceprint') document.dispatchEvent(new Event('voiceprints-refresh'));
  }
  function settingText(id, text) { $(id).textContent = text || '—'; }
  function renderServiceSettings(value) {
    const embedding = value.context?.embedding;
    const memory = value.context?.memoryModel;
    settingText('embedding-mode', embedding?.configured ? embedding.mode : '未配置');
    settingText('embedding-model', embedding?.model);
    settingText('embedding-url', embedding?.mode === '本地' ? '本机模型' : embedding?.baseURL);
    settingText('memory-model', memory?.configured ? memory.model : '未配置');
    settingText('memory-url', memory?.baseURL);
    settingText('volcano-status', value.sound2text?.configured ? '已配置' : '未配置');
    settingText('volcano-resource', value.sound2text?.resourceId);
    settingText('volcano-endpoint', value.sound2text?.endpoint);
  }
  $('open-settings').addEventListener('click', () => showSettings('llm'));
  document.querySelector('.settings-nav').addEventListener('click', event => {
    const button = event.target.closest('[data-settings-panel]');
    if (button) showSettings(button.dataset.settingsPanel);
  });
  $('close-settings').addEventListener('click', () => $('model-settings').close());
  $('model-form').addEventListener('input', () => { formDirty = true; });
  $('owner-speaker-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const result = await request('/api/owner-speaker', { name: $('owner-speaker').value });
      if (state) state.ownerSpeaker = result.ownerSpeaker;
      notice('主人显示名已保存');
    } catch (error) { notice(error.message, true); }
  });
  $('model-form').addEventListener('submit', async event => {
    event.preventDefault(); if (saving || state?.busy) return;
    try {
      const body = modelSubmission({ routerBaseURL: $('router-base-url').value, routerModel: $('router-model').value, routerApiKey: $('router-api-key').value, workerUsesRouter: true });
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
    if (!lastSentence(mainCaption(state))) return;
    try {
      const next = interactionRequest(state, '', localAudioStatus);
      dictating = true; agentOpen = true; agentPhase = 'wait'; controls(); renderAgent(); notice('');
      const result = await request(next.path, next.body);
      applyState(await request('/api/state'));
      if (result?.skipped) { agentOpen = false; agentPhase = 'idle'; }
      else if (agentPhase === 'wait' && !state?.busy) agentPhase = 'idle';
      renderAgent(); controls();
    } catch (error) {
      agentPhase = 'idle'; notice(error.message, true);
      if (agentOpen) { $('agent-pending').hidden = true; $('interaction-window').hidden = false; revealAgent(error.message); }
    }
    finally { dictating = false; controls(); }
  }
  $('submit-form').addEventListener('submit', event => {
    event.preventDefault(); if ($('submit-button').disabled) return;
    confirmChain = confirmChain.then(sendConfirm, sendConfirm);
  });
  $('open-agent').addEventListener('click', () => {
    if ($('open-agent').disabled) return;
    agentOpen = !agentOpen;
    if (!agentOpen || !state?.busy) agentPhase = 'idle';
    renderAgent(); controls();
  });
  $('open-function').addEventListener('click', async () => {
    if ($('open-function').disabled) return;
    if (state?.speaker?.active) { await closeFunction(); return; }
    try {
      closing = true; controls(); notice('');
      await request('/api/function/open', {});
      applyState(await request('/api/state'));
    } catch (error) { notice(error.message, true); }
    finally { closing = false; controls(); }
  });
  async function closeFunction() {
    if ($('open-function').disabled || !state?.speaker?.active) return;
    try {
      closing = true; controls(); notice('');
      await request('/api/interaction', {});
      applyState(await request('/api/state'));
    } catch (error) { notice(error.message, true); }
    finally { closing = false; controls(); }
  }
  async function decideSocialCard(save) {
    if ($('save-social-card').disabled && $('discard-social-card').disabled) return;
    try {
      closing = true; controls(); notice('');
      const body = save ? {
        name: $('speaker-name-input').value,
        position: $('speaker-position-input').value,
        company: $('speaker-company-input').value,
        school: $('speaker-school-input').value,
        mbti: $('speaker-mbti-input').value,
        topic: $('speaker-topic-input').value,
      } : {};
      await request(save ? '/api/social-card/save' : '/api/social-card/discard', body);
      applyState(await request('/api/state'));
    } catch (error) { notice(error.message, true); }
    finally { closing = false; controls(); }
  }
  $('save-social-card').addEventListener('click', () => { decideSocialCard(true); });
  $('discard-social-card').addEventListener('click', () => { decideSocialCard(false); });
  for (const id of ['speaker-name-input', 'speaker-position-input', 'speaker-company-input', 'speaker-school-input', 'speaker-mbti-input', 'speaker-topic-input']) $(id).addEventListener('input', controls);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.repeat || $('model-settings').open) return;
    if ($('open-function').disabled || !state?.speaker?.active) return;
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
  window.addEventListener('beforeunload', () => { clearInterval(clockTimer); stopStream(); source?.close(); audio?.pause(); });
  controls(); connect();
})(globalThis);
