import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { InputError } from './tasks.mjs';
import { mountSound2text } from './sound2text/http-ws.mjs';

const WEB = new URL('../web/', import.meta.url);
const ASSETS = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/audio-capture.js', ['audio-capture.js', 'text/javascript; charset=utf-8']], ['/audio-worklet.js', ['audio-worklet.js', 'text/javascript; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/dsh-views.js', ['dsh-views.js', 'text/javascript; charset=utf-8']], ['/dsh-views.css', ['dsh-views.css', 'text/css; charset=utf-8']]]);
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
async function body(req) {
  let bytes = 0; const parts = [];
  for await (const part of req) { bytes += part.length; if (bytes > 65536) throw new InputError('请求超过 64 KiB', 413); parts.push(part); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new InputError('请求必须为有效 JSON'); }
}

/** Loopback-only HTTP surface; SSE snapshots are bounded and coalesced. */
export async function startWeb(runtime, { port = 4317 } = {}) {
  const clients = new Set(); let scheduled, closing = false;
  const publish = () => {
    scheduled = undefined;
    const message = `event: data\ndata: ${JSON.stringify(runtime.state())}\n\n`;
    for (const response of clients) {
      if (response.writableLength > 1024 * 1024) { response.destroy(); clients.delete(response); continue; }
      response.write(message);
    }
  };
  const changed = () => { if (!scheduled && !closing) scheduled = setTimeout(publish, 40); };
  runtime.on('change', changed);
  const server = createServer((req, res) => {
    const request = async () => {
      const host = req.headers.host ?? '';
      if (!/^127\.0\.0\.1:\d+$/.test(host)) throw new InputError('只允许本地终端访问', 403);
      const path = new URL(req.url, `http://${host}`).pathname;
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) throw new InputError('不允许跨来源访问', 403);
      if (req.method === 'GET' && path === '/api/state') return json(res, 200, runtime.state());
      if (req.method === 'GET' && path === '/api/model/config') return json(res, 200, runtime.models?.state() ?? runtime.state().modelConfig);
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, sessionCount: runtime.ctx.agents.list().length, mode: runtime.mode });
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`event: data\ndata: ${JSON.stringify(runtime.state())}\n\n`);
        clients.add(res); req.on('close', () => clients.delete(res)); return;
      }
      if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new InputError('Content-Type 必须为 application/json', 415);
        const input = await body(req);
        if (path === '/api/model/config') return json(res, 200, await runtime.configureModels(input));
        if (path === '/api/submit') return json(res, 202, await runtime.submit(input));
        if (path === '/api/voice/interaction') return json(res, 200, await runtime.voiceInteraction(input));
        if (path === '/api/interaction') return json(res, 200, await runtime.interrupt());
        if (path === '/api/subtitle/frame') { runtime.manager.frame(input.text); return json(res, 200, { accepted: true }); }
      }
      if (req.method === 'GET' && ASSETS.has(path)) {
        const [filename, type] = ASSETS.get(path);
        const data = await readFile(new URL(filename, WEB));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'" }); res.end(data); return;
      }
      json(res, 404, { error: 'Not found' });
    };
    request().catch(error => { if (!res.headersSent) json(res, error.status ?? 500, { error: error.message }); else res.destroy(); });
  });
  const audioWebSocket = runtime.sound2text ? mountSound2text(server, runtime.sound2text) : undefined;
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) {
    closing = true; clearTimeout(scheduled); runtime.off('change', changed); await audioWebSocket?.(); throw error;
  }
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}`, webRoot: fileURLToPath(WEB),
    async close() { await audioWebSocket?.(); closing = true; clearTimeout(scheduled); runtime.off('change', changed); for (const response of clients) response.end(); clients.clear(); server.closeIdleConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
