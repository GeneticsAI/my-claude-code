// 定位来源：真实 GPS（浏览器 Geolocation）或模拟驾驶（沿赛道自动行驶，用于演示与测试）。
import { SimDriver } from '../shared/track.js';

export class GpsSource {
  constructor({ mode, path, onFix, onError }) {
    this.mode = mode;
    this.path = path;
    this.onFix = onFix;
    this.onError = onError;
    this.watchId = null;
    this.timer = null;
    this.wakeLock = null;
    this._onVisible = () => document.visibilityState === 'visible' && this._lockScreen();
  }

  start() {
    if (this.mode === 'sim') {
      const sim = new SimDriver(this.path, {
        skill: 0.93 + Math.random() * 0.05,
        noise: 1.5,
        startOffset: -120,
        seed: Math.floor(Math.random() * 1e6),
      });
      let last = performance.now();
      this.timer = setInterval(() => {
        const now = performance.now();
        const fix = sim.step(now - last, Date.now());
        last = now;
        this.onFix({ ...fix, sim: true });
      }, 200);
    } else {
      if (!navigator.geolocation) {
        this.onError(new Error('当前浏览器不支持定位'));
        return;
      }
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const c = pos.coords;
          this.onFix({
            lat: c.latitude,
            lng: c.longitude,
            spd: Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null,
            hdg: Number.isFinite(c.heading) ? c.heading : null,
            acc: c.accuracy,
            ts: pos.timestamp,
            sim: false,
          });
        },
        (err) => this.onError(err),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
      );
    }
    // 共享位置期间保持屏幕常亮：多数手机息屏后浏览器会暂停定位
    this._lockScreen();
    document.addEventListener('visibilitychange', this._onVisible);
  }

  async _lockScreen() {
    try {
      if ('wakeLock' in navigator && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => (this.wakeLock = null));
      }
    } catch {
      /* 不支持或被拒绝：忽略 */
    }
  }

  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    clearInterval(this.timer);
    this.watchId = null;
    this.timer = null;
    document.removeEventListener('visibilitychange', this._onVisible);
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }
}
