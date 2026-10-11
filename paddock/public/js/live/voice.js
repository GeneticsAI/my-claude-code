// 车队对讲（按住说话）。
// 采集：麦克风 → AudioWorklet（16kHz μ-law，每帧 40ms）→ WebSocket 二进制帧。
// 播放：按发言人分别排队，留 ~120ms 抖动缓冲，保证连续不卡顿。
import { decode } from '../shared/mulaw.js';

const RATE = 16000;

export class Voice {
  constructor({ send, sendBinary }) {
    this.send = send;
    this.sendBinary = sendBinary;
    this.ctx = null;
    this.node = null;
    this.stream = null;
    this.talking = false;
    this.muted = false;
    this.next = new Map();
  }

  get unlocked() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  get micReady() {
    return !!this.node;
  }

  /** 必须在用户手势（点击/按下）中调用：浏览器只允许这样启动音频。 */
  async unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('当前浏览器不支持语音');
      this.ctx = new AC();
      this.out = this.ctx.createGain();
      this.out.gain.value = 1.4;
      this.out.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  async enableMic() {
    await this.unlock();
    if (this.node) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(window.isSecureContext ? '当前浏览器不支持麦克风' : '对讲说话需要用 https 开头的安全网址打开，现在仍可以收听别人的对讲');
    }
    if (!this.ctx.audioWorklet) throw new Error('当前浏览器不支持实时语音，请升级浏览器');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    await this.ctx.audioWorklet.addModule('/js/live/voice-worklet.js');
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'ptt-capture');
    this.node.port.onmessage = (e) => {
      if (this.talking || e.data.length < 640) this.sendBinary(e.data);
    };
    // worklet 需要接入音频图才会被持续调度；接一个静音增益节点到输出
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    src.connect(this.node).connect(sink).connect(this.ctx.destination);
  }

  startTalk() {
    if (!this.node || this.talking) return;
    this.talking = true;
    this.send({ t: 'ptt', on: true });
    this.node.port.postMessage({ on: true });
    this.beep(880, 0.06);
  }

  stopTalk() {
    if (!this.talking) return;
    this.talking = false;
    this.node.port.postMessage({ on: false });
    // 等最后一帧发出后再通知结束
    setTimeout(() => this.send({ t: 'ptt', on: false }), 80);
    this.beep(620, 0.08);
  }

  play(uid, bytes) {
    if (!this.unlocked || this.muted || !bytes.length) return;
    const pcm = decode(bytes);
    const buf = this.ctx.createBuffer(1, pcm.length, RATE);
    buf.copyToChannel(pcm, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    const now = this.ctx.currentTime;
    let t = this.next.get(uid) ?? 0;
    if (t < now + 0.03) t = now + 0.12;
    src.start(t);
    this.next.set(uid, t + buf.duration);
  }

  /** 对讲机式提示音 */
  beep(freq, dur) {
    if (!this.unlocked) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.08, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start();
    o.stop(this.ctx.currentTime + dur);
  }

  setMuted(m) {
    this.muted = m;
  }

  close() {
    if (this.talking) this.stopTalk();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.node = null;
  }
}
