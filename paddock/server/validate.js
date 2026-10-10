// 输入校验：所有来自客户端的数据都先过这里，只保留白名单字段。
import { HttpError } from './http.js';

const bad = (msg) => {
  throw new HttpError(400, msg);
};

export function text(v, { name, min = 0, max = 500, required = false } = {}) {
  if (v == null || v === '') {
    if (required || min > 0) bad(`${name}不能为空`);
    return '';
  }
  if (typeof v !== 'string') bad(`${name}格式错误`);
  const s = v.trim();
  if (s.length < min) bad(`${name}至少 ${min} 个字`);
  if (s.length > max) bad(`${name}不能超过 ${max} 个字`);
  return s;
}

export function num(v, { name, min = -Infinity, max = Infinity, int = false } = {}) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) bad(`${name}格式错误`);
  if (int && !Number.isInteger(n)) bad(`${name}必须是整数`);
  if (n < min || n > max) bad(`${name}超出范围`);
  return n;
}

export function id(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, '不存在');
  return n;
}

export const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function point(p, name = '坐标') {
  if (!p || typeof p !== 'object') bad(`${name}格式错误`);
  return { lat: num(p.lat, { name, min: -90, max: 90 }), lng: num(p.lng, { name, min: -180, max: 180 }) };
}

export function line(l, name = '计时线') {
  if (!Array.isArray(l) || l.length !== 2) bad(`${name}需要两个端点`);
  return [point(l[0], name), point(l[1], name)];
}

export function path(p) {
  if (p == null) return null;
  if (!Array.isArray(p) || p.length < 3 || p.length > 5000) bad('赛道路径格式错误');
  return p.map((q) => {
    if (!Array.isArray(q) || q.length !== 2) bad('赛道路径格式错误');
    return [num(q[0], { name: '赛道路径', min: -90, max: 90 }), num(q[1], { name: '赛道路径', min: -180, max: 180 })];
  });
}

export const EVENT_KINDS = ['trackday', 'touring', 'meetup', 'roadtrip'];

/** 圈速上报校验：合理范围 + 分段之和与圈速一致 + 轨迹点数限制。 */
export function lap(b) {
  if (!b || typeof b !== 'object') bad('圈速数据格式错误');
  const lapMs = num(b.lapMs, { name: '圈速', min: 10_000, max: 3_600_000 });
  let sectors = null;
  if (Array.isArray(b.sectors) && b.sectors.length >= 2 && b.sectors.length <= 6) {
    sectors = b.sectors.map((s) => num(s, { name: '分段', min: 500, max: 3_600_000 }));
    const sum = sectors.reduce((a, c) => a + c, 0);
    if (Math.abs(sum - lapMs) > 50) sectors = null;
  }
  const trace = Array.isArray(b.trace) ? b.trace.slice(0, 1200) : [];
  for (const t of trace) {
    if (!Array.isArray(t) || t.length !== 5 || !t.every(isFiniteNum)) bad('圈速轨迹格式错误');
  }
  return {
    lapMs,
    sectors,
    maxSpeed: Math.min(150, num(b.maxSpeed, { name: '极速', min: 0 })),
    avgSpeed: num(b.avgSpeed, { name: '均速', min: 0, max: 150 }),
    distance: num(b.distance, { name: '圈长', min: 50, max: 100_000 }),
    startedAt: num(b.startedAt, { name: '时间', min: 0, int: true }),
    trace,
  };
}

/** 实时位置：只转发白名单字段，丢弃客户端夹带的其他内容。 */
export function loc(b) {
  if (!isFiniteNum(b.lat) || !isFiniteNum(b.lng) || Math.abs(b.lat) > 90 || Math.abs(b.lng) > 180) return null;
  const opt = (v, lo, hi) => (isFiniteNum(v) && v >= lo && v <= hi ? v : null);
  const out = {
    lat: b.lat,
    lng: b.lng,
    spd: opt(b.spd, 0, 150),
    hdg: opt(b.hdg, 0, 360),
    acc: opt(b.acc, 0, 10_000),
    latG: opt(b.latG, -5, 5),
    lonG: opt(b.lonG, -5, 5),
    sim: b.sim === true,
  };
  const l = b.lap;
  if (l && typeof l === 'object') {
    out.lap = {
      n: opt(l.n, 0, 10_000),
      elapsed: opt(l.elapsed, 0, 3_600_000),
      sector: opt(l.sector, 0, 10),
      delta: opt(l.delta, -600_000, 600_000),
      last: opt(l.last, 0, 3_600_000),
      best: opt(l.best, 0, 3_600_000),
    };
  }
  return out;
}
