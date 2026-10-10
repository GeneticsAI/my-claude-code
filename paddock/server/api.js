// REST 接口：账号、个人主页、关注、动态、评论点赞、活动、圈速、通知、搜索。
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './http.js';
import * as v from './validate.js';
import { USER_COLORS } from './store.js';

const IMAGE_LIMIT = 3 * 1024 * 1024;

async function saveImage(dataUrl, dir) {
  if (typeof dataUrl !== 'string') fail(400, '图片格式错误');
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) fail(400, '只支持 JPG / PNG / WebP 图片');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > IMAGE_LIMIT) fail(413, '图片不能超过 3MB');
  const ok =
    (m[1] === 'jpeg' && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ||
    (m[1] === 'png' && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) ||
    (m[1] === 'webp' && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP');
  if (!ok) fail(400, '图片内容无效');
  const name = `${randomBytes(12).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  await writeFile(path.join(dir, name), buf);
  return `/uploads/${name}`;
}

/** 简单的按 IP 限流（登录 / 注册防爆破）。 */
function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      if (hits.size > 10_000) for (const [k, x] of hits) if (x.reset < now) hits.delete(k);
      return;
    }
    if (++h.n > max) fail(429, '操作太频繁，请稍后再试');
  };
}

export function registerApi(router, { store, rt, uploadsDir }) {
  const authLimit = limiter(20, 10 * 60 * 1000);
  const R = (method, pattern, handler, opts = {}) => router.add(method, '/api' + pattern, Object.assign(handler, opts));

  const requireEvent = (id, user) => {
    const ev = store.getEvent(id, user.id);
    if (!ev) fail(404, '活动不存在');
    return ev;
  };
  const requireOwner = (id, user) => {
    const owner = store.eventOwner(id);
    if (owner == null) fail(404, '活动不存在');
    if (owner !== user.id) fail(403, '只有组织者可以这样做');
  };
  const requirePost = (id, user) => {
    const p = store.getPost(id, user.id);
    if (!p) fail(404, '动态不存在');
    return p;
  };

  // ---------- 账号 ----------

  R('POST', '/auth/register', ({ body, ip }) => {
    authLimit(ip);
    const username = v.text(body.username, { name: '用户名', min: 3, max: 20 });
    if (!/^[A-Za-z0-9_]+$/.test(username)) fail(400, '用户名只能包含字母、数字和下划线');
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 6 || password.length > 100) fail(400, '密码至少 6 位');
    const nickname = v.text(body.nickname || username, { name: '昵称', min: 1, max: 20 });
    const car = v.text(body.car, { name: '座驾', max: 40 });
    if (store.usernameTaken(username)) fail(409, '用户名已被占用');
    const user = store.createUser({ username, password, nickname, car });
    return { token: store.createSession(user.id), user };
  }, { public: true });

  R('POST', '/auth/login', ({ body, ip }) => {
    authLimit(ip);
    const user = store.checkLogin(String(body.username || ''), String(body.password || ''));
    if (!user) fail(401, '用户名或密码错误');
    return { token: store.createSession(user.id), user };
  }, { public: true });

  R('POST', '/auth/logout', ({ token }) => {
    store.deleteSession(token);
    return { ok: true };
  });

  R('GET', '/me', ({ user }) => ({ user, unread: store.unreadCount(user.id) }));

  R('PATCH', '/me', ({ user, body }) => {
    const f = {};
    if (body.nickname !== undefined) f.nickname = v.text(body.nickname, { name: '昵称', min: 1, max: 20 });
    if (body.bio !== undefined) f.bio = v.text(body.bio, { name: '简介', max: 160 });
    if (body.car !== undefined) f.car = v.text(body.car, { name: '座驾', max: 40 });
    if (body.color !== undefined) {
      if (!USER_COLORS.includes(body.color)) fail(400, '颜色无效');
      f.color = body.color;
    }
    return { user: store.updateUser(user.id, f) };
  });

  R('POST', '/me/avatar', async ({ user, body }) => {
    const avatar = await saveImage(body.image, uploadsDir);
    return { user: store.updateUser(user.id, { avatar }) };
  }, { bodyLimit: 4.5 * 1024 * 1024 });

  R('GET', '/colors', () => ({ colors: USER_COLORS }));

  // ---------- 用户与关注 ----------

  R('GET', '/users/:id', ({ user, params }) => {
    const p = store.profile(v.id(params.id), user.id);
    if (!p) fail(404, '用户不存在');
    return { user: p };
  });

  R('GET', '/users/:id/posts', ({ user, params, query }) => ({
    posts: store.userPosts(v.id(params.id), user.id, { before: query.before ? v.id(query.before) : null }),
  }));

  R('GET', '/users/:id/laps', ({ params }) => ({ laps: store.userLaps(v.id(params.id)) }));

  R('GET', '/users/:id/events', ({ user, params }) => ({
    events: store.listEvents(user.id, { scope: 'mine', userId: v.id(params.id) }),
  }));

  R('GET', '/users/:id/:type', ({ params }) => {
    if (!['followers', 'following'].includes(params.type)) fail(404, '不存在');
    return { users: store.followList(v.id(params.id), params.type) };
  });

  R('POST', '/users/:id/follow', ({ user, params }) => {
    const target = v.id(params.id);
    if (target === user.id) fail(400, '不能关注自己');
    if (!store.getUser(target)) fail(404, '用户不存在');
    store.follow(user.id, target);
    return { ok: true };
  });

  R('DELETE', '/users/:id/follow', ({ user, params }) => {
    store.unfollow(user.id, v.id(params.id));
    return { ok: true };
  });

  R('GET', '/search', ({ user, query }) => {
    const q = String(query.q || '').trim().slice(0, 40);
    if (!q) return { users: [], events: [] };
    const like = q.toLowerCase();
    const events = store
      .listEvents(user.id, { scope: 'upcoming', limit: 200 })
      .concat(store.listEvents(user.id, { scope: 'past', limit: 200 }))
      .filter((e) => (e.title + e.place).toLowerCase().includes(like))
      .slice(0, 20);
    return { users: store.searchUsers(q), events };
  });

  // ---------- 动态 ----------

  R('GET', '/feed', ({ user, query }) => ({
    posts: store.feed(user.id, {
      scope: query.scope === 'following' ? 'following' : 'all',
      before: query.before ? v.id(query.before) : null,
    }),
  }));

  R('POST', '/posts', async ({ user, body }) => {
    const text = v.text(body.text, { name: '内容', max: 1000 });
    let lapId = null;
    let eventId = null;
    if (body.lapId != null) {
      const lap = store.lapSummary(v.id(body.lapId));
      if (!lap) fail(404, '圈速记录不存在');
      lapId = lap.id;
    }
    if (body.eventId != null) {
      if (!store.eventSummary(v.id(body.eventId))) fail(404, '活动不存在');
      eventId = v.id(body.eventId);
    }
    const image = body.image ? await saveImage(body.image, uploadsDir) : null;
    if (!text && !image && !lapId && !eventId) fail(400, '写点什么吧');
    return { post: store.createPost(user.id, { text, image, lapId, eventId }) };
  }, { bodyLimit: 4.5 * 1024 * 1024 });

  R('GET', '/posts/:id', ({ user, params }) => {
    const post = requirePost(v.id(params.id), user);
    return { post, comments: store.comments(post.id) };
  });

  R('DELETE', '/posts/:id', ({ user, params }) => {
    if (!store.deletePost(v.id(params.id), user.id)) fail(404, '动态不存在');
    return { ok: true };
  });

  R('POST', '/posts/:id/like', ({ user, params }) => {
    const post = requirePost(v.id(params.id), user);
    store.like(post.id, user.id);
    return { ok: true };
  });

  R('DELETE', '/posts/:id/like', ({ user, params }) => {
    store.unlike(v.id(params.id), user.id);
    return { ok: true };
  });

  R('POST', '/posts/:id/comments', ({ user, params, body }) => {
    const post = requirePost(v.id(params.id), user);
    const text = v.text(body.text, { name: '评论', min: 1, max: 500 });
    return { comment: store.addComment(post.id, user.id, text) };
  });

  R('DELETE', '/comments/:id', ({ user, params }) => {
    if (!store.deleteComment(v.id(params.id), user.id)) fail(404, '评论不存在');
    return { ok: true };
  });

  // ---------- 活动 ----------

  const eventFields = (body, partial) => {
    const f = {};
    const has = (k) => !partial || body[k] !== undefined;
    if (has('title')) f.title = v.text(body.title, { name: '标题', min: 2, max: 40 });
    if (has('description')) f.description = v.text(body.description, { name: '介绍', max: 2000 });
    if (has('kind')) {
      if (!v.EVENT_KINDS.includes(body.kind)) fail(400, '活动类型无效');
      f.kind = body.kind;
    }
    if (has('startsAt')) f.startsAt = v.num(body.startsAt, { name: '时间', min: 0, int: true });
    if (has('place')) f.place = v.text(body.place, { name: '地点', max: 60 });
    if (has('lat')) f.lat = v.num(body.lat, { name: '纬度', min: -90, max: 90 });
    if (has('lng')) f.lng = v.num(body.lng, { name: '经度', min: -180, max: 180 });
    if (has('maxMembers')) f.maxMembers = v.num(body.maxMembers ?? 0, { name: '人数上限', min: 0, max: 500, int: true });
    return f;
  };

  R('GET', '/events', ({ user, query }) => ({
    events: store
      .listEvents(user.id, { scope: ['upcoming', 'past', 'mine'].includes(query.scope) ? query.scope : 'upcoming' })
      .map((e) => ({ ...e, online: rt.onlineCount(e.id) })),
  }));

  R('POST', '/events', ({ user, body }) => {
    const id = store.createEvent(user.id, eventFields(body, false));
    return { event: store.getEvent(id, user.id) };
  });

  R('GET', '/events/:id', ({ user, params }) => {
    const ev = requireEvent(v.id(params.id), user);
    return { event: { ...ev, online: rt.onlineCount(ev.id), role: ev.members.find((m) => m.id === user.id)?.role ?? null } };
  });

  R('PATCH', '/events/:id', ({ user, params, body }) => {
    const id = v.id(params.id);
    requireOwner(id, user);
    const f = eventFields(body, true);
    if (body.startLine !== undefined) f.startLine = body.startLine === null ? null : v.line(body.startLine, '起终点线');
    if (body.sectorLines !== undefined) {
      if (!Array.isArray(body.sectorLines) || body.sectorLines.length > 5) fail(400, '分段线最多 5 条');
      f.sectorLines = body.sectorLines.map((l) => v.line(l, '分段线'));
    }
    if (body.path !== undefined) f.path = v.path(body.path);
    store.updateEvent(id, f);
    if (body.startLine !== undefined || body.sectorLines !== undefined || body.path !== undefined) {
      rt.broadcastTrack(id, store.eventTrack(id));
    }
    return { event: store.getEvent(id, user.id) };
  }, { bodyLimit: 512 * 1024 });

  R('DELETE', '/events/:id', ({ user, params }) => {
    const id = v.id(params.id);
    requireOwner(id, user);
    store.deleteEvent(id);
    rt.closeRoom(id);
    return { ok: true };
  });

  R('POST', '/events/:id/join', ({ user, params }) => {
    const ev = requireEvent(v.id(params.id), user);
    if (!ev.isMember && ev.maxMembers > 0 && ev.memberCount >= ev.maxMembers) fail(409, '活动名额已满');
    if (store.join(ev.id, user.id)) rt.memberJoined(ev.id, { ...user, role: 'member' });
    return { ok: true };
  });

  R('DELETE', '/events/:id/join', ({ user, params }) => {
    const ev = requireEvent(v.id(params.id), user);
    if (ev.owner.id === user.id) fail(400, '组织者不能退出自己的活动');
    store.leave(ev.id, user.id);
    rt.kick(ev.id, user.id);
    return { ok: true };
  });

  R('GET', '/events/:id/board', ({ user, params }) => {
    const ev = requireEvent(v.id(params.id), user);
    return { board: store.board(ev.id) };
  });

  R('GET', '/events/:id/messages', ({ user, params, query }) => {
    const id = v.id(params.id);
    if (!store.isMember(id, user.id)) fail(403, '加入活动后才能查看群聊');
    return { messages: store.messages(id, { before: query.before ? v.id(query.before) : null }) };
  });

  /** 自己在该活动的最佳圈（带轨迹），用作实时 Δ 的参考圈。 */
  R('GET', '/events/:id/mybest', ({ user, params }) => ({ lap: store.bestLap(v.id(params.id), user.id) }));

  R('GET', '/laps/:id', ({ params }) => {
    const lap = store.getLap(v.id(params.id));
    if (!lap) fail(404, '圈速记录不存在');
    const ref = store.bestLap(lap.eventId);
    const own = store.bestLap(lap.eventId, lap.user.id);
    return {
      lap,
      sessionBest: ref && ref.id !== lap.id ? ref : null,
      personalBest: own && own.id !== lap.id && own.id !== ref?.id ? own : null,
      board: store.board(lap.eventId),
    };
  });

  // ---------- 通知 ----------

  R('GET', '/notifications', ({ user }) => ({ notifications: store.notifications(user.id) }));

  R('POST', '/notifications/read', ({ user }) => {
    store.markRead(user.id);
    return { ok: true };
  });

  return router;
}

