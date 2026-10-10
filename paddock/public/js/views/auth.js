import { post, setSession, state } from '../api.js';
import { h, busy, clear } from '../ui.js';

export default function authView({ el, query }) {
  if (state.token && state.me) {
    location.replace('#/feed');
    return;
  }
  let mode = query.mode === 'register' ? 'register' : 'login';

  function draw() {
    clear(el);
    const username = h('input', { class: 'input', name: 'username', autocomplete: 'username', placeholder: '字母、数字或下划线', required: true });
    const password = h('input', {
      class: 'input', name: 'password', type: 'password', placeholder: mode === 'register' ? '至少 6 位' : '',
      autocomplete: mode === 'register' ? 'new-password' : 'current-password', required: true,
    });
    const nickname = h('input', { class: 'input', name: 'nickname', placeholder: '车友们怎么称呼你', maxlength: 20 });
    const car = h('input', { class: 'input', name: 'car', placeholder: '例如 Porsche 911 GT3 / BMW M4', maxlength: 40 });
    const submit = h('button', { class: 'btn primary block', type: 'submit' }, mode === 'login' ? '登录' : '注册并进入');

    const form = h(
      'form',
      {
        onsubmit: (e) => {
          e.preventDefault();
          busy(submit, async () => {
            const body = { username: username.value.trim(), password: password.value };
            if (mode === 'register') Object.assign(body, { nickname: nickname.value.trim(), car: car.value.trim() });
            const r = await post(mode === 'login' ? '/auth/login' : '/auth/register', body);
            setSession(r.token, r.user);
            location.replace(mode === 'register' ? '#/events' : '#/feed');
          });
        },
      },
      h('label', { class: 'field' }, h('span', null, '用户名'), username),
      h('label', { class: 'field' }, h('span', null, '密码'), password),
      mode === 'register' ? h('label', { class: 'field' }, h('span', null, '昵称'), nickname) : null,
      mode === 'register' ? h('label', { class: 'field' }, h('span', null, '座驾（选填）'), car) : null,
      submit
    );

    el.appendChild(
      h(
        'div',
        { class: 'auth' },
        h(
          'div',
          { class: 'hero' },
          h('img', { src: '/icons/icon.svg', alt: '' }),
          h('h1', null, '围场 Paddock'),
          h('p', null, '约跑 · 实时位置 · 圈速遥测 · 车队对讲'),
          h('div', { class: 'stripes' })
        ),
        h(
          'div',
          { class: 'seg', style: { margin: '0 0 20px' } },
          h('button', { type: 'button', class: mode === 'login' ? 'on' : '', onclick: () => ((mode = 'login'), draw()) }, '登录'),
          h('button', { type: 'button', class: mode === 'register' ? 'on' : '', onclick: () => ((mode = 'register'), draw()) }, '注册')
        ),
        form
      )
    );
    username.focus();
  }
  draw();
}
