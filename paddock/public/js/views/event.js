import { get, post, del, state } from '../api.js';
import { h, icon, clear, topbar, avatar, busy, toast, confirmDialog, fmtDateTime, KIND_LABEL, empty } from '../ui.js';
import { BaseMap, trackLayer } from '../live/maps.js';
import { boardTable } from './board.js';

export default async function eventView({ el, params }) {
  const id = encodeURIComponent(params.id);
  const [{ event: ev }, { board }] = await Promise.all([get(`/events/${id}`), get(`/events/${id}/board`)]);
  const isOwner = ev.owner.id === state.me.id;
  const full = ev.maxMembers > 0 && ev.memberCount >= ev.maxMembers;

  const actions = h('div', { class: 'event-actions' });
  if (ev.isMember) {
    actions.appendChild(h('a', { class: 'btn primary', href: `#/live/${ev.id}` }, icon('pulse'), ev.online ? `进入实况 · ${ev.online} 人在线` : '进入实况'));
    if (!isOwner) {
      const leave = h('button', { class: 'btn outline', style: { flex: '0 0 auto' } }, '退出');
      leave.addEventListener('click', async () => {
        if (!(await confirmDialog('退出这个活动？', '退出后将无法查看群聊和实况。', '退出', true))) return;
        busy(leave, async () => {
          await del(`/events/${ev.id}/join`);
          toast('已退出活动');
          location.reload();
        });
      });
      actions.appendChild(leave);
    }
  } else {
    const join = h('button', { class: 'btn primary', disabled: full }, full ? '名额已满' : '报名参加');
    join.addEventListener('click', () =>
      busy(join, async () => {
        await post(`/events/${ev.id}/join`);
        toast('报名成功，到时见！', 'success');
        location.reload();
      })
    );
    actions.appendChild(join);
  }
  actions.appendChild(
    h('a', { class: 'btn outline', style: { flex: '0 0 auto' }, href: `#/compose?event=${ev.id}`, 'aria-label': '分享到动态' }, icon('share'))
  );

  const mapEl = h('div', { class: 'mini-map' });
  const boardEl = boardTable({
    board,
    me: state.me.id,
    onRow: (uid, e) => e && (location.hash = `#/lap/${e.bestLapId}`),
  });

  clear(el).appendChild(
    h(
      'div',
      { class: 'page' },
      topbar({
        title: '活动详情',
        back: '#/events',
        actions: isOwner ? [h('a', { class: 'icon-btn', href: `#/event/${ev.id}/edit`, 'aria-label': '编辑活动' }, icon('edit'))] : [],
      }),
      h(
        'section',
        { class: 'event-hero' },
        h(
          'div',
          { class: `event-banner k-${ev.kind}` },
          h('span', { class: 'kind' }, KIND_LABEL[ev.kind] || '活动'),
          ev.online > 0 ? h('span', { class: 'chip onair' }, `实况中 ${ev.online}`) : null,
          h('div', { class: 'flag' })
        ),
        h('h2', null, ev.title),
        h(
          'div',
          { class: 'info-list' },
          h('div', { class: 'row' }, icon('clock'), h('b', null, fmtDateTime(ev.startsAt))),
          ev.place ? h('div', { class: 'row' }, icon('pin'), h('b', null, ev.place)) : null,
          h('div', { class: 'row' }, icon('users'), `${ev.memberCount}${ev.maxMembers ? ` / ${ev.maxMembers}` : ''} 人报名`),
          h(
            'div',
            { class: 'row' },
            icon('flag'),
            ev.hasTrack ? `已设置计时线（${(ev.sectorLines?.length || 0) + 1} 个计时段）` : '尚未设置计时线',
            isOwner && !ev.hasTrack ? h('span', { class: 'dim' }, '· 进入实况后可设置') : null
          )
        ),
        actions
      ),
      ev.description ? [h('div', { class: 'section-title' }, '介绍'), h('p', { class: 'event-desc' }, ev.description)] : null,
      h('div', { class: 'section-title' }, ev.hasTrack ? '赛道' : '集合点'),
      mapEl,
      h('div', { class: 'section-title' }, h('span', null, '圈速排行'), board.entries.length ? h('span', { class: 'dim' }, '点击查看圈速分析') : null),
      boardEl || empty(ev.isMember ? '还没有人完成计时圈 — 进入实况开始跑吧' : '还没有圈速记录', 'trophy'),
      h('div', { class: 'section-title' }, `成员 ${ev.members.length}`),
      h(
        'div',
        { class: 'members' },
        ev.members.map((m) =>
          h('a', { href: `#/user/${m.id}` }, avatar(m, 48), h('span', null, m.nickname), m.role === 'owner' ? h('small', { class: 'owner-tag' }, '组织者') : null)
        )
      )
    )
  );

  const bm = new BaseMap(mapEl, { center: { lat: ev.lat, lng: ev.lng }, zoom: 14 });
  const tl = trackLayer(bm);
  tl.set({ path: ev.path, startLine: ev.startLine, sectorLines: ev.sectorLines });
  const b = tl.bounds();
  if (b) bm.map.fitBounds(b, { padding: [16, 16] });
  if (!ev.path) bm.pinMarker({ lat: ev.lat, lng: ev.lng });
  return () => bm.remove();
}
