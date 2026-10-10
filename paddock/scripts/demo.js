// 一键演示：npm run demo
// 启动服务器（独立的 data-demo 目录，每次重建），写入演示车友 / 动态 / 活动 / 历史圈速，
// 并让 6 位模拟车手在“演示赛道日”里实时跑圈、聊天。用 demo / paddock123 登录即可体验。
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { demoTrack, SimDriver } from '../public/js/shared/track.js';
import { LapTimer, compactTrace } from '../public/js/shared/laptimer.js';
import { Bot } from './bots.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR || path.join(ROOT, 'data-demo');
const port = Number(process.env.PORT || 3000);
rmSync(dataDir, { recursive: true, force: true });

const app = createApp({ dataDir });
const { store } = app;

const DRIVERS = [
  { username: 'linyu', nickname: '林雨', car: 'Porsche 911 GT3 RS', bio: '纽北 7 分 40 是小目标', skill: 0.985 },
  { username: 'ajie', nickname: '阿杰', car: 'BMW M4 CSL', bio: '后驱信仰', skill: 0.97 },
  { username: 'kevin', nickname: 'Kevin', car: 'Honda Civic Type R FL5', bio: '前驱也能很快', skill: 0.955 },
  { username: 'laozhou', nickname: '老周', car: 'Nissan GT-R Nismo', bio: '周末赛道，平时奶爸', skill: 0.95 },
  { username: 'sophie', nickname: '苏菲', car: 'Lotus Emira', bio: '轻量化才是王道', skill: 0.94 },
  { username: 'xiaopeng', nickname: '小鹏', car: 'Toyota GR86', bio: '入坑第一年，多多指教', skill: 0.915 },
];
const COLORS = ['#b05cff', '#22c3ee', '#2bd96b', '#ffb020', '#ff4fa3', '#a3e635'];

const demo = store.createUser({ username: 'demo', password: 'paddock123', nickname: '体验官', car: 'Porsche 718 Cayman GT4' });
store.updateUser(demo.id, { color: '#ff4d1a', bio: '体验账号 · 欢迎来到围场' });
const drivers = DRIVERS.map((d, i) => {
  const u = store.createUser({ username: d.username, password: 'paddock123', nickname: d.nickname, car: d.car });
  return { ...d, ...store.updateUser(u.id, { color: COLORS[i], bio: d.bio }) };
});

const now = Date.now();
const H = 3600 * 1000;
const anchor = { lat: 31.3389, lng: 121.2197 };

// 进行中的赛道日（模拟车手在这里跑）
const live = store.createEvent(drivers[0].id, {
  title: '周六晨练 · 赛道日（演示）',
  description: '演示活动：模拟车手正在实时跑圈。\n\n进入「实况」可以看到所有人的实时位置、圈速和差距；点「开始共享位置 → 模拟驾驶」自己也下场跑一圈；按住右下角按钮可以对讲（用两个浏览器窗口登录不同账号试试）。',
  kind: 'trackday', startsAt: now - 0.5 * H, place: '演示赛道（模拟数据）', lat: anchor.lat, lng: anchor.lng, maxMembers: 20,
});
store.updateEvent(live, demoTrack(anchor));

// 往期赛道日（带历史圈速，方便看圈速分析）
const pastAnchor = { lat: 31.29, lng: 121.17 };
const past = store.createEvent(drivers[1].id, {
  title: '九月夜跑赛道日', description: '感谢大家参与！圈速已经全部上传，欢迎查看分析。',
  kind: 'trackday', startsAt: now - 21 * 24 * H, place: '演示赛道 B（模拟数据）', lat: pastAnchor.lat, lng: pastAnchor.lng, maxMembers: 16,
});
const pastTrack = demoTrack(pastAnchor, { seed: 3, heading: 30 });
store.updateEvent(past, pastTrack);

const touring = store.createEvent(drivers[3].id, {
  title: '盘山公路巡航 · 安吉', description: '早上 7 点服务区集合，全程车队对讲，不飙车、不压线，注意安全。中午农家乐。',
  kind: 'touring', startsAt: now + 6 * 24 * H, place: '沪渝高速 · 嘉兴服务区', lat: 30.7522, lng: 120.7555, maxMembers: 12,
});
const meetup = store.createEvent(drivers[4].id, {
  title: '咖啡 & 车 · 周日早茶车聚', description: '聊车、拍照、交换改装心得。欢迎带上你的爱车！',
  kind: 'meetup', startsAt: now + 9 * 24 * H, place: '西岸美术馆停车场', lat: 31.1700, lng: 121.4560, maxMembers: 0,
});

