// 排行榜表格：活动详情页（静态）与实况页（叠加实时速度 / 当前圈 / Δ）共用。
import { h, icon } from '../ui.js';
import { fmtLap, fmtDelta, kmh } from '../shared/format.js';

/**
 * opts:
 *   board     服务器返回的排行榜 {entries, bestLap, bestSectors}
 *   live      Map<uid, 实时状态>（可选）
 *   online    Set<uid>（可选）
 *   members   Map<uid, user>（可选，用于补全只在线、未出圈速的车手）
 *   me        当前用户 id
 *   onRow     点击行回调 (uid, entry)
 */
export function boardTable({ board, live = null, online = null, members = null, me = null, onRow = null }) {
  const entries = board?.entries || [];
  const rows = entries.map((e) => ({ uid: e.user.id, user: members?.get(e.user.id) || e.user, e }));
  if (live) {
    for (const [uid, l] of live) {
      if (l.online === false || rows.some((r) => r.uid === uid)) continue;
      const user = members?.get(uid);
      if (user) rows.push({ uid, user, e: null });
    }
  }
  if (!rows.length) return null;

  const table = h('div', { class: 'board' });
  table.appendChild(
    h('div', { class: 'board-head' }, h('span', null, `车手 ${rows.length}`), h('span', null, `最佳圈 / 差距 · 共 ${board?.totalLaps || 0} 圈`))
  );
  rows.forEach((r, i) => {
    const l = live?.get(r.uid);
    const isLive = l && l.online !== false && (!online || online.has(r.uid));
    let liveLine = null;
    if (isLive) {
      const parts = [`${kmh(l.spd)} km/h`];
      if (l.lap?.n) parts.push(`L${l.lap.n}`);
      if (l.lap?.delta != null) parts.push(`Δ${fmtDelta(l.lap.delta)}`);
      liveLine = h('small', { class: 'live-line' }, '● ', parts.join(' · '));
      if (l.lap?.delta != null) liveLine.classList.add(l.lap.delta < 0 ? 'green' : 'red');
    }
    const e = r.e;
    const bestCls = e && board.bestLap === e.best ? 'purple' : '';
    const lastCls = e && e.laps > 1 && e.last === e.best ? 'green' : '';
    table.appendChild(
      h(
        'div',
        {
          class: `board-row${r.uid === me ? ' me' : ''}`,
          role: onRow ? 'button' : null,
          tabindex: onRow ? 0 : null,
          onclick: onRow ? () => onRow(r.uid, e) : null,
        },
        h('span', { class: 'pos' }, e ? i + 1 : '–'),
        h('span', { class: 'bar', style: { background: r.user.color } }),
        h(
          'div',
          { class: 'driver' },
          h('b', null, r.user.nickname),
          liveLine || h('small', null, [r.user.car || '', e ? `${e.laps} 圈 · 极速 ${kmh(e.vmax)}` : '尚未完成计时圈'].filter(Boolean).join(' · '))
        ),
        h(
          'div',
          { class: 'times' },
          h('b', { class: bestCls }, e ? fmtLap(e.best) : '-:--.---'),
          h('small', null, e ? (i === 0 ? (e.last != null ? `上圈 ${fmtLap(e.last)}` : '') : `+${(e.gap / 1000).toFixed(3)}`) : ''),
          e && i > 0 && e.last != null ? h('small', { class: lastCls }, `上圈 ${fmtLap(e.last)}`) : null
        ),
        onRow ? h('span', { class: 'go' }, icon('chevron')) : h('span')
      )
    );
  });
  return table;
}
