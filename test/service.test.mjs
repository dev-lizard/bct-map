import test from 'node:test';
import assert from 'node:assert/strict';
import { excessWait, findHubs, ServiceLog } from '../server/service.mjs';
import { toSchedule } from '../web/schedule.js';
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
  assert.deepEqual(s.delivered.byDate[0], { date: '20261022', scheduled: 3, operated: 2, partial: 0, canceled: 0, missed: 1, unknown: 0 });
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
  assert.deepEqual(log.summary({ days: 1, schedule, nowS: day + 12 * H }).runtime.byTrip, { T1: ['R1', 1, 720, 600, 1, 1, 60, 0] }); // 12 min against 10: over by 10%+; left 1 min late
});

test('state and days round-trip through storage', () => {
  const log = new ServiceLog({ timezone: TZ });
  recordMorning(log);
  const copy = new ServiceLog({ timezone: TZ });
  for (const d of log.dates()) copy.load(d, log.serialize(d));
  copy.importState(JSON.parse(JSON.stringify(log.exportState())));
  assert.deepEqual(copy.summary({ days: 1, schedule, nowS: day + 12 * H }), log.summary({ days: 1, schedule, nowS: day + 12 * H }));
});

test('schedule fit also keeps the start delay; on-time and delay by timepoint feed trends', () => {
  const log = new ServiceLog({ timezone: TZ });
  log.observe({ passages: [pass('T1', 1, day + 8 * H + 180)], trips, nowS: day + 8 * H + 180 }); // left A 3 min late
  log.observe({ passages: [pass('T1', 3, day + 8 * H + 840)], trips, nowS: day + 8 * H + 840 }); // C 4 min late
  log.observe({ trips, nowS: day + 8 * H + 840 + 700 });
  const s = log.summary({ days: 1, schedule, nowS: day + 12 * H });
  assert.deepEqual(s.runtime.byTrip.T1, ['R1', 1, 660, 600, 0, 1, 180, 1]); // a late start, 1 min lost on the way
  assert.deepEqual(s.delays, { 'R1|0|A': [1, 180, 0], 'R1|0|C': [1, 240, 600] });
  assert.deepEqual(s.daily[0].ontime.R1, [2, 0, 0, 420]); // both within 5 min late: on time
});

test('transfers: a timetabled connection at a hub, made or missed by the real times', () => {
  // R1 ends at hub stop H1 at 8:10; R2 leaves hub stop H2 at 8:15 and 8:30. Both stops are in station P.
  const hubTrips = {
    T1: { r: 'R1', d: 0, h: 'Hub', sv: 'WK', s: [[1, 'A', 8 * H, 1], [2, 'H1', 8 * H + 600, 1]] },
    U1: { r: 'R2', d: 0, h: 'Out', sv: 'WK', s: [[1, 'H2', 8 * H + 900, 1], [2, 'Z', 8 * H + 1500, 1]] },
    U2: { r: 'R2', d: 0, h: 'Out', sv: 'WK', s: [[1, 'H2', 8 * H + 1800, 1], [2, 'Z', 8 * H + 2400, 1]] },
  };
  const sched = toSchedule({ meta: { timezone: TZ }, calendar, exceptions: [], trips: hubTrips });
  const stopRows = [['P', '', 0, 0, 'Hub Station', 1, '', ''], ['H1', '', 0, 0, 'Bay 1', 0, '', 'P'], ['H2', '', 0, 0, 'Bay 2', 0, '', 'P']];
  const hubs = findHubs(stopRows, sched, 2);
  assert.deepEqual(hubs, [{ id: 'P', name: 'Hub Station', stops: ['H1', 'H2'] }]);
  const run = (arrive, depart) => {
    const log = new ServiceLog({ timezone: TZ });
    log.setHubs(hubs, sched);
    log.observe({ passages: [pass('T1', 2, day + 8 * H + arrive)], trips: sched.trips, nowS: day + 8 * H + arrive });
    log.observe({ passages: [pass('U1', 1, day + 8 * H + depart)], trips: sched.trips, nowS: day + 8 * H + depart });
    return log.summary({ days: 1, schedule: sched, nowS: day + 12 * H }).transfers.byHub.P['R1>R2'];
  };
  assert.deepEqual(run(660, 840), [1, 1, 180, 0, 0]); // in at 8:11, out at 8:14: made
  assert.deepEqual(run(840, 900), [1, 0, 0, 900, 1]); // in at 8:14, out at 8:15: missed, 15 more minutes
  assert.deepEqual(run(960, 900), [1, 0, 0, 900, 1]); // the connection left before the bus came in
});

