(function (root) {
  'use strict';
  /** Streaming windowed-sinc resampler. Keeps filter history across AudioWorklet blocks. */
  class PCMResampler {
    constructor(sourceRate, targetRate = 16000) {
      if (!Number.isFinite(sourceRate) || sourceRate < targetRate || targetRate <= 0) throw new Error('不支持当前麦克风采样率。');
      this.sourceRate = sourceRate; this.targetRate = targetRate;
      this.ratio = sourceRate / targetRate; this.samples = []; this.base = 0; this.position = 0; this.half = 16; this.inputCount = 0; this.outputCount = 0;
    }
    process(input) {
      this.inputCount += input.length;
      if (this.sourceRate === this.targetRate) { this.outputCount += input.length; return Float32Array.from(input); }
      for (const sample of input) this.samples.push(sample);
      const end = this.base + this.samples.length, output = [], cutoff = .45 / this.ratio;
      while (this.position + this.half < end) {
        const center = Math.floor(this.position); let sum = 0, norm = 0;
        for (let index = center - this.half + 1; index <= center + this.half; index++) {
          const distance = index - this.position;
          const x = 2 * cutoff * distance;
          const sinc = Math.abs(x) < 1e-8 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
          const weight = 2 * cutoff * sinc * (.5 + .5 * Math.cos(Math.PI * distance / this.half));
          const sample = index < 0 ? this.samples[0] ?? 0 : this.samples[index - this.base] ?? 0;
          sum += sample * weight; norm += weight;
        }
        output.push(norm ? sum / norm : 0); this.position += this.ratio;
      }
      const drop = Math.max(0, Math.floor(this.position) - this.half - this.base);
      if (drop) { this.samples.splice(0, drop); this.base += drop; }
      this.outputCount += output.length;
      return Float32Array.from(output);
    }
    flush() {
      const missing = Math.max(0, Math.floor(this.inputCount / this.ratio) - this.outputCount);
      if (!missing) return new Float32Array(0);
      const final = this.process(new Float32Array(this.half + Math.ceil(this.ratio)));
      return final.slice(0, missing);
    }
  }
  function pcm16le(samples) {
    const data = new ArrayBuffer(samples.length * 2), view = new DataView(data);
    samples.forEach((value, index) => { const sample = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0)); view.setInt16(index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true); });
    return data;
  }
  class PCMPacketizer {
    constructor(size = 3200) { this.size = size; this.pending = []; }
    push(samples) {
      for (const sample of samples) this.pending.push(sample);
      const packets = [];
      while (this.pending.length >= this.size) packets.push(pcm16le(this.pending.splice(0, this.size)));
      return packets;
    }
    flush() { return this.pending.length ? pcm16le(this.pending.splice(0)) : null; }
  }
  function microphoneError(error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return '麦克风权限未开启，请在浏览器中允许后重试。';
    if (error?.name === 'NotFoundError') return '未找到可用的麦克风。';
    if (error?.name === 'NotReadableError') return '麦克风正被其他应用占用或无法读取。';
    return error?.message || '语音输入启动失败。';
  }
  class AudioCapture {
    constructor({ onStatus = () => {}, onError = () => {}, environment = root } = {}) {
      this.env = environment; this.onStatus = onStatus; this.onError = onError; this.status = 'idle'; this.generation = 0; this.checkpoints = new Map(); this.checkpointId = 0;
    }
    setStatus(value) { this.status = value; this.onStatus(value); }
    async start() {
      if (this.status !== 'idle') return;
      const token = ++this.generation; this.setStatus('connecting');
      try {
        const Context = this.env.AudioContext || this.env.webkitAudioContext;
        if (!Context || !this.env.navigator?.mediaDevices?.getUserMedia || !this.env.AudioWorkletNode) throw new Error('当前浏览器不支持麦克风实时采集，请使用最新版 Chrome 或 Edge。');
        this.context = new Context(); await this.context.resume();
        if (token !== this.generation) return;
        const stream = await this.env.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        if (token !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
        this.media = stream;
        for (const track of stream.getTracks()) track.onended = () => this.fail(new Error('麦克风已断开，当前指令已中止。'));
        const base = String(this.env.mootingBase || '').replace(/\/$/, '');
        await this.context.audioWorklet.addModule(base + '/audio-worklet.js');
        if (token !== this.generation) return;
        const protocol = this.env.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = this.socket = new this.env.WebSocket(protocol + '//' + this.env.location.host + base + '/api/sound2text/audio');
        socket.binaryType = 'arraybuffer';
        await new Promise((resolve, reject) => {
          const timer = this.env.setTimeout(() => reject(new Error('语音识别服务连接超时。')), 10000);
          this.cancelReady = () => { this.env.clearTimeout(timer); reject(new Error('语音输入已取消。')); };
          const finish = (error) => { this.env.clearTimeout(timer); this.cancelReady = undefined; error ? reject(error) : resolve(); };
          socket.onopen = () => socket.send(JSON.stringify({ type: 'start' }));
          socket.onerror = () => finish(new Error('无法连接语音识别服务。'));
          socket.onclose = () => finish(new Error('语音识别连接已关闭。'));
          socket.onmessage = event => {
            let message; try { message = JSON.parse(event.data); } catch { finish(new Error('语音服务返回无效数据。')); return; }
            if (message.type === 'ready') finish();
            else if (message.type === 'error') finish(new Error(message.error || message.message || '语音识别服务不可用。'));
          };
        });
        if (token !== this.generation) return;
        socket.onerror = () => this.fail(new Error('语音识别连接异常，当前指令已中止。'));
        socket.onclose = () => { if (this.status === 'running') this.fail(new Error('语音识别连接中断，当前指令已中止。')); };
        socket.onmessage = event => {
          let message; try { message = JSON.parse(event.data); } catch { this.fail(new Error('语音服务返回无效数据。')); return; }
          if (message.type === 'error') this.fail(new Error(message.error || message.message || '语音识别失败。'));
          else if (message.type === 'state' && ['error', 'stopped', 'paused'].includes(message.state?.status)) this.fail(new Error(message.state.error || '语音服务已停止，当前指令已中止。'));
        };
        this.node = new this.env.AudioWorkletNode(this.context, 'sound2text-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        this.node.port.onmessage = event => {
          if (event.data?.type === 'checkpoint') {
            const entry = this.checkpoints.get(event.data.id);
            if (entry) { this.checkpoints.delete(event.data.id); this.env.clearTimeout(entry.timer); entry.resolve(event.data.audioMs); } return;
          }
          if (this.status !== 'running' || token !== this.generation || !(event.data instanceof ArrayBuffer)) return;
          if (socket.readyState !== 1 || socket.bufferedAmount > 256 * 1024) { this.fail(new Error('语音上传积压或连接断开，当前指令已中止。')); return; }
          socket.send(event.data);
        };
        this.source = this.context.createMediaStreamSource(stream); this.mute = this.context.createGain(); this.mute.gain.value = 0;
        this.source.connect(this.node); this.node.connect(this.mute); this.mute.connect(this.context.destination);
        this.setStatus('running');
      } catch (error) {
        if (token !== this.generation) return;
        await this.cleanup(false); this.setStatus('idle'); throw new Error(microphoneError(error));
      }
    }
    checkpoint() {
      if (this.status !== 'running' || !this.node) return Promise.reject(new Error('麦克风尚未就绪，请稍后重试。'));
      const id = ++this.checkpointId;
      return new Promise((resolve, reject) => {
        const timer = this.env.setTimeout(() => { this.checkpoints.delete(id); reject(new Error('获取语音边界超时，本次未提交。')); }, 1000);
        this.checkpoints.set(id, { resolve, reject, timer }); this.node.port.postMessage({ type: 'checkpoint', id });
      });
    }
    async cleanup(sendPause) {
      for (const entry of this.checkpoints.values()) { this.env.clearTimeout(entry.timer); entry.reject(new Error('语音输入已停止，本次指令已中止。')); }
      this.checkpoints.clear();
      const socket = this.socket; this.socket = undefined;
      if (sendPause && socket?.readyState === 1) socket.send(JSON.stringify({ type: 'cancel_capture' }));
      this.cancelReady?.(); this.cancelReady = undefined;
      for (const track of this.media?.getTracks() ?? []) { track.onended = null; track.stop(); } this.media = undefined;
      if (sendPause && this.node && socket?.readyState === 1) {
        const node = this.node;
        await new Promise(resolve => {
          const timer = this.env.setTimeout(resolve, 200);
          node.port.onmessage = event => {
            if (event.data?.type === 'flushed') { this.env.clearTimeout(timer); resolve(); }
            else if (event.data instanceof ArrayBuffer && socket.readyState === 1 && socket.bufferedAmount < 256 * 1024) socket.send(event.data);
          };
          node.port.postMessage({ type: 'flush' });
        });
      }
      if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); this.node = undefined; }
      this.source?.disconnect(); this.source = undefined; this.mute?.disconnect(); this.mute = undefined;
      const context = this.context; this.context = undefined;
      if (context && context.state !== 'closed') await context.close().catch(() => {});
      if (socket) {
        socket.onerror = null; socket.onmessage = null;
        if (sendPause && socket.readyState === 1) {
          await new Promise(resolve => {
            const timer = this.env.setTimeout(() => { socket.close(); resolve(); }, 3500);
            socket.onclose = () => { this.env.clearTimeout(timer); resolve(); };
            socket.onmessage = event => { try { const value = JSON.parse(event.data); if (['paused', 'stopped'].includes(value.type) || (value.type === 'ack' && value.action === 'pause')) { this.env.clearTimeout(timer); socket.close(); resolve(); } } catch {} };
            socket.send(JSON.stringify({ type: 'pause' }));
          });
        } else { socket.onclose = null; socket.close(); }
      }
    }
    async pause() { if (this.status === 'idle') return; ++this.generation; this.setStatus('stopping'); await this.cleanup(true); this.setStatus('idle'); }
    async fail(error) { if (this.status === 'idle' || this.status === 'stopping') return; ++this.generation; this.setStatus('stopping'); await this.cleanup(false); this.setStatus('idle'); this.onError(microphoneError(error)); }
  }
  root.MootingAudio = { PCMResampler, pcm16le, PCMPacketizer, AudioCapture, microphoneError };
})(globalThis);
