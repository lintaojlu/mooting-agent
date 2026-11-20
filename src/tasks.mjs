import { createTrace, currentTrace, elapsed, errorFields, failure, log, outcomeLevel, runWithTrace, timed, traceIds } from './log/index.mjs';
import { randomUUID } from 'node:crypto';

export class InputError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

/** Assemble the user's sole input into an immutable simulated Context snapshot. */
export function snapshotInput(value) {
  if (!value || typeof value !== 'object' || typeof value.instruction !== 'string' || !value.instruction.trim()) throw new InputError('请输入指令');
  if (value.instruction.length > 4000) throw new InputError('指令上限 4000 字符');
  if (Object.keys(value).some(key => key !== 'instruction')) throw new InputError('仅接受 instruction；Context 由系统自动组装');
  const instruction = value.instruction.trim(), at = new Date().toISOString();
  const context = Object.freeze([Object.freeze({ speaker: '用户', text: instruction, kind: 'speech', at })]);
  return Object.freeze({ id: randomUUID(), instruction, context, trigger: 'instruction_submit', at });
}

/** One public session owns all task events; task handles never create DSH Sessions. */
export class TaskManager {
  #tasks = new Map();
  #handles = new Map();
  #timings = new Map();
  #capabilities = new Map();
  #active = undefined;
  #executions = new Set();
  #controllers = new Set();
  get executing() { return this.#executions.size; }
  /** Admit a worker immediately; Router cancellation never owns its signal. */
  launch(plan, snapshot, { isCurrent = () => true } = {}) {
    const controller = new AbortController();
    this.#controllers.add(controller);
    const before = new Set(this.#tasks.keys());
    const execution = this.start(plan, snapshot, controller.signal, { isCurrent });
    const task = [...this.#tasks.values()].find(item => !before.has(item.id));
    const tracked = execution.catch(() => {}).finally(() => { this.#executions.delete(tracked); this.#controllers.delete(controller); });
    this.#executions.add(tracked);
    if (!task) { this.#controllers.delete(controller); throw new InputError('任务未能启动，请检查能力与执行器'); }
    return structuredClone(task);
  }
  async idle() { while (this.#executions.size) await Promise.all([...this.#executions]); }
  constructor({ emit, subtitle, speaker = () => {}, limit = 100 }) { this.emit = emit; this.subtitle = subtitle; this.speaker = speaker; this.limit = limit; }
  display(capability, active, value, taskId) {
    if (capability === 'speaker_identification') this.speaker({ active, person: value ?? null, simulated: true, ...(taskId ? { taskId } : {}) });
    else this.subtitle({ active, text: value ?? '', ...(taskId ? { taskId } : {}) });
  }
  register(capability) {
    if (this.#capabilities.has(capability.id)) throw new Error(`Duplicate capability: ${capability.id}`);
    this.#capabilities.set(capability.id, capability);
    return () => this.#capabilities.delete(capability.id);
  }
  capabilities() { return [...this.#capabilities.values()].map(({ id, description }) => ({ id, description })); }
  tasks() { return structuredClone([...this.#tasks.values()]); }
  start(plan, snapshot, signal, options) {
    const trace = createTrace('worker', traceIds());
    return runWithTrace(trace, () => this.startBody(plan, snapshot, signal, options));
  }
  async startBody(plan, snapshot, signal, { isCurrent = () => true } = {}) {
    if (!plan || !this.#capabilities.has(plan.capability)) throw new InputError('未知能力，未执行');
    signal?.throwIfAborted();
    const capability = this.#capabilities.get(plan.capability);
    if (plan.execution_kind !== (capability.executionKind ?? 'program')) throw new InputError('执行器类型与能力不匹配');
    const task = { id: randomUUID(), capability: capability.id, status: 'starting', inputId: snapshot.id };
    while (this.#tasks.size >= this.limit) {
      const terminal = [...this.#tasks].find(([, t]) => ['completed', 'failed', 'cancelled'].includes(t.status));
      if (!terminal) throw new InputError('任务容量已满', 409);
      this.#tasks.delete(terminal[0]);
    }
    this.#tasks.set(task.id, task);
    const timing = { start: performance.now(), trace: currentTrace() };
    this.#timings.set(task.id, timing);
    const fields = { taskId: task.id, inputId: task.inputId, operation: capability.id };
    log('info', 'worker.start', fields, timing.trace);
    this.emit('worker.starting', { capability: capability.id, execution_kind: plan.execution_kind }, task.id);
    try {
      if (capability.continuous && this.#active) await this.stop(this.#active, 'replaced');
      const handle = await capability.start({ taskId: task.id, snapshot, signal, onEnded: reason => {
        queueMicrotask(() => { this.stop(task.id, reason ?? 'source_stopped').catch(() => {}); });
      }, publish: text => {
        if (this.#active !== task.id || task.status !== 'running') return;
        this.display(capability.id, true, text, task.id);
        this.emit(capability.id === 'speaker_identification' ? 'speaker.frame' : 'subtitle.frame', capability.id === 'speaker_identification' ? { person: text, simulated: true } : { text }, task.id);
      } });
      this.#handles.set(task.id, handle);
      signal?.throwIfAborted();
      if (capability.continuous && !isCurrent()) throw new DOMException('持续功能启动已被新的交互打断', 'AbortError');
      task.status = 'running';
      if (capability.continuous) this.#active = task.id;
      log('debug', 'worker.ready', { ...fields, elapsedMs: elapsed(timing.start) }, timing.trace);
      this.emit('worker.ready', { capability: capability.id, continuous: !!capability.continuous }, task.id);
      if (capability.continuous) {
        this.display(capability.id, true, undefined, task.id);
        handle.begin?.();
        task.result = { started: true, taskId: task.id, capability: capability.id, ...(capability.id === 'speaker_identification' ? { simulated: true } : {}) };
      } else {
        task.result = handle.result;
        await handle.dispose?.(); this.#handles.delete(task.id);
        task.status = 'completed';
        this.emit('worker.completed', { result: task.result }, task.id);
      }
      log('info', 'worker.report', { ...fields, outcome: task.status === 'completed' ? 'ok' : 'running', elapsedMs: elapsed(timing.start) }, timing.trace);
      if (task.status === 'completed') this.#timings.delete(task.id);
      this.emit('worker.report', { status: task.status, result: task.result }, task.id);
      return structuredClone(task);
    } catch (error) {
      await this.#handles.get(task.id)?.dispose?.(); this.#handles.delete(task.id);
      if (this.#active === task.id) { this.#active = undefined; this.display(task.capability, false); }
      task.status = signal?.aborted || error.name === 'AbortError' ? 'cancelled' : 'failed'; task.result = { error: error.message };
      this.#timings.delete(task.id);
      const outcome = task.status === 'cancelled' ? 'cancelled' : failure(error);
      log(outcomeLevel(outcome), 'worker.report', { ...fields, ...errorFields(error), outcome, elapsedMs: elapsed(timing.start) }, timing.trace);
      this.emit(`worker.${task.status}`, task.result, task.id);
      this.emit('worker.report', { status: task.status, result: task.result }, task.id); throw error;
    }
  }
  async stop(id, reason = 'user_interaction') {
    const task = this.#tasks.get(id);
    if (!task || task.status !== 'running') return;
    const timing = this.#timings.get(id);
    return timed('worker.stop', () => this.stopBody(task, reason), {
      taskId: id, reason, durationMs: timing ? elapsed(timing.start) : undefined,
    }, { trace: timing?.trace });
  }
  async stopBody(task, reason) {
    const id = task.id;
    this.#timings.delete(id);
    task.status = 'stopping'; this.emit('worker.stopping', { reason }, id);
    // A display lease is revoked before disposal, so late frames cannot reappear.
    if (this.#active === id) { this.#active = undefined; this.display(task.capability, false); }
    try {
      await this.#handles.get(id)?.dispose?.(); this.#handles.delete(id);
      task.status = 'completed'; task.result = { reason };
      this.emit('worker.completed', { reason }, id);
      this.emit('worker.report', { status: task.status, reason }, id);
    } catch (error) {
      task.status = 'failed'; task.result = { error: error.message, reason };
      this.emit('worker.failed', task.result, id); throw error;
    }
  }
  async interrupt(reason = 'user_interaction') { if (this.#active) await this.stop(this.#active, reason); }
  frame(text) {
    if (typeof text !== 'string' || text.length > 2000 || !text.trim()) throw new InputError('字幕帧需要 1–2000 字符');
    if (!this.#active) throw new InputError('当前没有字幕任务', 409);
    this.#handles.get(this.#active)?.push?.(text);
  }
  async dispose() {
    for (const controller of this.#controllers) controller.abort(new DOMException('宿主退出', 'AbortError'));
    await this.idle(); await this.interrupt('host_shutdown');
  }
}
