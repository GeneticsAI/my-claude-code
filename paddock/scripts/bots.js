// 模拟车手：通过与真实 App 完全相同的 WebSocket 协议上报位置、圈速、群聊。
// 用于演示（npm run demo）和压测/联调（npm run simulate）。
import WebSocket from 'ws';
import { LapTimer, MotionEstimator, compactTrace } from '../public/js/shared/laptimer.js';
import { SimDriver, circuitForEvent } from '../public/js/shared/track.js';

const CHAT = [
  'T1 刹车点比上节晚了 10 米，爽',
  '后直道有点顺风',
  '轮胎温度上来了，准备推一圈',
  '谁在我后面？跟得很紧啊',
  '下一节换我领跑',
  '出弯油门早了一点，有点推头',
  '这圈有车慢，下一圈再冲',
  '胎压降到 2.1 感觉好多了',
  '午饭去哪吃？',
];

export class Bot {
  constructor({ base, token, user, eventId, skill = 0.93, startOffset = 0, chatty = true, hz = 2 }) {
    this.base = base;
    this.token = token;
    this.user = user;
    this.eventId = eventId;
    this.skill = skill;
    this.startOffset = startOffset;
    this.chatty = chatty;
    this.dt = 1000 / hz;
    this.stopped = false;
  }

  start() {
    this.connect();
    return this;
  }

  connect() {
    const ws = new WebSocket(this.base.replace(/^http/, 'ws') + '/ws');
    this.ws = ws;
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token: this.token, eventId: this.eventId })));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      if (msg.t === 'welcome') this.onTrack(msg.track, true);
      else if (msg.t === 'track') this.onTrack(msg.track, false);
    });
    ws.on('close', () => {
      clearInterval(this.loop);
      clearTimeout(this.chatTimer);
      if (!this.stopped) setTimeout(() => this.connect(), 2000);
    });
    ws.on('error', () => {});
  }

  onTrack(track, first) {
    if (!first && JSON.stringify(track) === JSON.stringify(this.track)) return;
    this.track = track;
    if (!track.startLine && !track.path) return; // 没有赛道可跑
    const path = circuitForEvent(track);
    this.sim = new SimDriver(path, { skill: this.skill, noise: 1.2, startOffset: this.startOffset, seed: this.user.id * 7919 });
    this.timer = new LapTimer({ startLine: track.startLine, sectorLines: track.sectorLines || [] });
    this.motion = new MotionEstimator();
    clearInterval(this.loop);
    this.loop = setInterval(() => this.tick(), this.dt);
    if (this.chatty && first) this.scheduleChat();
  }

  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  tick() {
    const fix = this.sim.step(this.dt, Date.now());
    const g = this.motion.push(fix);
    for (const e of this.timer.push(fix)) {
      if (e.type !== 'lap') continue;
      const l = e.lap;
      this.send({
        t: 'lap', ref: `${l.startedAt}`, n: l.n, lapMs: l.lapMs, sectors: l.sectors, maxSpeed: l.maxSpeed,
        avgSpeed: l.avgSpeed, distance: l.distance, startedAt: l.startedAt, trace: compactTrace(l.trace),
      });
    }
    const st = this.timer.status(fix.ts);
    this.send({
      t: 'loc', lat: fix.lat, lng: fix.lng, spd: fix.spd, hdg: fix.hdg, acc: fix.acc, latG: g.latG, lonG: g.lonG, sim: true,
      lap: { n: st.running ? st.lapNo : null, elapsed: st.elapsed, sector: st.sector, delta: st.delta, last: st.last, best: st.best },
    });
  }

  scheduleChat() {
    this.chatTimer = setTimeout(() => {
      this.send({ t: 'chat', text: CHAT[Math.floor(Math.random() * CHAT.length)] });
      this.scheduleChat();
    }, 60_000 + Math.random() * 120_000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.loop);
    clearTimeout(this.chatTimer);
    this.send({ t: 'stop' });
    this.ws?.close();
  }
}