test('feed quality: stale reports, GPS gaps, timetable-only predictions, and buses that vanish', () => {
  const log = new ServiceLog({ timezone: TZ });
  const feed = (t, reportT) => ({ header: { timestamp: t }, entity: [{ id: 'bus1', vehicle: { vehicle: { id: 'bus1' }, trip: { tripId: 'T1', startDate: '20261022' }, position: { latitude: 26.1, longitude: -80.1 }, timestamp: reportT } }] });
  log.observe({ vehicles: feed(day + 8 * H, day + 8 * H), trips, nowS: day + 8 * H });
  log.observe({ vehicles: feed(day + 8 * H + 600, day + 8 * H + 360), trips, nowS: day + 8 * H + 600 }); // 6 min since the last: a gap, and 4 min old: stale
  const live = predicted => ({ tripId: 'T2', startDate: '20261022', canceled: false, nextStop: { seq: 3 }, bySeq: new Map([[3, predicted]]) });
  log.observe({ liveTrips: [live(day + 8 * H + 1200)], trips, nowS: day + 8 * H + 700 }); // exactly the timetable
  log.observe({ liveTrips: [live(day + 8 * H + 1290)], trips, nowS: day + 8 * H + 760 });
  // L1 seen leaving its first timepoint, then nothing, with 30 timetabled minutes to go: it dropped out.
  const longTrips = { ...trips, L1: { r: 'R1', d: 0, sv: 'WK', s: [[1, 'A', 8 * H, 1], [2, 'C', 8 * H + 1800, 1]] } };
  log.observe({ passages: [pass('L1', 1, day + 8 * H + 770)], trips: longTrips, nowS: day + 8 * H + 770 });
  for (let t = 830; t <= 1500; t += 60) log.observe({ trips: longTrips, nowS: day + 8 * H + t });
  const f = log.summary({ days: 1, schedule, nowS: day + 12 * H }).feed;
  assert.deepEqual(f.byDate[0], { date: '20261022', reports: 2, stale: 1, gaps: 1, dropouts: 1, predictedTrips: 2, timetableOnly: 1 });
  assert.deepEqual(f.byRoute.R1, [1, 1, 2, 1]);
});

test('schedule: routes and weekday departures by stop', () => {
  const sched = toSchedule({ meta: { timezone: TZ }, calendar, exceptions: [], trips });
  assert.deepEqual([...sched.routesByStop().get('B')], ['R1']);
  assert.deepEqual(Object.fromEntries(sched.departuresByStop(new Set(['WK']))), { A: 3, B: 3 }); // C is where they end
});

test('service delivered: a trip GPS saw run only part of the way is partial', () => {
  // L runs A 8:00, B 8:20, C 8:40. GPS saw it leave A and pass B, then nothing: the last 20 minutes weren't run.
  const longTrips = { L: { r: 'R1', d: 0, sv: 'WK', s: [[1, 'A', 8 * H, 1], [2, 'B', 8 * H + 1200], [3, 'C', 8 * H + 2400, 1]] } };
  const sched = { trips: longTrips, calendar, exceptions: [] };
  const run = passages => {
    const log = new ServiceLog({ timezone: TZ });
    for (let t = day + 7.5 * H; t <= day + 9.5 * H; t += 60) log.observe({ vehicles: vehicles(t, t < day + 8.4 * H ? ['L'] : []), trips: longTrips, nowS: t });
    log.observe({ passages, trips: longTrips, nowS: day + 9.5 * H });
    return log.summary({ days: 1, schedule: sched, nowS: day + 12 * H }).delivered;
  };
  let d = run([pass('L', 1, day + 8 * H + 30), pass('L', 2, day + 8 * H + 1250)]);
  assert.equal(d.byDate[0].partial, 1);
  assert.deepEqual(d.partial.map(({ tripId, notRunStartS, notRunEndS, fromStop, toStop }) => ({ tripId, notRunStartS, notRunEndS, fromStop, toStop })),
    [{ tripId: 'L', notRunStartS: 0, notRunEndS: 1200, fromStop: 'A', toStop: 'B' }]);
  d = run([pass('L', 1, day + 8 * H + 30), pass('L', 2, day + 8 * H + 1250), pass('L', 3, day + 8 * H + 2450)]);
  assert.deepEqual([d.byDate[0].operated, d.byDate[0].partial], [1, 0]); // the whole way: ran in full
});
