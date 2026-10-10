// G.711 μ-law 编解码：对讲语音 16kHz 单声道，每个采样 1 字节（≈128kbps）。
// 实现简单、零延迟、所有浏览器都能跑，适合按住说话的车队对讲。

const BIAS = 0x84;
const CLIP = 32635;

export function encodeSample(sample) {
  let s = Math.max(-1, Math.min(1, sample)) * 32767;
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s = Math.min(CLIP, s) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const DECODE_TABLE = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let s = ((mantissa << 3) + BIAS) << exponent;
  s -= BIAS;
  DECODE_TABLE[i] = (sign ? -s : s) / 32768;
}

export function encode(float32) {
  const out = new Uint8Array(float32.length);
  for (let i = 0; i < float32.length; i++) out[i] = encodeSample(float32[i]);
  return out;
}

export function decode(bytes) {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = DECODE_TABLE[bytes[i]];
  return out;
}
