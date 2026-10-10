// 实时通道（WebSocket /ws）：每个活动一个“房间”。
//
// 客户端 → 服务器（JSON）
//   {t:'hello', token, eventId}        认证并进入活动房间（必须是活动成员）
//   {t:'loc', lat,lng,spd,hdg,..,lap}  实时位置 + 遥测（只在内存中转发，不落库）
//   {t:'stop'}                         停止共享位置
//   {t:'lap', ...}                     完成一圈（落库，广播排行榜）
//   {t:'chat', text}                   群聊消息
//   {t:'ptt', on}                      按下 / 松开对讲键
//   二进制帧                            对讲音频（16kHz μ-law），服务器在帧头加上 4 字节 uid 后转发
//
// 服务器 → 客户端
//   welcome / presence / loc / loc-stop / lap / chat / ptt / track / member / kicked / error
//   二进制帧：[uid:uint32][μ-law 音频]

import { WebSocketServer } from 'ws';
import * as v from './validate.js';

const HEARTBEAT_MS = 15_000;
const LOC_MIN_INTERVAL = 150;
const CHAT_MIN_INTERVAL = 700;
const VOICE_BYTES_PER_SEC = 24_000; // 16kHz μ-law = 16KB/s，留余量
const LIVE_TTL = 10 * 60 * 1000;

class Room {
  constructor(id) {
    this.id = id;
    this.clients = new Set();
    this.live = new Map(); // uid -> 最近一次位置/遥测
    this.talking = new Set();
  }

  online() {
    const ids = new Set();
    for (const c of this.clients) ids.add(c.user.id);
    return ids;
  }

  send(msg, except = null) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c !== except && c.readyState === 1) c.send(data);
  }
}

