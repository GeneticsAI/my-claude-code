// 演示赛道与模拟驾驶（浏览器与 Node 共用）。
// 没有真车也能完整体验：按赛道曲率算出过弯极限速度，再做加速/刹车约束，
// 得到接近真实的速度曲线；SimDriver 沿赛道“开车”并产出与真实 GPS 相同格式的定位点。

import { bearing, destination, distance, fromXY, toXY } from './geo.js';
import { G } from './laptimer.js';

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 生成一条封闭赛道（[[lat,lng],...]），第 0 个点位于 anchor，且在该点的行驶方向为 heading（度）。
 * 做法：绕圆随机撒控制点（部分向内收形成发卡弯），用向心 Catmull-Rom 样条连成平滑闭环，
 * 再按 8m 间距重采样，并把起点挪到最长的直道上。size=1 时一圈约 3.5–4.5km。
 */
export function generateCircuit({ anchor, heading = 90, size = 1, seed = 6 }) {
  const rand = rng(seed);
  const base = 520 * size;
  const K = 16;
  const ctrl = [];
  for (let k = 0; k < K; k++) {
    const th = (k / K) * Math.PI * 2 + (rand() - 0.5) * 0.3;
    let r = base * (0.55 + rand() * 0.5);
    if (rand() < 0.4) r *= 0.45;
    ctrl.push({ x: r * Math.cos(th) * 1.5, y: r * Math.sin(th) });
  }
  const dense = [];
  for (let i = 0; i < K; i++) {
    const p0 = ctrl[(i - 1 + K) % K];
    const p1 = ctrl[i];
    const p2 = ctrl[(i + 1) % K];
    const p3 = ctrl[(i + 2) % K];
    for (let j = 0; j < 60; j++) dense.push(catmullRom(p0, p1, p2, p3, j / 60));
  }
  const pts = resample(dense, 8);
  const n = pts.length;
  // 起点选在“前后 120m 内曲率总和最小”的位置，即最长直道中段
  const curv = curvatures(pts);
  const win = 15;
  let bestI = 0;
  let bestSum = Infinity;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = -win; j <= win; j++) sum += curv[(i + j + n) % n];
    if (sum < bestSum) {
      bestSum = sum;
      bestI = i;
    }
  }
  const raw = pts.slice(bestI).concat(pts.slice(0, bestI));
  // 平移旋转：让第 0 点落在原点，切线方向对准 heading
  const p0 = raw[0];
  const tx = raw[1].x - raw[n - 1].x;
  const ty = raw[1].y - raw[n - 1].y;
  const want = ((90 - heading) * Math.PI) / 180;
  const rot = want - Math.atan2(ty, tx);
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return raw.map(({ x, y }) => {
    const dx = x - p0.x;
    const dy = y - p0.y;
    const ll = fromXY(anchor, { x: dx * c - dy * s, y: dx * s + dy * c });
    return [round6(ll.lat), round6(ll.lng)];
  });
}

function catmullRom(p0, p1, p2, p3, t) {
  const knot = (a, b) => Math.max(Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)), 1e-6);
  const t1 = knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const tt = t1 + (t2 - t1) * t;
  const mix = (a, b, ta, tb) => {
    const f = (tt - ta) / (tb - ta);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  };
  const a1 = mix(p0, p1, 0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, 0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

function resample(pts, spacing) {
  const out = [pts[0]];
  let carry = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    let d = spacing - carry;
    while (d <= seg) {
      const f = d / seg;
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      d += spacing;
    }
    carry = seg - (d - spacing);
  }
  if (Math.hypot(out[out.length - 1].x - out[0].x, out[out.length - 1].y - out[0].y) < spacing / 2) out.pop();
  return out;
}

/** 闭合折线每个点的曲率（1/m），用前后各 k 个点的航向变化 / 弧长估计。 */
function curvatures(xy, k = 3) {
  const n = xy.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = xy[(i - k + n) % n];
    const b = xy[i];
    const c = xy[(i + k) % n];
    const h1 = Math.atan2(b.y - a.y, b.x - a.x);
    const h2 = Math.atan2(c.y - b.y, c.x - b.x);
    let dh = Math.abs(h2 - h1);
    if (dh > Math.PI) dh = 2 * Math.PI - dh;
    const arc = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y);
    out[i] = dh / Math.max(arc, 1e-6);
  }
  return out;
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

/** 在赛道 path 的 frac（0~1）位置生成一条横跨赛道的计时线。 */
export function lineAcross(path, frac = 0, width = 44) {
  const prep = prepareCircuit(path);
  const s = frac * prep.length;
  const p = prep.pointAt(s);
  const ahead = prep.pointAt(s + 5);
  const h = bearing(p, ahead);
  const a = destination(p, h - 90, width / 2);
  const b = destination(p, h + 90, width / 2);
  return [roundPt(a), roundPt(b)];
}

