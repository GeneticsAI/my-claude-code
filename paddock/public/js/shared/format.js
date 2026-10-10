// 计时与数值格式化（浏览器与 Node 共用）。

/** 圈速 83456 → "1:23.456" */
export function fmtLap(ms) {
  if (ms == null || !Number.isFinite(ms)) return '-:--.---';
  const total = Math.round(ms);
  const m = Math.floor(total / 60000);
  const s = ((total % 60000) / 1000).toFixed(3).padStart(6, '0');
  return `${m}:${s}`;
}

/** 分段时间 31234 → "31.234"，超过一分钟用 fmtLap。 */
export function fmtSector(ms) {
  if (ms == null || !Number.isFinite(ms)) return '--.---';
  return ms >= 60000 ? fmtLap(ms) : (ms / 1000).toFixed(3);
}

/** 差值 -320 → "-0.32"，+1534 → "+1.53" */
export function fmtDelta(ms, digits = 2) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const sign = ms < 0 ? '-' : '+';
  return sign + (Math.abs(ms) / 1000).toFixed(digits);
}

/** m/s → km/h 整数 */
export function kmh(mps) {
  return mps == null || !Number.isFinite(mps) ? 0 : Math.round(mps * 3.6);
}

/** 运行中的圈时（精确到 0.1 秒）123456 → "2:03.4" */
export function fmtRunning(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '-:--.-';
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}
