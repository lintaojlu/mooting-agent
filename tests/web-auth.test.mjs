import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startWeb } from '../src/web-server.mjs';

function runtime() {
  return { mode: 'unconfigured', on() {}, off() {}, state: () => ({ sessionId: 'mooting-main', mode: 'unconfigured' }), ctx: { agents: { list: () => [{}] } }, manager: { frame() {} } };
}
function cookie(response) {
  return (response.headers.getSetCookie?.() ?? []).map(line => line.split(';')[0]).join('; ');
}
function ask(port, { path = '/mooting-agent/api/login', method = 'GET', headers = {}, payload } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      const parts = [];
      res.on('data', chunk => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('account gate and base path protect the public prefix', async t => {
  const web = await startWeb(runtime(), { port: 0, basePath: '/mooting-agent', auth: true, publicHosts: ['nillin.space'] });
  t.after(() => web.close());
  assert.equal((await fetch(web.url + '/mooting-agent/api/state')).status, 401);
  assert.equal((await fetch(web.url + '/mooting-agent/api/context/trace')).status, 401);
  const page = await fetch(web.url + '/mooting-agent/', { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/mooting-agent/login');
  const slash = await fetch(web.url + '/mooting-agent', { redirect: 'manual' });
  assert.equal(slash.status, 308);
  assert.equal((await fetch(web.url + '/mooting-agent/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nil', password: 'nope' }) })).status, 401);
  const login = await fetch(web.url + '/mooting-agent/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Zoe', password: 'mooting@2026' }) });
  assert.equal(login.status, 200);
  const session = cookie(login);
  assert.match(session, /^mooting_session=/);
  assert.equal((await fetch(web.url + '/mooting-agent/api/state', { headers: { Cookie: session } })).status, 200);
  const html = await fetch(web.url + '/mooting-agent/', { headers: { Cookie: session } }).then(response => response.text());
  assert.match(html, /content="\/mooting-agent"/);
  assert.match(html, /href="\/mooting-agent\/"/);
  assert.doesNotMatch(html, /%%BASE/);
  assert.equal((await fetch(web.url + '/api/state', { headers: { Cookie: session } })).status, 404);
  const loginPage = await fetch(web.url + '/mooting-agent/login', { redirect: 'manual', headers: { Cookie: session } });
  assert.equal(loginPage.status, 302);
});

test('public host accepts the forwarded https origin and rejects others', async t => {
  const web = await startWeb(runtime(), { port: 0, basePath: '/mooting-agent', auth: true, publicHosts: ['nillin.space'] });
  t.after(() => web.close());
  const port = Number(new URL(web.url).port);
  const denied = await ask(port, { method: 'POST', headers: { Host: 'evil.example', Origin: 'https://evil.example', 'Content-Type': 'application/json' }, payload: '{}' });
  assert.equal(denied.status, 403);
  const cross = await ask(port, { method: 'POST', headers: { Host: 'nillin.space', Origin: 'https://other.example', 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json' }, payload: '{}' });
  assert.equal(cross.status, 403);
  const ok = await ask(port, { method: 'POST', headers: { Host: 'nillin.space', Origin: 'https://nillin.space', 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.8' }, payload: JSON.stringify({ username: 'olsen', password: 'mooting@2026' }) });
  assert.equal(ok.status, 200);
  const setCookie = [].concat(ok.headers['set-cookie'] ?? []).join(';');
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /Path=\/mooting-agent/);
});
