// 数据层：Node 内置 SQLite（node:sqlite），单文件数据库，无需安装数据库服务。
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  nickname TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  car TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL,
  avatar TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  place TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  max_members INTEGER NOT NULL DEFAULT 0,
  start_line TEXT,
  sector_lines TEXT NOT NULL DEFAULT '[]',
  path TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS event_members (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS laps (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lap_ms INTEGER NOT NULL,
  sectors TEXT,
  max_speed REAL NOT NULL,
  avg_speed REAL NOT NULL,
  distance REAL NOT NULL,
  started_at INTEGER NOT NULL,
  car TEXT NOT NULL DEFAULT '',
  trace TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (event_id, user_id, started_at)
);
CREATE INDEX IF NOT EXISTS laps_event ON laps(event_id, lap_ms);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL DEFAULT '',
  image TEXT,
  lap_id INTEGER REFERENCES laps(id) ON DELETE SET NULL,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_user ON posts(user_id, id);
CREATE TABLE IF NOT EXISTS likes (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_post ON comments(post_id, id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_event ON messages(event_id, id);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, id);
`;

export const USER_COLORS = [
  '#ff4d1a', '#ffb020', '#2bd96b', '#22c3ee', '#4f7cff',
  '#b05cff', '#ff4fa3', '#e8e8e8', '#a3e635', '#f97316',
];

const SESSION_TTL = 1000 * 60 * 60 * 24 * 60;
const USER_COLS = 'u.id, u.username, u.nickname, u.bio, u.car, u.color, u.avatar';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const json = (s, fallback = null) => (s == null ? fallback : JSON.parse(s));

function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [, saltHex, keyHex] = stored.split('$');
  const key = scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
  return timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}

export function publicUser(r) {
  if (!r) return null;
  return { id: r.id, username: r.username, nickname: r.nickname, bio: r.bio, car: r.car, color: r.color, avatar: r.avatar };
}

/** 从带 u_ 前缀列的行里取出作者信息。 */
function author(r) {
  return { id: r.u_id, username: r.u_username, nickname: r.u_nickname, car: r.u_car, color: r.u_color, avatar: r.u_avatar };
}
const AUTHOR_COLS =
  'u.id u_id, u.username u_username, u.nickname u_nickname, u.car u_car, u.color u_color, u.avatar u_avatar';

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.db.exec(SCHEMA);
    this._stmts = new Map();
  }

  close() {
    this.db.close();
  }

  q(sql) {
    let s = this._stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this._stmts.set(sql, s);
    }
    return s;
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------- 用户与会话 ----------

  createUser({ username, password, nickname, car = '' }) {
    const color = USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
    const r = this.q(
      'INSERT INTO users (username, pass_hash, nickname, car, color, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(username, hashPassword(password), nickname, car, color, Date.now());
    return this.getUser(r.lastInsertRowid);
  }

  usernameTaken(username) {
    return !!this.q('SELECT 1 FROM users WHERE username = ?').get(username);
  }

  checkLogin(username, password) {
    const r = this.q('SELECT id, pass_hash FROM users WHERE username = ?').get(username);
    if (!r || !verifyPassword(password, r.pass_hash)) return null;
    return this.getUser(r.id);
  }

  getUser(id) {
    return publicUser(this.q(`SELECT ${USER_COLS} FROM users u WHERE u.id = ?`).get(id));
  }

  updateUser(id, fields) {
    const allowed = ['nickname', 'bio', 'car', 'color', 'avatar'];
    for (const k of allowed) {
      if (fields[k] !== undefined) this.q(`UPDATE users SET ${k} = ? WHERE id = ?`).run(fields[k], id);
    }
    return this.getUser(id);
  }

  createSession(userId) {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.q('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      sha256(token), userId, now, now + SESSION_TTL
    );
    return token;
  }

  userByToken(token) {
    if (!token || typeof token !== 'string') return null;
    const r = this.q(
      `SELECT ${USER_COLS} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`
    ).get(sha256(token), Date.now());
    return publicUser(r);
  }

  deleteSession(token) {
    this.q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  profile(id, viewerId) {
    const user = this.getUser(id);
    if (!user) return null;
    const c = this.q(
      `SELECT
        (SELECT COUNT(*) FROM follows WHERE followee_id = $id) followers,
        (SELECT COUNT(*) FROM follows WHERE follower_id = $id) following,
        (SELECT COUNT(*) FROM posts WHERE user_id = $id) posts,
        (SELECT COUNT(*) FROM laps WHERE user_id = $id) laps,
        (SELECT COUNT(*) FROM event_members WHERE user_id = $id) events,
        EXISTS(SELECT 1 FROM follows WHERE follower_id = $viewer AND followee_id = $id) is_following,
        EXISTS(SELECT 1 FROM follows WHERE follower_id = $id AND followee_id = $viewer) follows_you`
    ).get({ id, viewer: viewerId });
    return {
      ...user,
      stats: { followers: c.followers, following: c.following, posts: c.posts, laps: c.laps, events: c.events },
      isFollowing: !!c.is_following,
      followsYou: !!c.follows_you,
    };
  }

  searchUsers(q, limit = 20) {
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    return this.q(
      `SELECT ${USER_COLS} FROM users u WHERE u.nickname LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR u.car LIKE ? ESCAPE '\\' ORDER BY u.id LIMIT ?`
    ).all(like, like, like, limit).map(publicUser);
  }

  // ---------- 关注 ----------

  follow(followerId, followeeId) {
    const r = this.q('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)').run(
      followerId, followeeId, Date.now()
    );
    if (r.changes) this.notify(followeeId, followerId, 'follow');
  }

  unfollow(followerId, followeeId) {
    this.q('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(followerId, followeeId);
  }

  followList(userId, type) {
    const sql =
      type === 'followers'
        ? `SELECT ${USER_COLS} FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followee_id = ? ORDER BY f.created_at DESC`
        : `SELECT ${USER_COLS} FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ? ORDER BY f.created_at DESC`;
    return this.q(sql).all(userId).map(publicUser);
  }

  // ---------- 动态 ----------

  createPost(userId, { text = '', image = null, lapId = null, eventId = null }) {
    const r = this.q('INSERT INTO posts (user_id, text, image, lap_id, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      userId, text, image, lapId, eventId, Date.now()
    );
    return this.getPost(r.lastInsertRowid, userId);
  }

  deletePost(id, userId) {
    return this.q('DELETE FROM posts WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  _posts(where, params, viewerId, limit = 20) {
    const rows = this.q(
      `SELECT p.*, ${AUTHOR_COLS},
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) comment_count,
        EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $viewer) liked
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE ${where} ORDER BY p.id DESC LIMIT $limit`
    ).all({ ...params, viewer: viewerId, limit });
    return rows.map((r) => ({
      id: r.id,
      user: author(r),
      text: r.text,
      image: r.image,
      createdAt: r.created_at,
      likes: r.like_count,
      comments: r.comment_count,
      liked: !!r.liked,
      lap: r.lap_id ? this.lapSummary(r.lap_id) : null,
      event: r.event_id ? this.eventSummary(r.event_id) : null,
    }));
  }

  feed(viewerId, { scope = 'all', before = null, limit = 20 }) {
    const where =
      scope === 'following'
        ? `(p.user_id = $viewer OR p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = $viewer)) AND ($before IS NULL OR p.id < $before)`
        : `($before IS NULL OR p.id < $before)`;
    return this._posts(where, { before }, viewerId, limit);
  }

  userPosts(userId, viewerId, { before = null, limit = 20 } = {}) {
    return this._posts('p.user_id = $uid AND ($before IS NULL OR p.id < $before)', { uid: userId, before }, viewerId, limit);
  }

  getPost(id, viewerId) {
    return this._posts('p.id = $pid', { pid: id }, viewerId, 1)[0] || null;
  }

  postOwner(id) {
    return this.q('SELECT user_id FROM posts WHERE id = ?').get(id)?.user_id ?? null;
  }

  like(postId, userId) {
    const r = this.q('INSERT OR IGNORE INTO likes (post_id, user_id, created_at) VALUES (?, ?, ?)').run(postId, userId, Date.now());
    if (r.changes) this.notify(this.postOwner(postId), userId, 'like', { postId });
  }

  unlike(postId, userId) {
    this.q('DELETE FROM likes WHERE post_id = ? AND user_id = ?').run(postId, userId);
  }

  addComment(postId, userId, text) {
    const r = this.q('INSERT INTO comments (post_id, user_id, text, created_at) VALUES (?, ?, ?, ?)').run(
      postId, userId, text, Date.now()
    );
    this.notify(this.postOwner(postId), userId, 'comment', { postId });
    return this.comments(postId).find((c) => c.id === r.lastInsertRowid);
  }

  comments(postId) {
    return this.q(
      `SELECT c.id, c.text, c.created_at, ${AUTHOR_COLS} FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.id`
    ).all(postId).map((r) => ({ id: r.id, text: r.text, createdAt: r.created_at, user: author(r) }));
  }

  deleteComment(id, userId) {
    return (
      this.q(
        'DELETE FROM comments WHERE id = ? AND (user_id = ? OR post_id IN (SELECT id FROM posts WHERE user_id = ?))'
      ).run(id, userId, userId).changes > 0
    );
  }

  // ---------- 活动 ----------

  createEvent(ownerId, e) {
    return this.tx(() => {
      const r = this.q(
        `INSERT INTO events (owner_id, title, description, kind, starts_at, place, lat, lng, max_members, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(ownerId, e.title, e.description, e.kind, e.startsAt, e.place, e.lat, e.lng, e.maxMembers, Date.now());
      const id = r.lastInsertRowid;
      this.q("INSERT INTO event_members (event_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(id, ownerId, Date.now());
      return id;
    });
  }

  updateEvent(id, f) {
    const map = {
      title: 'title', description: 'description', kind: 'kind', startsAt: 'starts_at', place: 'place',
      lat: 'lat', lng: 'lng', maxMembers: 'max_members',
    };
    for (const [k, col] of Object.entries(map)) {
      if (f[k] !== undefined) this.q(`UPDATE events SET ${col} = ? WHERE id = ?`).run(f[k], id);
    }
    if (f.startLine !== undefined) this.q('UPDATE events SET start_line = ? WHERE id = ?').run(f.startLine ? JSON.stringify(f.startLine) : null, id);
    if (f.sectorLines !== undefined) this.q('UPDATE events SET sector_lines = ? WHERE id = ?').run(JSON.stringify(f.sectorLines), id);
    if (f.path !== undefined) this.q('UPDATE events SET path = ? WHERE id = ?').run(f.path ? JSON.stringify(f.path) : null, id);
  }

  deleteEvent(id) {
    this.q('DELETE FROM events WHERE id = ?').run(id);
  }

  _eventRow(r) {
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      kind: r.kind,
      startsAt: r.starts_at,
      place: r.place,
      lat: r.lat,
      lng: r.lng,
      maxMembers: r.max_members,
      owner: author(r),
      memberCount: r.member_count,
      isMember: !!r.is_member,
      hasTrack: !!r.start_line,
      createdAt: r.created_at,
    };
  }

  _eventSelect() {
    return `SELECT e.*, ${AUTHOR_COLS},
      (SELECT COUNT(*) FROM event_members WHERE event_id = e.id) member_count,
      EXISTS(SELECT 1 FROM event_members WHERE event_id = e.id AND user_id = $viewer) is_member
      FROM events e JOIN users u ON u.id = e.owner_id`;
  }

  listEvents(viewerId, { scope = 'upcoming', userId = null, limit = 50 } = {}) {
    // 开始后 12 小时内仍算“进行中/即将开始”
    const cutoff = Date.now() - 12 * 3600 * 1000;
    // node:sqlite 不接受语句里没用到的命名参数，所以按分支只传需要的键
    let where;
    let order = 'e.starts_at ASC';
    const params = { viewer: viewerId, limit };
    if (scope === 'past') {
      where = 'e.starts_at < $cutoff';
      order = 'e.starts_at DESC';
      params.cutoff = cutoff;
    } else if (scope === 'mine') {
      where = 'e.id IN (SELECT event_id FROM event_members WHERE user_id = $uid)';
      order = 'e.starts_at DESC';
      params.uid = userId ?? viewerId;
    } else {
      where = 'e.starts_at >= $cutoff';
      params.cutoff = cutoff;
    }
    return this.q(`${this._eventSelect()} WHERE ${where} ORDER BY ${order} LIMIT $limit`)
      .all(params)
      .map((r) => this._eventRow(r));
  }

  getEvent(id, viewerId) {
    const r = this.q(`${this._eventSelect()} WHERE e.id = $id`).get({ id, viewer: viewerId });
    if (!r) return null;
    const ev = this._eventRow(r);
    ev.startLine = json(r.start_line);
    ev.sectorLines = json(r.sector_lines, []);
    ev.path = json(r.path);
    ev.members = this.eventMembers(id);
    return ev;
  }

  eventTrack(id) {
    const r = this.q('SELECT start_line, sector_lines, path FROM events WHERE id = ?').get(id);
    return r ? { startLine: json(r.start_line), sectorLines: json(r.sector_lines, []), path: json(r.path) } : null;
  }

  eventSummary(id) {
    const r = this.q('SELECT id, title, kind, starts_at, place FROM events WHERE id = ?').get(id);
    return r ? { id: r.id, title: r.title, kind: r.kind, startsAt: r.starts_at, place: r.place } : null;
  }

  eventOwner(id) {
    return this.q('SELECT owner_id FROM events WHERE id = ?').get(id)?.owner_id ?? null;
  }

  eventMembers(id) {
    return this.q(
      `SELECT ${USER_COLS}, m.role FROM event_members m JOIN users u ON u.id = m.user_id WHERE m.event_id = ? ORDER BY m.joined_at`
    ).all(id).map((r) => ({ ...publicUser(r), role: r.role }));
  }

  isMember(eventId, userId) {
    return !!this.q('SELECT 1 FROM event_members WHERE event_id = ? AND user_id = ?').get(eventId, userId);
  }

  join(eventId, userId) {
    const r = this.q("INSERT OR IGNORE INTO event_members (event_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").run(
      eventId, userId, Date.now()
    );
    if (r.changes) this.notify(this.eventOwner(eventId), userId, 'join', { eventId });
    return r.changes > 0;
  }

  leave(eventId, userId) {
    this.q("DELETE FROM event_members WHERE event_id = ? AND user_id = ? AND role != 'owner'").run(eventId, userId);
  }

  // ---------- 圈速 ----------

  /** 写入一圈；同一车手同一活动同一起始时刻重复提交会被忽略（断线重传幂等）。返回 lap id。 */
  addLap(eventId, user, lap) {
    const r = this.q(
      `INSERT OR IGNORE INTO laps (event_id, user_id, lap_ms, sectors, max_speed, avg_speed, distance, started_at, car, trace, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      eventId, user.id, Math.round(lap.lapMs), lap.sectors ? JSON.stringify(lap.sectors.map(Math.round)) : null,
      lap.maxSpeed, lap.avgSpeed, lap.distance, lap.startedAt, user.car || '', JSON.stringify(lap.trace), Date.now()
    );
    if (!r.changes) {
      return { id: this.q('SELECT id FROM laps WHERE event_id = ? AND user_id = ? AND started_at = ?').get(eventId, user.id, lap.startedAt).id, duplicate: true };
    }
    return { id: r.lastInsertRowid, duplicate: false };
  }

  _lapRow(r) {
    return {
      id: r.id,
      eventId: r.event_id,
      lapMs: r.lap_ms,
      sectors: json(r.sectors),
      maxSpeed: r.max_speed,
      avgSpeed: r.avg_speed,
      distance: r.distance,
      startedAt: r.started_at,
      car: r.car,
      createdAt: r.created_at,
    };
  }

  getLap(id) {
    const r = this.q(`SELECT l.*, ${AUTHOR_COLS} FROM laps l JOIN users u ON u.id = l.user_id WHERE l.id = ?`).get(id);
    if (!r) return null;
    return { ...this._lapRow(r), user: author(r), trace: json(r.trace), event: this.eventSummary(r.event_id) };
  }

  lapSummary(id) {
    const r = this.q(
      `SELECT l.id, l.event_id, l.lap_ms, l.sectors, l.max_speed, l.avg_speed, l.distance, l.started_at, l.car, l.created_at, e.title event_title
       FROM laps l JOIN events e ON e.id = l.event_id WHERE l.id = ?`
    ).get(id);
    return r ? { ...this._lapRow(r), eventTitle: r.event_title } : null;
  }

  bestLap(eventId, userId = null) {
    const r = userId
      ? this.q('SELECT id FROM laps WHERE event_id = ? AND user_id = ? ORDER BY lap_ms, id LIMIT 1').get(eventId, userId)
      : this.q('SELECT id FROM laps WHERE event_id = ? ORDER BY lap_ms, id LIMIT 1').get(eventId);
    return r ? this.getLap(r.id) : null;
  }

  userLaps(userId, { limit = 50 } = {}) {
    // 每个活动的个人最佳
    return this.q(
      `SELECT l.id, l.event_id, l.lap_ms, l.sectors, l.max_speed, l.avg_speed, l.distance, l.started_at, l.car, l.created_at,
              e.title event_title, e.starts_at event_starts_at, COUNT(*) OVER (PARTITION BY l.event_id) lap_count
       FROM laps l JOIN events e ON e.id = l.event_id
       WHERE l.user_id = ? AND l.id = (SELECT id FROM laps WHERE event_id = l.event_id AND user_id = l.user_id ORDER BY lap_ms, id LIMIT 1)
       ORDER BY e.starts_at DESC LIMIT ?`
    ).all(userId, limit).map((r) => ({ ...this._lapRow(r), eventTitle: r.event_title, eventStartsAt: r.event_starts_at }));
  }

  /**
   * 活动排行榜：按个人最佳圈排序，附带上一圈、圈数、极速、各分段最佳、理论最佳圈，
   * 以及全场最佳分段（前端用紫色标出）。
   */
  board(eventId) {
    const rows = this.q(
      `SELECT l.id, l.user_id, l.lap_ms, l.sectors, l.max_speed, ${AUTHOR_COLS}
       FROM laps l JOIN users u ON u.id = l.user_id WHERE l.event_id = ? ORDER BY l.id`
    ).all(eventId);
    const by = new Map();
    const overallSectors = [];
    for (const r of rows) {
      let e = by.get(r.user_id);
      if (!e) {
        e = { user: author(r), best: null, bestLapId: null, last: null, lastLapId: null, laps: 0, vmax: 0, bestSectors: [] };
        by.set(r.user_id, e);
      }
      e.laps++;
      e.last = r.lap_ms;
      e.lastLapId = r.id;
      e.vmax = Math.max(e.vmax, r.max_speed);
      if (e.best == null || r.lap_ms < e.best) {
        e.best = r.lap_ms;
        e.bestLapId = r.id;
      }
      const sectors = json(r.sectors);
      if (sectors) {
        sectors.forEach((ms, i) => {
          if (e.bestSectors[i] == null || ms < e.bestSectors[i]) e.bestSectors[i] = ms;
          if (overallSectors[i] == null || ms < overallSectors[i]) overallSectors[i] = ms;
        });
      }
    }
    const entries = [...by.values()].sort((a, b) => a.best - b.best);
    const leader = entries[0]?.best ?? null;
    for (const e of entries) {
      e.gap = leader == null ? null : e.best - leader;
      e.theoretical = e.bestSectors.length && e.bestSectors.every((v) => v != null) ? e.bestSectors.reduce((a, b) => a + b, 0) : null;
    }
    return { entries, bestLap: leader, bestSectors: overallSectors, totalLaps: rows.length };
  }

  // ---------- 活动群聊 ----------

  addMessage(eventId, userId, text) {
    const r = this.q('INSERT INTO messages (event_id, user_id, text, created_at) VALUES (?, ?, ?, ?)').run(eventId, userId, text, Date.now());
    return this.messages(eventId, { limit: 1, before: r.lastInsertRowid + 1 })[0];
  }

  messages(eventId, { before = null, limit = 50 } = {}) {
    return this.q(
      `SELECT m.id, m.text, m.created_at, ${AUTHOR_COLS} FROM messages m JOIN users u ON u.id = m.user_id
       WHERE m.event_id = $eid AND ($before IS NULL OR m.id < $before) ORDER BY m.id DESC LIMIT $limit`
    ).all({ eid: eventId, before, limit }).reverse().map((r) => ({ id: r.id, text: r.text, createdAt: r.created_at, user: author(r) }));
  }

  // ---------- 通知 ----------

  notify(userId, actorId, kind, { postId = null, eventId = null } = {}) {
    if (!userId || userId === actorId) return;
    this.q('INSERT INTO notifications (user_id, actor_id, kind, post_id, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      userId, actorId, kind, postId, eventId, Date.now()
    );
  }

  notifications(userId, limit = 50) {
    return this.q(
      `SELECT n.id, n.kind, n.post_id, n.event_id, n.read, n.created_at, ${AUTHOR_COLS},
        p.text post_text, e.title event_title
       FROM notifications n JOIN users u ON u.id = n.actor_id
       LEFT JOIN posts p ON p.id = n.post_id LEFT JOIN events e ON e.id = n.event_id
       WHERE n.user_id = ? ORDER BY n.id DESC LIMIT ?`
    ).all(userId, limit).map((r) => ({
      id: r.id,
      kind: r.kind,
      read: !!r.read,
      createdAt: r.created_at,
      actor: author(r),
      postId: r.post_id,
      postText: r.post_text,
      eventId: r.event_id,
      eventTitle: r.event_title,
    }));
  }

  unreadCount(userId) {
    return this.q('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read = 0').get(userId).n;
  }

  markRead(userId) {
    this.q('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(userId);
  }
}
