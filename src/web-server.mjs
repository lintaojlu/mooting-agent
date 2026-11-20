import { createTrace, elapsed, errorFields, log, runWithTrace } from './log/index.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { InputError } from './tasks.mjs';
import { mountSound2text } from './sound2text/http-ws.mjs';
import { HostedAudio, VOICEPRINT_LIMIT, checkAudioUrl, checkSpeakerName, decodeAudio } from './sound2text/voiceprints.mjs';
import { createAccess, forwardedProto, hostDecision, loginDocument, originAllowed, credentialsMatch } from './access.mjs';

const WEB = new URL('../web/', import.meta.url);
const ASSETS = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']], ['/voiceprints.html', ['voiceprints.html', 'text/html; charset=utf-8']], ['/voiceprints.js', ['voiceprints.js', 'text/javascript; charset=utf-8']], ['/voiceprint-worklet.js', ['voiceprint-worklet.js', 'text/javascript; charset=utf-8']], ['/boot.js', ['boot.js', 'text/javascript; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/audio-capture.js', ['audio-capture.js', 'text/javascript; charset=utf-8']], ['/audio-worklet.js', ['audio-worklet.js', 'text/javascript; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/dsh-views.js', ['dsh-views.js', 'text/javascript; charset=utf-8']], ['/dsh-views.css', ['dsh-views.css', 'text/css; charset=utf-8']]]);
const API_ROUTES = new Set([
  '/api/login', '/api/logout', '/api/state', '/api/context/trace', '/api/model/config', '/api/health', '/api/voiceprints',
  '/api/events', '/api/voiceprints/register', '/api/voiceprints/rename', '/api/voiceprints/replace', '/api/voiceprints/delete',
  '/api/memory/clear', '/api/social-card/create', '/api/owner-speaker', '/api/submit', '/api/voice/interaction', '/api/function/open',
  '/api/social-card/save', '/api/social-card/discard', '/api/interaction', '/api/subtitle/frame',
]);
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'" };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
async function body(req, limit = 65536) {
  let bytes = 0; const parts = [];
  for await (const part of req) { bytes += part.length; if (bytes > limit) throw new InputError('请求超过大小限制', 413); parts.push(part); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new InputError('请求必须为有效 JSON'); }
}
function raiseVoiceprint(error) {
  if (error instanceof InputError) throw error;
  throw new InputError(error?.message || '声纹服务失败', error?.status || 502);
}
function externalOrigin(req, decision, access) {
  const proto = decision.loopback ? 'http' : (forwardedProto(req) === 'https' ? 'https' : 'http');
  return `${proto}://${decision.host}${access.base}`;
}
async function registrationUrl(input, { loopback, hostedAudio, origin }) {
  if (input?.audioUrl) {
    try { return checkAudioUrl(input.audioUrl); } catch (error) { raiseVoiceprint(error); }
  }
  if (loopback) throw new InputError('当前是本机访问，请填写火山引擎能够下载的公网音频 URL');
  if (!input?.audioBase64) throw new InputError('请录制、上传音频，或填写公网音频 URL');
  let decoded;
  try { decoded = decodeAudio(input.audioBase64, input.filename || 'voice.wav'); } catch (error) { raiseVoiceprint(error); }
  const token = hostedAudio.put(decoded.bytes, decoded.contentType);
  return `${origin}/api/voiceprints/media/${token}`;
}
async function page(filename, base) {
  let text = await readFile(new URL(filename, WEB), 'utf8');
  if (filename.endsWith('.html')) text = text.replaceAll('%%BASE_HREF%%', base ? `${base}/` : '/').replaceAll('%%BASE%%', base);
  return text;
}

