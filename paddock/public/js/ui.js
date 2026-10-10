// DOM 小工具。所有用户内容都以文本节点插入，杜绝 XSS。
import { icon } from './icons.js';

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export { icon };

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function toast(message, type = 'info', ms = 2600) {
  const box = document.getElementById('toasts');
  for (const old of box.children) if (old.textContent === message) old.remove();
  while (box.children.length >= 3) box.firstChild.remove();
  const t = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, message);
  box.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export function toastError(e) {
  toast(e?.message || String(e), 'error');
}

/** 头像：有图片用图片，否则用昵称首字 + 个人主题色。 */
export function avatar(user, size = 40) {
  const el = h('span', {
    class: 'avatar',
    style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px`, background: user?.color || '#555' },
  });
  if (user?.avatar) el.appendChild(h('img', { src: user.avatar, alt: '', loading: 'lazy' }));
  else el.textContent = (user?.nickname || '?').trim().slice(0, 1).toUpperCase();
  return el;
}

export function userLink(user, ...children) {
  return h('a', { href: `#/user/${user.id}` }, ...children);
}

export function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
  return fmtDate(ts);
}

const pad = (n) => String(n).padStart(2, '0');
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

export function fmtDate(ts) {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${sameYear ? '' : d.getFullYear() + '年'}${d.getMonth() + 1}月${d.getDate()}日`;
}

export function fmtDateTime(ts) {
  const d = new Date(ts);
  return `${fmtDate(ts)} 周${WEEK[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dateBlock(ts) {
  const d = new Date(ts);
  return h('div', { class: 'date-block' }, h('small', null, `${d.getMonth() + 1}月`), h('b', null, d.getDate()));
}

/** datetime-local 输入框需要的本地时间字符串 */
export function toLocalInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function spinner() {
  return h('div', { class: 'spinner', role: 'progressbar', 'aria-label': '加载中' });
}

export function empty(text, iconName = 'flag', action = null) {
  return h('div', { class: 'empty' }, icon(iconName), h('p', null, text), action);
}

export function topbar({ title, back = false, actions = [], brand = false }) {
  return h(
    'header',
    { class: 'topbar' },
    back
      ? h('button', { class: 'icon-btn', 'aria-label': '返回', onclick: () => goBack(typeof back === 'string' ? back : '#/feed') }, icon('back'))
      : null,
    brand
      ? h('h1', { class: 'brand' }, h('img', { src: '/icons/icon.svg', alt: '' }), title)
      : h('h1', null, title),
    ...actions
  );
}

// 应用内浏览栈：直接打开深链接时“返回”跳到上级页面，而不是离开应用
const navStack = [];
export function trackNav(hash) {
  if (navStack.length > 1 && navStack[navStack.length - 2] === hash) navStack.pop();
  else if (navStack[navStack.length - 1] !== hash) navStack.push(hash);
}

export function goBack(fallback) {
  if (navStack.length > 1) history.back();
  else location.hash = fallback;
}

export function modal(build) {
  return new Promise((resolve) => {
    const close = (v) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => e.key === 'Escape' && close(null);
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
    const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => e.target === backdrop && close(null) }, box);
    build(box, close);
    document.body.appendChild(backdrop);
    document.addEventListener('keydown', onKey);
    box.querySelector('button, input, textarea')?.focus();
  });
}

export function confirmDialog(title, message, okText = '确定', danger = false) {
  return modal((box, close) => {
    box.append(
      h('h3', null, title),
      message ? h('p', null, message) : null,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn', onclick: () => close(false) }, '取消'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, okText)
      )
    );
  });
}

export function lightbox(src) {
  const backdrop = h('div', { class: 'modal-backdrop lightbox', onclick: () => backdrop.remove() }, h('img', { src, alt: '' }));
  document.body.appendChild(backdrop);
}

/** 选择图片并在本地压缩为 JPEG data URL（长边不超过 maxSide）。 */
export function pickImage({ maxSide = 1600, quality = 0.85 } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/*' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        const bmp = await loadImage(file);
        const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
        const canvas = h('canvas', { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
        canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch {
        toast('无法读取这张图片', 'error');
        resolve(null);
      }
    });
    input.click();
  });
}

function loadImage(file) {
  if (window.createImageBitmap) return createImageBitmap(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

export const KIND_LABEL = { trackday: '赛道日', touring: '山路巡航', meetup: '车友聚会', roadtrip: '自驾长途' };

/** 按钮执行异步操作期间禁用，避免重复提交。 */
export async function busy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toastError(e);
  } finally {
    btn.disabled = false;
  }
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