const roundPt = (p) => ({ lat: round6(p.lat), lng: round6(p.lng) });

/** 一键生成：赛道 + 起终点线 + 两条分段线（三个计时段）。 */
export function demoTrack(anchor, opts = {}) {
  const path = generateCircuit({ anchor, ...opts });
  return {
    path,
    startLine: lineAcross(path, 0),
    sectorLines: [lineAcross(path, 0.34), lineAcross(path, 0.68)],
  };
}

/**
 * 预处理赛道：累计距离 + 速度曲线（默认参数接近街道胎跑车的业余赛道日水平）。
 * vProfile 由曲率限速（横向 aLat）→ 反向刹车约束 → 正向加速约束 三步得到。
 */
export function prepareCircuit(path, { vMax = 66, aLat = 1.15 * G, aAcc = 0.45 * G, aBrake = 1.1 * G } = {}) {
  const pts = path.map(([lat, lng]) => ({ lat, lng }));
  const n = pts.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + distance(pts[i], pts[(i + 1) % n]);
  const length = cum[n];

  const origin = pts[0];
  const curv = curvatures(pts.map((p) => toXY(origin, p)));
  const vLim = new Float64Array(n);
  for (let i = 0; i < n; i++) vLim[i] = curv[i] > 1e-6 ? Math.min(vMax, Math.sqrt(aLat / curv[i])) : vMax;
  const v = Float64Array.from(vLim);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 2 * n - 1; j >= 0; j--) {
      const i = j % n;
      const nx = (i + 1) % n;
      const ds = cum[i + 1] - cum[i];
      v[i] = Math.min(v[i], Math.sqrt(v[nx] * v[nx] + 2 * aBrake * ds));
    }
    for (let j = 0; j < 2 * n; j++) {
      const i = j % n;
      const pv = (i - 1 + n) % n;
      const ds = cum[pv + 1] - cum[pv];
      v[i] = Math.min(v[i], Math.sqrt(v[pv] * v[pv] + 2 * aAcc * ds));
    }
  }

  function locate(s) {
    s = ((s % length) + length) % length;
    let lo = 0;
    let hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const f = (s - cum[lo]) / Math.max(cum[lo + 1] - cum[lo], 1e-9);
    return { i: lo, f };
  }

  return {
    length,
    pointAt(s) {
      const { i, f } = locate(s);
      const a = pts[i];
      const b = pts[(i + 1) % n];
      return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
    },
    speedAt(s) {
      const { i, f } = locate(s);
      return v[i] + (v[(i + 1) % n] - v[i]) * f;
    },
  };
}

/**
 * 模拟车手：沿赛道行驶，每圈节奏随机浮动，可叠加 GPS 噪声。
 * step(dtMs, ts) 返回 {lat, lng, spd, hdg, acc, ts}。
 */
export class SimDriver {
  constructor(path, { skill = 1, startOffset = 0, noise = 0, seed = 1, consistency = 0.015 } = {}) {
    this.track = prepareCircuit(path);
    this.skill = skill;
    this.noise = noise;
    this.consistency = consistency;
    this.rand = rng(seed);
    this.s = startOffset;
    this.lap = Math.floor(startOffset / this.track.length);
    this.pace = this._newPace();
  }

  _newPace() {
    return this.skill * (1 + (this.rand() - 0.5) * 2 * this.consistency);
  }

  step(dtMs, ts = Date.now()) {
    // 以 50ms 子步长积分，保证车辆运动与采样频率无关（1Hz 与 10Hz 采样看到的是同一条轨迹）
    for (let left = dtMs; left > 0; left -= 50) {
      const h = Math.min(50, left);
      this.s += (this.track.speedAt(this.s) * this.pace * h) / 1000;
      const lap = Math.floor(this.s / this.track.length);
      if (lap !== this.lap) {
        this.lap = lap;
        this.pace = this._newPace();
      }
    }
    const v = this.track.speedAt(this.s) * this.pace;
    const exact = this.track.pointAt(this.s);
    // 航向取自无噪声轨迹（真实 GPS 的航向来自多普勒测速，同样比位置平滑）
    const hdg = bearing(exact, this.track.pointAt(this.s + 4));
    const p = this.noise > 0 ? destination(exact, this.rand() * 360, this.rand() * this.noise) : exact;
    return { lat: p.lat, lng: p.lng, spd: v, hdg, acc: this.noise || 3, ts };
  }
}

/** 根据活动的赛道配置得到可供模拟驾驶的路径；没有赛道时围绕起终点线 / 集合点生成一条。 */
export function circuitForEvent(ev) {
  if (ev.path && ev.path.length > 10) return ev.path;
  if (ev.startLine) {
    const [a, b] = ev.startLine;
    const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
    return generateCircuit({ anchor: mid, heading: (bearing(a, b) + 90) % 360 });
  }
  return generateCircuit({ anchor: { lat: ev.lat, lng: ev.lng }, heading: 90 });
}