/** HTTP surface. Loopback stays open for local use; a public host requires the account gate and a path prefix. */
export async function startWeb(runtime, { port = 4317, basePath = '', publicHosts = [], auth = false } = {}) {
  const access = createAccess({ basePath, publicHosts, auth });
  const hostedAudio = new HostedAudio();
  const clients = new Set();
  let scheduled, closing = false, deliveries = [];
  const publish = () => {
    scheduled = undefined;
    const updates = deliveries;
    deliveries = [];
    const sent = new Map();
    for (const client of clients) {
      if (client.res.destroyed || client.res.writableLength > 1024 * 1024) { client.res.destroy(); clients.delete(client); continue; }
      const state = runtime.state(client.username);
      const message = `event: data\ndata: ${JSON.stringify(state)}\n\n`;
      client.res.write(message);
      sent.set(client.username, state);
    }
    for (const { trace, user, inputId, phase, outcome, queuedAt } of updates) {
      const state = sent.get(user) ?? (!auth ? sent.get(undefined) : undefined);
      const delivered = state?.traceId === trace.traceId || state?.trace.some(item => item.traceId === trace.traceId);
      log(delivered ? 'info' : 'debug', 'web.sse.delivery', {
        phase, inputId, totalMs: delivered ? elapsed(trace.started) : undefined, queueMs: elapsed(queuedAt),
        outcome: delivered ? outcome ?? 'ok' : 'unavailable',
      }, trace);
    }
  };
  const changed = delivery => {
    if (closing) return;
    if (delivery) deliveries.push({ ...delivery, queuedAt: performance.now() });
    if (!scheduled) scheduled = setTimeout(publish, 40);
  };
  runtime.on('change', changed);
  const server = createServer((req, res) => {
    const started = performance.now();
    const trace = createTrace('web');
    let route = 'unknown', requestError;
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
      route = API_ROUTES.has(path) || ASSETS.has(path) || path === '/login' || path === '/login.js' ? path : 'unknown';
      if (req.method === 'POST' && path === '/api/submit') trace.source = 'text';
      if (req.method === 'POST' && path === '/api/voice/interaction') trace.source = 'voice';
      const media = /^\/api\/voiceprints\/media\/([a-f0-9]{48})$/u.exec(path);
      if (req.method === 'GET' && media) {
        route = '/api/voiceprints/media';
        const file = hostedAudio.get(media[1]);
        if (!file) return json(res, 404, { error: '音频不存在或已过期' });
        res.writeHead(200, { 'Content-Type': file.contentType, 'Content-Length': String(file.bytes.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(file.bytes); return;
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
        if (req.method === 'GET' && (path === '/' || path === '/index.html' || path === '/voiceprints.html')) { res.writeHead(302, { Location: `${access.base}/login` }); res.end(); return; }
        throw new InputError('请先登录', 401);
      }
      const username = access.auth ? access.sessionUser(req) : undefined;
      runtime.buildAudioUrl = async clip => `${externalOrigin(req, decision, access)}/api/voiceprints/media/${hostedAudio.put(clip, 'audio/L16')}`;
      if (req.method === 'GET' && path === '/api/state') return json(res, 200, runtime.state(username));
      if (req.method === 'GET' && path === '/api/context/trace') return json(res, 200, await runtime.contextTrace(username));
      if (req.method === 'GET' && path === '/api/model/config') return json(res, 200, runtime.models?.state() ?? runtime.state(username).modelConfig);
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, sessionCount: runtime.ctx.agents.list().length, mode: runtime.mode });
      if (req.method === 'GET' && path === '/api/voiceprints') {
        try {
          const items = await runtime.sound2text.voiceprints().listAll();
          return json(res, 200, { items, total: items.length, limit: VOICEPRINT_LIMIT, canRegister: items.length < VOICEPRINT_LIMIT });
        } catch (error) { raiseVoiceprint(error); }
      }
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        log('debug', 'web.sse.connected', { route, elapsedMs: elapsed(started) });
        res.write(`event: data\ndata: ${JSON.stringify(runtime.state(username))}\n\n`);
        const client = { res, username }; clients.add(client); req.on('close', () => clients.delete(client)); return;
      }
      if (req.method === 'POST' && path.startsWith('/api/voiceprints')) {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new InputError('Content-Type 必须为 application/json', 415);
        const input = await body(req, 3_000_000);
        const directory = runtime.sound2text.voiceprints();
        const origin = externalOrigin(req, decision, access);
        try {
          if (path === '/api/voiceprints/register') {
            const name = checkSpeakerName(input?.name);
            const audioUrl = await registrationUrl(input, { loopback: decision.loopback, hostedAudio, origin });
            return json(res, 200, await directory.register({ name, audioUrl }));
          }
          if (path === '/api/voiceprints/rename') return json(res, 200, await directory.rename({ id: input?.id, name: input?.name }));
          if (path === '/api/voiceprints/replace') {
            const name = checkSpeakerName(input?.name);
            const audioUrl = await registrationUrl(input, { loopback: decision.loopback, hostedAudio, origin });
            return json(res, 200, await directory.replace({ id: input?.id, name, audioUrl }));
          }
          if (path === '/api/voiceprints/delete') return json(res, 200, await directory.remove(input?.id));
        } catch (error) { raiseVoiceprint(error); }
        return json(res, 404, { error: 'Not found' });
      }
      if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new InputError('Content-Type 必须为 application/json', 415);
        const input = await body(req);
        if (path === '/api/model/config') return json(res, 200, await runtime.configureModels(input));
        if (path === '/api/memory/clear') {
          if (input?.confirm !== true) throw new InputError('请确认清空记忆和 Agent 对话', 400);
          return json(res, 200, await runtime.clearMemory(username));
        }
        if (path === '/api/social-card/create') return json(res, 200, await runtime.createSocialCard(input, username));
        if (path === '/api/owner-speaker') return json(res, 200, runtime.setOwnerSpeaker(input?.name, username));
        if (path === '/api/submit') return json(res, 202, await runtime.submit(input, username));
        if (path === '/api/voice/interaction') return json(res, 200, await runtime.voiceInteraction({ ...input, username }));
        if (path === '/api/function/open') return json(res, 200, await runtime.showSpeaker(username));
        if (path === '/api/social-card/save') return json(res, 200, await runtime.saveSocialCard(input, username));
        if (path === '/api/social-card/discard') return json(res, 200, await runtime.discardSocialCard(username, input?.cardId));
        if (path === '/api/interaction') return json(res, 200, await runtime.interrupt(username, input?.cardId));
        if (path === '/api/subtitle/frame') { runtime.frame(input.text); return json(res, 200, { accepted: true }); }
      }
      if (req.method === 'GET' && ASSETS.has(path)) {
        const [filename, type] = ASSETS.get(path);
        const data = filename.endsWith('.html') ? await page(filename, access.base) : await readFile(new URL(filename, WEB));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY }); res.end(data); return;
      }
      json(res, 404, { error: 'Not found' });
    };
    let ended = false;
    const end = closed => {
      if (ended) return;
      ended = true;
      const statusCode = res.headersSent ? res.statusCode : undefined;
      const outcome = closed ? 'cancelled' : statusCode >= 500 ? 'failed' : statusCode >= 400 ? 'rejected' : 'ok';
      const level = outcome === 'failed' ? 'error' : outcome === 'rejected' || closed ? 'warning' : req.method === 'POST' ? 'info' : 'debug';
      log(level, 'web.request.end', { ...requestError, method: req.method, route, statusCode, outcome, elapsedMs: elapsed(started) }, trace);
    };
    res.once('finish', () => end(false));
    res.once('close', () => end(!res.writableFinished && route !== '/api/events'));
    res.setHeader('X-Trace-Id', trace.traceId);
    runWithTrace(trace, request).catch(error => {
      requestError = errorFields(error);
      if (!res.headersSent) json(res, error.status ?? 500, { error: error.message });
      else res.destroy();
    });
  });
  const audioWebSocket = runtime.sound2text ? mountSound2text(server, runtime.sound2text, { publicHosts: access.publicHosts, basePath: access.base, authorize: req => !access.auth || Boolean(access.sessionUser(req)), identify: req => access.sessionUser(req) || '', onOwner: (username, active) => runtime.setAudioOwner?.(username, active) }) : undefined;
  server.requestTimeout = access.publicHosts.length ? 0 : 10000;
  server.headersTimeout = access.publicHosts.length ? 60000 : 10000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) {
    closing = true; clearTimeout(scheduled); runtime.off('change', changed); await audioWebSocket?.();
    log('error', 'web.listen.failed', errorFields(error));
    throw error;
  }
  log('info', 'web.listening');
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}`, basePath: access.base, auth: access.auth, webRoot: fileURLToPath(WEB),
    async close() { await audioWebSocket?.(); closing = true; clearTimeout(scheduled); runtime.off('change', changed); for (const client of clients) client.res.end(); clients.clear(); server.closeIdleConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
