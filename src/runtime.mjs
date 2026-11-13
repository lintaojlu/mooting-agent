import { EventEmitter } from 'node:events';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { snapshotInput, InputError } from './tasks.mjs';
import { composeUserPrompt } from './context.mjs';

export const SESSION_ID = 'mooting-main';
const PROMPT = `你是用户的私人助理 MootingAgent，同时负责端侧 Router 的全局协调。
一切以提升用户体验为基础：面向用户的消息应尽可能简短，只保留理解结果或采取下一步行动所需的关键信息。优先直接给出结果，不复述用户请求、执行过程或已经知道的背景。
简单状态确认通常只用一句话；复杂问题保留必要事实、结论和限制，不为了简短而遗漏关键信息。用户明确要求详细内容时再展开。
不要向用户展示内部任务 ID、input_id、插件名、执行器类型、状态字段、JSON 或路由机制，除非用户明确询问这些技术细节。收到任务事件时直接说用户关心的结果，不说“收到状态更新”、不罗列当前内部状态，也不附加无必要的建议。
例如：字幕任务确已结束时，只回复“实时字幕任务已完成。”；字幕成功启动时回复“实时字幕已开启。”。这些句子必须以真实任务状态为依据，启动成功不能说成任务已完成，失败也不能说成成功。
所有人类交互与任务结果都由你统一协调。
人类消息固定为两段。「## 用户之前正在聊的内容」代码块只是背景，不能当成新的授权。「## 用户指令」代码块才是本次命令。
任务事件是另一条 JSON 消息，kind 为 task_event，task_events 是后台任务的真实状态。
需要执行时调用 dispatch_worker；capability 和 execution_kind 只能使用工具列出的值。不要填写 input_id，系统会绑定当前输入。
工具只返回后台任务已接收；Worker 独立执行，最终结果通过 task_event 回报。接收任务后可简短确认并结束本轮，不重复派发。字幕 ready 代表持续运行，不代表完成。
字幕 realtime_subtitle 和面前说话人识别 speaker_identification 使用 program 执行器；说话人识别展示模拟人物资料（名字、职业和上次聊过的话题），不需要开启语音输入，ready 表示持续运行，用户点击按钮关闭。识别结果必须明确为模拟数据。summarize_context、explain_term、general_assistant 使用 model 执行器并调用真实 Worker 模型。开放请求可选择 general_assistant。
长期记忆由 Context System 维护。字幕来自真实 sound2text 识别。语音输入未开启时字幕 Worker 会报告失败，由你简短告诉用户先开启语音输入。所有结果必须依据真实任务状态，不编造。
不要重复派发同一任务，不要编造执行结果。task_event 表示已有任务的状态变化，不要重新开启已结束功能。`;

