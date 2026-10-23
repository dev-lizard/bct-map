import test from 'node:test';
import assert from 'node:assert/strict';
import { AT_STOP_M, KEEP_REPORTS, MAX_SPEED_MPS, approach, positionAt, pushReport, reckonCap, updateSpeed } from '../web/reckon.js';

test('updateSpeed blends observations and ignores bad intervals', () => {
  assert.equal(updateSpeed(null, 100, 10), 10);
  assert.equal(updateSpeed(10, 0, 10), 5); // half-way towards the new reading
  assert.equal(updateSpeed(10, -20, 10), 5); // backward jitter reads as stopped, not reversing
  assert.equal(updateSpeed(null, 5000, 10), MAX_SPEED_MPS);
  assert.equal(updateSpeed(7, 100, 0), 7);
});

test('reckonCap stops at the next stop, and holds a bus dwelling at one', () => {
  assert.equal(reckonCap(100, 10, 10), 200); // no stop known: one report interval ahead
  assert.equal(reckonCap(100, 10, 10, 150), 150); // stop ahead within reach
  assert.equal(reckonCap(100, 10, 10, 500), 200); // stop further than one interval
  assert.equal(reckonCap(100, 10, 10, 100 - AT_STOP_M / 2), 100); // at the stop: no extrapolation
  assert.equal(reckonCap(100, 10, 10, 50), 200); // stop already passed: ignored
});

test('pushReport keeps reports in order, flattens backward jitter, and keeps only the newest', () => {
  const reports = [];
  pushReport(reports, 10, 100);
  pushReport(reports, 10, 150); // same timestamp: ignored
  pushReport(reports, 5, 50); // older: ignored
  pushReport(reports, 20, 90); // jitter backwards: held at 100
  assert.deepEqual(reports, [{ ts: 10, along: 100 }, { ts: 20, along: 100 }]);
  for (let i = 3; i <= KEEP_REPORTS + 3; i++) pushReport(reports, i * 10, i * 100);
  assert.equal(reports.length, KEEP_REPORTS);
  assert.equal(reports.at(-1).ts, (KEEP_REPORTS + 3) * 10);
});

test('positionAt interpolates between reports and dead-reckons past the newest, capped', () => {
  const reports = [{ ts: 0, along: 0 }, { ts: 10, along: 100 }, { ts: 30, along: 100 }];
  assert.deepEqual(positionAt(reports, -5, 9, 999), { along: 0, speed: 0 });
  assert.deepEqual(positionAt(reports, 5, 9, 999), { along: 50, speed: 10 });
  assert.deepEqual(positionAt(reports, 20, 9, 999), { along: 100, speed: 0 }); // stood still between reports
  assert.deepEqual(positionAt(reports, 32, 5, 999), { along: 110, speed: 5 }); // past the newest report
  assert.deepEqual(positionAt(reports, 60, 5, 130), { along: 130, speed: 0 }); // ...up to the cap
  assert.equal(positionAt([], 0, 0, 0), null);
});

test('approach holds when drawn ahead and never passes the target', () => {
  assert.equal(approach(120, 100, 10, 0.1), 120);
  assert.equal(approach(99.99, 100, 10, 0.1), 100);
  const next = approach(50, 100, 10, 0.1);
  assert.ok(next > 50 && next < 100);
});

// Replays a bus through the same steps the map takes. Each poll (every `pollS`) sees only the newest
// report that has arrived, `latencyS` after it was made; in between, the bus is drawn `D` seconds
// behind the feed. D=0 is pure dead-reckoning from the newest report.
function simulate({ position, reportTs, latencyS, D, seconds, pollS = 10, fps = 10, stops = [] }) {
  const reports = [];
  let speed = null;
  let gapS = 10;
  let drawn = null;
  let cap = 0;
  let lastTs = null;
  const overshoots = [];
  const trace = [];
  for (let i = 0; i <= seconds * fps; i++) {
    const t = i / fps;
    if (i % (pollS * fps) === 0) {
      const ts = reportTs.filter(x => x + latencyS <= t).at(-1);
      if (ts != null && ts !== lastTs) {
        const along = position(ts);
        if (drawn != null) overshoots.push(Math.max(0, drawn - along));
        const last = reports.at(-1);
        if (last) {
          speed = updateSpeed(speed, along - last.along, ts - last.ts);
          gapS += 0.3 * (ts - last.ts - gapS);
        }
        pushReport(reports, ts, along);
        cap = reckonCap(reports.at(-1).along, speed ?? 0, gapS, stops.find(s => s >= along - 1) ?? null);
        if (drawn == null) drawn = along;
        lastTs = ts;
      }
    }
    if (reports.length) {
      const target = positionAt(reports, t - D, speed ?? 0, cap);
      drawn = approach(drawn, target.along, Math.max(0, target.speed), 1 / fps);
    }
    trace.push({ t, drawn });
  }
  return { overshoots, trace };
}

