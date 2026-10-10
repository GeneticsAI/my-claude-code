import { get, post, patch, del, state, setSession } from '../api.js';
import {
  h, icon, clear, topbar, avatar, empty, spinner, busy, toast, confirmDialog, pickImage, fmtDate, userLink,
} from '../ui.js';
import { postList } from './feed.js';
import { eventCard } from './events.js';
import { fmtLap, kmh } from '../shared/format.js';

export async function profileView({ el, params }) {
  const { user: u } = await get(`/users/${encodeURIComponent(params.id)}`);
  const isMe = u.id === state.me.id;
  let tab = 'posts';
  const body = h('div');
  const seg = h('div', { class: 'seg' });

  const followersCount = h('b', null, u.stats.followers);
  const followBtn = h('button', { class: 'btn' });
  function drawFollow() {
    clear(followBtn);
    followBtn.className = `btn ${u.isFollowing ? 'outline' : 'primary'}`;
    followBtn.append(u.isFollowing ? '已关注' : u.followsYou ? '回关' : '关注');
  }
  followBtn.addEventListener('click', () =>
    busy(followBtn, async () => {
      if (u.isFollowing) await del(`/users/${u.id}/follow`);
      else await post(`/users/${u.id}/follow`);
      u.isFollowing = !u.isFollowing;
      u.stats.followers += u.isFollowing ? 1 : -1;
      followersCount.textContent = u.stats.followers;
      drawFollow();
    })
  );
  drawFollow();

  async function drawTab() {
    clear(seg).append(
      ...[
        ['posts', `动态 ${u.stats.posts}`],
        ['laps', '圈速'],
        ['events', `活动 ${u.stats.events}`],
      ].map(([k, label]) => h('button', { class: tab === k ? 'on' : '', onclick: () => ((tab = k), drawTab()) }, label))
    );
    clear(body);
    if (tab === 'posts') {
      return postList(body, (before) => get(`/users/${u.id}/posts${before ? `?before=${before}` : ''}`).then((r) => r.posts));
    }
    body.appendChild(spinner());
    if (tab === 'laps') {
      const { laps } = await get(`/users/${u.id}/laps`);
      clear(body);
      if (!laps.length) return body.appendChild(empty('还没有圈速记录', 'trophy'));
      body.appendChild(h('div', { class: 'section-title' }, '各活动个人最佳'));
      for (const l of laps) {
        body.appendChild(
          h(
            'a',
            { class: 'pb-row', href: `#/lap/${l.id}` },
            h('div', { class: 'info' }, h('b', null, l.eventTitle), h('small', null, `${fmtDate(l.eventStartsAt)} · ${l.car || '未填写座驾'} · 极速 ${kmh(l.maxSpeed)} km/h`)),
            h('div', { class: 'time' }, fmtLap(l.lapMs), h('small', null, `${(l.distance / 1000).toFixed(2)} km`)),
            icon('chevron')
          )
        );
      }
    } else {
      const { events } = await get(`/users/${u.id}/events`);
      clear(body);
      if (!events.length) return body.appendChild(empty('还没有参加活动', 'flag'));
      body.appendChild(h('div', { style: { height: '4px' } }));
      for (const ev of events) body.appendChild(eventCard(ev));
    }
  }

  clear(el).appendChild(
    h(
      'div',
      { class: 'page' },
      topbar({
        title: isMe ? '我的' : u.nickname,
        back: isMe ? false : '#/feed',
        actions: isMe ? [h('a', { class: 'icon-btn', href: '#/settings', 'aria-label': '设置' }, icon('settings'))] : [],
      }),
      h(
        'section',
        { class: 'profile-head' },
        h(
          'div',
          { class: 'top' },
          avatar(u, 72),
          h('div', { style: { minWidth: 0 } }, h('h2', null, u.nickname), h('div', { class: 'handle' }, `@${u.username}`, u.followsYou && !isMe ? ' · 关注了你' : ''))
        ),
        u.car ? h('div', { class: 'car-line' }, icon('car'), u.car) : null,
        u.bio ? h('p', { class: 'bio' }, u.bio) : null,
        h(
          'div',
          { class: 'stats-row' },
          h('a', { href: `#/user/${u.id}/following` }, h('b', null, u.stats.following), h('small', null, '关注')),
          h('a', { href: `#/user/${u.id}/followers` }, followersCount, h('small', null, '粉丝')),
          h('div', null, h('b', null, u.stats.events), h('small', null, '活动')),
          h('div', null, h('b', null, u.stats.laps), h('small', null, '计时圈'))
        ),
        isMe
          ? h('div', { class: 'profile-actions' }, h('a', { class: 'btn outline', href: '#/settings' }, icon('edit'), '编辑资料'), h('a', { class: 'btn primary', href: '#/compose' }, icon('plus'), '发动态'))
          : h('div', { class: 'profile-actions' }, followBtn)
      ),
      seg,
      body
    )
  );
  await drawTab();
}

