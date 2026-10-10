// GPS 圈速计时（浏览器与 Node 共用）。
//
// 原理：每两个相邻 GPS 定位点连成一段轨迹，检测它是否与起终点线 / 分段线相交，
// 按交点在线段上的比例插值出精确的穿越时刻——1Hz 的手机 GPS 也能得到百分之一秒级的圈速。
// 第一次穿越起终点线确定行驶方向，之后反向穿越一律忽略；短于 minLapMs 的“圈”视为抖动。
//
// 圈轨迹 trace 的每个点为 [累计距离m, 圈内用时ms, 速度m/s, lat, lng]，
// 用于实时 Δ（与最佳圈在同一距离处比较用时）和赛后速度曲线对比。

import { crossLine, distance, lerpPoint, bearing } from './geo.js';

export const G = 9.80665;
// 超过此速度（≈430km/h）视为 GPS 跳点，不计入极速
const MAX_PLAUSIBLE_SPEED = 120;

export class LapTimer {
  constructor({ startLine = null, sectorLines = [], minLapMs = 20000 } = {}) {
    this.minLapMs = minLapMs;
    this.best = null;
    this.last = null;
    this.bestSectors = [];
    this.lapNo = 0;
    this.setLines(startLine, sectorLines);
  }

  /** 更换计时线（组织者修改赛道时调用），会丢弃当前未完成的圈。 */
  setLines(startLine, sectorLines = []) {
    this.startLine = startLine && startLine.length === 2 ? startLine : null;
    this.sectorLines = (sectorLines || []).filter((l) => l && l.length === 2);
    this.dir = null;
    this.prev = null;
    this.prevSpeed = 0;
    this._resetLap(null);
  }

  /** 设定参考最佳圈（例如从服务器取回的历史最佳），用于计算实时 Δ。 */
  setBest(lap) {
    if (lap && lap.trace && lap.trace.length > 1) this.best = lap;
  }

  _resetLap(startTs, point = null, speed = 0) {
    this.lapStart = startTs;
    this.sectorIdx = 0;
    this.sectorStart = startTs;
    this.sectors = [];
    this.dist = 0;
    this.maxSpeed = speed;
    this.trace = startTs == null ? [] : [[0, 0, speed, point.lat, point.lng]];
  }

  get running() {
    return this.lapStart != null;
  }

  /**
   * 输入一个定位点 {lat, lng, ts, spd?}，返回本次触发的事件数组：
   * {type:'lapStart'} | {type:'sector', idx, ms} | {type:'lap', lap}
   */
  push(fix) {
    const events = [];
    if (!this.startLine) {
      this.prev = fix;
      return events;
    }
    const prev = this.prev;
    this.prev = fix;
    if (!prev) return events;
    const dt = fix.ts - prev.ts;
    if (dt <= 0) {
      this.prev = prev;
      return events;
    }
    const segLen = distance(prev, fix);
    const raw = Number.isFinite(fix.spd) && fix.spd >= 0 ? fix.spd : segLen / (dt / 1000);
    const speed = raw > MAX_PLAUSIBLE_SPEED ? this.prevSpeed : raw;
    const prevSpeed = this.prevSpeed;
    this.prevSpeed = speed;

    const crossings = [];
    const sc = crossLine(prev, fix, this.startLine[0], this.startLine[1]);
    if (sc && (this.dir === null || sc.dir === this.dir)) crossings.push({ kind: 'start', t: sc.t, dir: sc.dir });
    if (this.running && this.sectorIdx < this.sectorLines.length) {
      const line = this.sectorLines[this.sectorIdx];
      const c = crossLine(prev, fix, line[0], line[1]);
      if (c) crossings.push({ kind: 'sector', t: c.t });
    }
    crossings.sort((a, b) => a.t - b.t);

    let lastT = 0;
    for (const cr of crossings) {
      const tc = prev.ts + cr.t * dt;
      const point = lerpPoint(prev, fix, cr.t);
      const v = prevSpeed + (speed - prevSpeed) * cr.t;
      if (this.running) this.dist += segLen * (cr.t - lastT);
      lastT = cr.t;

      if (cr.kind === 'sector') {
        if (!this.running) continue;
        const ms = tc - this.sectorStart;
        this.sectors.push(ms);
        this.sectorStart = tc;
        events.push({ type: 'sector', idx: this.sectorIdx, ms });
        this.sectorIdx++;
        continue;
      }

      if (this.dir === null) this.dir = cr.dir;
      if (this.running) {
        const lapMs = tc - this.lapStart;
        if (lapMs < this.minLapMs) continue;
        this.sectors.push(tc - this.sectorStart);
        this.trace.push([this.dist, lapMs, v, point.lat, point.lng]);
        this.maxSpeed = Math.max(this.maxSpeed, v);
        const complete = this.sectorLines.length > 0 && this.sectors.length === this.sectorLines.length + 1;
        const lap = {
          n: this.lapNo,
          lapMs,
          sectors: complete ? this.sectors : null,
          maxSpeed: this.maxSpeed,
          avgSpeed: this.dist / (lapMs / 1000),
          distance: this.dist,
          startedAt: Math.round(this.lapStart),
          trace: this.trace,
        };
        this._recordLap(lap);
        events.push({ type: 'lap', lap });
      } else {
        events.push({ type: 'lapStart' });
      }
      this.lapNo++;
      this._resetLap(tc, point, v);
    }

    if (this.running) {
      this.dist += segLen * (1 - lastT);
      this.maxSpeed = Math.max(this.maxSpeed, speed);
      this.trace.push([this.dist, fix.ts - this.lapStart, speed, fix.lat, fix.lng]);
    }
    return events;
  }

