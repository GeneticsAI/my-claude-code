import { get, post, state } from '../api.js';
import { h, clear, topbar, avatar, timeAgo, empty } from '../ui.js';

const TEXT = {
  like: '赞了你的动态',
  comment: '评论了你的动态',
  follow: '关注了你',
  join: '报名了你的活动',
};

export default async function inboxView({ el }) {
  const { notifications } = await get('/notifications');
  const list = h('div');
  if (!notifications.length) list.appendChild(empty('暂时没有新消息', 'bell'));
  for (const n of notifications) {
    const href = n.postId ? `#/post/${n.postId}` : n.eventId ? `#/event/${n.eventId}` : `#/user/${n.actor.id}`;
    const quote = n.postText ? n.postText.slice(0, 40) : n.eventTitle;
    list.appendChild(
      h(
        'a',
        { class: `notice${n.read ? '' : ' unread'}`, href },
        avatar(n.actor, 40),
        h(
          'div',
          { class: 'body' },
          h('p', null, h('b', null, n.actor.nickname), ' ', TEXT[n.kind] || '与你互动', quote ? [' ', h('q', null, quote)] : null),
          h('small', null, timeAgo(n.createdAt))
        )
      )
    );
  }
  clear(el).appendChild(h('div', { class: 'page' }, topbar({ title: '消息' }), list));
  if (notifications.some((n) => !n.read)) {
    await post('/notifications/read');
    state.unread = 0;
    window.dispatchEvent(new Event('paddock:unread'));
  }
}
