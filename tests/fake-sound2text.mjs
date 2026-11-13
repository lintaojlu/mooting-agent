import { EventEmitter } from 'node:events';

/** Explicit test fixture only; production always mounts the Volcengine-backed service. */
export class FakeSound2text {
  events = new EventEmitter();
  value = { configured: true, status: 'running', text: '测试识别文本', capture: { status: 'idle' }, audioMs: 0 };
  state() { return structuredClone(this.value); }
  subscribe(listener) { this.events.on('change', listener); return () => this.events.off('change', listener); }
  update(change) { Object.assign(this.value, change); this.events.emit('change', this.state()); }
  armCapture() { this.update({ capture: { status: 'listening' } }); }
  finishCapture() { this.update({ capture: { status: 'finishing' } }); }
  cancelCapture(reason) { this.update({ capture: { status: 'idle', reason } }); }
  commit(text) { this.update({ capture: { status: 'idle' } }); this.events.emit('instruction', { text, id: 'fixture-utterance' }); }
  async pause() { this.cancelCapture('paused'); this.update({ status: 'stopped' }); }
}
