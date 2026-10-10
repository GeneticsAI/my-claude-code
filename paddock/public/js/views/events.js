import { get, post, patch, del, state } from '../api.js';
import {
  h, icon, clear, topbar, empty, spinner, busy, toast, confirmDialog, dateBlock, fmtDateTime, toLocalInput, KIND_LABEL,
} from '../ui.js';
import { BaseMap } from '../live/maps.js';

export function eventCard(ev) {
  return h(
    'a',
    { class: 'event-card', href: `#/event/${ev.id}` },
    h(
      'div',
      { class: `event-banner k-${ev.kind}` },
      h('span', { class: 'kind' }, KIND_LABEL[ev.kind] || '活动'),
      ev.online > 0 ? h('span', { class: 'chip onair' }, `实况中 ${ev.online}`) : ev.hasTrack ? h('span', { class: 'chip' }, icon('flag'), '已设计时线') : null,
      h('div', { class: 'flag' })
    ),
    h(
      'div',
      { class: 'event-body' },
      dateBlock(ev.startsAt),
      h(
        'div',
        { class: 'info' },
        h('h3', null, ev.title),
        h('div', { class: 'row' }, icon('clock'), fmtDateTime(ev.startsAt)),
        ev.place ? h('div', { class: 'row' }, icon('pin'), ev.place) : null,
        h(
          'div',
          { class: 'row' },
          icon('users'),
          `${ev.memberCount}${ev.maxMembers ? ` / ${ev.maxMembers}` : ''} 人 · 组织者 ${ev.owner.nickname}`,
          ev.isMember ? h('span', { class: 'chip accent', style: { marginLeft: '6px' } }, '已加入') : null
        )
      )
    )
  );
}

export async function eventsView({ el, query }) {
  let scope = ['upcoming', 'mine', 'past'].includes(query.scope) ? query.scope : 'upcoming';
  const list = h('div');
  const seg = h('div', { class: 'seg' });

  async function load() {
    clear(seg).append(
      ...[
        ['upcoming', '即将开始'],
        ['mine', '我参加的'],
        ['past', '往期'],
      ].map(([k, label]) => h('button', { class: scope === k ? 'on' : '', onclick: () => ((scope = k), load()) }, label))
    );
    clear(list).appendChild(spinner());
    const { events } = await get(`/events?scope=${scope}`);
    clear(list);
    if (!events.length) {
      list.appendChild(
        empty(scope === 'mine' ? '你还没有参加任何活动' : '暂时没有活动', 'flag', h('a', { class: 'btn primary', href: '#/events/new' }, icon('plus'), '发起活动'))
      );
    }
    for (const ev of events) list.appendChild(eventCard(ev));
  }

  clear(el).appendChild(
    h(
      'div',
      { class: 'page' },
      topbar({
        title: '活动',
        actions: [h('a', { class: 'btn primary small', href: '#/events/new' }, icon('plus'), '发起')],
      }),
      seg,
      list
    )
  );
  await load();
}

