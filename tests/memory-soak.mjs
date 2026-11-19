import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ContextSystem } from '../src/context/index.mjs';
import { harness } from './harness.mjs';
import { testBridge, ENV_PATH } from './hindsight-live.mjs';

// Real-time, opt-in acceptance run. Synthetic ASR finals, real Router LLM and real Hindsight/local models.
// A short smoke duration only validates this runner; it does not count as the one-hour acceptance.
const durationMs = Number(process.env.MOOTING_SOAK_MS ?? 3_600_000);
if (!Number.isFinite(durationMs) || durationMs < 1000) throw new Error('MOOTING_SOAK_MS 必须 >= 1000');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, p = 0.95) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null;
const bridge = testBridge({ bank: `mooting-soak-${process.pid}-${Date.now().toString(36)}`, mentalModelTrigger: { minRefreshIntervalSeconds: 600 } });
const dataRoot = await mkdtemp(join(tmpdir(), 'mooting-soak-'));
const context = new ContextSystem({ dataRoot, bridge });
await context.ready;
const report = { startedAt: new Date().toISOString(), durationMs, workload: '每3秒一条合成中文 ASR 定稿；每分钟一轮真实 Router；生产默认 flush 条件及本地模型', bank: bridge.bank, baselineFirstPacketMs: [], memoryFirstPacketMs: [], compileMs: [], immediateReadMs: [], backlog: [], errors: [] };
let h, feeding, sampling, closing = false;
async function routerTurn(target) {
  const started = performance.now();
  let first;
  const off = h.ctx.on('agent/assistant-stream', ({ frame }) => {
    if (first === undefined && frame.type === 'chunk' && frame.chunk.type === 'text-delta') first = performance.now() - started;
  });
  try {
    await h.runtime.submit({ instruction: '请只回复“收到”。' });
    await h.runtime.idle();
    if (first === undefined) throw new Error(h.runtime.lastError || 'Router 未输出首包');
    target.push(first);
  } finally { off(); }
}
async function cleanup() {
  if (closing) return;
  closing = true;
  clearInterval(feeding); clearInterval(sampling);
  if (h) h.runtime.context = context;
  try { await h?.dispose(); }
  finally {
    try { await context.dispose(); }
    finally {
      try { if (bridge.ready) await bridge.deleteBank(); }
      finally { await bridge.stop(); }
    }
  }
}
try {
  h = await harness({ realModels: true, configPath: ENV_PATH, context });
  if (!h.runtime.models.state().configured) throw new Error('一小时验收需要配置真实 MOOTING_BASE_URL / MOOTING_MODEL');
  // Baseline uses the same Router with memory injection and recording disabled, before daemon startup.
  h.runtime.context = null;
  for (let i = 0; i < 8; i++) await routerTurn(report.baselineFirstPacketMs);
  h.runtime.context = context;
  await bridge.start();
  if (!bridge.ready) throw new Error(`Hindsight 未就绪：${bridge.error}`);
  const facts = ['我的同事王磊是产品经理，别名磊哥。', '磊哥在做语音助手原型，下周五交付。', '李娜是大学同学，在协和医院当医生。', '我住在杭州，喜欢美式咖啡和简短回复。', '周五要和设计师陈晨确认交互稿。', '语音助手原型先完成本地记忆缓存，再优化中文检索。'];
  let seq = 0;
  feeding = setInterval(() => {
    const text = facts[seq % facts.length];
    const start = performance.now();
    context.observe({ status: 'running', utterances: [{ text, definite: true, start_time: ++seq * 3000 }] });
    if (!context.compile('').includes(text)) report.errors.push('定稿后未能立即读取原话');
    report.immediateReadMs.push(performance.now() - start);
    const compiled = performance.now();
    context.compile('王磊和李娜最近有什么安排？');
    report.compileMs.push(performance.now() - compiled);
  }, 3000);
  const started = Date.now();
  sampling = setInterval(() => {
    report.backlog.push({ elapsedMs: Date.now() - started, pending: context.state().outbox });
    console.log(JSON.stringify({ elapsedSeconds: Math.round((Date.now() - started) / 1000), outbox: context.state().outbox, turns: report.memoryFirstPacketMs.length, service: bridge.status }));
  }, 60_000);
  while (Date.now() - started < durationMs) {
    const next = Date.now() + 60_000;
    try { await routerTurn(report.memoryFirstPacketMs); }
    catch (error) { report.errors.push(error.message); }
    await sleep(Math.max(0, Math.min(next - Date.now(), durationMs - (Date.now() - started))));
  }
  clearInterval(feeding); clearInterval(sampling);
  context.voicePaused();
  const drainStart = Date.now();
  do {
    await context.flush({ force: true, reason: 'soak-drain' });
    if (context.state().outbox === 0) break;
    if (Date.now() - drainStart > 600_000) throw new Error('停止输入后10分钟仍未清空 outbox');
    await sleep(3000);
  } while (true);
  report.elapsedMs = Date.now() - started;
  report.utterances = seq;
  report.finalOutbox = context.state().outbox;
  report.compileP95Ms = percentile(report.compileMs);
  report.immediateReadP95Ms = percentile(report.immediateReadMs);
  report.baselineFirstPacketP95Ms = percentile(report.baselineFirstPacketMs);
  report.memoryFirstPacketP95Ms = percentile(report.memoryFirstPacketMs);
  report.routerP95DeltaMs = report.memoryFirstPacketP95Ms - report.baselineFirstPacketP95Ms;
  report.fullHour = durationMs >= 3_600_000;
  report.models = Object.fromEntries(Object.entries(context.cache.models).map(([id, model]) => [id, { updatedAt: model.updatedAt, contentChars: model.content?.length ?? 0 }]));
  report.cachePopulated = ['user-profile', 'people', 'open-items'].every(id => report.models[id]?.contentChars > 0);
  report.backgroundOperations = [];
  for (let offset = 0; ; offset += 100) {
    const page = await bridge.operations(undefined, { limit: 100, offset });
    report.backgroundOperations.push(...(page.operations ?? []).filter(op => op.status !== 'completed').map(op => ({ type: op.task_type, status: op.status, createdAt: op.created_at, error: op.error_message })));
    if (!page.operations?.length || offset + page.operations.length >= page.total) break;
  }
  report.functionalPassed = report.errors.length === 0 && report.finalOutbox === 0 && report.cachePopulated && report.compileP95Ms <= 10 && report.immediateReadP95Ms <= 100;
  // Operationalize the plan's qualitative 'no noticeable regression' conservatively;
  // raw baseline has only eight samples, so report this separately rather than asserting causality.
  report.latencyToleranceMs = Math.max(500, report.baselineFirstPacketP95Ms * 0.2);
  report.latencyPassed = report.routerP95DeltaMs <= report.latencyToleranceMs;
  report.passed = report.functionalPassed && report.latencyPassed;
} catch (error) {
  report.errors.push(error.stack ?? error.message);
  report.passed = false;
  process.exitCode = 1;
} finally {
  await cleanup().catch(error => { report.errors.push(`cleanup: ${error.message}`); process.exitCode = 1; });
  if (report.errors.length || !report.passed) { report.passed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  await mkdir('artifacts', { recursive: true });
  const output = process.env.MOOTING_SOAK_REPORT ?? 'artifacts/memory-soak-report.json';
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: output, passed: report.passed, fullHour: report.fullHour, compileP95Ms: report.compileP95Ms, immediateReadP95Ms: report.immediateReadP95Ms, routerP95DeltaMs: report.routerP95DeltaMs, errors: report.errors }));
}
