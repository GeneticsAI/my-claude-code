import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { demoTrack } from '../public/js/shared/track.js';

let app;
let base;
let dir;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'paddock-test-'));
  app = createApp({ dataDir: dir, log: false });
  const port = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(method, url, body, token) {
  const res = await fetch(base + '/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, ...data };
}

async function register(username, car = 'Porsche 911 GT3') {
  const r = await api('POST', '/auth/register', { username, password: 'secret123', nickname: username.toUpperCase(), car });
  assert.equal(r.status, 200, r.error);
  return r;
}

/** 连接 WebSocket 并收集消息；next(t) 等待下一条指定类型的消息。 */
function connect(token, eventId) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  const inbox = [];
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    const msg = isBinary ? { t: 'voice', uid: data.readUInt32BE(0), bytes: data.subarray(4) } : JSON.parse(data.toString());
    const i = waiters.findIndex((w) => w.t === msg.t);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token, eventId })));
  return {
    ws,
    closed,
    send: (m) => ws.send(JSON.stringify(m)),
    next(t, ms = 3000) {
      const i = inbox.findIndex((m) => m.t === t);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { t, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), ms);
      });
    },
  };
}

test('auth: register, duplicate, login, me, logout', async () => {
  const a = await register('alice');
  assert.ok(a.token);
  assert.equal(a.user.nickname, 'ALICE');
  assert.equal((await api('POST', '/auth/register', { username: 'ALICE', password: 'secret123' })).status, 409);
  assert.equal((await api('POST', '/auth/register', { username: 'a b', password: 'secret123' })).status, 400);
  assert.equal((await api('POST', '/auth/login', { username: 'alice', password: 'wrong' })).status, 401);
  const login = await api('POST', '/auth/login', { username: 'alice', password: 'secret123' });
  assert.equal(login.status, 200);
  assert.equal((await api('GET', '/me', null, login.token)).user.username, 'alice');
  await api('POST', '/auth/logout', {}, login.token);
  assert.equal((await api('GET', '/me', null, login.token)).status, 401);
  assert.equal((await api('GET', '/feed')).status, 401);
});

test('social: follow, posts, feed scopes, likes, comments, notifications', async () => {
  const b = await register('bob');
  const c = await register('carol');
  assert.equal((await api('POST', `/users/${c.user.id}/follow`, {}, b.token)).status, 200);
  const prof = await api('GET', `/users/${c.user.id}`, null, b.token);
  assert.equal(prof.user.isFollowing, true);
  assert.equal(prof.user.stats.followers, 1);

  const p = await api('POST', '/posts', { text: '周末去赛道！' }, c.token);
  assert.equal(p.status, 200);
  await api('POST', '/posts', { text: 'dave 的动态' }, (await register('dave')).token);

  const following = await api('GET', '/feed?scope=following', null, b.token);
  assert.deepEqual(following.posts.map((x) => x.text), ['周末去赛道！']);
  const all = await api('GET', '/feed?scope=all', null, b.token);
  assert.equal(all.posts.length >= 2, true);

  await api('POST', `/posts/${p.post.id}/like`, {}, b.token);
  await api('POST', `/posts/${p.post.id}/like`, {}, b.token); // 幂等
  const cm = await api('POST', `/posts/${p.post.id}/comments`, { text: '带上我' }, b.token);
  assert.equal(cm.comment.text, '带上我');
  const detail = await api('GET', `/posts/${p.post.id}`, null, b.token);
  assert.equal(detail.post.likes, 1);
  assert.equal(detail.post.liked, true);
  assert.equal(detail.comments.length, 1);

  const n = await api('GET', '/notifications', null, c.token);
  assert.deepEqual(n.notifications.map((x) => x.kind).sort(), ['comment', 'follow', 'like']);
  assert.equal((await api('GET', '/me', null, c.token)).unread, 3);
  await api('POST', '/notifications/read', {}, c.token);
  assert.equal((await api('GET', '/me', null, c.token)).unread, 0);

  assert.equal((await api('DELETE', `/posts/${p.post.id}`, null, b.token)).status, 404); // 不能删别人的
  assert.equal((await api('DELETE', `/posts/${p.post.id}`, null, c.token)).status, 200);

  const s = await api('GET', '/search?q=car', null, b.token);
  assert.ok(s.users.some((u) => u.username === 'carol'));
});

test('uploads: rejects non-images, accepts a real PNG', async () => {
  const u = await register('erin');
  const fake = 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
  assert.equal((await api('POST', '/me/avatar', { image: fake }, u.token)).status, 400);
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const r = await api('POST', '/me/avatar', { image: png }, u.token);
  assert.equal(r.status, 200);
  const img = await fetch(base + r.user.avatar);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(base + '/uploads/../paddock.db')).status, 404);
});

