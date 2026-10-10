import { get, post, del, state } from '../api.js';
import { h, icon, clear, topbar, avatar, userLink, timeAgo, empty, busy, toast } from '../ui.js';
import { postCard } from './feed.js';

export default async function postView({ el, params }) {
  const { post: p, comments } = await get(`/posts/${encodeURIComponent(params.id)}`);
  const list = h('div', { class: 'comments' });

  function commentRow(c) {
    const canDelete = c.user.id === state.me.id || p.user.id === state.me.id;
    const row = h(
      'div',
      { class: 'comment' },
      userLink(c.user, avatar(c.user, 34)),
      h('div', { class: 'body' }, userLink(c.user, h('b', null, c.user.nickname)), h('p', null, c.text), h('small', null, timeAgo(c.createdAt))),
      canDelete
        ? h('button', {
            class: 'icon-btn', 'aria-label': '删除评论',
            onclick: async () => {
              try {
                await del(`/comments/${c.id}`);
                row.remove();
              } catch (e) {
                toast(e.message, 'error');
              }
            },
          }, icon('x'))
        : null
    );
    return row;
  }

  if (!comments.length) list.appendChild(empty('还没有评论，来抢沙发', 'comment'));
  for (const c of comments) list.appendChild(commentRow(c));

  const input = h('input', { class: 'input', placeholder: '写评论…', maxlength: 500, enterkeyhint: 'send' });
  const send = h('button', { class: 'btn primary small', type: 'submit' }, '发送');
  const form = h('form', {
    class: 'inner',
    onsubmit: (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      busy(send, async () => {
        const r = await post(`/posts/${p.id}/comments`, { text });
        if (!comments.length) clear(list);
        comments.push(r.comment);
        list.appendChild(commentRow(r.comment));
        input.value = '';
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      });
    },
  }, input, send);

  clear(el).appendChild(
    h(
      'div',
      { class: 'page', style: { paddingBottom: '90px' } },
      topbar({ title: '动态', back: '#/feed' }),
      postCard(p, { onDeleted: () => (location.hash = '#/feed') }),
      list,
      h('div', { class: 'input-bar' }, form)
    )
  );
}
