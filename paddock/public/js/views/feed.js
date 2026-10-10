import { get, post, del, state } from '../api.js';
import {
  h, icon, clear, topbar, avatar, userLink, timeAgo, empty, spinner, toast, busy, confirmDialog, lightbox,
  pickImage, dateBlock, KIND_LABEL, fmtDateTime, goBack,
} from '../ui.js';
import { fmtLap, fmtSector, kmh } from '../shared/format.js';

/** 圈速卡片：动态、主页、发帖预览共用。 */
export function lapCard(lap, user) {
  return h(
    'a',
    { class: 'lap-card', href: `#/lap/${lap.id}` },
    h(
      'div',
      { class: 'top' },
      h('span', { class: 'label' }, '单圈成绩 · LAP TIME'),
      user ? h('span', { class: 'label' }, user.nickname) : null
    ),
    h('div', { class: 'time mono' }, fmtLap(lap.lapMs)),
    h('div', { class: 'sub' }, lap.eventTitle || '', lap.car ? ` · ${lap.car}` : ''),
    h(
      'div',
      { class: 'stats' },
      h('span', null, '极速 ', h('b', null, kmh(lap.maxSpeed)), ' km/h'),
      h('span', null, '均速 ', h('b', null, kmh(lap.avgSpeed)), ' km/h'),
      lap.sectors ? h('span', null, lap.sectors.map((s, i) => `S${i + 1} ${fmtSector(s)}`).join('  ')) : null
    )
  );
}

export function eventMini(ev) {
  return h(
    'a',
    { class: 'event-mini', href: `#/event/${ev.id}` },
    dateBlock(ev.startsAt),
    h(
      'div',
      { style: { minWidth: 0 } },
      h('b', null, ev.title),
      h('div', { class: 'muted', style: { fontSize: '13px' } }, `${KIND_LABEL[ev.kind] || ''} · ${fmtDateTime(ev.startsAt)}`),
      ev.place ? h('div', { class: 'dim', style: { fontSize: '12px' } }, ev.place) : null
    )
  );
}

