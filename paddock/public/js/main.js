// 入口：哈希路由、底部导航、登录守卫、未读通知轮询、Service Worker 注册。
import { get, state } from './api.js';
import { h, icon, clear, spinner, empty, trackNav, toastError } from './ui.js';
import authView from './views/auth.js';
import { feedView, composeView } from './views/feed.js';
import postView from './views/post.js';
import { eventsView, eventFormView } from './views/events.js';
import eventView from './views/event.js';
import liveView from './views/live.js';
import lapView from './views/lap.js';
import inboxView from './views/inbox.js';
import { profileView, settingsView, followsView } from './views/profile.js';
import searchView from './views/search.js';

const routes = [
  ['/login', authView, { public: true, bare: true }],
  ['/feed', feedView, { tab: 'feed' }],
  ['/compose', composeView, { bare: true }],
  ['/post/:id', postView, { bare: true }],
  ['/events', eventsView, { tab: 'events' }],
  ['/events/new', eventFormView, {}],
  ['/event/:id', eventView, { tab: 'events' }],
  ['/event/:id/edit', eventFormView, {}],
  ['/live/:id', liveView, { bare: true }],
  ['/lap/:id', lapView, {}],
  ['/inbox', inboxView, { tab: 'inbox' }],
  ['/user/:id', profileView, { tab: 'me' }],
  ['/user/:id/:type', followsView, {}],
  ['/settings', settingsView, { tab: 'me' }],
  ['/search', searchView, {}],
].map(([pattern, view, opts]) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  return { re, keys, view, ...opts };
});

const TABS = [
  ['feed', '#/feed', '动态', 'home'],
  ['events', '#/events', '活动', 'flag'],
  ['inbox', '#/inbox', '消息', 'bell'],
  ['me', '#/user/me', '我的', 'user'],
];

const viewEl = document.getElementById('view');
const tabbar = document.getElementById('tabbar');
let cleanup = null;
let renderSeq = 0;
let activeTab = null;

function renderTabbar(active) {
  clear(tabbar);
  const inner = h('div', { class: 'inner' });
  for (const [key, href, label, ic] of TABS) {
    inner.appendChild(
      h(
        'a',
        { href, class: key === active ? 'active' : '', 'aria-current': key === active ? 'page' : null },
        icon(ic),
        label,
        key === 'inbox' && state.unread > 0 ? h('span', { class: 'badge' }, state.unread > 99 ? '99+' : state.unread) : null
      )
    );
  }
  tabbar.appendChild(inner);
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/feed';
  const [pathPart, queryPart = ''] = raw.split('?');
  return { path: pathPart, query: Object.fromEntries(new URLSearchParams(queryPart)) };
}

async function render() {
  const seq = ++renderSeq;
  if (cleanup) {
    try {
      cleanup();
    } catch (e) {
      console.error(e);
    }
    cleanup = null;
  }
  let { path, query } = parseHash();
  if (path === '/user/me' && state.me) path = `/user/${state.me.id}`;

  if (!state.token && path !== '/login') {
    location.replace('#/login');
    return;
  }
  if (state.token && !state.me) {
    try {
      const r = await get('/me');
      state.me = r.user;
      state.unread = r.unread;
    } catch (e) {
      if (!state.token) return; // 401 已跳转登录
      clear(viewEl).appendChild(empty(e.message, 'x'));
      return;
    }
    if (seq !== renderSeq) return;
    if (path === '/user/me') path = `/user/${state.me.id}`;
  }

  let route = null;
  let params = {};
  for (const r of routes) {
    const m = r.re.exec(path);
    if (m) {
      route = r;
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      break;
    }
  }
  trackNav(location.hash);
  if (!route) {
    location.replace('#/feed');
    return;
  }
  // 别人的主页不高亮“我的”
  const othersProfile = route.tab === 'me' && params.id && Number(params.id) !== state.me?.id;
  activeTab = othersProfile ? null : route.tab;
  tabbar.classList.toggle('hidden', !!route.bare);
  renderTabbar(activeTab);

  clear(viewEl);
  const el = h('div');
  viewEl.appendChild(el);
  el.appendChild(spinner());
  window.scrollTo(0, 0);
  try {
    const result = await route.view({ el, params, query });
    if (seq !== renderSeq) {
      if (typeof result === 'function') result();
      return;
    }
    if (typeof result === 'function') cleanup = result;
  } catch (e) {
    console.error(e);
    if (seq === renderSeq) {
      clear(el).appendChild(empty(e.message || '加载失败', 'x', h('a', { class: 'btn', href: '#/feed' }, '回到首页')));
    }
  }
}

window.addEventListener('hashchange', render);
render();

// 每 30 秒刷新未读通知数
setInterval(async () => {
  if (!state.token || document.hidden) return;
  try {
    const r = await get('/me');
    if (r.unread !== state.unread) {
      state.unread = r.unread;
      renderTabbar(activeTab);
    }
  } catch {
    /* 忽略 */
  }
}, 30_000);

// 视图修改了 state.unread 后派发此事件以刷新角标
window.addEventListener('paddock:unread', () => renderTabbar(activeTab));

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.status !== undefined) toastError(e.reason);
});
