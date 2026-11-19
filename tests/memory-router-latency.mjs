import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ContextSystem } from '../src/context/index.mjs';
import { harness } from './harness.mjs';
import { ENV_PATH, testBridge } from './hindsight-live.mjs';

const liveLoad = process.env.MOOTING_LATENCY_LIVE === '1';
const pairs = Number(process.env.MOOTING_LATENCY_PAIRS ?? 12);
if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > 120) throw new Error('MOOTING_LATENCY_PAIRS 必须为 1–120 整数');
const bridge = liveLoad ? testBridge({ bank: `mooting-latency-${process.pid}-${Date.now().toString(36)}`, mentalModelTrigger: { minRefreshIntervalSeconds: 600 } }) : null;
const context = new ContextSystem({ dataRoot: await mkdtemp(join(tmpdir(), 'mooting-latency-')), bridge });
await context.ready;
context.cache.models = { 'user-profile': { content: '用户住在杭州，是创业者，喜欢简短回复和美式咖啡。' }, 'open-items': { content: '周五交付语音助手原型，先完成记忆缓存，再优化中文检索。' }, people: { people: [] } };
for (let i=0; i<30; i++) context.observe({ status: 'running', utterances: [{ text: ['王磊是产品经理，昵称磊哥，下周五交付语音助手原型。', '李娜是大学同学，在协和医院当医生。', '用户住在杭州，喜欢美式咖啡和简短回复。'][i%3], definite: true, start_time: i }] });
const report = { startedAt: new Date().toISOString(), pairs, liveLoad, memoryChars: context.compile('请只回复“收到”。').length, baselineMs: [], memoryMs: [], errors: [], boundary: liveLoad ? '两个等轮数真实 Router Session 交替比较，同时运行真实 Hindsight、本地模型和每3秒一条定稿；控制会话长度和测试时段，但基线组也承受共享后台负载，不能替代无 Hindsight 的整小时基线。' : '交替运行两个独立且轮数相同的真实 Router Session；没有 Hindsight 守护进程；仅用于补查注入文本开销，不能替代一小时长测。' };
let baseline, memory, feeding;
async function measure(h) {
  let first;
  const started = performance.now();
  const off = h.ctx.on('agent/assistant-stream', ({ frame }) => { if (first === undefined && frame.type === 'chunk' && frame.chunk.type === 'text-delta') first = performance.now()-started; });
  try {
    await h.runtime.submit({ instruction: '请只回复“收到”。' });
    await h.runtime.idle();
    if (first === undefined) throw new Error(h.runtime.lastError ?? '无首包');
    return first;
  } finally { off(); }
}
const quantile = (values, q) => values.length ? [...values].sort((a,b)=>a-b)[Math.min(values.length-1, Math.floor(values.length*q))] : null;
try {
  if (bridge) {
    await bridge.start();
    if (!bridge.ready) throw new Error(`Hindsight 未就绪：${bridge.error}`);
    let sequence = 1000;
    feeding = setInterval(() => context.observe({ status: 'running', utterances: [{ text: '磊哥下周五交付语音助手原型，用户住在杭州。', definite: true, start_time: ++sequence * 3000 }] }), 3000);
  }
  baseline = await harness({ realModels: true, configPath: ENV_PATH });
  memory = await harness({ realModels: true, configPath: ENV_PATH, context });
  for (let i=0; i<report.pairs; i++) {
    for (const kind of i%2 ? ['memory','baseline'] : ['baseline','memory']) {
      try { report[kind+'Ms'].push(await measure(kind === 'memory' ? memory : baseline)); }
      catch (error) { report.errors.push({ pair:i, kind, message:error.message }); }
    }
  }
  report.baselineP50Ms = quantile(report.baselineMs, .5);
  report.memoryP50Ms = quantile(report.memoryMs, .5);
  report.baselineP95Ms = quantile(report.baselineMs, .95);
  report.memoryP95Ms = quantile(report.memoryMs, .95);
} finally {
  clearInterval(feeding);
  await baseline?.dispose(); await memory?.dispose();
  try { await context.dispose(); }
  finally { if (bridge) { try { if (bridge.ready) await bridge.deleteBank(); } finally { await bridge.stop(); } } }
  report.finishedAt = new Date().toISOString();
  await mkdir('artifacts', { recursive: true });
  await writeFile(process.env.MOOTING_LATENCY_REPORT ?? (liveLoad ? 'artifacts/memory-router-loaded-latency-report.json' : 'artifacts/memory-router-latency-report.json'), JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
  if (report.errors.length) process.exitCode = 1;
}
