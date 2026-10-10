// 轻量折线图（Canvas），用于圈速分析的速度曲线与时间差曲线。支持多图共享十字光标。
import { h } from './ui.js';

export class LineChart {
  constructor({ height = 170, yFmt = (v) => v.toFixed(0), xFmt = (v) => `${Math.round(v)} m`, zero = false, yPad = 0.08 } = {}) {
    this.canvas = h('canvas', { style: { height: `${height}px` } });
    this.height = height;
    this.yFmt = yFmt;
    this.xFmt = xFmt;
    this.zero = zero;
    this.yPad = yPad;
    this.series = [];
    this.cursor = null;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.canvas);
  }

  setData(series) {
    this.series = series.filter((s) => s.points.length > 1);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const s of this.series) {
      for (const [x, y] of s.points) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (this.zero) {
      const m = Math.max(Math.abs(y0), Math.abs(y1), 0.1);
      y0 = -m;
      y1 = m;
    }
    const pad = (y1 - y0) * this.yPad || 1;
    this.bounds = { x0, x1, y0: y0 - pad, y1: y1 + pad };
    this.draw();
  }

  /** 像素 x → 数据 x */
  xAt(clientX) {
    const r = this.canvas.getBoundingClientRect();
    const { x0, x1 } = this.bounds;
    const L = 40;
    const W = r.width - L - 8;
    return x0 + Math.max(0, Math.min(1, (clientX - r.left - L) / W)) * (x1 - x0);
  }

  setCursor(x) {
    this.cursor = x;
    this.draw();
  }

  /** 在某条曲线上按 x 插值取 y */
  valueAt(i, x) {
    const pts = this.series[i]?.points;
    if (!pts) return null;
    if (x < pts[0][0] || x > pts[pts.length - 1][0]) return null;
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid][0] <= x) lo = mid;
      else hi = mid;
    }
    const [xa, ya] = pts[lo];
    const [xb, yb] = pts[hi];
    return xb === xa ? ya : ya + ((yb - ya) * (x - xa)) / (xb - xa);
  }

  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const hgt = this.height;
    if (!w || !this.bounds) return;
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const L = 40;
    const R = 8;
    const T = 6;
    const B = 18;
    const W = w - L - R;
    const H = hgt - T - B;
    const { x0, x1, y0, y1 } = this.bounds;
    const px = (x) => L + ((x - x0) / (x1 - x0 || 1)) * W;
    const py = (y) => T + (1 - (y - y0) / (y1 - y0 || 1)) * H;

    // 网格与坐标
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.fillStyle = '#6b7480';
    ctx.strokeStyle = '#262b33';
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const y = y0 + ((y1 - y0) * i) / 4;
      ctx.beginPath();
      ctx.moveTo(L, py(y));
      ctx.lineTo(L + W, py(y));
      ctx.stroke();
      ctx.fillText(this.yFmt(y), L - 6, py(y));
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const x = x0 + ((x1 - x0) * i) / 4;
      ctx.fillText(this.xFmt(x), Math.min(Math.max(px(x), L + 16), L + W - 16), T + H + 4);
    }
    if (this.zero) {
      ctx.strokeStyle = '#4a5160';
      ctx.beginPath();
      ctx.moveTo(L, py(0));
      ctx.lineTo(L + W, py(0));
      ctx.stroke();
    }

    for (const s of this.series) {
      if (s.fillZero) {
        // 时间差：领先（负值）绿色，落后（正值）红色
        for (const [sign, color] of [
          [-1, 'rgba(43,217,107,0.28)'],
          [1, 'rgba(255,69,69,0.28)'],
        ]) {
          ctx.beginPath();
          ctx.moveTo(px(s.points[0][0]), py(0));
          for (const [x, y] of s.points) ctx.lineTo(px(x), py(sign < 0 ? Math.min(0, y) : Math.max(0, y)));
          ctx.lineTo(px(s.points[s.points.length - 1][0]), py(0));
          ctx.closePath();
          ctx.fillStyle = color;
          ctx.fill();
        }
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 2;
      ctx.setLineDash(s.dash || []);
      ctx.beginPath();
      s.points.forEach(([x, y], i) => (i ? ctx.lineTo(px(x), py(y)) : ctx.moveTo(px(x), py(y))));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (this.cursor != null) {
      const cx = px(this.cursor);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, T);
      ctx.lineTo(cx, T + H);
      ctx.stroke();
      this.series.forEach((s, i) => {
        const y = this.valueAt(i, this.cursor);
        if (y == null) return;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(cx, py(y), 3.5, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }

  destroy() {
    this.ro.disconnect();
  }
}

/** 让多张图共享光标：在任意一张上滑动，所有图同步显示同一距离处的数值 */
export function linkCursors(charts, onMove) {
  for (const c of charts) {
    const move = (e) => {
      const x = c.xAt(e.clientX);
      charts.forEach((o) => o.setCursor(x));
      onMove?.(x);
    };
    c.canvas.addEventListener('pointermove', move);
    c.canvas.addEventListener('pointerdown', move);
  }
}