test('events + realtime: membership, live location, laps, board, chat, voice relay', async () => {
  const org = await register('organizer');
  const drv = await register('driver', 'BMW M4 CSL');
  const out = await register('outsider');

  const anchor = { lat: 31.3389, lng: 121.2197 };
  const ev = await api('POST', '/events', {
    title: '周六赛道日', description: '新手友好', kind: 'trackday', startsAt: Date.now(), place: '演示赛道', ...anchor, maxMembers: 2,
  }, org.token);
  assert.equal(ev.status, 200, ev.error);
  const id = ev.event.id;
  assert.equal(ev.event.memberCount, 1);

  // 非组织者不能改赛道；组织者可以
  const track = demoTrack(anchor);
  assert.equal((await api('PATCH', `/events/${id}`, { startLine: track.startLine }, drv.token)).status, 403);
  const patched = await api('PATCH', `/events/${id}`, track, org.token);
  assert.equal(patched.status, 200, patched.error);
  assert.equal(patched.event.sectorLines.length, 2);

  assert.equal((await api('POST', `/events/${id}/join`, {}, drv.token)).status, 200);
  assert.equal((await api('POST', `/events/${id}/join`, {}, out.token)).status, 409); // 名额已满
  assert.equal((await api('GET', `/events/${id}/messages`, null, out.token)).status, 403);

  // 非成员连接被拒
  const x = connect(out.token, id);
  assert.equal(await x.closed, 4003);

  const A = connect(org.token, id);
  const welcomeA = await A.next('welcome');
  assert.equal(welcomeA.track.startLine.length, 2);
  const B = connect(drv.token, id);
  const welcomeB = await B.next('welcome');
  assert.deepEqual(welcomeB.online.sort(), [org.user.id, drv.user.id].sort());
  assert.equal((await A.next('presence')).uid, drv.user.id);
  assert.equal((await api('GET', `/events/${id}`, null, org.token)).event.online, 2);

  // 实时位置：只转发白名单字段
  B.send({ t: 'loc', lat: 31.34, lng: 121.22, spd: 40.5, hdg: 90, evil: '<img>', lap: { n: 2, delta: -320 } });
  const loc = await A.next('loc');
  assert.equal(loc.uid, drv.user.id);
  assert.equal(loc.spd, 40.5);
  assert.equal(loc.lap.delta, -320);
  assert.equal(loc.evil, undefined);

  // 圈速：落库 + 广播排行榜；重复提交幂等
  const lap = {
    t: 'lap', ref: 'r1', n: 1, lapMs: 95_432, sectors: [30_000, 32_000, 33_432], maxSpeed: 60, avgSpeed: 42,
    distance: 4000, startedAt: 1_700_000_000_000, trace: [[0, 0, 40, 31.34, 121.22], [4000, 95_432, 41, 31.34, 121.22]],
  };
  B.send(lap);
  const ack = await B.next('lap-ack');
  const lapMsg = await A.next('lap');
  assert.equal(lapMsg.lap.lapMs, 95_432);
  assert.equal(lapMsg.sessionBest, true);
  assert.equal(lapMsg.board.entries[0].user.id, drv.user.id);
  B.send(lap);
  assert.equal((await B.next('lap-ack')).id, ack.id);
  B.send({ ...lap, ref: 'r2', lapMs: 5 }); // 不合理圈速被拒
  assert.match((await B.next('error')).message, /圈速/);

  const board = await api('GET', `/events/${id}/board`, null, org.token);
  assert.equal(board.board.entries.length, 1);
  assert.equal(board.board.totalLaps, 1);
  assert.equal(board.board.entries[0].theoretical, 95_432);

  const lapDetail = await api('GET', `/laps/${ack.id}`, null, org.token);
  assert.equal(lapDetail.lap.trace.length, 2);
  assert.equal((await api('GET', `/events/${id}/mybest`, null, drv.token)).lap.id, ack.id);

  // 分享圈速到动态
  const share = await api('POST', '/posts', { text: 'PB!', lapId: ack.id }, drv.token);
  assert.equal(share.post.lap.lapMs, 95_432);

  // 群聊
  A.send({ t: 'chat', text: '  注意 T3 有油  ' });
  const chat = await B.next('chat');
  assert.equal(chat.msg.text, '注意 T3 有油');
  assert.equal((await api('GET', `/events/${id}/messages`, null, drv.token)).messages.length, 1);

  // 对讲：未按下 PTT 时音频被丢弃；按下后转发并带上 uid
  A.ws.send(Buffer.from([1, 2, 3]), { binary: true });
  A.send({ t: 'ptt', on: true });
  assert.deepEqual(await B.next('ptt'), { t: 'ptt', uid: org.user.id, on: true });
  A.ws.send(Buffer.from([9, 8, 7, 6]), { binary: true });
  const voice = await B.next('voice');
  assert.equal(voice.uid, org.user.id);
  assert.deepEqual([...voice.bytes], [9, 8, 7, 6]);

  // 组织者修改赛道 → 房间内广播
  await api('PATCH', `/events/${id}`, { sectorLines: [] }, org.token);
  assert.deepEqual((await B.next('track')).track.sectorLines, []);

  // 退出活动 → 被移出房间
  await api('DELETE', `/events/${id}/join`, null, drv.token);
  await B.next('kicked');
  assert.equal((await api('DELETE', `/events/${id}/join`, null, org.token)).status, 400);

  A.ws.close();
  B.ws.close();
});

test('static: SPA fallback, leaflet vendor, CSP header, path traversal', async () => {
  const index = await fetch(base + '/events/42');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(base + '/vendor/leaflet/leaflet.js')).status, 200);
  assert.equal((await fetch(base + '/js/../../server/store.js')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/server/store.js')).status, 404);
});