  _recordLap(lap) {
    this.last = lap;
    if (!this.best || lap.lapMs < this.best.lapMs) this.best = lap;
    if (lap.sectors) {
      lap.sectors.forEach((ms, i) => {
        if (this.bestSectors[i] == null || ms < this.bestSectors[i]) this.bestSectors[i] = ms;
      });
    }
  }

  /** 当前圈相对最佳圈的实时差值（ms，负数=更快）。 */
  delta() {
    if (!this.running || !this.best || this.trace.length < 2) return null;
    const ref = timeAtDistance(this.best.trace, this.dist);
    if (ref == null) return null;
    const cur = this.trace[this.trace.length - 1][1];
    return cur - ref;
  }

  /** 供 HUD / 广播使用的当前状态快照。 */
  status(now) {
    return {
      lapNo: this.lapNo,
      running: this.running,
      elapsed: this.running ? now - this.lapStart : null,
      sector: this.running ? this.sectorIdx + 1 : null,
      delta: this.delta(),
      last: this.last ? this.last.lapMs : null,
      best: this.best ? this.best.lapMs : null,
    };
  }
}

/** 在圈轨迹里按距离插值出用时；超出范围返回 null。 */
export function timeAtDistance(trace, d) {
  if (!trace || trace.length < 2 || d < 0 || d > trace[trace.length - 1][0]) return null;
  let lo = 0;
  let hi = trace.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (trace[mid][0] <= d) lo = mid;
    else hi = mid;
  }
  const [d0, t0] = trace[lo];
  const [d1, t1] = trace[hi];
  if (d1 === d0) return t0;
  return t0 + ((t1 - t0) * (d - d0)) / (d1 - d0);
}

/** 均匀抽稀轨迹到最多 max 个点（保留首尾），并把数值四舍五入以减小体积。 */
export function compactTrace(trace, max = 600) {
  let out = trace;
  if (trace.length > max) {
    out = [];
    const step = (trace.length - 1) / (max - 1);
    for (let i = 0; i < max; i++) out.push(trace[Math.round(i * step)]);
  }
  return out.map(([d, t, v, lat, lng]) => [
    Math.round(d * 10) / 10,
    Math.round(t),
    Math.round(v * 100) / 100,
    Math.round(lat * 1e6) / 1e6,
    Math.round(lng * 1e6) / 1e6,
  ]);
}

/**
 * 由 GPS 推算纵向 / 横向加速度（G）。
 * 纵向 = 速度变化率，横向 = 速度 × 航向角速度；做指数平滑以压低 GPS 噪声。
 */
export class MotionEstimator {
  constructor(alpha = 0.35) {
    this.alpha = alpha;
    this.prev = null;
    this.prevV = null;
    this.prevHdg = null;
    this.lonG = 0;
    this.latG = 0;
  }

  push(fix) {
    const prev = this.prev;
    this.prev = fix;
    if (!prev) return { lonG: 0, latG: 0 };
    const dt = (fix.ts - prev.ts) / 1000;
    if (dt <= 0 || dt > 5) {
      this.prevV = null;
      this.prevHdg = null;
      return { lonG: this.lonG, latG: this.latG };
    }
    const seg = distance(prev, fix);
    const v = Number.isFinite(fix.spd) ? fix.spd : seg / dt;
    const v0 = this.prevV ?? v;
    this.prevV = v;
    let lon = (v - v0) / dt / G;
    let lat = 0;
    if (v > 3 && seg > 0.5) {
      const hdg = Number.isFinite(fix.hdg) ? fix.hdg : bearing(prev, fix);
      if (this.prevHdg != null) {
        const dh = ((hdg - this.prevHdg + 540) % 360) - 180;
        lat = (v * ((dh * Math.PI) / 180)) / dt / G;
      }
      this.prevHdg = hdg;
    } else {
      this.prevHdg = null;
    }
    lon = Math.max(-3, Math.min(3, lon));
    lat = Math.max(-3, Math.min(3, lat));
    this.lonG += this.alpha * (lon - this.lonG);
    this.latG += this.alpha * (lat - this.latG);
    return { lonG: this.lonG, latG: this.latG };
  }
}
