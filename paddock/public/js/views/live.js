// 实况页：地图上的成员实时位置 + 圈速 HUD + 实时排行榜 + 群聊 + 按住说话对讲。
import { get, patch, state } from '../api.js';
import { h, icon, clear, avatar, toast, toastError, modal, confirmDialog, goBack } from '../ui.js';
import { BaseMap, trackLayer } from '../live/maps.js';
import { CarLayer } from '../live/cars.js';
import { Realtime } from '../live/rt.js';
import { Voice } from '../live/voice.js';
import { GpsSource } from '../live/gps.js';
import { LapTimer, MotionEstimator, compactTrace } from '../shared/laptimer.js';
import { demoTrack, circuitForEvent } from '../shared/track.js';
import { fmtLap, fmtDelta, fmtRunning, fmtSector, kmh } from '../shared/format.js';
import { boardTable } from './board.js';
import { geoErrorText } from './events.js';

const LOC_INTERVAL = 400;

export default async function liveView({ el, params }) {
  const eventId = Number(params.id);
  const { event: ev } = await get(`/events/${eventId}`);
  if (!ev.isMember) {
    toast('报名活动后才能进入实况', 'error');
    location.replace(`#/event/${eventId}`);
    return;
  }
  const me = state.me;
  const isOwner = ev.owner.id === me.id;

  const S = {
    track: { path: ev.path, startLine: ev.startLine, sectorLines: ev.sectorLines || [] },
    members: new Map(ev.members.map((m) => [m.id, m])),
    online: new Set(),
    live: new Map(),
    talking: new Set(),
    board: null,
    sharing: null,
    follow: true,
    tab: 'board',
    lastSent: 0,
    clockOffset: 0,
    lastFix: null,
  };
  const timers = [];
  const memberOf = (uid) => S.members.get(uid) || { id: uid, nickname: '车友', color: '#888888', car: '' };

  // ---------- 页面结构 ----------
  const connDot = h('span', { class: 'conn-dot' });
  const connText = h('span', null, '连接中…');
  const top = h(
    'div',
    { class: 'live-top' },
    h('button', { class: 'round-btn', 'aria-label': '返回', onclick: () => goBack(`#/event/${eventId}`) }, icon('back')),
    h('div', { class: 'title' }, h('b', null, ev.title), h('small', null, connDot, connText))
  );

  const hud = {
    root: h('div', { class: 'hud hidden' }),
    speed: h('b', null, '0'),
    lapNo: h('span', { class: 'lap-no' }, 'OUT LAP'),
    running: h('span', { class: 'running' }, '-:--.-'),
    delta: h('span', { class: 'delta hidden' }),
    last: h('b', null, '-:--.---'),
    best: h('b', null, '-:--.---'),
    sectors: h('div', { class: 'sectors' }),
    g: h('canvas', { width: 124, height: 124, 'aria-label': 'G 值' }),
    sim: h('span', { class: 'sim-tag hidden' }, '模拟驾驶'),
    noLine: h('span', { class: 'dim hidden' }, '未设置计时线'),
  };
  hud.root.append(
    h('div', { class: 'speed' }, hud.speed, h('small', null, 'KM/H')),
    h(
      'div',
      { class: 'lap-now' },
      h('div', { class: 'l1' }, hud.lapNo, hud.running, hud.delta),
      h('div', { class: 'l2' }, h('span', null, '上圈 ', hud.last), h('span', null, '最佳 ', hud.best), hud.sim, hud.noLine),
      hud.sectors
    ),
    hud.g
  );

  const talkChip = h('div', { class: 'talk-chip hidden', role: 'status' });
  const bannerBox = h('div');
  const pickBox = h('div');

  const btnFollow = h('button', { class: 'round-btn', 'aria-label': '跟随我的位置', title: '跟随我' }, icon('locate'));
  const btnFit = h('button', { class: 'round-btn', 'aria-label': '显示全部车手', title: '全部车手' }, icon('fit'));
  const btnLayer = h('button', { class: 'round-btn', 'aria-label': '切换地图', title: '切换地图' }, icon('layers'));
  const btnSound = h('button', { class: 'round-btn', 'aria-label': '对讲收听', title: '对讲收听' }, icon('volume'));
  const btnTrack = isOwner ? h('button', { class: 'round-btn', 'aria-label': '赛道设置', title: '赛道设置' }, icon('sliders')) : null;
  const tools = h('div', { class: 'live-tools' }, btnFollow, btnFit, btnLayer, btnSound, btnTrack);

  const shareBtn = h('button', { class: 'share-btn' });
  const ptt = h('button', { class: 'ptt', 'aria-label': '按住说话' }, icon('mic'), h('small', null, '按住说话'));

  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  const panel = h('div', { class: 'panel' });
  const chatList = h('div', { class: 'chat-list' });
  const chatInput = h('input', { class: 'input', placeholder: '发消息给车队…', maxlength: 500, enterkeyhint: 'send' });
  const chatForm = h(
    'form',
    {
      class: 'chat-input',
      onsubmit: (e) => {
        e.preventDefault();
        const text = chatInput.value.trim();
        if (!text) return;
        if (rt.send({ t: 'chat', text })) chatInput.value = '';
        else toast('连接中，稍后再发', 'error');
      },
    },
    chatInput,
    h('button', { class: 'btn primary small', type: 'submit', 'aria-label': '发送' }, icon('send'))
  );
  const sheet = h(
    'div',
    { class: 'sheet' },
    h('div', { class: 'handle', role: 'button', 'aria-label': '展开/收起', onclick: () => root.classList.toggle('sheet-open') }),
    tabsEl,
    panel,
    chatForm
  );

  const mapEl = h('div', { class: 'live-map' });
  const root = h('div', { class: 'live' }, mapEl, top, hud.root, talkChip, bannerBox, pickBox, tools, shareBtn, ptt, sheet);
  clear(el).appendChild(root);

  // ---------- 地图 ----------
  const bm = new BaseMap(mapEl, { center: { lat: ev.lat, lng: ev.lng }, zoom: 15 });
  const tl = trackLayer(bm);
  const cars = new CarLayer(bm);
  tl.set(S.track);
  // 取景时避开顶部标题栏、右侧工具栏和底部面板
  const fitOpts = () =>
    window.innerWidth < 900
      ? { paddingTopLeft: [16, 80], paddingBottomRight: [64, 240], maxZoom: 17 }
      : { paddingTopLeft: [40, 80], paddingBottomRight: [440, 40], maxZoom: 17 };
  const tb = tl.bounds();
  if (tb) bm.map.fitBounds(tb, fitOpts());
  else bm.pinMarker({ lat: ev.lat, lng: ev.lng });
  bm.map.on('dragstart', () => {
    S.follow = false;
    btnFollow.classList.remove('on');
  });

  // ---------- 计时 ----------
  const timer = new LapTimer({ startLine: S.track.startLine, sectorLines: S.track.sectorLines });
  const motion = new MotionEstimator();
  const gTrail = [];
  get(`/events/${eventId}/mybest`)
    .then((r) => {
      if (r.lap) {
        timer.setBest(r.lap);
        r.lap.sectors?.forEach((ms, i) => (timer.bestSectors[i] = ms));
        renderHud();
      }
    })
    .catch(() => {});

  // ---------- 实时连接 ----------
  const rt = new Realtime(eventId, state.token);
  const voice = new Voice({ send: (m) => rt.send(m), sendBinary: (b) => rt.sendBinary(b) });

  const PENDING_KEY = `paddock.pending.${eventId}.${me.id}`;
  let pending = [];
  try {
    pending = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
  } catch {
    pending = [];
  }
  const savePending = () => {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    } catch {
      /* 存储已满或不可用 */
    }
  };

  rt.on('status', (s) => {
    connDot.className = `conn-dot ${s === 'online' ? 'on' : 'off'}`;
    renderConn(s);
  });
  rt.on('fatal', () => {
    toast('你已不是该活动成员', 'error');
    location.replace(`#/event/${eventId}`);
  });
  rt.on('kicked', (m) => {
    toast(m.reason === 'deleted' ? '活动已被删除' : '你已退出该活动', 'error');
    location.replace(m.reason === 'deleted' ? '#/events' : `#/event/${eventId}`);
  });
  rt.on('welcome', (m) => {
    S.online = new Set(m.online);
    S.talking = new Set(m.talking);
    S.board = m.board;
    S.live = new Map(Object.entries(m.live).map(([k, v]) => [Number(k), v]));
    for (const [uid, l] of S.live) {
      if (uid === me.id) continue;
      cars.upsert(uid, { ...l, user: memberOf(uid), me: false, online: S.online.has(uid), talking: S.talking.has(uid) });
    }
    applyTrack(m.track);
    clear(chatList);
    for (const msg of m.chat) appendChat(msg, false);
    scrollChat();
    for (const p of pending) rt.send(p);
    if (S.sharing && S.lastFix) sendLoc(S.lastFix, true);
    renderPanel();
    renderTalk();
    if (!tb && S.live.size) fitAll();
  });
  rt.on('presence', (m) => {
    if (m.online) S.online.add(m.uid);
    else {
      S.online.delete(m.uid);
      S.talking.delete(m.uid);
      const l = S.live.get(m.uid);
      if (l) l.online = false;
    }
    cars.style(m.uid, { online: m.online, talking: false });
    renderTalk();
    renderConn('online');
    schedulePanel();
  });
  rt.on('loc', (m) => {
    S.live.set(m.uid, m);
    S.online.add(m.uid);
    cars.upsert(m.uid, { ...m, user: memberOf(m.uid), me: false, online: true, talking: S.talking.has(m.uid) });
    schedulePanel();
  });
  rt.on('loc-stop', (m) => {
    S.live.delete(m.uid);
    if (m.uid !== me.id) cars.remove(m.uid);
    schedulePanel();
  });
  rt.on('lap', (m) => {
    S.board = m.board;
    const who = memberOf(m.lap.uid);
    if (m.lap.uid !== me.id && m.sessionBest) toast(`🟣 ${who.nickname} 刷新全场最快 ${fmtLap(m.lap.lapMs)}`, 'purple', 4000);
    if (m.sessionBest || m.pb) {
      appendSystem(`${who.nickname} ${m.sessionBest ? '刷新全场最快' : '刷新个人最佳'} ${fmtLap(m.lap.lapMs)}`);
    }
    renderPanel();
    renderHud();
  });
  rt.on('lap-ack', (m) => {
    pending = pending.filter((p) => p.ref !== m.ref);
    savePending();
  });
  rt.on('error', (m) => {
    if (m.ref) {
      pending = pending.filter((p) => p.ref !== m.ref);
      savePending();
    }
    toast(m.message, 'error');
  });
  rt.on('chat', (m) => {
    appendChat(m.msg, true);
    if (S.tab !== 'chat' && m.msg.user.id !== me.id) {
      S.unreadChat = true;
      renderTabs();
    }
  });
  rt.on('ptt', (m) => {
    if (m.on) S.talking.add(m.uid);
    else S.talking.delete(m.uid);
    cars.style(m.uid, { talking: m.on });
    renderTalk();
  });
  rt.on('voice', ({ uid, bytes }) => voice.play(uid, bytes));
  rt.on('track', (m) => {
    applyTrack(m.track);
    toast('组织者更新了赛道计时线');
  });
  rt.on('member', (m) => {
    S.members.set(m.user.id, m.user);
    appendSystem(`${m.user.nickname} 加入了活动`);
    schedulePanel();
  });

  function renderConn(s = rt.ready ? 'online' : 'offline') {
    if (s !== 'online') {
      connText.textContent = s === 'reconnecting' ? '重新连接中…' : '离线，正在重连…';
      return;
    }
    const sharing = [...liveWithMe().values()].filter((l) => l.online !== false).length;
    connText.textContent = `${S.online.size} 人在线 · ${sharing} 人共享位置`;
  }

  const trackKey = (t) => JSON.stringify([t.startLine || null, t.sectorLines || [], t.path || null]);

  function applyTrack(track) {
    if (!track) return;
    const same = trackKey(track) === trackKey(S.track);
    S.track = { path: track.path, startLine: track.startLine, sectorLines: track.sectorLines || [] };
    tl.set(S.track);
    if (same) return;
    // 计时线变了：旧赛道上的参考圈不再可比，清空个人最佳参考
    timer.setLines(S.track.startLine, S.track.sectorLines);
    timer.best = null;
    timer.bestSectors = [];
    if (S.sharing === 'sim') {
      stopSharing(false);
      startSharing('sim');
    }
    renderHud();
    renderPanel();
  }

  // ---------- 共享位置 / 计时 ----------
  let gps = null;
  let followZoom = false;
  let lastGpsWarn = 0;

  function startSharing(mode) {
    S.sharing = mode;
    S.follow = true;
    btnFollow.classList.add('on');
    motion.prev = null;
    timer.prev = null;
    gps = new GpsSource({
      mode,
      path: circuitForEvent({ ...S.track, lat: ev.lat, lng: ev.lng }),
      onFix,
      onError: (err) => {
        if (err?.code === 1 || !window.isSecureContext || !navigator.geolocation) {
          toast(geoErrorText(err), 'error', 5000);
          stopSharing();
          return;
        }
        // 隧道、桥下等处的短暂失锁：浏览器会自动重试，只偶尔提示一次
        if (Date.now() - lastGpsWarn > 15_000) {
          lastGpsWarn = Date.now();
          toast('GPS 信号弱，正在重新定位…', 'error');
        }
      },
    });
    gps.start();
    if (bm.map.getZoom() < 16) followZoom = true;
    root.classList.add('sharing');
    hud.root.classList.remove('hidden');
    hud.sim.classList.toggle('hidden', mode !== 'sim');
    renderShareBtn();
    renderHud();
  }

  function stopSharing(notify = true) {
    gps?.stop();
    gps = null;
    S.sharing = null;
    S.lastFix = null;
    cars.remove(me.id);
    if (notify) rt.send({ t: 'stop' });
    root.classList.remove('sharing');
    hud.root.classList.add('hidden');
    renderShareBtn();
  }

  function onFix(fix) {
    S.lastFix = fix;
    S.clockOffset = Date.now() - fix.ts;
    const g = motion.push(fix);
    if (fix.spd == null && motion.prevV != null) fix.spd = motion.prevV;
    for (const e of timer.push(fix)) {
      if (e.type === 'lap') onLap(e.lap);
      else if (e.type === 'lapStart') toast('计时开始 · 第 1 个计时圈', 'success');
    }
    cars.upsert(me.id, { ...fix, user: me, me: true, online: true, talking: voice.talking });
    if (followZoom) {
      followZoom = false;
      bm.map.setView(bm.toMap(fix), 16);
    } else if (S.follow) bm.map.panTo(bm.toMap(fix), { animate: true, duration: 0.5, noMoveStart: true });
    hud.speed.textContent = kmh(fix.spd);
    gTrail.push(g);
    if (gTrail.length > 14) gTrail.shift();
    drawG(g);
    renderHud();
    sendLoc(fix);
    schedulePanel();
  }

  function sendLoc(fix, force = false) {
    const now = Date.now();
    if (!force && now - S.lastSent < LOC_INTERVAL) return;
    S.lastSent = now;
    const st = timer.status(fix.ts);
    rt.send({
      t: 'loc', lat: fix.lat, lng: fix.lng, spd: fix.spd, hdg: fix.hdg, acc: fix.acc,
      latG: motion.latG, lonG: motion.lonG, sim: !!fix.sim,
      lap: { n: st.running ? st.lapNo : null, elapsed: st.elapsed, sector: st.sector, delta: st.delta, last: st.last, best: st.best },
    });
  }

  function onLap(lap) {
    const sb = S.board?.bestLap == null || lap.lapMs < S.board.bestLap;
    const pb = timer.best === lap;
    showBanner(lap, { sb, pb });
    const msg = {
      t: 'lap', ref: `${me.id}-${lap.startedAt}`, n: lap.n, lapMs: lap.lapMs, sectors: lap.sectors,
      maxSpeed: lap.maxSpeed, avgSpeed: lap.avgSpeed, distance: lap.distance, startedAt: lap.startedAt,
      trace: compactTrace(lap.trace),
    };
    pending.push(msg);
    savePending();
    rt.send(msg);
  }

  function showBanner(lap, { sb, pb }) {
    clear(bannerBox);
    const prevBest = S.board?.entries.find((e) => e.user.id === me.id)?.best;
    let sub = '';
    if (sb) sub = h('span', { class: 'purple' }, '全场最快');
    else if (pb) sub = h('span', { class: 'green' }, '个人最佳');
    else if (prevBest) sub = h('span', { class: 'red' }, `${fmtDelta(lap.lapMs - Math.min(prevBest, timer.best.lapMs), 3)}`);
    bannerBox.appendChild(
      h('div', { class: `lap-banner ${sb ? 'sb' : pb ? 'pb' : ''}` }, h('small', null, `第 ${lap.n} 圈`), h('b', null, fmtLap(lap.lapMs)), sub)
    );
  }

  function renderHud() {
    if (!S.sharing) return;
    const st = timer.status(Date.now() - S.clockOffset);
    const hasLine = !!S.track.startLine;
    hud.noLine.classList.toggle('hidden', hasLine);
    hud.lapNo.textContent = !hasLine ? '' : st.running ? `L${st.lapNo}` : 'OUT LAP';
    hud.last.textContent = fmtLap(st.last);
    hud.best.textContent = fmtLap(st.best);
    if (st.delta != null) {
      hud.delta.textContent = fmtDelta(st.delta);
      hud.delta.className = `delta ${st.delta <= 0 ? 'faster' : 'slower'}`;
    } else hud.delta.className = 'delta hidden';
    // 分段
    const n = hasLine ? S.track.sectorLines.length + 1 : 0;
    clear(hud.sectors).classList.toggle('hidden', n < 2);
    for (let i = 0; i < n; i++) {
      const ms = st.running ? timer.sectors[i] : null;
      let cls = '';
      if (ms != null) {
        const sb = S.board?.bestSectors?.[i];
        const pbs = timer.bestSectors[i];
        cls = sb == null || ms <= sb ? 'sb' : pbs == null || ms <= pbs ? 'pb' : 'done';
      } else if (st.running && i === timer.sectorIdx) cls = 'cur';
      hud.sectors.appendChild(h('span', { class: cls }, ms != null ? fmtSector(ms) : `S${i + 1}`));
    }
  }

  timers.push(
    setInterval(() => {
      if (S.sharing && timer.running) hud.running.textContent = fmtRunning(Date.now() - S.clockOffset - timer.lapStart);
      else if (S.sharing) hud.running.textContent = S.track.startLine ? '-:--.-' : '';
    }, 100)
  );

  function drawG(g) {
    const c = hud.g;
    const ctx = c.getContext('2d');
    const W = c.width;
    const cx = W / 2;
    const R = W / 2 - 8;
    const scale = R / 1.5;
    ctx.clearRect(0, 0, W, W);
    ctx.strokeStyle = '#323844';
    ctx.lineWidth = 2;
    for (const r of [0.5, 1, 1.5]) {
      ctx.beginPath();
      ctx.arc(cx, cx, r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - R, cx);
    ctx.lineTo(cx + R, cx);
    ctx.moveTo(cx, cx - R);
    ctx.lineTo(cx, cx + R);
    ctx.stroke();
    gTrail.forEach((p, i) => {
      ctx.fillStyle = `rgba(255,77,26,${(i + 1) / gTrail.length / 2.5})`;
      ctx.beginPath();
      ctx.arc(cx + p.latG * scale, cx - p.lonG * scale, 5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = '#ff4d1a';
    ctx.beginPath();
    ctx.arc(cx + g.latG * scale, cx - g.lonG * scale, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#a4acb7';
    ctx.font = '600 20px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.hypot(g.latG, g.lonG).toFixed(1)}G`, cx, W - 4);
  }

  function renderShareBtn() {
    clear(shareBtn);
    if (S.sharing) {
      shareBtn.className = 'share-btn stop';
      shareBtn.append(icon('stop'), S.sharing === 'sim' ? '停止模拟' : '停止共享');
    } else {
      shareBtn.className = 'share-btn';
      shareBtn.append(icon('play'), '开始共享位置');
    }
  }
  renderShareBtn();

  shareBtn.addEventListener('click', async () => {
    if (S.sharing) {
      if (await confirmDialog('停止共享位置？', '其他车友将看不到你的位置和实时数据。', '停止')) stopSharing();
      return;
    }
    const mode = await modal((box, close) => {
      box.append(
        h('h3', null, '开始共享'),
        h('p', null, S.track.startLine ? '你的位置、车速和圈速将实时共享给本活动成员。' : '组织者尚未设置计时线，将只共享位置和车速。'),
        h(
          'div',
          { class: 'choice' },
          h('button', { onclick: () => close('real') }, icon('locate'), h('div', null, h('b', null, '真实 GPS'), h('small', null, '在车上使用，手机固定好并保持屏幕常亮'))),
          h('button', { onclick: () => close('sim') }, icon('car'), h('div', null, h('b', null, '模拟驾驶'), h('small', null, '沿赛道自动行驶，用于体验和测试')))
        )
      );
    });
    if (mode) startSharing(mode);
  });

  // ---------- 对讲 ----------
  let pressing = false;
  root.addEventListener('pointerdown', () => voice.unlock().then(renderSound).catch(() => {}), { once: true });

  async function pttDown(e) {
    e?.preventDefault();
    if (pressing) return;
    if (!rt.ready) return toast('尚未连接，无法对讲', 'error');
    if (!voice.micReady) {
      try {
        await voice.enableMic();
        toast('麦克风已就绪，按住按钮说话', 'success');
        renderSound();
      } catch (err) {
        toast(err?.name === 'NotAllowedError' ? '麦克风权限被拒绝，请在浏览器设置中允许' : err.message || '无法打开麦克风', 'error', 4000);
      }
      return;
    }
    pressing = true;
    voice.startTalk();
    ptt.classList.add('active');
    cars.style(me.id, { talking: true });
  }
  function pttUp() {
    if (!pressing) return;
    pressing = false;
    voice.stopTalk();
    ptt.classList.remove('active');
    cars.style(me.id, { talking: false });
  }
  ptt.addEventListener('pointerdown', (e) => {
    ptt.setPointerCapture?.(e.pointerId);
    pttDown(e);
  });
  ptt.addEventListener('pointerup', pttUp);
  ptt.addEventListener('pointercancel', pttUp);
  ptt.addEventListener('lostpointercapture', pttUp);
  ptt.addEventListener('contextmenu', (e) => e.preventDefault());
  const isTyping = () => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  const onKeyDown = (e) => {
    if (e.code === 'Space' && !e.repeat && !isTyping()) pttDown(e);
  };
  const onKeyUp = (e) => {
    if (e.code === 'Space' && !isTyping()) pttUp();
  };
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  function renderSound() {
    clear(btnSound).appendChild(icon(voice.muted || !voice.unlocked ? 'mute' : 'volume'));
    btnSound.classList.toggle('on', voice.unlocked && !voice.muted);
  }
  btnSound.addEventListener('click', async () => {
    if (!voice.unlocked) {
      try {
        await voice.unlock();
        toast('已开启对讲收听');
      } catch (e) {
        toastError(e);
      }
    } else {
      voice.setMuted(!voice.muted);
      toast(voice.muted ? '对讲已静音' : '对讲已恢复');
    }
    renderSound();
  });
  renderSound();

  function renderTalk() {
    const others = [...S.talking].filter((uid) => uid !== me.id);
    clear(talkChip).classList.toggle('hidden', !others.length);
    if (!others.length) return;
    const first = memberOf(others[0]);
    talkChip.append(
      avatar(first, 26),
      `${first.nickname}${others.length > 1 ? ` 等 ${others.length} 人` : ''} 正在讲话`,
      h('span', { class: 'bars' }, h('i'), h('i'), h('i'))
    );
  }

  // ---------- 底部面板：排行 / 车手 / 群聊 ----------
  function renderTabs() {
    clear(tabsEl).append(
      ...[
        ['board', '排行'],
        ['drivers', '车手'],
        ['chat', '群聊'],
      ].map(([k, label]) =>
        h(
          'button',
          {
            class: S.tab === k ? 'on' : '', role: 'tab', 'aria-selected': String(S.tab === k),
            onclick: () => {
              S.tab = k;
              if (k === 'chat') S.unreadChat = false;
              root.classList.add('sheet-open');
              renderTabs();
              renderPanel();
            },
          },
          label,
          k === 'chat' && S.unreadChat ? h('span', { class: 'dot' }) : null
        )
      )
    );
    chatForm.classList.toggle('hidden', S.tab !== 'chat');
  }

  let panelTimer = null;
  function schedulePanel() {
    if (panelTimer) return;
    panelTimer = setTimeout(() => {
      panelTimer = null;
      renderPanel();
    }, 800);
  }

  function liveWithMe() {
    const live = new Map(S.live);
    if (S.sharing && S.lastFix) {
      const st = timer.status(S.lastFix.ts);
      live.set(me.id, { spd: S.lastFix.spd, online: true, lap: { n: st.running ? st.lapNo : null, delta: st.delta } });
    } else live.delete(me.id);
    return live;
  }

  function renderPanel() {
    renderConn();
    if (S.tab === 'chat') {
      if (panel.firstChild !== chatList) {
        clear(panel).appendChild(chatList);
        scrollChat();
      }
      return;
    }
    const scroll = panel.scrollTop;
    clear(panel);
    if (S.tab === 'board') {
      if (!S.track.startLine) {
        panel.appendChild(
          h('div', { class: 'notice-bar' }, isOwner ? '还没有计时线：点右侧 ⚙ 设置起终点线，或一键生成演示赛道。' : '组织者尚未设置计时线，暂时只显示位置和车速。')
        );
      }
      const t = boardTable({
        board: S.board,
        live: liveWithMe(),
        online: new Set([...S.online, me.id]),
        members: S.members,
        me: me.id,
        onRow: (uid, e) => focusDriver(uid, e),
      });
      panel.appendChild(t || h('div', { class: 'notice-bar' }, '还没有人在线共享位置。点「开始共享位置」出发吧！'));
    } else {
      const live = liveWithMe();
      const rank = (m) => (live.has(m.id) ? 0 : S.online.has(m.id) || m.id === me.id ? 1 : 2);
      const list = [...S.members.values()].sort((a, b) => rank(a) - rank(b) || a.nickname.localeCompare(b.nickname));
      for (const m of list) {
        const l = live.get(m.id);
        const r = rank(m);
        panel.appendChild(
          h(
            'div',
            { class: 'driver-row' },
            avatar(m, 36),
            h(
              'div',
              { class: 'who' },
              h('b', null, m.nickname, m.id === me.id ? '（我）' : ''),
              h('small', null, h('span', { class: `status-dot ${r === 0 ? 'sharing' : r === 1 ? 'online' : ''}` }), r === 0 ? '共享位置中' : r === 1 ? '在线' : '离线', m.car ? ` · ${m.car}` : '')
            ),
            l ? h('span', { class: 'spd' }, `${kmh(l.spd)}`, h('small', { class: 'dim' }, ' km/h')) : null,
            l && m.id !== me.id ? h('button', { class: 'icon-btn', 'aria-label': `定位到 ${m.nickname}`, onclick: () => focusDriver(m.id) }, icon('locate')) : null
          )
        );
      }
    }
    panel.scrollTop = scroll;
  }

  function focusDriver(uid, entry) {
    const p = uid === me.id ? S.lastFix : cars.position(uid);
    if (p) {
      S.follow = uid === me.id;
      btnFollow.classList.toggle('on', S.follow);
      bm.map.setView(bm.toMap(p), Math.max(bm.map.getZoom(), 16));
      if (window.innerWidth < 900) root.classList.remove('sheet-open');
    } else if (entry) {
      location.hash = `#/lap/${entry.bestLapId}`;
    }
  }

  function appendChat(msg, live) {
    const mine = msg.user.id === me.id;
    const atBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 60;
    chatList.appendChild(
      h(
        'div',
        { class: `msg${mine ? ' mine' : ''}` },
        mine ? null : avatar(msg.user, 28),
        h('div', null, h('div', { class: 'who' }, mine ? '我' : msg.user.nickname), h('div', { class: 'bubble' }, msg.text))
      )
    );
    if (live && (atBottom || mine)) scrollChat();
  }

  function appendSystem(text) {
    chatList.appendChild(h('div', { class: 'msg system' }, h('span', null, text)));
    scrollChat();
  }

  function scrollChat() {
    if (S.tab !== 'chat') return;
    requestAnimationFrame(() => (panel.scrollTop = panel.scrollHeight));
  }

  renderTabs();
  renderPanel();

  // ---------- 地图工具 ----------
  btnFollow.classList.add('on');
  btnFollow.addEventListener('click', () => {
    S.follow = true;
    btnFollow.classList.add('on');
    if (S.lastFix) bm.map.setView(bm.toMap(S.lastFix), Math.max(bm.map.getZoom(), 16));
    else if (!S.sharing) toast('开始共享位置后可跟随自己');
  });
  function fitAll() {
    const pts = cars.displayPoints();
    const b = tl.bounds();
    const bounds = b || (pts.length ? L.latLngBounds(pts) : null);
    if (!bounds) return;
    for (const p of pts) bounds.extend(p);
    bm.map.fitBounds(bounds, fitOpts());
  }
  btnFit.addEventListener('click', () => {
    S.follow = false;
    btnFollow.classList.remove('on');
    fitAll();
  });
  btnLayer.addEventListener('click', () => toast(`地图：${bm.cycleLayer()}`));

  // ---------- 组织者：赛道设置 ----------
  let menu = null;
  function closeMenu() {
    menu?.remove();
    menu = null;
  }
  btnTrack?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu) return closeMenu();
    const item = (ic, label, fn, cls = '') =>
      h('button', {
        class: cls,
        onclick: async () => {
          closeMenu();
          try {
            await fn();
          } catch (err) {
            toastError(err);
          }
        },
      }, icon(ic), label);
    menu = h(
      'div',
      { class: 'tool-menu', onclick: (ev2) => ev2.stopPropagation() },
      item('wand', '在地图中心生成演示赛道', async () => {
        if (S.track.startLine && !(await confirmDialog('覆盖现有赛道？', '会替换当前的起终点线和分段线。'))) return;
        const c = bm.fromMap(bm.map.getCenter());
        await saveTrack(demoTrack(c));
        setTimeout(() => {
          const b = tl.bounds();
          if (b) bm.map.fitBounds(b, fitOpts());
        }, 300);
      }),
      h('hr'),
      item('flag', '设置起终点线', async () => {
        const pts = await pick(2, '起终点线');
        if (pts) await saveTrack({ startLine: pts });
      }),
      item('line', `添加分段线（当前 ${S.track.sectorLines.length} 条）`, async () => {
        if (!S.track.startLine) throw new Error('请先设置起终点线');
        if (S.track.sectorLines.length >= 5) throw new Error('最多 5 条分段线');
        const pts = await pick(2, `分段线 S${S.track.sectorLines.length + 1}`);
        if (pts) await saveTrack({ sectorLines: [...S.track.sectorLines, pts] });
      }),
      item('x', '清除分段线', () => saveTrack({ sectorLines: [] })),
      h('hr'),
      item('trash', '清除赛道与计时线', async () => {
        if (await confirmDialog('清除赛道？', '已记录的圈速不受影响。', '清除', true)) {
          await saveTrack({ startLine: null, sectorLines: [], path: null });
        }
      }, 'danger')
    );
    tools.appendChild(menu);
  });
  const onDocClick = () => closeMenu();
  document.addEventListener('click', onDocClick);

  async function saveTrack(body) {
    await patch(`/events/${eventId}`, body);
    toast('赛道已保存，已同步给所有车友', 'success');
  }

  let cancelPick = null;
  function pick(n, label) {
    return new Promise((resolve) => {
      const pts = [];
      const dots = L.layerGroup().addTo(bm.map);
      const text = h('span');
      const update = () => (text.textContent = `${label}：在赛道两侧各点一下（${pts.length}/${n}）`);
      const done = (v) => {
        bm.map.off('click', onClick);
        dots.remove();
        clear(pickBox);
        mapEl.style.cursor = '';
        cancelPick = null;
        resolve(v);
      };
      const onClick = (e) => {
        const p = bm.fromMap(e.latlng);
        pts.push(p);
        L.marker(bm.toMap(p), { icon: L.divIcon({ html: h('div', { class: 'pick-dot' }), className: '', iconSize: null }) }).addTo(dots);
        update();
        if (pts.length === n) done(pts);
      };
      cancelPick = () => done(null);
      update();
      clear(pickBox).appendChild(h('div', { class: 'pick-banner' }, text, h('button', { onclick: () => done(null) }, '取消')));
      mapEl.style.cursor = 'crosshair';
      bm.map.on('click', onClick);
    });
  }

  // ---------- 清理 ----------
  return () => {
    cancelPick?.();
    if (S.sharing) stopSharing();
    pttUp();
    voice.close();
    rt.close();
    timers.forEach(clearInterval);
    clearTimeout(panelTimer);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('click', onDocClick);
    cars.destroy();
    bm.remove();
  };
}
