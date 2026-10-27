import test from 'node:test';
import assert from 'node:assert/strict';
import { excessWait, ServiceLog } from '../server/service.mjs';
import { serviceDayStart } from '../web/gtfs-util.js';

const TZ = 'America/New_York';
const day = serviceDayStart('20261022', TZ); // a Thursday
const H = 3600;
const calendar = { WK: { days: [1, 1, 1, 1, 1, 0, 0], start: '20261001', end: '20261231' } };
// Route R1 northbound every 10 minutes: timepoints A (first) and C, ordinary stop B.
const trip = start => ({ r: 'R1', d: 0, h: 'North', sv: 'WK', s: [[1, 'A', start, 1], [2, 'B', start + 300], [3, 'C', start + 600, 1]] });
const trips = { T1: trip(8 * H), T2: trip(8 * H + 600), T3: trip(8 * H + 1200) };
const schedule = { trips, calendar, exceptions: [] };
const pass = (tripId, seq, time) => ({ tripId, seq, time, startDate: '20261022' });
const vehicles = (t, tripIds) => ({ header: { timestamp: t }, entity: tripIds.map(id => ({ id, vehicle: { trip: { tripId: id, startDate: '20261022' }, position: { latitude: 26.1, longitude: -80.1 }, timestamp: t } })) });

// Recorder running every minute from 7:30 to 9:30, buses on T1 and T2; T3 never shows.
function recordMorning(log) {
  for (let t = day + 7.5 * H; t <= day + 9.5 * H; t += 60) log.observe({ vehicles: vehicles(t, t < day + 8.5 * H ? ['T1', 'T2'] : []), trips, nowS: t });
}

test('service delivered: operated, canceled, missed, and unknown when the recorder was off', () => {
  const log = new ServiceLog({ timezone: TZ });
  recordMorning(log);
  let s = log.summary({ days: 1, schedule, nowS: day + 12 * H });
  assert.deepEqual(s.delivered.byDate[0], { date: '20261022', scheduled: 3, operated: 2, canceled: 0, missed: 1, unknown: 0 });
  assert.deepEqual(s.delivered.missed.map(m => m.tripId), ['T3']);
  s = log.summary({ days: 1, schedule, canceled: new Set(['20261022|T3']), nowS: day + 12 * H });
  assert.equal(s.delivered.byDate[0].canceled, 1);
  const quiet = new ServiceLog({ timezone: TZ }); // never ran: nothing can be called missed
  assert.equal(quiet.summary({ days: 1, schedule, nowS: day + 12 * H }).delivered.byDate[0].unknown, 3);
});

test('prediction accuracy: each lead-time bucket against the GPS arrival', () => {
  const log = new ServiceLog({ timezone: TZ });
  const live = (predicted, nowS) => ({ tripId: 'T1', startDate: '20261022', canceled: false, nextStop: { seq: 3 }, bySeq: new Map([[3, predicted]]) });
  // 25 min out it said 8:10; 8 min out, 8:12; 1 min out, 8:13. The bus passed C at 8:13.
  log.observe({ liveTrips: [live(day + 8 * H + 600)], trips, nowS: day + 8 * H + 600 - 1500 });
  log.observe({ liveTrips: [live(day + 8 * H + 720)], trips, nowS: day + 8 * H + 720 - 480 });
  log.observe({ liveTrips: [live(day + 8 * H + 780)], trips, nowS: day + 8 * H + 780 - 60 });
  log.observe({ passages: [pass('T1', 3, day + 8 * H + 780)], trips, nowS: day + 8 * H + 790 });
  const { byRoute } = log.summary({ days: 1, schedule, nowS: day + 12 * H }).predictions;
  // [count, Σ|error|, accurate, early, late] by bucket: 0-2 exact; 5-10 one min late (accurate); 20-30 three min late (accurate at the edge).
  assert.deepEqual(byRoute.R1, { 0: [1, 0, 1, 0, 0], 2: [1, 60, 1, 0, 0], 4: [1, 180, 1, 0, 0] });
});

test('headways and excess wait at timepoints', () => {
  const log = new ServiceLog({ timezone: TZ });
  // Timetabled 10 min apart at A; actually 2 min, then 18 min apart.
  log.observe({ passages: [pass('T1', 1, day + 8 * H + 480)], trips, nowS: day + 8 * H + 480 });
  log.observe({ passages: [pass('T2', 1, day + 8 * H + 600)], trips, nowS: day + 8 * H + 600 });
  log.observe({ passages: [pass('T3', 1, day + 8 * H + 1680)], trips, nowS: day + 8 * H + 1680 });
  const { byStop } = log.summary({ days: 1, schedule, nowS: day + 12 * H }).headways;
  const w = excessWait(byStop['R1|0|A']);
  assert.deepEqual(w, { n: 2, actualWaitS: 492, scheduledWaitS: 300, excessS: 192 }); // (120² + 1080²) / (2 × 1200) against 600² × 2 / (2 × 1200)
});

test('schedule fit: running time from first to last timepoint seen, once the trip is over', () => {
  const log = new ServiceLog({ timezone: TZ });
  log.observe({ passages: [pass('T1', 1, day + 8 * H + 60)], trips, nowS: day + 8 * H + 60 });
  log.observe({ passages: [pass('T1', 3, day + 8 * H + 780)], trips, nowS: day + 8 * H + 780 });
  assert.deepEqual(log.summary({ days: 1, schedule, nowS: day + 8 * H + 800 }).runtime.byTrip, {}); // not over yet
  log.observe({ trips, nowS: day + 8 * H + 780 + 700 });
  assert.deepEqual(log.summary({ days: 1, schedule, nowS: day + 12 * H }).runtime.byTrip, { T1: ['R1', 1, 720, 600, 1] }); // 12 min against 10: over by 10%+
});

test('state and days round-trip through storage', () => {
  const log = new ServiceLog({ timezone: TZ });
  recordMorning(log);
  const copy = new ServiceLog({ timezone: TZ });
  for (const d of log.dates()) copy.load(d, log.serialize(d));
  copy.importState(JSON.parse(JSON.stringify(log.exportState())));
  assert.deepEqual(copy.summary({ days: 1, schedule, nowS: day + 12 * H }), log.summary({ days: 1, schedule, nowS: day + 12 * H }));
});