const neverReverses = trace => trace.every((s, i) => i === 0 || s.drawn == null || trace[i - 1].drawn == null || s.drawn >= trace[i - 1].drawn);
const every10s = Array.from({ length: 20 }, (_, i) => i * 10);

test('dead-reckoning (no delay), steady bus: reaches each next report without passing it', () => {
  const { overshoots, trace } = simulate({ position: t => 10 * t, reportTs: every10s, latencyS: 10, D: 0, seconds: 150 });
  assert.ok(Math.max(...overshoots) < 0.5, `overshoot ${Math.max(...overshoots)}`);
  assert.ok(neverReverses(trace));
});

test('dead-reckoning (no delay), bus dwelling at a stop: waits there instead of running on', () => {
  // 10 m/s to the stop at 250 m (t=25 s), 20 s dwell, then 10 m/s on towards the stop at 600 m.
  const position = t => (t < 25 ? 10 * t : t < 45 ? 250 : 250 + 10 * (t - 45));
  const { overshoots, trace } = simulate({ position, reportTs: every10s, latencyS: 10, D: 0, seconds: 150, stops: [250, 600] });
  assert.ok(Math.max(...overshoots) < 0.5, `overshoot ${Math.max(...overshoots)}`);
  assert.ok(neverReverses(trace));
});

// Like BCT's buses: irregular reports and stops at lights between them.
// 10 m/s, 30 s at a light, 12 m/s, 10 s at a stop, then 8 m/s.
const bursty = t => (t < 20 ? 10 * t : t < 50 ? 200 : t < 70 ? 200 + 12 * (t - 50) : t < 80 ? 440 : 440 + 8 * (t - 80));
const burstyReports = [0, 12, 20, 35, 41, 60, 66, 80, 95, 100, 118, 130, 141, 155, 170];

test('bursty bus: dead-reckoning alone runs past reports, which is why the map plays back', () => {
  const { overshoots } = simulate({ position: bursty, reportTs: burstyReports, latencyS: 8, D: 0, seconds: 200 });
  assert.ok(Math.max(...overshoots) > 25, `overshoot ${Math.max(...overshoots)}`);
});

test('bursty bus: playback with enough delay never passes the next report', () => {
  // Here the longest wait from one delivered report's timestamp to the next delivery is 30 s.
  const { overshoots, trace } = simulate({ position: bursty, reportTs: burstyReports, latencyS: 8, D: 35, seconds: 200 });
  assert.equal(Math.max(...overshoots), 0);
  assert.ok(neverReverses(trace));
});

test('bursty bus: playback keeps it moving while the real bus was driving', () => {
  const D = 35;
  const { trace } = simulate({ position: bursty, reportTs: burstyReports, latencyS: 8, D, seconds: 200 });
  // Display times when the real bus was driving (not at the light or the stop), away from the ends.
  const driving = s => s.t - D > 2 && s.t - D < 140 && !(s.t - D > 18 && s.t - D < 52) && !(s.t - D > 68 && s.t - D < 82);
  const frames = trace.map((s, i) => ({ s, prev: trace[i - 1] })).filter(({ s, prev }) => prev && driving(s));
  const still = frames.filter(({ s, prev }) => s.drawn === prev.drawn).length;
  assert.ok(still / frames.length < 0.05, `still ${((100 * still) / frames.length).toFixed(1)}%`);
});
