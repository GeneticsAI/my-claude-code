import test from 'node:test';
import assert from 'node:assert/strict';
import { distance, crossLine, wgsToGcj, gcjToWgs, destination, bearing } from '../public/js/shared/geo.js';
import { LapTimer, MotionEstimator, timeAtDistance, compactTrace } from '../public/js/shared/laptimer.js';
import { encode, decode } from '../public/js/shared/mulaw.js';
import { demoTrack, SimDriver, prepareCircuit, circuitForEvent } from '../public/js/shared/track.js';
import { fmtLap, fmtDelta, fmtSector } from '../public/js/shared/format.js';

const ANCHOR = { lat: 31.3389, lng: 121.2197 };

test('distance / destination / bearing are consistent', () => {
  const p = destination(ANCHOR, 45, 1000);
  assert.ok(Math.abs(distance(ANCHOR, p) - 1000) < 0.5);
  assert.ok(Math.abs(bearing(ANCHOR, p) - 45) < 0.1);
});

test('crossLine detects crossing, fraction and direction', () => {
  const q1 = destination(ANCHOR, 0, 20);
  const q2 = destination(ANCHOR, 180, 20);
  const west = destination(ANCHOR, 270, 30);
  const east = destination(ANCHOR, 90, 10);
  const c = crossLine(west, east, q1, q2);
  assert.ok(c);
  assert.ok(Math.abs(c.t - 0.75) < 0.01);
  const back = crossLine(east, west, q1, q2);
  assert.equal(back.dir, -c.dir);
  assert.equal(crossLine(west, destination(ANCHOR, 270, 5), q1, q2), null);
});

test('GCJ-02 offset is realistic and inverse round-trips', () => {
  const [glat, glng] = wgsToGcj(39.908692, 116.397477);
  const shift = distance({ lat: 39.908692, lng: 116.397477 }, { lat: glat, lng: glng });
  assert.ok(shift > 100 && shift < 800, `shift ${shift}`);
  const [wlat, wlng] = gcjToWgs(glat, glng);
  assert.ok(Math.abs(wlat - 39.908692) < 1e-6 && Math.abs(wlng - 116.397477) < 1e-6);
  assert.deepEqual(wgsToGcj(48.8566, 2.3522), [48.8566, 2.3522]);
});

test('mu-law round trip keeps signal within quantisation error', () => {
  const src = new Float32Array(1000).map((_, i) => 0.8 * Math.sin(i / 7));
  const out = decode(encode(src));
  let err = 0;
  for (let i = 0; i < src.length; i++) err = Math.max(err, Math.abs(out[i] - src[i]));
  assert.ok(err < 0.03, `max err ${err}`);
  assert.equal(encode(new Float32Array([0]))[0], 0xff);
});

test('format helpers', () => {
  assert.equal(fmtLap(83456), '1:23.456');
  assert.equal(fmtLap(59999.6), '1:00.000');
  assert.equal(fmtLap(null), '-:--.---');
  assert.equal(fmtDelta(-320), '-0.32');
  assert.equal(fmtDelta(1534), '+1.53');
  assert.equal(fmtSector(31234), '31.234');
});

function drive(track, { laps = 3, hz = 1, skill = 1, seed = 3, noise = 0 } = {}) {
  const sim = new SimDriver(track.path, { skill, seed, noise, startOffset: -150 });
  const timer = new LapTimer({ startLine: track.startLine, sectorLines: track.sectorLines });
  const prep = prepareCircuit(track.path);
  const events = [];
  let ts = 1_700_000_000_000;
  const step = 1000 / hz;
  const total = ((laps + 0.3) * prep.length) / 30;
  for (let t = 0; t < total * 1000; t += step) {
    ts += step;
    events.push(...timer.push(sim.step(step, ts)));
  }
  return { events, timer, prep };
}

test('LapTimer times simulated laps consistently with track length and speed', () => {
  const track = demoTrack(ANCHOR);
  const { events, timer, prep } = drive(track, { laps: 3, hz: 1 });
  assert.equal(events[0].type, 'lapStart');
  const laps = events.filter((e) => e.type === 'lap').map((e) => e.lap);
  assert.ok(laps.length >= 2, `laps ${laps.length}`);
  for (const lap of laps) {
    // 1Hz 采样下按弦长累计距离，比真实赛道略短但应在 2% 以内
    assert.ok(Math.abs(lap.distance - prep.length) / prep.length < 0.02, `dist ${lap.distance} vs ${prep.length}`);
    assert.equal(lap.sectors.length, 3);
    const sum = lap.sectors.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - lap.lapMs) < 1);
    assert.ok(lap.lapMs > 60_000 && lap.lapMs < 240_000, `lap ${lap.lapMs}`);
    assert.ok(lap.maxSpeed > 30);
  }
  assert.equal(timer.best.lapMs, Math.min(...laps.map((l) => l.lapMs)));
  assert.equal(events.filter((e) => e.type === 'sector').length >= laps.length * 2, true);
});

