import test from 'node:test';
import assert from 'node:assert/strict';
import { runningTimeByWeather, SegmentLog } from '../server/segments.mjs';
import { WEATHER_CLASSES } from '../server/analytics.mjs';
import { serviceDayStart } from '../web/gtfs-util.js';

const TZ = 'America/New_York';
const day = serviceDayStart('20261023', TZ);
const DEG_PER_M = 1 / 110_540;
// Stops A to E going north, 400 m apart; timetable allows 60 s between each.
const stops = new Map(['A', 'B', 'C', 'D', 'E'].map((id, i) => [id, { lat: 26.1 + i * 400 * DEG_PER_M, lon: -80.15 }]));
const trips = { T1: { r: 'R1', s: ['A', 'B', 'C', 'D', 'E'].map((id, i) => [i + 1, id, 8 * 3600 + i * 60]) } };
// A vehicle-positions feed with one bus `metres` north of stop A at time `t`.
const report = (t, metres, extra = {}) => ({
  header: { timestamp: t },
  entity: [{ id: '1', vehicle: { trip: { tripId: 'T1' }, position: { latitude: 26.1 + metres * DEG_PER_M, longitude: -80.15 + 0.0003 }, timestamp: t, vehicle: { id: 'bus' }, ...extra } }],
});

test('stop-to-stop running times are interpolated from GPS reports, from the second stop passed on', () => {
  const log = new SegmentLog({ timezone: TZ });
  const t0 = day + 7 * 3600 + 30 * 60; // 7:30 AM: morning peak
  let runs = 0;
  // Leaves B (25 m past it, 425 m) at +37.5 s and C (825 m) at +77.5 s, then slows: D (1225 m) at +126.7 s.
  for (const [dt, m] of [[0, 50], [30, 350], [60, 650], [90, 950], [130, 1250]]) runs += log.observe(report(t0 + dt, m), { trips, stops });
  assert.equal(runs, 2); // B -> C and C -> D (A -> B needs the bus seen before A)
  const { segments, hourRows } = log.query({ days: 1, nowS: t0 + 200 });
  const am = 1; // PERIODS index of the morning peak
  const byKey = new Map(segments.map(s => [`${s[0]}>${s[1]}`, s.slice(2)]));
  assert.deepEqual(byKey.get('B>C').slice(am * 3, am * 3 + 3), [1, 40, 60]);
  assert.deepEqual(byKey.get('C>D').slice(am * 3, am * 3 + 3), [1, 49, 60]);
  assert.deepEqual(hourRows, [{ date: '20261023', hour: 7, n: 2, run: 89, sched: 120 }]);
});

test('repeated reports, long gaps, off-route fixes and impossible speeds are ignored', () => {
  const log = new SegmentLog({ timezone: TZ });
  const t0 = day + 12 * 3600;
  assert.equal(log.observe(report(t0, 350), { trips, stops }) + log.observe(report(t0, 350), { trips, stops }), 0);
  assert.equal(log.observe(report(t0 + 600, 1250), { trips, stops }), 0); // 10 minutes later: gap, not joined
  const far = { ...report(t0 + 610, 1300) };
  far.entity[0].vehicle.position.longitude = -80.12; // 3 km east of the line
  assert.equal(log.observe(far, { trips, stops }), 0);
  const fast = new SegmentLog({ timezone: TZ });
  fast.observe(report(t0, 350), { trips, stops });
  assert.equal(fast.observe(report(t0 + 5, 1250), { trips, stops }), 0); // 180 m/s
});

test('a day round-trips through its saved form; old days are pruned', () => {
  const log = new SegmentLog({ timezone: TZ });
  const t0 = day + 17 * 3600;
  for (const [dt, m] of [[0, 350], [60, 1250]]) log.observe(report(t0 + dt, m), { trips, stops });
  assert.deepEqual([...log.dirty], ['20261023']);
  const copy = new SegmentLog({ timezone: TZ });
  copy.load('20261023', log.serialize('20261023'));
  assert.deepEqual(copy.query({ days: 1, nowS: t0 }), log.query({ days: 1, nowS: t0 }));
  assert.deepEqual(copy.prune('20261024'), ['20261023']);
  assert.equal(copy.query({ days: 1, nowS: t0 }).segments.length, 0);
});

test('running time by weather compares wet hours with dry ones at the same hour', () => {
  const rows = [
    { date: '20261020', hour: 17, n: 100, run: 6000, sched: 6000 }, // dry 5 PM: index 1.0
    { date: '20261021', hour: 17, n: 40, run: 2880, sched: 2400 }, // rainy 5 PM: 1.2
    { date: '20261021', hour: 8, n: 10, run: 600, sched: 600 }, // rainy 8 AM, but no dry 8 AM to compare
  ];
  const weather = new Map([['20261020|17', 'dry'], ['20261021|17', 'rain'], ['20261021|8', 'rain']]);
  const [dry, rain, heavy] = runningTimeByWeather(rows, weather, WEATHER_CLASSES);
  assert.deepEqual([dry.index, dry.runs, rain.runs, rain.hours], [1, 100, 50, 2]);
  assert.equal(rain.index, 1.16); // (2880 + 600) / (2400 + 600)
  assert.deepEqual(rain.vsDry, { indexPts: 20, runs: 40 });
  assert.equal(heavy.index, null);
});

test('a report beyond the last stop doesn\'t time the final segment', () => {
  const log = new SegmentLog({ timezone: TZ });
  const t0 = day + 12 * 3600;
  // Passes D (1200 m) at +45 s, then is next seen 300 m past E (1600 m), at the terminal.
  let runs = 0;
  for (const [dt, m] of [[0, 1000], [30, 1150], [60, 1250], [100, 1900]]) runs += log.observe(report(t0 + dt, m), { trips, stops });
  assert.equal(runs, 0); // only D was timed, and D -> E has no honest end time
});

test('passages: each stop once the bus pulls away from it, 25 m past', () => {
  const log = new SegmentLog({ timezone: TZ });
  const t0 = day + 8 * 3600;
  const passages = [];
  const onPass = p => passages.push(p);
  // Waiting at A, leaves at +10 s at 5 m/s: 25 m out at +15 s. Reaches B (400 m) at +90 s, waits there
  // until +120 s, and is 25 m past it at +125 s: that's when it left B.
  for (const [dt, m] of [[0, 0], [10, 0], [20, 50], [90, 400], [120, 400], [130, 450]]) log.observe(report(t0 + dt, m, { trip: { tripId: 'T1', startDate: '20261023' } }), { trips, stops, onPass });
  assert.deepEqual(passages.map(p => [p.seq, Math.round(p.time - t0), p.startDate]), [[1, 15], [2, 125]].map(x => [...x, '20261023']));
});

test('tracking survives a restart between reports', () => {
  const t0 = day + 12 * 3600;
  const first = new SegmentLog({ timezone: TZ });
  first.observe(report(t0, 350), { trips, stops });
  const second = new SegmentLog({ timezone: TZ }); // as if the host was stopped and started again
  second.importTracking(JSON.parse(JSON.stringify(first.exportTracking())));
  assert.equal(second.observe(report(t0 + 60, 1150), { trips, stops }), 1); // B -> C measured
  const cold = new SegmentLog({ timezone: TZ });
  assert.equal(cold.observe(report(t0 + 60, 1150), { trips, stops }), 0); // without it: nothing
});
