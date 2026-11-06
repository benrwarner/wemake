// Sample-accurate capture worklet. Reports the exact frame recording started on
// so takes can be placed on the timeline with latency compensation.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options.processorOptions?.channels ?? 1;
    this.recording = false;
    this.reset();
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.reset(); this.recording = true; this.started = false; }
      else if (e.data === 'stop') { this.flush(); this.recording = false; this.port.postMessage({ type: 'done', endFrame: currentFrame }); }
    };
  }
  reset() { this.blocks = []; this.frames = 0; }
  process(inputs) {
    if (!this.recording) return true;
    if (!this.started) { this.started = true; this.port.postMessage({ type: 'start', frame: currentFrame }); }
    const input = inputs[0];
    const block = [];
    for (let c = 0; c < this.channels; c++) block.push(input[c] ? input[c].slice() : input[0] ? input[0].slice() : new Float32Array(128));
    this.blocks.push(block);
    this.frames += block[0].length;
    if (this.frames >= 8192) this.flush();
    return true;
  }
  flush() {
    if (!this.frames) return;
    const out = [];
    for (let c = 0; c < this.channels; c++) {
      const arr = new Float32Array(this.frames);
      let o = 0;
      for (const b of this.blocks) { arr.set(b[c], o); o += b[c].length; }
      out.push(arr);
    }
    this.port.postMessage({ type: 'chunk', data: out }, out.map((a) => a.buffer));
    this.reset();
  }
}
registerProcessor('wemake-recorder', RecorderProcessor);
