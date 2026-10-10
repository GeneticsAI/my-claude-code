import { get } from '../api.js';
import { h, clear, topbar, empty, debounce, toast } from '../ui.js';
import { userRow } from './profile.js';
import { eventCard } from './events.js';

export default function searchView({ el, query }) {
  const input = h('input', { class: 'input', type: 'search', placeholder: '搜索车友、座驾或活动', value: query.q || '', enterkeyhint: 'search' });
  const results = h('div');
  let seq = 0;

  const run = debounce(async () => {
    const q = input.value.trim();
    const my = ++seq;
    if (!q) {
      clear(results).appendChild(empty('输入昵称、车型或活动名称', 'search'));
      return;
    }
    try {
      const r = await get(`/search?q=${encodeURIComponent(q)}`);
      if (my !== seq) return;
      clear(results);
      if (!r.users.length && !r.events.length) return results.appendChild(empty('没有找到相关结果', 'search'));
      if (r.users.length) {
        results.appendChild(h('div', { class: 'section-title' }, '车友'));
        for (const u of r.users) results.appendChild(userRow(u));
      }
      if (r.events.length) {
        results.appendChild(h('div', { class: 'section-title' }, '活动'));
        for (const ev of r.events) results.appendChild(eventCard(ev));
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }, 250);

  input.addEventListener('input', run);
  clear(el).appendChild(h('div', { class: 'page' }, topbar({ title: '搜索', back: '#/feed' }), h('div', { class: 'search-box' }, input), results));
  input.focus();
  run();
}