export function postCard(p, { onDeleted } = {}) {
  const likeCount = h('span', null, p.likes || '');
  const likeBtn = h('button', { class: p.liked ? 'liked' : '', 'aria-label': '点赞', 'aria-pressed': String(p.liked) }, icon('heart'), likeCount);
  likeBtn.addEventListener('click', async () => {
    const was = p.liked;
    p.liked = !was;
    p.likes += was ? -1 : 1;
    likeBtn.classList.toggle('liked', p.liked);
    likeBtn.setAttribute('aria-pressed', String(p.liked));
    likeCount.textContent = p.likes || '';
    try {
      if (was) await del(`/posts/${p.id}/like`);
      else await post(`/posts/${p.id}/like`);
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  const mine = p.user.id === state.me?.id;
  const card = h(
    'article',
    { class: 'post' },
    h(
      'div',
      { class: 'post-head' },
      userLink(p.user, avatar(p.user, 40)),
      h(
        'div',
        { class: 'who' },
        userLink(p.user, h('div', { class: 'name' }, p.user.nickname)),
        h('div', { class: 'meta' }, timeAgo(p.createdAt), p.user.car ? ` · ${p.user.car}` : '')
      ),
      mine
        ? h(
            'button',
            {
              class: 'icon-btn', 'aria-label': '删除',
              onclick: async () => {
                if (!(await confirmDialog('删除这条动态？', '删除后无法恢复。', '删除', true))) return;
                try {
                  await del(`/posts/${p.id}`);
                  card.remove();
                  onDeleted?.();
                } catch (e) {
                  toast(e.message, 'error');
                }
              },
            },
            icon('trash')
          )
        : null
    ),
    p.text ? h('p', { class: 'post-text' }, p.text) : null,
    p.image ? h('div', { class: 'post-image', onclick: () => lightbox(p.image) }, h('img', { src: p.image, alt: '', loading: 'lazy' })) : null,
    p.lap ? lapCard(p.lap, p.user) : null,
    p.event ? eventMini(p.event) : null,
    h(
      'div',
      { class: 'post-actions' },
      likeBtn,
      h('a', { href: `#/post/${p.id}` }, icon('comment'), h('span', null, p.comments || '')),
      h(
        'button',
        {
          'aria-label': '分享',
          onclick: async () => {
            const url = `${location.origin}/#/post/${p.id}`;
            try {
              if (navigator.share) await navigator.share({ title: '围场 Paddock', text: p.text?.slice(0, 60) || '', url });
              else {
                await navigator.clipboard.writeText(url);
                toast('链接已复制');
              }
            } catch {
              /* 用户取消 */
            }
          },
        },
        icon('share')
      )
    )
  );
  return card;
}

/** 分页加载的动态列表 */
export function postList(container, loader) {
  let before = null;
  let done = false;
  const list = h('div');
  const more = h('button', { class: 'btn outline small more-btn hidden' }, '加载更多');
  container.append(list, more);
  async function load() {
    if (done) return;
    more.classList.add('hidden');
    const sp = spinner();
    list.appendChild(sp);
    try {
      const posts = await loader(before);
      sp.remove();
      if (!posts.length && before === null) list.appendChild(empty('这里还没有动态', 'comment'));
      for (const p of posts) list.appendChild(postCard(p));
      if (posts.length) before = posts[posts.length - 1].id;
      done = posts.length < 20;
      more.classList.toggle('hidden', done);
    } catch (e) {
      sp.remove();
      toast(e.message, 'error');
      more.classList.remove('hidden');
    }
  }
  more.addEventListener('click', load);
  return load();
}

export async function feedView({ el }) {
  let scope;
  try {
    scope = localStorage.getItem('paddock.feedScope') || 'all';
  } catch {
    scope = 'all';
  }
  const body = h('div');
  const seg = h('div', { class: 'seg' });
  function drawSeg() {
    clear(seg).append(
      h('button', { class: scope === 'all' ? 'on' : '', onclick: () => switchTo('all') }, '广场'),
      h('button', { class: scope === 'following' ? 'on' : '', onclick: () => switchTo('following') }, '关注')
    );
  }
  function switchTo(s) {
    scope = s;
    try {
      localStorage.setItem('paddock.feedScope', s);
    } catch {
      /* 忽略 */
    }
    drawSeg();
    clear(body);
    postList(body, (before) => get(`/feed?scope=${scope}${before ? `&before=${before}` : ''}`).then((r) => r.posts));
  }
  clear(el).appendChild(
    h(
      'div',
      { class: 'page' },
      topbar({
        title: '围场',
        brand: true,
        actions: [h('a', { class: 'icon-btn', href: '#/search', 'aria-label': '搜索' }, icon('search'))],
      }),
      seg,
      body,
      h('a', { class: 'fab', href: '#/compose', 'aria-label': '发动态' }, icon('plus'))
    )
  );
  switchTo(scope);
}

export async function composeView({ el, query }) {
  const lap = query.lap ? (await get(`/laps/${encodeURIComponent(query.lap)}`)).lap : null;
  const ev = query.event ? (await get(`/events/${encodeURIComponent(query.event)}`)).event : null;
  let image = null;
  const text = h('textarea', {
    class: 'textarea', maxlength: 1000, placeholder: lap ? '说说这一圈…' : ev ? '邀请车友一起来…' : '分享你的座驾、赛道日或今天的山路…',
  });
  const imgBox = h('div');
  const publish = h('button', { class: 'btn primary small' }, '发布');

  function drawImage() {
    clear(imgBox);
    if (image) {
      imgBox.appendChild(
        h('div', { class: 'attach' }, h('img', { src: image, alt: '' }),
          h('button', { class: 'remove', 'aria-label': '移除图片', onclick: () => ((image = null), drawImage()) }, icon('x')))
      );
    }
  }

  publish.addEventListener('click', () =>
    busy(publish, async () => {
      await post('/posts', { text: text.value, image, lapId: lap?.id, eventId: ev?.id });
      toast('已发布', 'success');
      location.replace('#/feed');
    })
  );

  const lapForCard = lap && { ...lap, eventTitle: lap.event?.title };
  clear(el).appendChild(
    h(
      'div',
      { class: 'page' },
      topbar({ title: '发动态', back: '#/feed', actions: [publish] }),
      h(
        'div',
        { class: 'composer' },
        h('div', { class: 'post-head' }, avatar(state.me, 40), h('b', null, state.me.nickname)),
        text,
        imgBox,
        lapForCard ? lapCard(lapForCard, lap.user) : null,
        ev ? eventMini(ev) : null,
        h(
          'div',
          { class: 'tools' },
          h('button', {
            class: 'btn small',
            onclick: async () => {
              const d = await pickImage();
              if (d) {
                image = d;
                drawImage();
              }
            },
          }, icon('image'), '图片'),
          h('button', { class: 'btn small outline', onclick: () => goBack('#/feed') }, '取消')
        )
      )
    )
  );
  text.focus();
}
