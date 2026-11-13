import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { InputError } from './tasks.mjs';
import { mountSound2text } from './sound2text/http-ws.mjs';
import { createAccess, forwardedProto, hostDecision, loginDocument, originAllowed, credentialsMatch } from './access.mjs';

const WEB = new URL('../web/', import.meta.url);
const ASSETS = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/boot.js', ['boot.js', 'text/javascript; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/audio-capture.js', ['audio-capture.js', 'text/javascript; charset=utf-8']], ['/audio-worklet.js', ['audio-worklet.js', 'text/javascript; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/dsh-views.js', ['dsh-views.js', 'text/javascript; charset=utf-8']], ['/dsh-views.css', ['dsh-views.css', 'text/css; charset=utf-8']]]);
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'" };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
async function body(req) {
  let bytes = 0; const parts = [];
  for await (const part of req) { bytes += part.length; if (bytes > 65536) throw new InputError('请求超过 64 KiB', 413); parts.push(part); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new InputError('请求必须为有效 JSON'); }
}
async function page(filename, base) {
  let text = await readFile(new URL(filename, WEB), 'utf8');
  if (filename === 'index.html') text = text.replaceAll('%%BASE_HREF%%', base ? `${base}/` : '/').replaceAll('%%BASE%%', base);
  return text;
}

/** HTTP surface. Loopback stays open for local use; a public host requires the account gate and a path prefix. */
export async function startWeb(runtime, { port = 4317, basePath = '', publicHosts = [], auth = false } = {}) {
  const access = createAccess({ basePath, publicHosts, auth });
  const clients = new Set(); let scheduled, closing = false;
  const publish = () => {
    scheduled = undefined;
    for (const client of clients) {
      const message = `event: data\ndata: ${JSON.stringify(runtime.state(client.username))}\n\n`;
      if (client.res.writableLength > 1024 * 1024) { client.res.destroy(); clients.delete(client); continue; }
      client.res.write(message);
    }
  };
  const changed = () => { if (!scheduled && !closing) scheduled = setTimeout(publish, 40); };
  runtime.on('change', changed);
  const server = createServer((req, res) => {
    const request = async () => {
      const decision = hostDecision(req, access.publicHosts);
      if (!decision.ok) throw new InputError('不允许从该地址访问', 403);
      if (!originAllowed(req, decision)) throw new InputError('不允许跨来源访问', 403);
      if (!decision.loopback && !['GET', 'HEAD'].includes(req.method ?? 'GET') && !req.headers.origin) throw new InputError('不允许跨来源访问', 403);
      const url = new URL(req.url ?? '/', `http://${decision.host}`);
      let path = url.pathname;
      if (access.base) {
        if (path === access.base) { res.writeHead(308, { Location: `${access.base}/` }); res.end(); return; }
        if (!path.startsWith(`${access.base}/`)) return json(res, 404, { error: 'Not found' });
        path = path.slice(access.base.length) || '/';
      }
      const secure = !decision.loopback && forwardedProto(req) === 'https';
      if (req.method === 'POST' && path === '/api/login') {
        if (!access.auth) return json(res, 404, { error: 'Not found' });
        if (!req.headers['content-type']?.startsWith('application/json')) throw new InputError('Content-Type 必须为 application/json', 415);
        const ip = access.clientIp(req);
        if (access.tooMany(ip)) throw new InputError('尝试次数过多，请 15 分钟后再试', 429);
        const input = await body(req);
        const username = credentialsMatch(input?.username, input?.password);
        if (!username) { access.fail(ip); throw new InputError('账号或密码不正确', 401); }
        access.clearFailures(ip);
        access.issue(res, username, secure);
        return json(res, 200, { ok: true, username });
      }
      if (req.method === 'POST' && path === '/api/logout') { access.clearCookie(res, req, secure); return json(res, 200, { ok: true }); }
      if (req.method === 'GET' && path === '/login.js') {
        const data = await readFile(new URL('login.js', WEB));
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY }); res.end(data); return;
      }
      if (req.method === 'GET' && path === '/login') {
        if (access.sessionUser(req)) { res.writeHead(302, { Location: `${access.base}/` }); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY }); res.end(loginDocument(access.base)); return;
      }
      if (access.auth && !access.sessionUser(req)) {
        if (req.method === 'GET' && (path === '/' || path === '/index.html')) { res.writeHead(302, { Location: `${access.base}/login` }); res.end(); return; }
        throw new InputError('请先登录', 401);
      }
      const username = access.auth ? access.sessionUser(req) : undefined;
      if (req.method === 'GET' && path === '/api/state') return json(res, 200, runtime.state(username));
      if (req.method === 'GET' && path === '/api/model/config') return json(res, 200, runtime.models?.state() ?? runtime.state(username).modelConfig);
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, sessionCount: runtime.ctx.agents.list().length, mode: runtime.mode });
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`event: data\ndata: ${JSON.stringify(runtime.state(username))}\n\n`);
        const client = { res, username }; clients.add(client); req.on('close', () => clients.delete(client)); return;
      }
      if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new InputError('Content-Type 必须为 application/json', 415);
        const input = await body(req);
        if (path === '/api/model/config') return json(res, 200, await runtime.configureModels(input));
        if (path === '/api/submit') return json(res, 202, await runtime.submit(input, username));
        if (path === '/api/voice/interaction') return json(res, 200, await runtime.voiceInteraction({ ...input, username }));
        if (path === '/api/interaction') return json(res, 200, await runtime.interrupt(username));
        if (path === '/api/subtitle/frame') { runtime.manager.frame(input.text); return json(res, 200, { accepted: true }); }
      }
      if (req.method === 'GET' && ASSETS.has(path)) {
        const [filename, type] = ASSETS.get(path);
        const data = filename === 'index.html' ? await page(filename, access.base) : await readFile(new URL(filename, WEB));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY }); res.end(data); return;
      }
      json(res, 404, { error: 'Not found' });
    };
    request().catch(error => { if (!res.headersSent) json(res, error.status ?? 500, { error: error.message }); else res.destroy(); });
  });
  const audioWebSocket = runtime.sound2text ? mountSound2text(server, runtime.sound2text, { publicHosts: access.publicHosts, basePath: access.base, authorize: req => !access.auth || Boolean(access.sessionUser(req)), identify: req => access.sessionUser(req) || '', onOwner: (username, active) => runtime.setAudioOwner?.(username, active) }) : undefined;
  server.requestTimeout = access.publicHosts.length ? 0 : 10000;
  server.headersTimeout = access.publicHosts.length ? 60000 : 10000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) {
    closing = true; clearTimeout(scheduled); runtime.off('change', changed); await audioWebSocket?.(); throw error;
  }
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}`, basePath: access.base, auth: access.auth, webRoot: fileURLToPath(WEB),
    async close() { await audioWebSocket?.(); closing = true; clearTimeout(scheduled); runtime.off('change', changed); for (const client of clients) client.res.end(); clients.clear(); server.closeIdleConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
