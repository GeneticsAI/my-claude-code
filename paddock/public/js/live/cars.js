// 地图上的车辆标记：箭头指示航向，标签显示昵称与实时车速，位置在两次更新之间平滑插值，
// 尾迹显示最近的行驶轨迹；离线变灰，正在对讲时外圈闪动。
import { h } from '../ui.js';
import { arrowIcon } from '../icons.js';
import { bearing, distance } from '../shared/geo.js';
import { kmh } from '../shared/format.js';

const TRAIL = 40;

export class CarLayer {
  constructor(bm) {
    this.bm = bm;
    this.cars = new Map();
    this.trails = L.layerGroup().addTo(bm.map);
    this.raf = requestAnimationFrame(() => this._tick());
    this.offReproject = bm.onReproject(() => {
      for (const c of this.cars.values()) {
        c.marker.setLatLng(bm.toMap(c.cur));
        c.trailLine.setLatLngs(c.trail.map((p) => bm.toMap(p)));
      }
    });
  }

  _create(uid, s) {
    const arrow = arrowIcon();
    const nameEl = h('b');
    const spdEl = h('span');
    const el = h('div', { class: 'car-marker' }, h('div', { class: 'arrow' }, arrow), h('div', { class: 'label' }, nameEl, spdEl));
    const marker = L.marker(this.bm.toMap(s), {
      icon: L.divIcon({ html: el, className: '', iconSize: null }),
      keyboard: false,
      zIndexOffset: s.me ? 1000 : 0,
    }).addTo(this.bm.map);
    const trailLine = L.polyline([], { color: s.user?.color || '#fff', weight: 3, opacity: 0.45, interactive: false }).addTo(this.trails);
    const car = {
      uid, marker, el, arrow, nameEl, spdEl, trailLine,
      cur: { lat: s.lat, lng: s.lng }, from: null, to: null, t0: 0, dur: 0, last: performance.now(), hdg: 0, trail: [],
    };
    this.cars.set(uid, car);
    return car;
  }

  /** s: {lat, lng, hdg, spd, user, me, online, talking} */
  upsert(uid, s) {
    let c = this.cars.get(uid);
    if (!c) c = this._create(uid, s);
    const now = performance.now();
    const target = { lat: s.lat, lng: s.lng };
    const jump = distance(c.cur, target);
    if (jump > 2000) {
      // 距离跳变太大（重新开始共享等）：直接跳过去，不做插值
      c.cur = target;
      c.from = null;
      c.trail = [];
      c.marker.setLatLng(this.bm.toMap(target));
    } else {
      c.from = { ...c.cur };
      c.to = target;
      c.t0 = now;
      c.dur = Math.max(150, Math.min(1500, now - c.last));
    }
    c.last = now;
    let hdg = Number.isFinite(s.hdg) ? s.hdg : null;
    if (hdg == null && jump > 1) hdg = bearing(c.cur, target);
    if (hdg != null) {
      // 走最短角度旋转，避免 359°→1° 时转一整圈
      const diff = ((hdg - (c.hdg % 360) + 540) % 360) - 180;
      c.hdg += diff;
      c.arrow.style.transform = `rotate(${c.hdg}deg)`;
    }
    c.trail.push(target);
    if (c.trail.length > TRAIL) c.trail.shift();
    c.trailLine.setLatLngs(c.trail.map((p) => this.bm.toMap(p)));
    this.style(uid, s);
  }

  /** 更新外观（颜色、标签、在线、对讲）而不移动位置 */
  style(uid, s) {
    const c = this.cars.get(uid);
    if (!c) return;
    if (s.user) {
      c.el.style.color = s.user.color;
      c.nameEl.textContent = s.me ? '我' : s.user.nickname;
      c.trailLine.setStyle({ color: s.user.color });
    }
    if (s.spd !== undefined) c.spdEl.textContent = s.spd == null ? '' : `${kmh(s.spd)}`;
    if (s.me !== undefined) c.el.classList.toggle('me', !!s.me);
    if (s.online !== undefined) c.el.classList.toggle('offline', !s.online);
    if (s.talking !== undefined) c.el.classList.toggle('talking', !!s.talking);
  }

  remove(uid) {
    const c = this.cars.get(uid);
    if (!c) return;
    c.marker.remove();
    c.trailLine.remove();
    this.cars.delete(uid);
  }

  has(uid) {
    return this.cars.has(uid);
  }

  position(uid) {
    return this.cars.get(uid)?.to || this.cars.get(uid)?.cur || null;
  }

  displayPoints() {
    return [...this.cars.values()].map((c) => this.bm.toMap(c.to || c.cur));
  }

  _tick() {
    const now = performance.now();
    for (const c of this.cars.values()) {
      if (!c.from) continue;
      const t = Math.min(1, (now - c.t0) / c.dur);
      c.cur = { lat: c.from.lat + (c.to.lat - c.from.lat) * t, lng: c.from.lng + (c.to.lng - c.from.lng) * t };
      c.marker.setLatLng(this.bm.toMap(c.cur));
      if (t >= 1) c.from = null;
    }
    this.raf = requestAnimationFrame(() => this._tick());
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.offReproject();
    for (const uid of [...this.cars.keys()]) this.remove(uid);
    this.trails.remove();
  }
}

