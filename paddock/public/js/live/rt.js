// 实况 WebSocket 客户端：自动重连（指数退避），JSON 消息按类型分发，二进制帧为对讲音频。
export class Realtime {
  constructor(eventId, token) {
    this.eventId = eventId;
    this.token = token;
    this.handlers = new Map();
    this.closed = false;
    this.ready = false;
    this.retry = 0;
    this.connect();
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  emit(type, msg) {
    for (const fn of this.handlers.get(type) || []) {
      try {
        fn(msg);
      } catch (e) {
        console.error(e);
      }
    }
  }

  connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: this.token, eventId: this.eventId }));
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.t === 'welcome') {
          this.ready = true;
          this.retry = 0;
          this.emit('status', 'online');
        }
        this.emit(msg.t, msg);
      } else {
        const dv = new DataView(e.data);
        this.emit('voice', { uid: dv.getUint32(0), bytes: new Uint8Array(e.data, 4) });
      }
    };
    ws.onclose = (e) => {
      const wasReady = this.ready;
      this.ready = false;
      if (this.closed) return;
      if (e.code === 4001 || e.code === 4003) {
        this.emit('fatal', e.code);
        return;
      }
      this.emit('status', wasReady ? 'reconnecting' : 'offline');
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {};
  }

  send(msg) {
    if (!this.ready || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  sendBinary(buf) {
    // 网络拥塞时丢弃语音帧，避免积压造成越来越大的延迟
    if (this.ready && this.ws.readyState === 1 && this.ws.bufferedAmount < 32 * 1024) this.ws.send(buf);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }
}
