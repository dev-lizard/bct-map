import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bunchKey, classifyRain, findBunching, hourCountsFromSamples, newEvents, summarizeBunching, weatherByHour, weatherImpact,
} from '../server/analytics.mjs';
import { serviceDayStart } from '../web/gtfs-util.js';

const TZ = 'America/New_York';
const H = 3600;
const day = serviceDayStart('20261023', TZ);
// Route R1 every 30 minutes through stops A, B, C; R2 runs the same stops.
const trips = {
  T1: { r: 'R1', d: 0, s: [[1, 'A', 8 * H], [2, 'B', 8 * H + 600], [3, 'C', 8 * H + 1200]] },
  T2: { r: 'R1', d: 0, s: [[1, 'A', 8 * H + 1800], [2, 'B', 8 * H + 2400], [3, 'C', 8 * H + 3000]] },
  T3: { r: 'R1', d: 1, s: [[1, 'C', 8 * H], [2, 'B', 8 * H + 600]] },
  T4: { r: 'R2', d: 0, s: [[1, 'B', 8 * H + 2300]] },
  T5: { r: 'R1', d: 0, s: [[1, 'A', 8 * H + 300], [2, 'B', 8 * H + 900]] }, // only 5 min behind T1
};
const live = (tripId, nextSeq, nextStopId, times, extra = {}) => ({
  tripId, startDate: '20261023', canceled: false,
  nextStop: { seq: nextSeq, stopId: nextStopId, time: times[nextSeq] },
  bySeq: new Map(Object.entries(times).map(([seq, t]) => [Number(seq), t])),
  ...extra,
});

test('bunching: a late bus caught by the next one, 1 minute apart instead of 30', () => {
  const t1 = live('T1', 2, 'B', { 1: day + 8 * H + 1500, 2: day + 8 * H + 2340 }); // 29 min late
  const t2 = live('T2', 2, 'B', { 2: day + 8 * H + 2400 }); // on time
  const [e, ...rest] = findBunching([t1, t2], trips, { timezone: TZ });
  assert.equal(rest.length, 0);
  assert.deepEqual([e.leader, e.follower, e.routeId, e.stopId, e.actualS, e.scheduledS], ['T1', 'T2', 'R1', 'B', 60, 1800]);
});

test('bunching: not for normal gaps, other directions or routes, or trips planned close together', () => {
  const t1 = live('T1', 2, 'B', { 2: day + 8 * H + 700 });
  const t2 = live('T2', 2, 'B', { 2: day + 8 * H + 2400 });
  assert.equal(findBunching([t1, t2], trips, { timezone: TZ }).length, 0); // 28 min apart
  const t3 = live('T3', 2, 'B', { 2: day + 8 * H + 2380 });
  const t4 = live('T4', 1, 'B', { 1: day + 8 * H + 2390 });
  assert.equal(findBunching([t2, t3, t4], trips, { timezone: TZ }).length, 0);
  const t5 = live('T5', 2, 'B', { 2: day + 8 * H + 760 }); // 1 min behind T1, but planned 5 min apart
  assert.equal(findBunching([t1, t5], trips, { timezone: TZ }).length, 0);
  const canceled = live('T1', 2, 'B', { 2: day + 8 * H + 2340 }, { canceled: true });
  assert.equal(findBunching([canceled, t2], trips, { timezone: TZ }).length, 0);
});

test('bunching events are kept once per pair per day, and summarised by route and hour', () => {
  const t1 = live('T1', 2, 'B', { 2: day + 8 * H + 2340 });
  const t2 = live('T2', 2, 'B', { 2: day + 8 * H + 2400 });
  const seen = new Map();
  const seenFor = date => seen.get(date) ?? seen.set(date, new Set()).get(date);
  const first = newEvents(findBunching([t1, t2], trips, { timezone: TZ }), bunchKey, seenFor);
  const again = newEvents(findBunching([t1, t2], trips, { timezone: TZ }), bunchKey, seenFor);
  assert.deepEqual([first.length, again.length], [1, 0]);
  const s = summarizeBunching(first, { days: 7, timezone: TZ, nowS: day + 10 * H });
  assert.deepEqual([s.total, s.byRoute, s.byHour], [1, [{ routeId: 'R1', events: 1 }], [{ hour: 8, events: 1 }]]);
  assert.equal(summarizeBunching(first, { days: 7, timezone: TZ, nowS: day + 9 * 86400 }).total, 0); // aged out
});

