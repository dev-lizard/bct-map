import test from 'node:test';
import assert from 'node:assert/strict';
import { bandOf, routesByStopPair, slowest, speedFeatures, speedTable } from '../web/speeds.js';

const DEG_PER_M = 1 / 110_540;
const stops = new Map([['A', 0], ['B', 400], ['C', 800], ['X', 850]].map(([id, m]) => [id, { lat: 26.1 + m * DEG_PER_M, lon: -80.15, name: `Stop ${id}` }]));
const periods = ['night', 'am', 'midday', 'pm', 'evening'].map(key => ({ key, label: key, from: 0, to: 0 }));
// [from, to, then runs, run seconds, timetabled seconds for each of the five periods]
const data = {
  days: 2,
  periods,
  segments: [
    ['A', 'B', 4, 80, 240, 0, 0, 0, 10, 300, 600, 10, 900, 600, 0, 0, 0], // 20 s at midday, 90 s at the PM peak
    ['B', 'C', 0, 0, 0, 0, 0, 0, 5, 200, 300, 0, 0, 0, 0, 0, 0], // 40 s all the time
    ['C', 'X', 0, 0, 0, 0, 0, 0, 5, 50, 300, 0, 0, 0, 0, 0, 0], // 50 m: too short to count
  ],
};

test('speeds: mph per stretch, congestion against its own fastest period', () => {
  const { segments, totals } = speedTable(data, { period: 'pm', stop: id => stops.get(id), routes: new Map([['A>B', ['R1']]]) });
  assert.equal(segments.length, 1); // only A -> B runs at the PM peak
  const [ab] = segments;
  assert.deepEqual([ab.runs, ab.meanRunS, ab.mph, ab.routes], [10, 90, 10, ['R1']]); // 402 m (great-circle) in 90 s
  assert.equal(ab.baselineMph, 45); // 402 m in 20 s, its best (midday)
  assert.equal(ab.extraPerRunS, 70);
  assert.equal(ab.lostPerDayS, 350); // 10 runs × 70 s over 2 days
  assert.equal(totals.runs, 10);
});

test('speeds: all day adds up every period; short stretches are left out', () => {
  const { segments, totals } = speedTable(data, { period: 'all', stop: id => stops.get(id) });
  assert.deepEqual(segments.map(s => `${s.from}>${s.to}`), ['A>B', 'B>C']); // A>B loses the most time
  assert.equal(segments[0].runs, 24);
  assert.equal(segments[1].lostPerDayS, 0);
  assert.equal(totals.runs, 29);
  assert.deepEqual(slowest(segments).map(s => s.from), ['A', 'B']); // A>B averages 53 s, B>C 40 s
});

test('speed bands and map features', () => {
  assert.deepEqual([5, 8, 11.9, 20, 40].map(bandOf), [0, 1, 1, 3, 4]);
  const { segments } = speedTable(data, { period: 'all', stop: id => stops.get(id) });
  const fc = speedFeatures(segments);
  assert.equal(fc.features.length, 2);
  assert.equal(fc.features[0].geometry.coordinates.length, 2);
});

test('routes by stop pair come from the timetable', () => {
  const pairs = routesByStopPair({ T1: { r: 'R1', s: [[1, 'A'], [2, 'B'], [3, 'C']] }, T2: { r: 'R2', s: [[1, 'A'], [2, 'B']] }, T3: { r: 'R1', s: [[1, 'A'], [2, 'B']] } });
  assert.deepEqual(Object.fromEntries(pairs), { 'A>B': ['R1', 'R2'], 'B>C': ['R1'] });
});
