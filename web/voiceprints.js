(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const local = location.hostname === '127.0.0.1' || location.hostname === 'localhost' || location.hostname === '[::1]';
  const base = String(root.mootingBase || '').replace(/\/$/, '');
  const api = path => base + path;
  let items = [], canRegister = true, clip = null, recording = null, clockTimer = 0;
  function status(message, error = false) {
    const node = $('voiceprint-status');
    node.textContent = message || '';
    node.classList.toggle('error', error);
  }
  async function request(path, body) {
    const response = await fetch(api(path), { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 401) { location.assign(api('/login')); throw new Error('请先登录'); }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '请求失败');
    return payload;
  }
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取音频失败'));
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.readAsDataURL(file);
    });
  }
  function wavBase64(samples, rate) {
    const data = samples.length * 2;
    const buffer = new ArrayBuffer(44 + data);
    const view = new DataView(buffer);
    const write = (offset, text) => { for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index)); };
    write(0, 'RIFF'); view.setUint32(4, 36 + data, true); write(8, 'WAVE'); write(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    write(36, 'data'); view.setUint32(40, data, true);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
  }
  function downsample(input, inputRate, outputRate) {
    if (inputRate === outputRate) return input;
    const ratio = inputRate / outputRate;
    const length = Math.floor(input.length / ratio);
    const output = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      const position = index * ratio;
      const left = Math.floor(position);
      const fraction = position - left;
      const a = input[left] ?? 0;
      const b = input[Math.min(left + 1, input.length - 1)] ?? a;
      output[index] = a + (b - a) * fraction;
    }
    return output;
  }
  function payloadFromClip(name) {
    if (clip) return { name, audioBase64: clip.audioBase64, filename: clip.filename };
    const audioUrl = $('voiceprint-url').value.trim();
    if (!audioUrl) throw new Error(local ? '请填写公网音频 URL' : '请先录音、上传音频，或填写公网音频 URL');
    return { name, audioUrl };
  }
  function render() {
    $('voiceprint-count').textContent = `${items.length} / 50`;
    $('voiceprint-submit').disabled = !canRegister;
    $('voiceprint-name').disabled = !canRegister;
    const list = $('voiceprint-list');
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = '还没有声纹';
      list.append(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement('li');
      row.className = 'voiceprint-row';
      const name = document.createElement('input');
      name.type = 'text'; name.maxLength = 32; name.value = item.name;
      const id = document.createElement('div');
      id.className = 'voiceprint-id'; id.textContent = item.id;
      const actions = document.createElement('div');
      actions.className = 'voiceprint-actions';
      const rename = document.createElement('button');
      rename.type = 'button'; rename.textContent = '改名';
      rename.addEventListener('click', async () => {
        try { status('正在改名…'); await request('/api/voiceprints/rename', { id: item.id, name: name.value.trim() }); status('已改名'); await load(); }
        catch (error) { status(error.message, true); }
      });
      const replace = document.createElement('button');
      replace.type = 'button'; replace.textContent = '更换音频';
      replace.addEventListener('click', async () => {
        try { status('正在更换音频…'); await request('/api/voiceprints/replace', { id: item.id, ...payloadFromClip(name.value.trim()) }); clip = null; status('已更换音频'); await load(); }
        catch (error) { status(error.message, true); }
      });
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = '删除';
      remove.addEventListener('click', async () => {
        if (!window.confirm(`删除声纹「${item.name || item.id}」？`)) return;
        try { status('正在删除…'); await request('/api/voiceprints/delete', { id: item.id }); status('已删除'); await load(); }
        catch (error) { status(error.message, true); }
      });
      actions.append(rename, replace, remove);
      row.append(name, id, actions);
      list.append(row);
    }
  }
  async function load() {
    const result = await request('/api/voiceprints');
    items = Array.isArray(result.items) ? result.items : [];
    canRegister = result.canRegister !== false && items.length < 50;
    render();
    if (!canRegister) status('声纹已达到 50 条上限。删除一些之后才能再注册。');
  }
  function stopClock() { clearInterval(clockTimer); clockTimer = 0; }
  async function stopRecording() {
    if (!recording) return;
    const current = recording; recording = null;
    const rate = current.context.sampleRate;
    current.node.disconnect(); current.source.disconnect();
    current.stream.getTracks().forEach(track => track.stop());
    await current.context.close();
    stopClock();
    $('voiceprint-record').textContent = '开始录音';
    const input = new Float32Array(current.chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of current.chunks) { input.set(chunk, offset); offset += chunk.length; }
    const samples = downsample(input, rate, 16000);
    const seconds = samples.length / 16000;
    if (seconds < 5 || seconds > 30) { clip = null; $('voiceprint-clock').textContent = '未录音'; throw new Error('录音需要 5–30 秒'); }
    clip = { audioBase64: wavBase64(samples, 16000), filename: 'voice.wav' };
    $('voiceprint-url').value = '';
    $('voiceprint-file').value = '';
    $('voiceprint-clock').textContent = `已录制 ${seconds.toFixed(1)} 秒`;
  }
  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) throw new Error('当前浏览器不能录音，请上传音频或填写公网 URL');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    const context = new AudioContext();
    await context.audioWorklet.addModule(api('/voiceprint-worklet.js'));
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'voiceprint-capture');
    const chunks = [];
    const started = performance.now();
    node.port.onmessage = event => { if (event.data instanceof Float32Array) chunks.push(event.data); };
    source.connect(node);
    recording = { stream, context, source, node, chunks, started };
    $('voiceprint-record').textContent = '停止录音';
    clockTimer = setInterval(() => {
      const seconds = (performance.now() - started) / 1000;
      $('voiceprint-clock').textContent = `录音中 ${seconds.toFixed(1)} 秒`;
      if (seconds >= 30) stopRecording().catch(error => status(error.message, true));
    }, 200);
  }
  $('voiceprint-local').hidden = !local;
  $('voiceprint-capture').hidden = local;
  $('voiceprint-record').addEventListener('click', async () => {
    try {
      status('');
      if (recording) await stopRecording();
      else await startRecording();
    } catch (error) { status(error.message, true); }
  });
  $('voiceprint-file').addEventListener('change', async () => {
    const file = $('voiceprint-file').files?.[0];
    if (!file) return;
    try {
      if (recording) await stopRecording();
      clip = { audioBase64: await fileToBase64(file), filename: file.name || 'voice.wav' };
      $('voiceprint-url').value = '';
      $('voiceprint-clock').textContent = file.name;
      status('');
    } catch (error) { clip = null; status(error.message, true); }
  });
  $('voiceprint-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!canRegister) return;
    try {
      status('正在注册…');
      await request('/api/voiceprints/register', payloadFromClip($('voiceprint-name').value.trim()));
      clip = null; $('voiceprint-name').value = ''; $('voiceprint-url').value = ''; $('voiceprint-file').value = ''; $('voiceprint-clock').textContent = '未录音';
      status('已注册');
      await load();
    } catch (error) { status(error.message, true); }
  });
  document.addEventListener('voiceprints-refresh', () => { load().catch(error => status(error.message, true)); });
  load().catch(error => status(error.message, true));
}(window));
