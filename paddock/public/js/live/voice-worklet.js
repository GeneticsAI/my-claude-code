// 对讲采集（AudioWorklet）：把麦克风音频降采样到 16kHz，编码为 μ-law，每 40ms 发一帧给主线程。
// μ-law 编码与 shared/mulaw.js 相同；这里内联一份，因为部分浏览器的 worklet 不支持 import。
const OUT_RATE = 16000;
const FRAME = 640;

function mulaw(sample) {
  let s = Math.max(-1, Math.min(1, sample)) * 32767;
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s = Math.min(32635, s) + 0x84;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

class PttCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.ratio = sampleRate / OUT_RATE;
    this.phase = 0;
    this.acc = 0;
    this.cnt = 0;
    this.buf = new Uint8Array(FRAME);
    this.n = 0;
    this.port.onmessage = (e) => {
      this.on = !!e.data.on;
      if (!this.on && this.n > 0) {
        this.port.postMessage(this.buf.slice(0, this.n));
        this.n = 0;
      }
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !this.on) return true;
    for (let i = 0; i < ch.length; i++) {
      // 盒式滤波降采样：对每个输出采样窗口内的输入取平均，顺带抑制混叠
      this.acc += ch[i];
      this.cnt++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        const v = this.acc / this.cnt;
        this.acc = 0;
        this.cnt = 0;
        this.buf[this.n++] = mulaw(v);
        if (this.n === FRAME) {
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('ptt-capture', PttCapture);
