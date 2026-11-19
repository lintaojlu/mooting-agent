import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { testBridge } from './hindsight-live.mjs';

// Run after the soak test: this uses the same isolated test profile/port and stops it on exit.
const cases = [
  { name: '王磊', alias: '磊哥', fact: '王磊是用户同事，职业是产品经理，昵称磊哥。', keyword: '产品经理' },
  { name: '李娜', alias: '娜姐', fact: '李娜是用户大学同学，是协和医院的医生，昵称娜姐。', keyword: '医生' },
  { name: '陈晨', alias: '晨晨', fact: '陈晨是用户合作的交互设计师，昵称晨晨。', keyword: '设计' },
  { name: '欧阳霁', alias: '小霁', fact: '欧阳霁是用户表姐，是建筑师，昵称小霁。', keyword: '建筑' },
  { name: '覃栩', alias: '阿栩', fact: '覃栩是用户邻居，职业是木工，昵称阿栩。', keyword: '木工' },
  { name: '司马澄', alias: '澄子', fact: '司马澄是用户中学同学，是律师，昵称澄子。', keyword: '律师' },
];
const bridge = testBridge({ bank: `mooting-recall-${process.pid}-${Date.now().toString(36)}`, mentalModelTrigger: { refreshAfterConsolidation: false } });
const report = { startedAt: new Date().toISOString(), model: null, cases: [], sampleLimit: '六位合成人物的姓名/别名各一条查询，不代表中文专名总体召回率', errors: [] };
try {
  await bridge.start();
  if (!bridge.ready) throw new Error(`真实记忆服务未就绪：${bridge.error}`);
  report.model = bridge.config.llm.model;
  await bridge.retain(cases.map(item => item.fact).join('\n'), { documentId: 'chinese-people-fixture', async: false, context: '测试合成人物。每个人的关系、职业和昵称都是明确确认的信息。', timestamp: new Date().toISOString() }, { timeoutMs: 120_000 });
  for (const item of cases) {
    for (const [kind, name] of [['name', item.name], ['alias', item.alias]]) {
      const query = `${name}的职业是什么？`;
      const started = performance.now();
      try {
        const result = await bridge.recall(query, { budget: 'mid', maxTokens: 2048, types: ['world', 'experience'] }, { timeoutMs: 3000 });
        const hits = (result.results ?? []).map(fact => fact.text);
        const found = hits.some(text => text.includes(item.name) && text.includes(item.keyword));
        report.cases.push({ name: item.name, kind, query, found, elapsedMs: performance.now() - started, results: hits });
      } catch (error) {
        report.cases.push({ name: item.name, kind, query, found: false, elapsedMs: performance.now() - started, error: error.message });
      }
    }
  }
  const summarize = kind => {
    const checks = report.cases.filter(item => item.kind === kind);
    return { total: checks.length, hits: checks.filter(item => item.found).length, rate: checks.filter(item => item.found).length / checks.length };
  };
  report.names = summarize('name');
  report.aliases = summarize('alias');
  report.hadTimeouts = report.cases.some(item => item.error);
} catch (error) { report.errors.push(error.message); process.exitCode = 1; }
finally {
  try { if (bridge.ready) await bridge.deleteBank(); }
  catch (error) { report.errors.push(`cleanup: ${error.message}`); process.exitCode = 1; }
  await bridge.stop();
  report.finishedAt = new Date().toISOString();
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/memory-chinese-recall-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ names: report.names, aliases: report.aliases, hadTimeouts: report.hadTimeouts, errors: report.errors }));
}
