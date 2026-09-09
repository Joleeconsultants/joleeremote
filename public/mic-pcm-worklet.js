// Original Jolee PCM uplink. Microphone samples never reach the output channels.
class JoleeMicPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 24000; this.remaining = this.ratio; this.sum = 0;
    this.block = new ArrayBuffer(2400); this.view = new DataView(this.block);
    this.count = 0; this.sequence = 0; this.pending = null;
    this.port.onmessage = event => { if (event.data?.ack === this.pending) this.pending = null; };
  }
  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channels = inputs[0];
    if (!channels?.length || !channels[0]?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] || 0;
      value /= channels.length;
      let weight = 1;
      // Weighted resampling preserves fractional positions across render quanta.
      while (weight > 1e-9) {
        const take = Math.min(weight, this.remaining);
        this.sum += value * take; this.remaining -= take; weight -= take;
        if (this.remaining < 1e-9) {
          const sample = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.view.setInt16(this.count++ * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
          this.sum = 0; this.remaining = this.ratio;
          if (this.count === 1200) {
            const sequence = this.sequence++;
            if (this.pending === null) {
              this.pending = sequence;
              this.port.postMessage({ buffer: this.block, sequence }, [this.block]);
              this.block = new ArrayBuffer(2400); this.view = new DataView(this.block);
            }
            this.count = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor('jolee-mic-pcm', JoleeMicPcm);
