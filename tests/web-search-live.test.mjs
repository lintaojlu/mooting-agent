import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Web from '@deepseek-ai/dsh-web';
import * as WebDeepseekApi from '@deepseek-ai/dsh-web-deepseek-api';
import * as WebFetchHttp from '@deepseek-ai/dsh-web-fetch-http';
import * as ToolWeb from '@deepseek-ai/dsh-tool-web';

/** Live check against the real DeepSeek Search API using the key from .env. Skipped without a key. */
const env = parseEnv(await readFile(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8'));
const key = env.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY;
if (env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY;

test('live web_search and web_fetch through the vendored DSH web stack', { skip: !key, timeout: 120_000 }, async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await ctx.plugin(Web, { searchProvider: 'deepseek-search-api', fetchProvider: 'http' });
  await ctx.plugin(WebDeepseekApi);
  await ctx.plugin(WebFetchHttp);
  await ctx.plugin(ToolWeb, { searchTimeoutMs: 60000 });

  const search = await ctx.web.search({ query: '2026年11月 最新 AI 新闻', maxResults: 5 }, AbortSignal.timeout(90_000));
  assert.ok(search.sources.length > 0, 'search returned sources');
  for (const source of search.sources) assert.ok(source.url.startsWith('http'), `source has url: ${source.url}`);
  console.log('search sources:', search.sources.map(s => `${s.title ?? '(no title)'} <${s.url}>`).join('\n  '));

  const fetch = await ctx.web.fetch({ url: 'https://example.com/' }, AbortSignal.timeout(30_000));
  assert.ok(JSON.stringify(fetch).includes('Example Domain'), 'fetch retrieved example.com');
});