/** 发起 / 编辑活动 */
export async function eventFormView({ el, params }) {
  const editing = params.id ? (await get(`/events/${encodeURIComponent(params.id)}`)).event : null;
  if (editing && editing.owner.id !== state.me.id) {
    toast('只有组织者可以编辑活动', 'error');
    location.replace(`#/event/${editing.id}`);
    return;
  }
  let kind = editing?.kind || 'trackday';
  let point = editing ? { lat: editing.lat, lng: editing.lng } : null;

  const title = h('input', { class: 'input', maxlength: 40, placeholder: '例如：周六上赛场赛道日', value: editing?.title || '' });
  const when = h('input', {
    class: 'input', type: 'datetime-local',
    value: toLocalInput(editing?.startsAt || nextSaturday()),
  });
  const place = h('input', { class: 'input', maxlength: 60, placeholder: '集合地点 / 赛道名称', value: editing?.place || '' });
  const desc = h('textarea', {
    class: 'textarea', maxlength: 2000, placeholder: '路线、节奏、装备要求、费用、注意事项……', value: editing?.description || '',
  });
  const max = h('input', { class: 'input', type: 'number', min: 0, max: 500, inputmode: 'numeric', value: editing?.maxMembers || 0 });
  const kinds = h('div', { class: 'chips-select' });
  const drawKinds = () =>
    clear(kinds).append(
      ...Object.entries(KIND_LABEL).map(([k, label]) =>
        h('button', { type: 'button', class: kind === k ? 'on' : '', onclick: () => ((kind = k), drawKinds()) }, label)
      )
    );
  drawKinds();

  const mapEl = h('div', { class: 'map-picker' });
  const pointHint = h('div', { class: 'hint' });
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, editing ? '保存修改' : '发布活动');

  const form = h(
    'form',
    {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        busy(submit, async () => {
          if (!point) throw new Error('请在地图上点选集合地点');
          const startsAt = new Date(when.value).getTime();
          if (!Number.isFinite(startsAt)) throw new Error('请选择活动时间');
          const body = {
            title: title.value, kind, startsAt, place: place.value, description: desc.value,
            lat: point.lat, lng: point.lng, maxMembers: Number(max.value) || 0,
          };
          const r = editing ? await patch(`/events/${editing.id}`, body) : await post('/events', body);
          toast(editing ? '已保存' : '活动已发布', 'success');
          location.replace(`#/event/${r.event.id}`);
        });
      },
    },
    h('label', { class: 'field' }, h('span', null, '活动名称'), title),
    h('div', { class: 'field' }, h('span', null, '类型'), kinds),
    h('label', { class: 'field' }, h('span', null, '时间'), when),
    h('label', { class: 'field' }, h('span', null, '地点名称'), place),
    h(
      'div',
      { class: 'field' },
      h('span', null, '集合点（点击地图选择）'),
      mapEl,
      h(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } },
        h('button', { type: 'button', class: 'btn small', onclick: useMyLocation }, icon('locate'), '使用我的位置'),
        pointHint
      )
    ),
    h('label', { class: 'field' }, h('span', null, '介绍'), desc),
    h('label', { class: 'field' }, h('span', null, '人数上限（0 表示不限）'), max),
    submit,
    editing
      ? h('button', {
          type: 'button', class: 'btn danger block', style: { marginTop: '12px' },
          onclick: async () => {
            if (!(await confirmDialog('删除活动？', '活动、圈速记录和群聊都会被删除，无法恢复。', '删除', true))) return;
            try {
              await del(`/events/${editing.id}`);
              toast('活动已删除');
              location.replace('#/events');
            } catch (e) {
              toast(e.message, 'error');
            }
          },
        }, '删除活动')
      : null
  );

  clear(el).appendChild(h('div', { class: 'page' }, topbar({ title: editing ? '编辑活动' : '发起活动', back: '#/events' }), form));

  // 默认上海国际赛车场附近；有定位权限时自动移到用户附近
  const bm = new BaseMap(mapEl, { center: point || { lat: 31.3389, lng: 121.2197 }, zoom: point ? 14 : 11 });
  let marker = point ? bm.pinMarker(point) : null;
  const setPoint = (p) => {
    point = p;
    if (marker) marker.moveTo(p);
    else marker = bm.pinMarker(p);
    pointHint.textContent = `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
  };
  if (point) pointHint.textContent = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
  bm.map.on('click', (e) => setPoint(bm.fromMap(e.latlng)));

  function useMyLocation() {
    if (!navigator.geolocation) return toast('当前浏览器不支持定位', 'error');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setPoint(p);
        bm.map.setView(bm.toMap(p), 15);
      },
      (err) => toast(geoErrorText(err), 'error'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  return () => bm.remove();
}

export function geoErrorText(err) {
  if (!window.isSecureContext) return '定位需要 HTTPS 访问（或在本机 localhost 打开）';
  if (err?.code === 1) return '定位权限被拒绝，请在浏览器设置中允许';
  if (err?.code === 3) return '定位超时，请到开阔处重试';
  return '无法获取位置';
}

function nextSaturday() {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  d.setHours(8, 30, 0, 0);
  return d.getTime();
}