test('interpolated crossing makes 1Hz timing agree with 10Hz timing', () => {
  const track = demoTrack(ANCHOR, { seed: 11 });
  const a = drive(track, { hz: 1, seed: 5 }).events.filter((e) => e.type === 'lap');
  const b = drive(track, { hz: 10, seed: 5 }).events.filter((e) => e.type === 'lap');
  assert.ok(a.length && b.length);
  const diff = Math.abs(a[0].lap.lapMs - b[0].lap.lapMs);
  assert.ok(diff < 150, `1Hz vs 10Hz differ by ${diff}ms`);
});

test('LapTimer ignores reverse crossings and jitter shorter than minLapMs', () => {
  const q1 = destination(ANCHOR, 0, 20);
  const q2 = destination(ANCHOR, 180, 20);
  const timer = new LapTimer({ startLine: [q1, q2], minLapMs: 20000 });
  const W = destination(ANCHOR, 270, 10);
  const E = destination(ANCHOR, 90, 10);
  let ts = 0;
  const at = (p) => ({ ...p, ts: (ts += 1000), spd: 20 });
  assert.deepEqual(timer.push(at(W)), []);
  assert.equal(timer.push(at(E))[0].type, 'lapStart');
  assert.deepEqual(timer.push(at(W)), []); // reverse
  assert.deepEqual(timer.push(at(E)), []); // forward but only 2s later
  ts += 60000;
  timer.push(at(W));
  const ev = timer.push(at(E));
  assert.equal(ev[0].type, 'lap');
  assert.ok(Math.abs(ev[0].lap.lapMs - 64000) < 1);
  assert.equal(ev[0].lap.sectors, null);
});

test('live delta is negative when faster than the reference lap', () => {
  const track = demoTrack(ANCHOR, { seed: 4 });
  const timer = new LapTimer({ startLine: track.startLine });
  const slow = new SimDriver(track.path, { skill: 0.9, consistency: 0, startOffset: -100 });
  let ts = 0;
  for (let i = 0; i < 400; i++) {
    ts += 500;
    timer.push(slow.step(500, ts));
  }
  assert.ok(timer.best, 'reference lap recorded');
  const fast = new SimDriver(track.path, { skill: 1.05, consistency: 0, startOffset: 0 });
  const t2 = new LapTimer({ startLine: track.startLine });
  t2.setBest(timer.best);
  // 新车手先开出 out lap，再在计时圈跑到一半时检查 Δ
  fast.s = -100;
  while (fast.s < fast.track.length * 0.5) {
    ts += 500;
    t2.push(fast.step(500, ts));
  }
  const d = t2.delta();
  assert.ok(d != null && d < 0, `delta ${d}`);
});

test('timeAtDistance interpolates and compactTrace bounds size', () => {
  const trace = [[0, 0], [100, 1000], [300, 2000]];
  assert.equal(timeAtDistance(trace, 50), 500);
  assert.equal(timeAtDistance(trace, 200), 1500);
  assert.equal(timeAtDistance(trace, 400), null);
  const big = Array.from({ length: 2000 }, (_, i) => [i, i * 10, 30, 31 + i / 1e6, 121]);
  const c = compactTrace(big, 500);
  assert.equal(c.length, 500);
  assert.deepEqual(c[0].slice(0, 2), [0, 0]);
  assert.equal(c[499][0], 1999);
});

test('MotionEstimator reports lateral G in a steady corner', () => {
  const m = new MotionEstimator(1);
  const r = 100;
  const v = 25;
  let out;
  for (let i = 0; i < 20; i++) {
    const ang = ((i * v) / r) * (180 / Math.PI);
    const p = destination(ANCHOR, ang, r);
    out = m.push({ ...p, spd: v, ts: i * 1000, hdg: (ang + 90) % 360 });
  }
  const expected = (v * v) / r / 9.80665;
  assert.ok(Math.abs(out.latG - expected) < 0.1, `latG ${out.latG} vs ${expected}`);
  assert.ok(Math.abs(out.lonG) < 0.05);
});

test('circuitForEvent anchors generated loops at the start line', () => {
  const track = demoTrack(ANCHOR);
  const path = circuitForEvent({ startLine: track.startLine });
  const [a, b] = track.startLine;
  const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
  assert.ok(distance(mid, { lat: path[0][0], lng: path[0][1] }) < 1);
  const timer = new LapTimer({ startLine: track.startLine });
  const sim = new SimDriver(path, { startOffset: -50 });
  let ts = 0;
  let laps = 0;
  for (let i = 0; i < 700; i++) {
    ts += 500;
    laps += timer.push(sim.step(500, ts)).filter((e) => e.type === 'lap').length;
  }
  assert.ok(laps >= 1);
});
