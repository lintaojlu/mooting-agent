import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

/** Same-origin, single-owner PCM transport. Capture controls stay on the Router's HTTP coordination path. */
export function mountSound2text(server, sound) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64000, perMessageDeflate: false });
  let owner, closing = false;
  const send = (socket, value) => { if (socket.readyState !== WebSocket.OPEN) return; if (socket.bufferedAmount > 262144) { socket.terminate(); return; } socket.send(JSON.stringify(value)); };
  const reject = (socket, status) => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
  function upgrade(req, socket, head) {
    let path; try { path = new URL(req.url, 'http://127.0.0.1').pathname; } catch { return reject(socket, '400 Bad Request'); }
    if (path !== '/api/sound2text/audio') return;
    const host = req.headers.host ?? '';
    if (closing || !/^127\.0\.0\.1:\d+$/.test(host) || req.headers.origin !== `http://${host}`) return reject(socket, '403 Forbidden');
    if (owner) return reject(socket, '409 Conflict');
    wss.handleUpgrade(req, socket, head, client => { owner = client; wss.emit('connection', client); });
  }
  server.on('upgrade', upgrade);
  wss.on('connection', socket => {
    const id = randomUUID(); let chain = Promise.resolve(), active = false, queued = 0;
    const changed = state => send(socket, { type: 'state', state });
    sound.events.on('change', changed); send(socket, { type: 'state', state: sound.state() });
    socket.on('message', (data, binary) => {
      if (binary) {
        try { if (!active) throw new Error('请先启动语音采集'); sound.pushAudio(data); }
        catch (error) { send(socket, { type: 'error', error: error.message }); }
        return;
      }
      if (data.length > 4096) { send(socket, { type: 'error', error: '控制消息过长' }); return; }
      let message; try { message = JSON.parse(data.toString()); } catch { send(socket, { type: 'error', error: '无效控制消息' }); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') { send(socket, { type: 'error', error: '无效控制消息' }); return; }
      if (message.type === 'cancel_capture') { sound.cancelCapture('语音采集已暂停，未完成指令已中止'); return; }
      if (queued >= 8) { send(socket, { type: 'error', error: '语音控制请求过多，请稍后再试' }); return; }
      queued++;
      chain = chain.then(async () => {
        if (message.type === 'start') { await sound.start(id); active = true; if (socket.readyState !== WebSocket.OPEN) { active = false; await sound.pause('browser_disconnected'); return; } send(socket, { type: 'ready', state: sound.state() }); }
        else if (message.type === 'pause') { active = false; await sound.pause('user_pause'); send(socket, { type: 'ack', action: 'pause', state: sound.state() }); }
        else throw new Error('仅支持 start / pause，指令采集通过交互键协调');
      }).catch(error => send(socket, { type: 'error', error: error.message })).finally(() => { queued--; });
    });
    socket.on('error', () => {});
    socket.on('close', () => { sound.events.off('change', changed); active = false; if (owner === socket) { owner = undefined; void chain.then(() => sound.pause('browser_disconnected')).catch(() => {}); } });
  });
  return async function dispose() {
    closing = true; server.off('upgrade', upgrade);
    for (const socket of wss.clients) socket.terminate();
    await sound.pause('transport_shutdown');
    await new Promise(resolve => wss.close(resolve));
  };
}
export const attachSound2textWebSocket = mountSound2text;
