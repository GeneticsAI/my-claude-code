// 圈速分析：单圈成绩、分段对比、速度曲线与时间差曲线（对比全场最快 / 个人最佳）、按速度着色的行驶轨迹。
import { get, state } from '../api.js';
import { h, icon, clear, topbar, avatar, userLink, fmtDateTime } from '../ui.js';
import { BaseMap, trackLayer } from '../live/maps.js';
import { LineChart, linkCursors } from '../charts.js';
import { timeAtDistance } from '../shared/laptimer.js';
import { fmtLap, fmtSector, fmtDelta, kmh } from '../shared/format.js';

const SPEED_STOPS = [
  [0, [62, 166, 255]],
  [0.35, [43, 217, 107]],
  [0.7, [255, 210, 63]],
  [1, [255, 69, 69]],
];

function speedColor(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < SPEED_STOPS.length; i++) {
    const [b, cb] = SPEED_STOPS[i];
    if (t <= b) {
      const [a, ca] = SPEED_STOPS[i - 1];
      const f = (t - a) / (b - a);
      return `rgb(${ca.map((v, k) => Math.round(v + (cb[k] - v) * f)).join(',')})`;
    }
  }
  return 'rgb(255,69,69)';
}

export default async function lapView({ el, params }) {
  const { lap, sessionBest, personalBest, board } = await get(`/laps/${encodeURIComponent(params.id)}`);
  const entry = board.entries.find((e) => e.user.id === lap.user.id);
  const rank = board.entries.indexOf(entry) + 1;
  const isSessionBest = board.bestLap === lap.lapMs && !sessionBest;
  const isPersonalBest = entry?.bestLapId === lap.id;
  const mine = lap.user.id === state.me.id;

  const refs = [];
  if (sessionBest) refs.push({ key: 'sb', label: `全场最快 · ${sessionBest.user.nickname}`, lap: sessionBest, color: '#b05cff' });
  if (personalBest) refs.push({ key: 'pb', label: '个人最佳', lap: personalBest, color: '#2bd96b' });
  let ref = refs[0] || null;

  const tags = h('div', { class: 'tags' });
  if (isSessionBest) tags.appendChild(h('span', { class: 'chip purple' }, icon('trophy'), '全场最快圈'));
  else if (isPersonalBest) tags.appendChild(h('span', { class: 'chip green' }, '个人最佳'));
  if (rank > 0) tags.appendChild(h('span', { class: 'chip' }, `排名 P${rank} / ${board.entries.length}`));
  if (sessionBest) tags.appendChild(h('span', { class: 'chip' }, `距最快 ${fmtDelta(lap.lapMs - sessionBest.lapMs, 3)}`));

  // 分段表
  let sectorEl = null;
  if (lap.sectors) {
    const pbS = entry?.bestSectors || [];
    const sbS = board.bestSectors || [];
    const rows = lap.sectors.map((ms, i) => {
      const cls = sbS[i] != null && ms <= sbS[i] ? 'purple' : pbS[i] != null && ms <= pbS[i] ? 'green' : '';
      return h('div', { class: 'tr' }, h('span', null, `S${i + 1}`), h('span', { class: cls }, fmtSector(ms)), h('span', null, fmtSector(pbS[i])), h('span', null, fmtSector(sbS[i])));
    });
    const theo = entry?.theoretical;
    const sbTheo = sbS.length && sbS.every((v) => v != null) ? sbS.reduce((a, b) => a + b, 0) : null;
    sectorEl = h(
      'div',
      { class: 'sector-table' },
      h('div', { class: 'tr th' }, h('span', null, '分段'), h('span', null, '本圈'), h('span', null, '个人最佳'), h('span', null, '全场最佳')),
      rows,
      h('div', { class: 'tr' }, h('span', { class: 'dim' }, '理论'), h('span', null, fmtLap(lap.lapMs)), h('span', null, theo ? fmtLap(theo) : '—'), h('span', null, sbTheo ? fmtLap(sbTheo) : '—'))
    );
  }

  const speedChart = new LineChart({ height: 180, yFmt: (v) => `${Math.round(v)}` });
  const deltaChart = new LineChart({ height: 130, zero: true, yFmt: (v) => fmtDelta(v * 1000, 1) });
  const readout = h('div', { class: 'chart-readout' }, '在曲线上滑动查看任意位置的数据');
  const legend = h('div', { class: 'chart-legend' });
  const refSeg = h('div', { class: 'seg', style: { margin: '0 16px 10px' } });
  const mapEl = h('div', { class: 'mini-map', style: { height: '280px' } });

  clear(el).appendChild(
    h(
      'div',
      { class: 'page' },
      topbar({
        title: '圈速分析',
        back: lap.event ? `#/event/${lap.event.id}` : '#/feed',
        actions: mine ? [h('a', { class: 'btn small primary', href: `#/compose?lap=${lap.id}` }, icon('share'), '分享')] : [],
      }),
      h(
        'section',
        { class: 'lap-hero' },
        h(
          'div',
          { class: 'driver' },
          userLink(lap.user, avatar(lap.user, 40)),
          h(
            'div',
            null,
            userLink(lap.user, h('b', null, lap.user.nickname)),
            h('div', { class: 'dim', style: { fontSize: '13px' } }, [lap.car, lap.event && h('a', { href: `#/event/${lap.event.id}` }, lap.event.title)].filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x])))
          )
        ),
        h('div', { class: 'time' }, fmtLap(lap.lapMs)),
        tags,
        h('div', { class: 'dim', style: { fontSize: '12px', marginTop: '8px' } }, fmtDateTime(lap.startedAt))
      ),
      h(
        'div',
        { class: 'stat-grid' },
        h('div', { class: 'stat' }, h('small', null, '极速'), h('b', null, kmh(lap.maxSpeed), h('em', null, 'km/h'))),
        h('div', { class: 'stat' }, h('small', null, '平均速度'), h('b', null, kmh(lap.avgSpeed), h('em', null, 'km/h'))),
        h('div', { class: 'stat' }, h('small', null, '圈长'), h('b', null, (lap.distance / 1000).toFixed(2), h('em', null, 'km'))),
        h('div', { class: 'stat' }, h('small', null, '最低弯速'), h('b', null, kmh(minCornerSpeed(lap.trace)), h('em', null, 'km/h')))
      ),
      sectorEl ? [h('div', { class: 'section-title' }, '分段时间'), sectorEl] : null,
      h('div', { class: 'section-title' }, '速度曲线'),
      refs.length > 1 ? refSeg : null,
      h('div', { class: 'chart-wrap' }, legend, speedChart.canvas, readout),
      ref ? [h('div', { class: 'section-title' }, h('span', null, '时间差 Δ'), h('span', { class: 'dim', style: { textTransform: 'none', letterSpacing: 0 } }, '绿色=领先  红色=落后')), h('div', { class: 'chart-wrap' }, deltaChart.canvas)] : null,
      h('div', { class: 'section-title' }, '行驶轨迹'),
      mapEl,
      h('div', { class: 'speed-legend' }, h('span', null, '慢'), h('div', { class: 'grad' }), h('span', null, '快'))
    )
  );

  // 轨迹地图
  const bm = new BaseMap(mapEl, { center: lap.trace[0] ? { lat: lap.trace[0][3], lng: lap.trace[0][4] } : { lat: 31, lng: 121 }, zoom: 15 });
  const tl = trackLayer(bm);
  const traceLayer = L.layerGroup().addTo(bm.map);
  const cursorDot = L.circleMarker([0, 0], { radius: 7, color: '#fff', weight: 2, fillColor: '#ff4d1a', fillOpacity: 1 });
  const speeds = lap.trace.map((p) => p[2]);
  const vMin = Math.min(...speeds);
  const vMax = Math.max(...speeds);
  function drawTrace() {
    traceLayer.clearLayers();
    for (let i = 1; i < lap.trace.length; i++) {
      const a = lap.trace[i - 1];
      const b = lap.trace[i];
      L.polyline([bm.toMap([a[3], a[4]]), bm.toMap([b[3], b[4]])], {
        color: speedColor((b[2] - vMin) / (vMax - vMin || 1)), weight: 5, opacity: 0.95, interactive: false,
      }).addTo(traceLayer);
    }
  }
  drawTrace();
  bm.onReproject(drawTrace);
  if (lap.trace.length > 1) bm.map.fitBounds(L.latLngBounds(lap.trace.map((p) => bm.toMap([p[3], p[4]]))), { padding: [20, 20] });
  get(`/events/${lap.eventId}`)
    .then((r) => tl.set({ startLine: r.event.startLine, sectorLines: r.event.sectorLines }))
    .catch(() => {});

  // 曲线
  const lapDist = lap.distance;
  const thisSpeed = lap.trace.map(([d, , v]) => [d, v * 3.6]);
  function drawCharts() {
    clear(legend).appendChild(h('span', null, h('i', { style: { background: '#ff4d1a' } }), '本圈'));
    const series = [{ points: thisSpeed, color: '#ff4d1a', width: 2 }];
    let deltaPts = [];
    if (ref) {
      legend.appendChild(h('span', null, h('i', { style: { background: ref.color } }), ref.label));
      const rl = ref.lap;
      // 两圈的测量圈长会略有差异，按圈内比例对齐后比较
      series.unshift({ points: rl.trace.map(([d, , v]) => [(d / rl.distance) * lapDist, v * 3.6]), color: ref.color, width: 1.5, dash: [5, 3] });
      deltaPts = lap.trace
        .map(([d, t]) => {
          const rt = timeAtDistance(rl.trace, (d / lapDist) * rl.distance);
          return rt == null ? null : [d, (t - rt) / 1000];
        })
        .filter(Boolean);
      deltaChart.setData([{ points: deltaPts, color: '#e8eaed', width: 1.5, fillZero: true }]);
    }
    speedChart.setData(series);
    return deltaPts;
  }
  drawCharts();
  if (refs.length > 1) {
    const drawSeg = () =>
      clear(refSeg).append(
        ...refs.map((r) => h('button', { class: ref === r ? 'on' : '', onclick: () => ((ref = r), drawSeg(), drawCharts()) }, r.key === 'sb' ? '对比全场最快' : '对比个人最佳'))
      );
    drawSeg();
  }

  linkCursors(ref ? [speedChart, deltaChart] : [speedChart], (x) => {
    const iThis = ref ? 1 : 0;
    const v = speedChart.valueAt(iThis, x);
    const parts = [`${(x / 1000).toFixed(2)} km`, `本圈 ${v == null ? '—' : Math.round(v)} km/h`];
    if (ref) {
      const rv = speedChart.valueAt(0, x);
      const dv = deltaChart.valueAt(0, x);
      parts.push(`参考 ${rv == null ? '—' : Math.round(rv)} km/h`);
      if (dv != null) parts.push(`Δ ${fmtDelta(dv * 1000)}s`);
    }
    readout.textContent = parts.join('  ·  ');
    // 地图上同步显示该距离处的位置
    const p = pointAtDistance(lap.trace, x);
    if (p) cursorDot.setLatLng(bm.toMap(p)).addTo(bm.map);
  });

  return () => {
    speedChart.destroy();
    deltaChart.destroy();
    bm.remove();
  };
}

function pointAtDistance(trace, d) {
  for (let i = 1; i < trace.length; i++) {
    if (trace[i][0] >= d) {
      const a = trace[i - 1];
      const b = trace[i];
      const f = (d - a[0]) / (b[0] - a[0] || 1);
      return [a[3] + (b[3] - a[3]) * f, a[4] + (b[4] - a[4]) * f];
    }
  }
  return null;
}

/** 最低弯速：取速度曲线的最小值（排除起步段）。 */
function minCornerSpeed(trace) {
  if (!trace?.length) return 0;
  return Math.min(...trace.slice(1, -1).map((p) => p[2]));
}
