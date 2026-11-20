import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Web from '@deepseek-ai/dsh-web';
import * as WebDeepseekApi from '@deepseek-ai/dsh-web-deepseek-api';
import * as WebFetchHttp from '@deepseek-ai/dsh-web-fetch-http';
import * as ToolWeb from '@deepseek-ai/dsh-tool-web';
import { harness } from './harness.mjs';

/** End-to-end: the real router model decides to call web_search and answers from its results. */
const env = parseEnv(await readFile(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8'));
const ready = env.DEEPSEEK_API_KEY && env.MOOTING_BASE_URL && env.MOOTING_MODEL;
if (env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY;

test('router model calls web_search and answers with fresh sources', { skip: !ready, timeout: 300_000 }, async t => {
  const h = await harness({ realModels: true }); t.after(() => h.dispose());
  await h.ctx.plugin(Web, { searchProvider: 'deepseek-search-api', fetchProvider: 'http' });
  await h.ctx.plugin(WebDeepseekApi);
  await h.ctx.plugin(WebFetchHttp);
  await h.ctx.plugin(ToolWeb, { searchTimeoutMs: 60000 });
  assert.equal(h.runtime.state().mode, 'live');

  await h.runtime.submit({ instruction: '用 web_search 搜一下本周的 AI 重要新闻，用中文简要告诉我两条，并附来源链接。' });
  await h.runtime.idle();

  const state = h.runtime.state();
  const searchCall = state.trace.find(e => e.type === 'dsh.tool/call' && JSON.stringify(e.data).includes('web_search'));
  assert.ok(searchCall, `router called web_search; trace: ${JSON.stringify(state.trace.map(e => e.type))}`);
  const answer = state.trace.findLast(e => e.type === 'router.answer')?.data.text ?? '';
  assert.ok(answer.length > 0, 'router answered');
  console.log('\n--- router answer ---\n' + answer + '\n---------------------');
});