export async function followsView({ el, params }) {
  if (!['followers', 'following'].includes(params.type)) {
    location.replace(`#/user/${params.id}`);
    return;
  }
  const [{ user: u }, { users }] = await Promise.all([
    get(`/users/${encodeURIComponent(params.id)}`),
    get(`/users/${encodeURIComponent(params.id)}/${params.type}`),
  ]);
  const list = h('div');
  if (!users.length) list.appendChild(empty(params.type === 'followers' ? '还没有粉丝' : '还没有关注任何人', 'users'));
  for (const x of users) list.appendChild(userRow(x));
  clear(el).appendChild(
    h('div', { class: 'page' }, topbar({ title: `${u.nickname} 的${params.type === 'followers' ? '粉丝' : '关注'}`, back: `#/user/${u.id}` }), list)
  );
}

export function userRow(x) {
  return userLink(
    x,
    h('div', { class: 'user-row' }, avatar(x, 44), h('div', { class: 'who' }, h('b', null, x.nickname), h('small', null, [x.car, x.bio].filter(Boolean).join(' · ') || `@${x.username}`)), icon('chevron'))
  );
}

export async function settingsView({ el }) {
  const me = state.me;
  const { colors } = await get('/colors');
  let color = me.color;
  const avatarBox = h('div');
  const drawAvatar = () => clear(avatarBox).appendChild(avatar({ ...me, color }, 72));
  drawAvatar();

  const nickname = h('input', { class: 'input', maxlength: 20, value: me.nickname });
  const car = h('input', { class: 'input', maxlength: 40, value: me.car, placeholder: '例如 Porsche 911 GT3 RS' });
  const bio = h('textarea', { class: 'textarea', maxlength: 160, value: me.bio, placeholder: '介绍一下你和你的车', style: { minHeight: '80px' } });
  const picker = h('div', { class: 'color-picker' });
  const drawColors = () =>
    clear(picker).append(
      ...colors.map((c) =>
        h('button', { type: 'button', class: c === color ? 'on' : '', style: { background: c }, 'aria-label': `颜色 ${c}`, onclick: () => ((color = c), drawColors(), drawAvatar()) })
      )
    );
  drawColors();

  const save = h('button', { class: 'btn primary block', type: 'submit' }, '保存');
  const uploadBtn = h('button', { type: 'button', class: 'btn small' }, icon('image'), '更换头像');
  uploadBtn.addEventListener('click', async () => {
    const img = await pickImage({ maxSide: 400, quality: 0.88 });
    if (!img) return;
    busy(uploadBtn, async () => {
      const r = await post('/me/avatar', { image: img });
      Object.assign(me, r.user);
      drawAvatar();
      toast('头像已更新', 'success');
    });
  });

  clear(el).appendChild(
    h(
      'div',
      { class: 'page' },
      topbar({ title: '编辑资料', back: `#/user/${me.id}` }),
      h(
        'form',
        {
          class: 'form',
          onsubmit: (e) => {
            e.preventDefault();
            busy(save, async () => {
              const r = await patch('/me', { nickname: nickname.value, car: car.value, bio: bio.value, color });
              Object.assign(me, r.user);
              toast('已保存', 'success');
              location.hash = `#/user/${me.id}`;
            });
          },
        },
        h('div', { class: 'avatar-edit' }, avatarBox, uploadBtn),
        h('label', { class: 'field' }, h('span', null, '昵称'), nickname),
        h('label', { class: 'field' }, h('span', null, '座驾'), car),
        h('label', { class: 'field' }, h('span', null, '简介'), bio),
        h('div', { class: 'field' }, h('span', null, '车队颜色（地图标记和排行榜使用）'), picker),
        save
      ),
      h('div', { class: 'section-title' }, '账号'),
      h(
        'div',
        { class: 'form', style: { paddingTop: 0 } },
        h('button', {
          class: 'btn danger block',
          onclick: async () => {
            if (!(await confirmDialog('退出登录？', null, '退出', true))) return;
            try {
              await post('/auth/logout');
            } catch {
              /* 忽略 */
            }
            setSession(null, null);
            location.replace('#/login');
          },
        }, icon('logout'), '退出登录'),
        h(
          'p',
          { class: 'hint', style: { marginTop: '16px', lineHeight: 1.6 } },
          '隐私说明：你的实时位置只在你主动「开始共享位置」后发送，且只对同一活动的成员可见，服务器不保存位置历史；只有完成的计时圈轨迹会被保存，用于圈速分析。'
        )
      )
    )
  );
}
