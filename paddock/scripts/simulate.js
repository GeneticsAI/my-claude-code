// 向任意正在运行的服务器派出模拟车手，用于联调和压测。
// 用法：npm run simulate -- --url http://localhost:3000 --event 1 --bots 4
// 机器人账号 sim_bot_1… 会自动注册并报名该活动（活动需有名额）。
import { parseArgs } from 'node:util';
import { Bot } from './bots.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3000' },
    event: { type: 'string' },
    bots: { type: 'string', default: '4' },
    password: { type: 'string', default: 'sim-bot-password' },
  },
});
if (!values.event) {
  console.error('请指定活动 id：npm run simulate -- --event <活动id>');
  process.exit(1);
}
const base = values.url.replace(/\/$/, '');
const eventId = Number(values.event);

async function call(method, url, body, token) {
  const res = await fetch(base + '/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

const CARS = ['Porsche Cayman GT4', 'BMW M2', 'Audi RS3', 'Mazda MX-5', 'Subaru BRZ', 'Mercedes-AMG GT', 'Ford Mustang GT', 'Toyota GR Supra'];
const bots = [];
for (let i = 1; i <= Number(values.bots); i++) {
  const username = `sim_bot_${i}`;
  let session;
  try {
    session = await call('POST', '/auth/login', { username, password: values.password });
  } catch {
    session = await call('POST', '/auth/register', { username, password: values.password, nickname: `模拟车手${i}`, car: CARS[(i - 1) % CARS.length] });
  }
  await call('POST', `/events/${eventId}/join`, {}, session.token);
  bots.push(new Bot({ base, token: session.token, user: session.user, eventId, skill: 0.9 + Math.random() * 0.08, startOffset: -i * 200 }).start());
  console.log(`🏎  ${session.user.nickname}（${session.user.car}）已上场`);
}
console.log('按 Ctrl+C 结束模拟');
process.on('SIGINT', () => {
  bots.forEach((b) => b.stop());
  setTimeout(() => process.exit(0), 300);
});
