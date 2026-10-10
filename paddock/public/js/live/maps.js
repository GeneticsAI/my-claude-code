// 地图底座（Leaflet）。数据一律是 WGS-84；切到高德底图时显示前转换为 GCJ-02，
// 用户在地图上点选的位置再反算回 WGS-84，保证与 GPS 数据对齐。
import { wgsToGcj, gcjToWgs } from '../shared/geo.js';
import { h, icon } from '../ui.js';

export const LAYERS = {
  amap: {
    name: '高德地图',
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    subdomains: '1234', gcj: true, dark: true, maxZoom: 18, attribution: '© 高德地图',
  },
  amapSat: {
    name: '高德卫星',
    url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    subdomains: '1234', gcj: true, dark: false, maxZoom: 18, attribution: '© 高德地图',
  },
  osm: {
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: 'abc', gcj: false, dark: true, maxZoom: 19, attribution: '© OpenStreetMap',
  },
  esri: {
    name: 'Esri 卫星',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    subdomains: 'abc', gcj: false, dark: false, maxZoom: 19, attribution: '© Esri',
  },
};
const ORDER = ['amap', 'amapSat', 'osm', 'esri'];
const LAYER_KEY = 'paddock.mapLayer';

function savedLayer() {
  try {
    const k = localStorage.getItem(LAYER_KEY);
    if (k && LAYERS[k]) return k;
  } catch {
    /* 忽略 */
  }
  return 'amap';
}

export class BaseMap {
  constructor(el, { center, zoom = 15, interactive = true } = {}) {
    this.el = el;
    this.map = L.map(el, {
      zoomControl: false,
      attributionControl: true,
      dragging: interactive,
      scrollWheelZoom: interactive,
      doubleClickZoom: interactive,
      touchZoom: interactive,
      boxZoom: false,
      keyboard: interactive,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
    });
    // 赛道标签（S1/起终点）放在车辆标记下面，避免挡住车手名字
    this.map.createPane('track-labels').classList.add('leaflet-track-labels-pane');
    this.map.attributionControl.setPrefix(false);
    this.layerKey = savedLayer();
    this.tile = null;
    this.reprojectors = new Set();
    this._applyLayer();
    if (center) this.map.setView(this.toMap(center), zoom);
  }

  get layer() {
    return LAYERS[this.layerKey];
  }

  /** WGS-84 {lat,lng} → 当前底图坐标 [lat,lng] */
  toMap(p) {
    const lat = Array.isArray(p) ? p[0] : p.lat;
    const lng = Array.isArray(p) ? p[1] : p.lng;
    return this.layer.gcj ? wgsToGcj(lat, lng) : [lat, lng];
  }

  /** 当前底图坐标（Leaflet LatLng）→ WGS-84 {lat,lng} */
  fromMap(ll) {
    const [lat, lng] = this.layer.gcj ? gcjToWgs(ll.lat, ll.lng) : [ll.lat, ll.lng];
    return { lat, lng };
  }

  _applyLayer() {
    const cfg = this.layer;
    if (this.tile) this.tile.remove();
    this.tile = L.tileLayer(cfg.url, { subdomains: cfg.subdomains, maxZoom: cfg.maxZoom, maxNativeZoom: 18, attribution: cfg.attribution });
    this.tile.addTo(this.map);
    this.el.classList.toggle('dark-tiles', cfg.dark);
  }

  setLayer(key) {
    if (!LAYERS[key] || key === this.layerKey) return;
    const wasGcj = this.layer.gcj;
    let center = null;
    try {
      center = this.fromMap(this.map.getCenter());
    } catch {
      /* 地图尚未设置视野 */
    }
    this.layerKey = key;
    try {
      localStorage.setItem(LAYER_KEY, key);
    } catch {
      /* 忽略 */
    }
    this._applyLayer();
    if (wasGcj !== this.layer.gcj) {
      if (center) this.map.setView(this.toMap(center), this.map.getZoom(), { animate: false });
      for (const fn of this.reprojectors) fn();
    }
  }

  cycleLayer() {
    const next = ORDER[(ORDER.indexOf(this.layerKey) + 1) % ORDER.length];
    this.setLayer(next);
    return LAYERS[next].name;
  }

  /** 注册切换坐标系时需要重绘的覆盖物 */
  onReproject(fn) {
    this.reprojectors.add(fn);
    return () => this.reprojectors.delete(fn);
  }

  pinMarker(p) {
    let at = p;
    const el = h('div', { class: 'pin-marker' }, icon('pin'));
    const m = L.marker(this.toMap(at), { icon: L.divIcon({ html: el, className: '', iconSize: null }), keyboard: false });
    m.addTo(this.map);
    this.onReproject(() => m.setLatLng(this.toMap(at)));
    m.moveTo = (q) => {
      at = q;
      m.setLatLng(this.toMap(q));
    };
    return m;
  }

  remove() {
    this.reprojectors.clear();
    this.map.remove();
  }
}

/**
 * 赛道覆盖物：赛道轮廓、起终点线（黑白格）、分段线（琥珀色 S1/S2…）。
 * 返回 { set(track), clear() }
 */
export function trackLayer(bm) {
  const group = L.layerGroup().addTo(bm.map);
  let current = null;

  function draw() {
    group.clearLayers();
    const t = current;
    if (!t) return;
    if (t.path?.length) {
      const pts = t.path.map((p) => bm.toMap(p));
      L.polyline(pts.concat([pts[0]]), { color: '#ffffff', weight: 16, opacity: 0.1, interactive: false }).addTo(group);
      L.polyline(pts.concat([pts[0]]), { color: '#d9dde3', weight: 3, opacity: 0.55, dashArray: '10 10', interactive: false }).addTo(group);
    }
    (t.sectorLines || []).forEach((line, i) => {
      L.polyline(line.map((p) => bm.toMap(p)), { color: '#ffb020', weight: 5, opacity: 0.95, interactive: false })
        .bindTooltip(`S${i + 1}`, { permanent: true, direction: 'center', className: 'sector-tip', pane: 'track-labels' })
        .addTo(group);
    });
    if (t.startLine) {
      const pts = t.startLine.map((p) => bm.toMap(p));
      L.polyline(pts, { color: '#ffffff', weight: 8, opacity: 1, interactive: false }).addTo(group);
      L.polyline(pts, { color: '#0a0b0d', weight: 8, opacity: 1, dashArray: '4 4', interactive: false })
        .bindTooltip('起/终点', { permanent: true, direction: 'right', offset: [8, 0], className: 'start-tip', pane: 'track-labels' })
        .addTo(group);
    }
  }

  bm.onReproject(draw);
  return {
    set(track) {
      current = track;
      draw();
    },
    bounds() {
      const pts = [];
      if (current?.path) for (const p of current.path) pts.push(bm.toMap(p));
      if (current?.startLine) for (const p of current.startLine) pts.push(bm.toMap(p));
      return pts.length ? L.latLngBounds(pts) : null;
    },
    clear() {
      group.clearLayers();
    },
  };
}