test('weather classes from station rain: the wettest station decides the hour', () => {
  assert.deepEqual([0, 0.0001, 0.01, 0.09, 0.1, 0.38].map(classifyRain), ['dry', 'dry', 'rain', 'rain', 'heavy', 'heavy']);
  // As Iowa Environmental Mesonet sends it (CRLF line ends); "valid" times end the hour.
  const csv = [
    'station,network,valid,precip_in',
    'FLL,FL_ASOS,2026-10-23 13:00,0.05', // 12:00–13:00
    'PMP,FL_ASOS,2026-10-23 13:00,0.38',
    'HWO,FL_ASOS,2026-10-23 13:00,0.0',
    'FLL,FL_ASOS,2026-10-23 14:00,0.0001', // a trace
    'FLL,FL_ASOS,2026-10-24 00:00,0.02', // 11 PM on the 23rd
    'FLL,FL_ASOS,2026-10-23 15:00,M',
    '',
  ].join('\r\n');
  assert.deepEqual([...weatherByHour(csv)], [['20261023|12', 'heavy'], ['20261023|13', 'dry'], ['20261023|23', 'rain']]);
});

test('weather impact compares each class with dry weather at the same hours of the day', () => {
  const c = (date, hour, n, late, sumDelay) => ({ date, hour, n, early: 0, late, sumDelay });
  const counts = [
    c('20261020', 8, 100, 10, 6000), // dry 8 AM: 90% on time, mean 60 s
    c('20261020', 17, 100, 30, 18000), // dry 5 PM: 70% on time, mean 180 s
    c('20261021', 17, 50, 25, 15000), // rainy 5 PM: 50% on time, mean 300 s
    c('20261022', 8, 10, 0, 0), // no weather for this hour
  ];
  const weather = new Map([['20261020|8', 'dry'], ['20261020|17', 'dry'], ['20261021|17', 'rain']]);
  const w = weatherImpact(counts, weather);
  const [dry, rain, heavy] = w.classes;
  assert.deepEqual([dry.samples, dry.onTimePct, rain.samples, rain.onTimePct, rain.meanDelayS], [200, 80, 50, 50, 300]);
  // Raw, rain looks 30 points worse than dry; against dry 5 PMs only, it's 20 points worse.
  assert.deepEqual(rain.vsDry, { onTimePts: -20, meanDelayS: 120, samples: 50 });
  assert.equal(heavy.samples, 0);
  assert.equal(w.unmatchedSamples, 10);
});

test('hourly counts from reliability samples use the calendar date in Broward', () => {
  const counts = hourCountsFromSamples([[day + 8 * H, 'R1', 30, 8], [day + 8 * H + 60, 'R2', 400, 8], [day + 24 * H + 600, 'R1', -90, 0]], TZ);
  assert.deepEqual(counts.map(c => [c.date, c.hour, c.n, c.late, c.early]), [['20261023', 8, 2, 1, 0], ['20261024', 0, 1, 0, 1]]);
});

test('bunching with the vehicle feed: trips without a bus, and two trips of one bus, don\'t count', () => {
  const t1 = live('T1', 2, 'B', { 2: day + 8 * H + 2340 });
  const t2 = live('T2', 2, 'B', { 2: day + 8 * H + 2400 });
  const find = busOnTrip => findBunching([t1, t2], trips, { timezone: TZ, busOnTrip }).length;
  assert.equal(find(new Map([['T1', 'bus1'], ['T2', 'bus2']])), 1);
  assert.equal(find(new Map([['T1', 'bus1']])), 0); // nobody is driving T2 yet
  assert.equal(find(new Map([['T1', 'bus1'], ['T2', 'bus1']])), 0);
});