for (const d of drivers) {
  store.join(live, d.id);
  store.join(past, d.id);
}
store.join(live, demo.id);
store.join(past, demo.id);
store.join(touring, drivers[0].id);
store.join(touring, drivers[2].id);
store.join(meetup, drivers[5].id);

/** 离线模拟若干圈并写入数据库 */
function seedLaps(eventId, track, user, skill, laps, startTs) {
  const sim = new SimDriver(track.path, { skill, noise: 1.2, startOffset: -150, seed: user.id * 31 });
  const timer = new LapTimer({ startLine: track.startLine, sectorLines: track.sectorLines });
  let ts = startTs;
  const ids = [];
  while (ids.length < laps) {
    ts += 500;
    for (const e of timer.push(sim.step(500, ts))) {
      if (e.type !== 'lap') continue;
      const { id } = store.addLap(eventId, user, { ...e.lap, trace: compactTrace(e.lap.trace) });
      ids.push(id);
    }
  }
  return ids;
}

const liveTrack = store.eventTrack(live);
const pastLapIds = {};
drivers.forEach((d, i) => {
  pastLapIds[d.username] = seedLaps(past, pastTrack, d, d.skill, 5, now - 21 * 24 * H + i * 60_000);
  seedLaps(live, liveTrack, d, d.skill, 2, now - 0.4 * H + i * 45_000);
});
const demoPast = seedLaps(past, pastTrack, demo, 0.9, 4, now - 21 * 24 * H + 9 * 60_000);

// 关注关系
for (const d of drivers) {
  store.follow(demo.id, d.id);
  if (d.skill > 0.94) store.follow(d.id, demo.id);
}
store.follow(drivers[5].id, drivers[0].id);
store.follow(drivers[2].id, drivers[1].id);

// 动态
const best = (ids) => ids.map((id) => store.getLap(id)).sort((a, b) => a.lapMs - b.lapMs)[0];
const posts = [
  [drivers[5], { text: '第一次下赛道，紧张到手心出汗 😂 感谢林雨哥带线！', eventId: past }],
  [drivers[0], { text: '九月夜跑的最快圈，T5 晚刹还是有点保守，下次再挑战。', lapId: best(pastLapIds.linyu).id }],
  [drivers[3], { text: '下周安吉盘山巡航，还有几个名额，全程对讲，新手友好～', eventId: touring }],
  [drivers[1], { text: '换了一套半热熔，抓地力提升肉眼可见。周六赛道日见！' }],
  [drivers[4], { text: 'Emira 的转向手感真的太细腻了，轻量化 yyds。' }],
  [demo, { text: '我的第一个计时圈，还有很大进步空间 💪', lapId: best(demoPast).id }],
];
const postIds = posts.map(([u, p], i) => {
  const post = store.createPost(u.id, p);
  store.db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(now - (posts.length - i) * 2.7 * H, post.id);
  return post.id;
});
store.like(postIds[0], drivers[0].id);
store.like(postIds[0], drivers[2].id);
store.like(postIds[1], drivers[5].id);
store.like(postIds[1], demo.id);
store.like(postIds[5], drivers[0].id);
store.like(postIds[5], drivers[3].id);
store.addComment(postIds[0], drivers[0].id, '进步很快！下次教你循迹刹车');
store.addComment(postIds[1], drivers[1].id, '这个 T5 我也是，入弯太早了');
store.addComment(postIds[5], drivers[0].id, '欢迎入坑！');
store.addComment(postIds[5], drivers[4].id, '加油，下次一起跑');
store.addMessage(live, drivers[0].id, '早！今天赛道温度不错，大家注意前几圈热胎');
store.addMessage(live, drivers[5].id, '收到，我先跟在后面学走线');

await app.listen(port, '0.0.0.0');
console.log('\n   演示账号：demo / paddock123（其他车友账号如 linyu、ajie 密码相同）');
console.log(`   打开 http://localhost:${port} 登录后，在「活动」里进入「周六晨练 · 赛道日（演示）」→ 进入实况\n`);

const base = `http://127.0.0.1:${port}`;
const bots = drivers.map((d, i) =>
  new Bot({ base, token: store.createSession(d.id), user: d, eventId: live, skill: d.skill, startOffset: -i * 650 }).start()
);

const shutdown = async () => {
  bots.forEach((b) => b.stop());
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
