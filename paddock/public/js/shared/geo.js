// 地理计算工具（浏览器与 Node 共用）。
// 约定：点为 {lat, lng}（WGS-84，GPS 原始坐标）；数据库与接口里一律存 WGS-84，
// 只有在高德等国内底图上显示时才转换为 GCJ-02。

const EARTH_R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** 两点间大圆距离（米）。 */
export function distance(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** a→b 的方位角（度，正北为 0，顺时针）。 */
export function bearing(a, b) {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** 从 p 沿方位角 brg 前进 dist 米后的点。 */
export function destination(p, brg, dist) {
  const d = dist / EARTH_R;
  const t = toRad(brg);
  const lat1 = toRad(p.lat);
  const lng1 = toRad(p.lng);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(t));
  const lng2 =
    lng1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: toDeg(lat2), lng: ((toDeg(lng2) + 540) % 360) - 180 };
}

/** 以 origin 为原点的局部平面坐标（米，x 向东、y 向北）。赛道尺度内误差可忽略。 */
export function toXY(origin, p) {
  return {
    x: toRad(p.lng - origin.lng) * EARTH_R * Math.cos(toRad(origin.lat)),
    y: toRad(p.lat - origin.lat) * EARTH_R,
  };
}

export function fromXY(origin, { x, y }) {
  return {
    lat: origin.lat + toDeg(y / EARTH_R),
    lng: origin.lng + toDeg(x / (EARTH_R * Math.cos(toRad(origin.lat)))),
  };
}

/**
 * 判断移动轨迹 p1→p2 是否穿过计时线 q1–q2。
 * 返回 null 或 { t, dir }：t 为穿越点在 p1→p2 上的比例（用于插值穿越时刻），
 * dir 为穿越方向（+1/-1），用来过滤反向穿越（例如从维修区倒着开过线）。
 */
export function crossLine(p1, p2, q1, q2) {
  const a = toXY(q1, p1);
  const b = toXY(q1, p2);
  const d = toXY(q1, q2);
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const denom = rx * d.y - ry * d.x;
  if (Math.abs(denom) < 1e-9) return null;
  const qpx = -a.x;
  const qpy = -a.y;
  const t = (qpx * d.y - qpy * d.x) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, dir: Math.sign(denom) };
}

/** 线性插值两个点。 */
export function lerpPoint(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

// ---- WGS-84 ↔ GCJ-02（国测局坐标，高德/腾讯底图使用） ----

const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

export function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function tLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return r;
}

function tLng(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return r;
}

export function wgsToGcj(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng];
  let dLat = tLat(lng - 105, lat - 35);
  let dLng = tLng(lng - 105, lat - 35);
  const radLat = toRad(lat);
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sq = Math.sqrt(magic);
  dLat = (dLat * 180) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sq)) * Math.PI);
  dLng = (dLng * 180) / ((GCJ_A / sq) * Math.cos(radLat) * Math.PI);
  return [lat + dLat, lng + dLng];
}

/** GCJ-02 → WGS-84，迭代求逆，误差 < 1e-7 度（约 1 厘米）。 */
export function gcjToWgs(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng];
  let wLat = lat;
  let wLng = lng;
  for (let i = 0; i < 8; i++) {
    const [gLat, gLng] = wgsToGcj(wLat, wLng);
    wLat -= gLat - lat;
    wLng -= gLng - lng;
  }
  return [wLat, wLng];
}
