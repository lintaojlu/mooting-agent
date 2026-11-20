import test from 'node:test';
import assert from 'node:assert/strict';
import Web from '@deepseek-ai/dsh-web';
import * as WebDeepseekApi from '@deepseek-ai/dsh-web-deepseek-api';
import * as WebFetchHttp from '@deepseek-ai/dsh-web-fetch-http';
import * as ToolWeb from '@deepseek-ai/dsh-tool-web';
import { harness } from './harness.mjs';

/** Mount the DSH web stack exactly as cordis.patch.yml does in production. */
async function mountWebStack(ctx) {
  await ctx.plugin(Web, { searchProvider: 'deepseek-search-api', fetchProvider: 'http' });
  await ctx.plugin(WebDeepseekApi);
  await ctx.plugin(WebFetchHttp);
  await ctx.plugin(ToolWeb, { searchTimeoutMs: 60000 });
}

async function admittedToolNames(h) {
  const set = await h.ctx.tools.resolve({ agent: h.runtime.handle.agent, modelSelection: { provider: 'mooting-mock', model: 'scripted-router' }, signal: AbortSignal.timeout(5000) });
  try { return [...set.view(h.runtime.handle.agent).keys()]; } finally { set.dispose(); }
}

test('web stack registers providers and exposes web_search/web_fetch to the mooting agent', async t => {
  const h = await harness(); t.after(() => h.dispose());
  await mountWebStack(h.ctx);
  const providers = h.ctx.web.listProviders();
  assert.ok(providers.search.some(p => p.id === 'deepseek-search-api'), 'search provider registered');
  assert.ok(providers.fetch.some(p => p.id === 'http'), 'fetch provider registered');
  const registered = h.ctx.tools.definitions(h.runtime.handle.agent).map(d => d.name);
  assert.ok(registered.includes('web_search') && registered.includes('web_fetch'), 'tools registered beside mooting tools');
  assert.ok(registered.includes('social_card'), 'mooting tools still present');
});

test('web_search admission follows DeepSeek key presence; web_fetch is always admitted', async t => {
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  const h = await harness(); t.after(() => h.dispose());
  t.after(() => { if (saved === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved; });
  await mountWebStack(h.ctx);
  const withoutKey = await admittedToolNames(h);
  assert.ok(!withoutKey.includes('web_search'), 'no key withholds web_search from the model step');
  assert.ok(withoutKey.includes('web_fetch'), 'web_fetch needs no credential');
  process.env.DEEPSEEK_API_KEY = 'sk-test-placeholder-key';
  const withKey = await admittedToolNames(h);
  assert.ok(withKey.includes('web_search') && withKey.includes('web_fetch'), 'a configured key admits web_search');
});
