import './audio-capture.js';

class Sound2TextPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new globalThis.MootingAudio.PCMResampler(sampleRate, 16000);
    this.packetizer = new globalThis.MootingAudio.PCMPacketizer(3200);
    this.ended = false;
    this.port.onmessage = event => {
      if (event.data?.type === 'checkpoint' && !this.ended) {
        const packet = this.packetizer.flush(); if (packet) this.port.postMessage(packet, [packet]);
        const audioMs = Math.floor(this.resampler.inputCount / this.resampler.ratio) / 16;
        this.port.postMessage({ type: 'checkpoint', id: event.data.id, audioMs }); return;
      }
      if (event.data?.type !== 'flush' || this.ended) return;
      this.ended = true;
      for (const packet of this.packetizer.push(this.resampler.flush())) this.port.postMessage(packet, [packet]);
      const tail = this.packetizer.flush(); if (tail) this.port.postMessage(tail, [tail]);
      this.port.postMessage({ type: 'flushed' });
    };
  }
  process(inputs, outputs) {
    const channels = inputs[0];
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.ended || !channels?.length || !channels[0]?.length) return true;
    const mono = new Float32Array(channels[0].length);
    for (const channel of channels) for (let index = 0; index < mono.length; index++) mono[index] += channel[index] / channels.length;
    for (const packet of this.packetizer.push(this.resampler.process(mono))) this.port.postMessage(packet, [packet]);
    return true;
  }
}
registerProcessor('sound2text-pcm', Sound2TextPCMProcessor);
