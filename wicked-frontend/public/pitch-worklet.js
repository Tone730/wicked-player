/* Wicked Player — granular pitch shifter (AudioWorklet, audio-thread only) */
class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.WIN = 16384;            // power of two
    this.MASK = this.WIN - 1;
    this.ring = new Float32Array(this.WIN);
    this.w = 0;
    this.delay = this.WIN / 2;
  }
  interp(buf, pos) {
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const i0 = ((idx % this.WIN) + this.WIN) % this.WIN;
    const i1 = (i0 + 1) & this.MASK;
    return buf[i0] * (1 - frac) + buf[i1] * frac;
  }
  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;
    const inp = input[0], out = output[0];
    const s = params.ratio[0], dd = 1 - s;
    const WIN = this.WIN, MASK = this.MASK, ring = this.ring;
    let w = this.w, delay = this.delay;
    for (let i = 0; i < inp.length; i++) {
      ring[w & MASK] = inp[i]; w++;
      delay += dd; delay -= Math.floor(delay / WIN) * WIN;
      const dA = delay, dB = (dA + WIN / 2) % WIN;
      const s1 = this.interp(ring, w - 1 - dA);
      const s2 = this.interp(ring, w - 1 - dB);
      const w1 = Math.sin(Math.PI * (dA / WIN));
      const w2 = Math.sin(Math.PI * (dB / WIN));
      out[i] = (s1 * w1 + s2 * w2) / Math.max(0.3, w1 + w2);
    }
    this.w = w; this.delay = delay;
    return true;
  }
}
registerProcessor('pitch-shift', PitchProcessor);