export function attachRealtime(server, store) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 128 * 1024 });
  const rooms = new Map();

  const room = (id) => {
    let r = rooms.get(id);
    if (!r) {
      r = new Room(id);
      rooms.set(id, r);
    }
    return r;
  };

  const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));

  function leave(ws) {
    const r = ws.room;
    if (!r) return;
    r.clients.delete(ws);
    ws.room = null;
    const uid = ws.user.id;
    const stillOnline = [...r.clients].some((c) => c.user.id === uid);
    if (!stillOnline) {
      if (r.talking.delete(uid)) r.send({ t: 'ptt', uid, on: false });
      const live = r.live.get(uid);
      if (live) live.online = false;
      r.send({ t: 'presence', uid, online: false });
    }
    if (!r.clients.size) {
      // 房间空了：保留最近位置一段时间，便于回到页面时还能看到
      for (const [k, l] of r.live) if (Date.now() - l.at > LIVE_TTL) r.live.delete(k);
      if (!r.live.size) rooms.delete(r.id);
    }
  }

  function onHello(ws, msg) {
    const user = store.userByToken(msg.token);
    if (!user) return ws.close(4001, 'unauthorized');
    const eventId = Number(msg.eventId);
    if (!Number.isInteger(eventId) || !store.isMember(eventId, user.id)) return ws.close(4003, 'not a member');
    clearTimeout(ws.authTimer);
    leave(ws);
    ws.user = user;
    const r = room(eventId);
    const wasOnline = r.online().has(user.id);
    r.clients.add(ws);
    ws.room = r;
    send(ws, {
      t: 'welcome',
      me: user.id,
      eventId,
      online: [...r.online()],
      live: Object.fromEntries([...r.live].filter(([, l]) => Date.now() - l.at < LIVE_TTL)),
      talking: [...r.talking],
      track: store.eventTrack(eventId),
      board: store.board(eventId),
      chat: store.messages(eventId, { limit: 50 }),
    });
    if (!wasOnline) r.send({ t: 'presence', uid: user.id, online: true }, ws);
  }

  function onLap(ws, msg) {
    const r = ws.room;
    let lap;
    try {
      lap = v.lap(msg);
    } catch (e) {
      return send(ws, { t: 'error', message: e.message, ref: msg.ref });
    }
    const prevBest = store.board(r.id);
    const mine = prevBest.entries.find((e) => e.user.id === ws.user.id);
    const { id, duplicate } = store.addLap(r.id, ws.user, lap);
    send(ws, { t: 'lap-ack', ref: msg.ref, id });
    if (duplicate) return;
    const board = store.board(r.id);
    r.send({
      t: 'lap',
      lap: { id, uid: ws.user.id, n: msg.n ?? null, lapMs: lap.lapMs, sectors: lap.sectors, maxSpeed: lap.maxSpeed },
      pb: !mine || lap.lapMs < mine.best,
      sessionBest: prevBest.bestLap == null || lap.lapMs < prevBest.bestLap,
      board,
    });
  }

  function onJson(ws, msg) {
    if (msg.t === 'hello') return onHello(ws, msg);
    const r = ws.room;
    if (!r) return;
    const uid = ws.user.id;
    switch (msg.t) {
      case 'loc': {
        const now = Date.now();
        if (now - (ws.lastLoc || 0) < LOC_MIN_INTERVAL) return;
        ws.lastLoc = now;
        const loc = v.loc(msg);
        if (!loc) return;
        const live = { ...loc, at: now, online: true };
        r.live.set(uid, live);
        r.send({ t: 'loc', uid, ...live }, ws);
        return;
      }
      case 'stop':
        r.live.delete(uid);
        r.send({ t: 'loc-stop', uid });
        return;
      case 'lap':
        return onLap(ws, msg);
      case 'chat': {
        const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 500) : '';
        const now = Date.now();
        if (!text || now - (ws.lastChat || 0) < CHAT_MIN_INTERVAL) return;
        ws.lastChat = now;
        const m = store.addMessage(r.id, uid, text);
        r.send({ t: 'chat', msg: m });
        return;
      }
      case 'ptt': {
        const on = !!msg.on;
        if (on === r.talking.has(uid)) return;
        if (on) r.talking.add(uid);
        else r.talking.delete(uid);
        r.send({ t: 'ptt', uid, on }, ws);
        return;
      }
      default:
    }
  }

  function onVoice(ws, data) {
    const r = ws.room;
    if (!r || !r.talking.has(ws.user.id)) return;
    const now = Date.now();
    if (!ws.voiceWindow || now - ws.voiceWindow > 1000) {
      ws.voiceWindow = now;
      ws.voiceBytes = 0;
    }
    ws.voiceBytes += data.length;
    if (ws.voiceBytes > VOICE_BYTES_PER_SEC) return;
    const frame = Buffer.allocUnsafe(4 + data.length);
    frame.writeUInt32BE(ws.user.id, 0);
    data.copy(frame, 4);
    for (const c of r.clients) if (c !== ws && c.readyState === 1 && c.user.id !== ws.user.id) c.send(frame, { binary: true });
  }

  wss.on('connection', (ws) => {
    ws.user = null;
    ws.room = null;
    ws.isAlive = true;
    ws.authTimer = setTimeout(() => !ws.user && ws.close(4001, 'auth timeout'), 10_000);
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          if (ws.user) onVoice(ws, data);
          return;
        }
        const msg = JSON.parse(data.toString());
        if (!msg || typeof msg !== 'object') return;
        if (!ws.user && msg.t !== 'hello') return;
        onJson(ws, msg);
      } catch {
        send(ws, { t: 'error', message: '消息格式错误' });
      }
    });
    ws.on('close', () => {
      clearTimeout(ws.authTimer);
      if (ws.user) leave(ws);
    });
    ws.on('error', () => {});
  });

  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  return {
    onlineCount(eventId) {
      return rooms.get(eventId)?.online().size ?? 0;
    },
    broadcastTrack(eventId, track) {
      rooms.get(eventId)?.send({ t: 'track', track });
    },
    memberJoined(eventId, user) {
      rooms.get(eventId)?.send({ t: 'member', user });
    },
    /** 用户退出活动后，断开他在该房间的连接。 */
    kick(eventId, uid) {
      const r = rooms.get(eventId);
      if (!r) return;
      r.live.delete(uid);
      for (const c of [...r.clients]) {
        if (c.user.id === uid) {
          send(c, { t: 'kicked' });
          leave(c);
        }
      }
      r.send({ t: 'loc-stop', uid });
    },
    closeRoom(eventId) {
      const r = rooms.get(eventId);
      if (!r) return;
      for (const c of [...r.clients]) {
        send(c, { t: 'kicked', reason: 'deleted' });
        leave(c);
      }
      rooms.delete(eventId);
    },
    close() {
      clearInterval(beat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