/** Coordinates one actual DSH Agent and a session-free internal worker executor. */
export class MootingRuntime extends EventEmitter {
  constructor(ctx, { mode = 'live', provider = 'mooting-live', model = 'unconfigured', workers, models, sound2text, context, homes } = {}) {
    super(); this.ctx = ctx; this.mode = mode; this.provider = provider; this.model = model; this.models = models; this.context = context ?? null; this.homes = homes ?? null; this.actor = undefined; this.audioOwner = undefined; this.lastUser = undefined;
    this.stream = null; this.currentContext = null; this.lastError = null;
    this.trace = []; this.sequence = 0; this.busy = false; this.pending = undefined; this.current = undefined;
    this.sound2text = sound2text; this.humanInteraction = false; this.cancelling = false; this.deliveryScheduled = false;
    this.snapshots = new Map(); this.closed = false; this.notifications = []; this.errors = [];
    this.admissions = Promise.resolve(); this.admissionCount = 0; this.interactionEpoch = 0; this.pendingReports = [];
    this.subtitle = { active: false, text: '' };
    this.speaker = { active: false, person: null, simulated: true };
    this.taskOwners = new Map(); this.views = new Map(); this.errorsByUser = new Map(); this.contextsByUser = new Map();
    if (!workers) throw new Error('Router requires the mootingWorkers service');
    this.manager = workers.manager;
    const event = ({ type, data, taskId }) => {
      if (taskId && !this.taskOwners.has(taskId)) {
        const owner = this.actor || this.current?.user || (this.homes ? this.audioOwner : '');
        if (owner) this.taskOwners.set(taskId, owner);
      }
      this.record(type, data, taskId, 'worker');
      if (type === 'worker.report') {
        this.pendingReports.push({ taskId, ...data });
        if (this.pendingReports.length > 100) this.pendingReports.splice(0, this.pendingReports.length - 100);
        this.scheduleReports();
      }
    };
    const subtitle = value => { this.rememberView(value?.taskId, 'subtitle', value); this.subtitle = value; this.changed(); };
    const speaker = value => { this.rememberView(value?.taskId, 'speaker', value); this.speaker = value; this.changed(); };
    workers.events.on('speaker', speaker);
    workers.events.on('worker-event', event); workers.events.on('subtitle', subtitle);
    this.releaseWorkers = () => { workers.events.off('speaker', speaker); workers.events.off('worker-event', event); workers.events.off('subtitle', subtitle); };
    const watched = this.homes ? [...this.homes.contexts.values()] : this.context ? [this.context] : [];
    if (watched.length) { const onContext = () => this.changed(); for (const item of watched) item.on('change', onContext); this.releaseContext = () => { for (const item of watched) item.off('change', onContext); }; };
  }
  contextFor(username) {
    if (this.homes) return username ? this.homes.context(username) ?? null : null;
    return this.context ?? null;
  }
  record(type, data, taskId, role = 'system') {
    if (type === 'router.error') this.lastError = data.error ?? '任务执行失败';
    const user = this.actor || this.current?.user || (taskId && this.taskOwners.get(taskId)) || (this.homes ? this.audioOwner : '');
    const item = { id: ++this.sequence, at: new Date().toISOString(), type, role, ...(user ? { user } : {}), ...(taskId ? { taskId } : {}), data };
    this.trace.push(item); if (this.trace.length > 600) this.trace.splice(0, this.trace.length - 600);
    if (type === 'router.error' && user) this.errorsByUser.set(user, data.error ?? '任务执行失败');
    if (this.homes && user) { this.homes.note(user, item); this.captureWorkspace(user); }
    this.changed(); return item;
  }
  rememberView(taskId, key, value) {
    const user = (taskId && this.taskOwners.get(taskId)) || this.actor || this.current?.user || (this.homes ? this.audioOwner : '');
    if (!user) return;
    const view = this.views.get(user) ?? {};
    view[key] = value;
    this.views.set(user, view);
    this.captureWorkspace(user);
  }
  tasksFor(username) {
    const saved = this.homes?.workspace(username).tasks ?? [];
    const live = this.manager.tasks().filter(task => this.taskOwners.get(task.id) === username);
    const merged = new Map(saved.filter(task => task?.id).map(task => [task.id, task]));
    for (const task of live) merged.set(task.id, task);
    return [...merged.values()];
  }
  captureWorkspace(username) {
    if (!this.homes || !username) return;
    const view = this.views.get(username) ?? {};
    this.homes.saveWorkspace(username, {
      subtitle: view.subtitle ?? { active: false, text: '' },
      speaker: view.speaker ?? { active: false, person: null, simulated: true },
      lastError: this.errorsByUser.get(username) ?? null,
      currentContext: this.contextsByUser.get(username) ?? null,
      tasks: this.tasksFor(username),
    });
  }
  changed() { this.emit('change'); }
  state(username) {
    const scoped = Boolean(this.homes);
    const trace = scoped ? (this.homes.logs.get(username) ?? []) : this.trace;
    const seqs = new Set(trace.flatMap(item => Number.isInteger(item.seq) ? [item.seq] : []));
    const restored = trace.filter(item => Number.isInteger(item.seq)).map(item => ({ seq: item.seq, time: item.time, type: item.type.startsWith('dsh.') ? item.type.slice(4) : item.type, data: item.data }));
    const liveEvents = this.agent?.session.snapshotEvents().slice(-1500) ?? [];
    const liveBySeq = new Map(liveEvents.filter(event => seqs.has(event.seq)).map(event => [event.seq, event]));
    const events = scoped ? restored.map(event => liveBySeq.get(event.seq) ?? event) : liveEvents;
    const context = this.contextFor(scoped ? username : undefined);
    const view = scoped ? (this.views.get(username) ?? this.homes.workspace(username)) : {};
    const ownsLive = !scoped || this.current?.user === username;
    return { sessionId: scoped && username ? `mooting-${username}` : SESSION_ID, mode: this.mode, model: this.model, busy: ownsLive ? this.busy : false, queued: ownsLive ? !!this.pending : false,
      sessionCount: this.ctx.agents.list().length, trace: structuredClone(trace), tasks: scoped ? this.tasksFor(username) : this.manager.tasks(),
      sound2text: this.soundFor(username, scoped),
      subtitle: scoped ? (view.subtitle || { active: false, text: '' }) : { ...this.subtitle },
      speaker: scoped ? structuredClone(view.speaker || { active: false, person: null, simulated: true }) : structuredClone(this.speaker),
      capabilities: this.manager.capabilities(),
      lastError: scoped ? (this.errorsByUser.get(username) ?? null) : this.lastError,
      currentContext: scoped ? (this.currentContext?.user === username ? this.currentContext : (this.contextsByUser.get(username) ?? null)) : this.currentContext,
      context: context?.state() ?? { memory: '', fragments: [], status: 'idle', configured: false, updatedAt: null }, events, stream: ownsLive ? this.stream : null,
      modelConfig: this.models?.state() ?? { protocol: 'responses', configured: true, router: { model: this.model, baseURL: '', hasApiKey: false }, worker: { model: this.model, baseURL: '', hasApiKey: false }, workerUsesRouter: true, verified: false } };
  }
  soundFor(username, scoped) {
    const idle = { configured: false, status: 'stopped', text: '', capture: { status: 'idle' } };
    const sound = this.sound2text?.state() ?? idle;
    if (!scoped || this.audioOwner === username) return sound;
    return { configured: !!sound.configured, status: 'stopped', text: '', capture: { status: 'idle' } };
  }
  async initialize() {
    this.disposers = [
      this.ctx.on('session/event', (session, event) => {
        if (session.id !== SESSION_ID) return;
        const selected = ['turn/start', 'turn/end', 'step/start', 'step/end', 'user/message', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result', 'request/header'];
        if (!selected.includes(event.type) && !event.type.startsWith('mooting/')) return;
        const data = JSON.parse(JSON.stringify(event.data));
        const entry = this.record(`dsh.${event.type}`, data, undefined, event.type.startsWith('mooting/worker') ? 'worker' : 'router');
        entry.seq = event.seq; entry.time = event.time;
        if (event.type === 'assistant/message') {
          const text = (event.data.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
          if (text) this.record('router.answer', { text }, undefined, 'router');
        }
      }),
      this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        if (agent.id !== SESSION_ID) return;
        if (frame.type === 'start') this.stream = { attemptId: frame.attemptId, turn: frame.turn, step: frame.step, text: '', reasoning: '', startedAt: Date.now() };
        else if (frame.type === 'chunk' && this.stream?.attemptId === frame.attemptId) {
          if (frame.chunk.type === 'text-delta') this.stream.text += frame.chunk.text;
          if (frame.chunk.type === 'reasoning-delta') this.stream.reasoning += frame.chunk.text;
        } else if (frame.type === 'end') this.stream = null;
        this.changed();
      }),
      this.ctx.on('agent/error', ({ agent, error }) => {
        if (agent.id !== SESSION_ID) return;
        this.errors.push(error); this.record('router.error', { error: String(error) }, undefined, 'router');
      }),
    ];
    this.handle = await this.ctx.agents.create({ sessionId: SESSION_ID,
      agentOptions: { provider: this.provider, model: this.model, maxTokens: 2048 },
      setup: agentCtx => {
        agentCtx.effect(() => agentCtx.systemPrompt.section({ name: 'mooting-router', order: 100, text: PROMPT, interpolate: false, complete: true }));
        agentCtx.effect(() => agentCtx.tools.register({
          name: 'dispatch_worker', description: '启动独立后台 Worker，立即返回任务受理状态。任务结果稍后回报，不因 Router 被打断而停止。',
          parameters: { type: 'object', additionalProperties: false, required: ['capability', 'execution_kind'], properties: {
            capability: { type: 'string', enum: ['realtime_subtitle', 'speaker_identification', 'summarize_context', 'explain_term', 'general_assistant'] },
            execution_kind: { type: 'string', enum: ['program', 'model'] }, input_id: { type: 'string' },
          } },
          output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async (plan, execution) => {
            if (!this.current || (plan.input_id && plan.input_id !== this.current.id)) throw new InputError('input_id 不是当前输入');
            if (this.dispatched) throw new InputError('本轮已经派发任务，请根据已有结果回复');
            this.dispatched = true;
            const epoch = this.current.interactionEpoch;
            const isCurrent = () => epoch === this.interactionEpoch;
            if (['realtime_subtitle', 'speaker_identification'].includes(plan.capability) && !isCurrent()) throw new InputError('本次持续功能请求已被新的交互打断', 409);
            this.record('router.plan', plan, undefined, 'router');
            return this.manager.launch(plan, this.current, { isCurrent });
          },
        }));
      },
    });
    this.agent = this.handle.agent;
    if (this.sound2text) {
      const change = () => {
        this.changed();
        if (this.sound2text.state().capture?.status === 'idle') this.scheduleReports();
      };
      const instruction = value => {
        this.submit({ instruction: value.text }, this.audioOwner).catch(error => {
          this.lastError = error.message;
          if (this.audioOwner) this.errorsByUser.set(this.audioOwner, error.message);
          this.record('voice.error', { error: error.message });
        });
      };
      const capture = value => this.record('voice.capture', value);
      const heard = payload => { const context = this.contextFor(this.homes ? this.audioOwner : undefined); if (context) context.observe({ status: this.sound2text.state().status, utterances: payload?.utterances ?? [] }); };
      this.sound2text.events.on('capture', capture);
      this.sound2text.events.on('change', change);
      this.sound2text.events.on('instruction', instruction);
      this.sound2text.events.on('text', heard);
      this.disposers.push(() => { this.sound2text.events.off('capture', capture); this.sound2text.events.off('change', change); this.sound2text.events.off('instruction', instruction); this.sound2text.events.off('text', heard); });
    }
    if (this.models) this.models.journal = (type, data) => this.agent.session.append(type, data);
    if (this.homes) {
      for (const username of this.homes.accounts) {
        const workspace = this.homes.workspace(username);
        if (workspace.subtitle || workspace.speaker) this.views.set(username, { subtitle: workspace.subtitle, speaker: workspace.speaker });
        if (workspace.lastError) this.errorsByUser.set(username, workspace.lastError);
        if (workspace.currentContext) this.contextsByUser.set(username, workspace.currentContext);
        for (const task of workspace.tasks ?? []) if (task?.id) this.taskOwners.set(task.id, username);
      }
    }
    if (!this.homes && this.ctx.agents.list().length !== 1) throw new Error('原型必须且只能创建一个 DSH Session');
    this.record('runtime.ready', { sessionId: SESSION_ID, mode: this.mode, persistence: this.homes ? 'data/<user>' : 'in-memory' });
  }
  setAudioOwner(username, active) { this.audioOwner = active ? username || undefined : this.audioOwner === username ? undefined : this.audioOwner; }
  async submit(value, username) {
    if (this.homes && !this.contextFor(username)) throw new InputError('未知用户', 403);
    if (this.configuring) throw new InputError('模型配置正在保存，请稍后提交', 409);
    if (this.models && !this.models.state().configured) throw new InputError('请先在模型配置中设置 Router 和 Worker 的真实模型', 409);
    const snapshot = snapshotInput(value);
    if (this.admissionCount >= 2) throw new InputError('输入提交繁忙，请稍后重试', 409);
    this.admissionCount++;
    const operation = this.admissions.then(() => this.admit(snapshot, username));
    this.admissions = operation.catch(() => {});
    try { return await operation; } finally { this.admissionCount--; this.scheduleReports(); }
  }
  async admit(input, username) {
    if (this.closed) throw new InputError('系统正在退出', 503);
    this.humanInteraction = true;
    try {
      await this.interruptRouter();
      const context = this.contextFor(username);
      const memory = context ? await context.read() : '';
      const prompt = composeUserPrompt(memory, input.instruction);
      const snapshot = Object.freeze({ ...input, command: input.instruction, prompt, user: username || undefined, interactionEpoch: ++this.interactionEpoch });
      if (username) { this.lastUser = username; this.contextsByUser.set(username, snapshot); this.captureWorkspace(username); }
      await this.manager.interrupt();
      this.snapshots.set(snapshot.id, snapshot);
      while (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.keys().next().value);
      this.currentContext = snapshot;
      this.record('interaction.submitted', snapshot);
      this.launch(snapshot);
      return { accepted: true, inputId: snapshot.id, sessionId: SESSION_ID };
    } finally { this.humanInteraction = false; this.scheduleReports(); }
  }
  async interruptRouter() {
    this.cancelling = true;
    try {
      this.agent?.cancel({ kind: 'user' }, { keepInbox: false });
      if (this.activePromise) await this.activePromise;
      this.stream = null;
    } finally { this.cancelling = false; }
  }
  captureBlocksReports() { return this.sound2text && this.sound2text.state().capture?.status !== 'idle'; }
  scheduleReports() {
    if (this.closed || this.deliveryScheduled) return;
    this.deliveryScheduled = true;
    queueMicrotask(() => {
      this.deliveryScheduled = false;
      if (this.closed || this.busy || this.cancelling || this.humanInteraction || this.admissionCount || this.captureBlocksReports() || !this.pendingReports.length) return;
      const reports = this.pendingReports.splice(0);
      this.launch({ kind: 'task_event', id: `event-${this.sequence}`, instruction: '后台任务状态已更新，请根据实际结果简短回复。', context: [], task_events: reports, user: this.audioOwner || this.lastUser });
    });
  }
  launch(input) {
    this.lastError = null; this.busy = true; this.current = input; this.dispatched = false; this.changed();
    this.activePromise = this.run(input).catch(error => { if (!this.cancelling) this.record('router.error', { error: error.message }, undefined, 'router'); }).finally(() => {
      this.busy = false; this.current = undefined;
      this.scheduleReports();
      this.changed();
    });
  }
  async run(input) {
    const before = this.errors.length;
    const taskEvent = input.kind === 'task_event';
    const text = taskEvent ? JSON.stringify({ ...input, tasks: this.manager.tasks(), task_events: [...(input.task_events ?? []), ...this.pendingReports.splice(0)] }) : input.prompt;
    this.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: taskEvent ? { kind: 'mooting-task-event', form: 'relay' } : { kind: 'user', command: input.command } }));
    await this.agent.whenIdle();
    if (this.errors.length > before && !this.cancelling) throw this.errors.at(-1);
  }
  async interrupt(username) {
    const previous = this.actor; if (username) this.actor = username;
    try { return await this.interruptBody(); }
    finally { this.actor = previous; }
  }
  async interruptBody() {
    const hadSubtitle = this.subtitle.active;
    const hadDisplay = hadSubtitle || this.speaker.active;
    if (!hadDisplay) return { stopped: false, interrupted: false };
    this.interactionEpoch++;
    this.humanInteraction = true;
    try {
      this.record('interaction.started', { subtitleWasActive: hadSubtitle });
      await this.manager.interrupt();
      return { stopped: true, interrupted: false };
    } finally { this.humanInteraction = false; this.scheduleReports(); }
  }
  async voiceInteraction({ boundaryMs, username } = {}) {
    const previous = this.actor; this.actor = username || previous;
    try { return await this.voiceInteractionBody({ boundaryMs }); }
    finally { this.actor = previous; }
  }
  async voiceInteractionBody({ boundaryMs } = {}) {
    if (!this.sound2text || this.sound2text.state().status !== 'running') throw new InputError('请先开启语音输入', 409);
    if (this.sound2text.state().capture?.status === 'listening') {
      await this.sound2text.finishCapture('manual', boundaryMs); return { finishing: true };
    }
    if (this.sound2text.state().capture?.status === 'finishing') throw new InputError('正在等待识别完成', 409);
    if (this.models && !this.models.state().configured) throw new InputError('请先配置模型', 409);
    this.humanInteraction = true;
    try {
      this.interactionEpoch++;
      this.sound2text.armCapture(boundaryMs); this.record('voice.capture-started', { boundaryMs });
      await this.interruptRouter();
      return { listening: true };
    } finally { this.humanInteraction = false; }
  }
  async configureModels(value) {
    if (!this.models) throw new InputError('当前测试组合不支持模型配置', 409);
    if (this.busy || this.pending || this.admissionCount || this.configuring) throw new InputError('请等待当前任务结束后再修改模型', 409);
    this.configuring = true;
    try {
      const result = await this.models.configure(value);
      this.mode = 'live'; this.model = result.router.model; this.lastError = null;
      await this.agent.model.select({ provider: this.provider, model: this.model });
      this.record('models.configured', { routerModel: this.model, workerModel: result.worker.model, verified: false });
      return result;
    } finally { this.configuring = false; this.changed(); }
  }
  async idle() {
    for (;;) {
      if (this.busy) await this.activePromise;
      await this.manager.idle();
      this.scheduleReports(); await Promise.resolve();
      if (!this.busy && !this.manager.executing && (!this.pendingReports.length || this.captureBlocksReports())) return;
    }
  }
  async dispose() {
    this.closed = true; this.pending = undefined; this.notifications = [];
    await this.manager.dispose();
    this.agent?.cancel({ kind: 'user' });
    await this.activePromise;
    await this.handle?.dispose();
    this.releaseContext?.(); this.releaseWorkers(); for (const dispose of this.disposers ?? []) dispose(); this.removeAllListeners();
  }
}
