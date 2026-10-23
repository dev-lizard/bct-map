import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReliabilityLog } from '../server/reliability.mjs';
import { serviceDayStart } from '../web/gtfs-util.js';

const TZ = 'America/New_York';
const H = 3600;
const day = serviceDayStart('20261022', TZ);
// Timepoints (4th element 1) at sequences 1, 3 and 5; 2 and 4 are ordinary stops.
const trips = {
  T1: { r: 'R1', s: [[1, 'A', 8 * H, 1], [2, 'B', 8 * H + 300], [3, 'C', 8 * H + 600, 1], [4, 'D', 8 * H + 900], [5, 'E', 8 * H + 1200, 1]] },
  T2: { r: 'R2', s: [[1, 'A', 9 * H, 1], [2, 'B', 9 * H + 600, 1]] },
};
// Stops a bus was seen to pass (SegmentLog.observe's onPass).
const passed = (tripId, times, startDate = '20261022') =>
  Object.entries(times).map(([seq, time]) => ({ tripId, seq: Number(seq), time, startDate }));

test('records each timepoint departure, once, and only at timepoints', () => {
  const log = new ReliabilityLog({ timezone: TZ });
  // 2 min late leaving timepoint 1, past ordinary stop 2, 1 min early at timepoint 3.
  const t1 = passed('T1', { 1: day + 8 * H + 120, 2: day + 8 * H + 400, 3: day + 8 * H + 540 });
  assert.equal(log.observe(t1, trips), 2);
  assert.deepEqual(log.samples.map(s => [s[1], s[2]]), [['R1', 120], ['R1', -60]]);
  assert.equal(log.observe(t1, trips), 0); // already recorded
});

test('skips implausible delays; works out the service date when the feed omits it', () => {
  const log = new ReliabilityLog({ timezone: TZ });
  assert.equal(log.observe(passed('T2', { 1: day + 9 * H + 5 * H }), trips), 0); // 5 h "late"
  // No start date in the feed: the service day whose timetable is nearest is used (the 22nd: 1 min late).
  assert.equal(log.observe(passed('T2', { 2: day + 9 * H + 660 }, null), trips), 1);
  assert.deepEqual(log.samples.at(-1).slice(1, 3), ['R2', 60]);
});

test('summary: on time is 1 min early to 5 min late; by route and by hour', () => {
  const log = new ReliabilityLog({ timezone: TZ });
  // [time, route, delay, hour]
  log.samples = [
    [day + 8 * H, 'R1', -120, 8], // early
    [day + 8 * H, 'R1', 0, 8], // on time
    [day + 9 * H, 'R1', 299, 9], // on time
    [day + 9 * H, 'R1', 400, 9], // late
    [day + 9 * H, 'R2', 30, 9], // on time
  ];
  const nowS = day + 10 * H;
  const all = log.summary({ nowS });
  assert.equal(all.samples, 5);
  assert.equal(all.onTimePct, 60);
  assert.deepEqual(all.routes.map(r => [r.routeId, r.onTimePct, r.earlyPct, r.latePct]), [['R2', 100, 0, 0], ['R1', 50, 25, 25]]);

  const r1 = log.summary({ nowS, routeId: 'R1' });
  assert.equal(r1.meanDelayS, 145); // (-120 + 0 + 299 + 400) / 4
  assert.deepEqual(r1.byHour.map(h => [h.hour, h.samples, h.onTimePct]), [[8, 2, 50], [9, 2, 50]]);

  assert.equal(log.summary({ nowS: nowS + 8 * 86400, days: 7 }).samples, 0); // outside the window
});

test('departures persist to disk and are not recorded twice after a restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bt3d-reliability-'));
  try {
    const feedTs = day + 8 * H + 800;
    const t1 = passed('T1', { 1: day + 8 * H + 120, 3: day + 8 * H + 540 });
    const first = new ReliabilityLog({ dir, timezone: TZ });
    await first.load(feedTs);
    first.observe(t1, trips);
    await first.flush();
    const lines = (await fs.readFile(path.join(dir, '20261022.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);

    const second = new ReliabilityLog({ dir, timezone: TZ });
    await second.load(feedTs);
    assert.equal(second.samples.length, 2);
    assert.equal(second.observe(t1, trips), 0); // remembered from the file
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
