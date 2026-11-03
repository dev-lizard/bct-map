import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blocksNotRun, chronicTrips, congestionByRiders, gpsUnits, holdingPoints, ratesDiffer, runtimeAdvice, share, sharesDiffer,
  transferAdvice, versusGoal,
} from '../web/attention.js';

test('shares come with a 95% range, narrower with more samples', () => {
  assert.deepEqual(share(80, 100), { pct: 80, lo: 71.1, hi: 86.7, pm: 7.8 });
  assert.ok(share(800, 1000).pm < 3);
  assert.equal(share(0, 0), null);
});

test('a change counts only when it is more than chance', () => {
  assert.equal(sharesDiffer(65, 100, 70, 100), false); // 65% against 70% of 100: noise
  assert.equal(sharesDiffer(6500, 10000, 7000, 10000), true); // the same on 10,000: real
  assert.equal(ratesDiffer(10, 7, 14, 7), false); // 10 against 14 bunching events in a week
  assert.equal(ratesDiffer(10, 7, 60, 7), true);
});

test('goals: met, close (within the range) or missed', () => {
  assert.equal(versusGoal('onTime', 82), 'met');
  assert.equal(versusGoal('onTime', 78, share(78, 100)), 'close'); // 80 is inside 78's range on 100
  assert.equal(versusGoal('onTime', 70, share(7000, 10000)), 'missed');
  assert.equal(versusGoal('excessWait', 30), 'met'); // lower is better
  assert.equal(versusGoal('excessWait', 90), 'missed');
});

test('running time: enough for 85% of runs, when the change is big enough to matter', () => {
  const advice = runtimeAdvice({
    'R1|0|4': [30, 1.05, 1.2, 3000, 12], // 50 min trips; 85% take up to 60: allow +10 min
    'R1|1|4': [30, 1.0, 1.03, 3000, 12], // +1.5 min: too small to change
    'R2|0|1': [5, 1.0, 1.5, 3000, 2], // too few runs
    'R3|0|2': [20, 0.8, 0.85, 3600, 8], // an hour timetabled, 85% done in 51 min: remove 9
  });
  assert.deepEqual(advice.map(a => [a.routeId, a.dir, a.period, a.changeS]), [['R1', 0, 4, 600], ['R3', 0, 2, -540]]);
});

test('transfers: how much later the second bus would have to leave', () => {
  // 40 tries: 10 had 5 min, 10 had 2, 10 had 1, 10 had -1. Made (2+ min): 50%.
  const slack = { H1: { 'A>B': { 5: 10, 2: 10, 1: 10, '-1': 10 }, 'C>D': { 6: 30 }, 'E>F': { 0: 5 } } };
  const [a] = transferAdvice(slack, { goal: 85 });
  assert.deepEqual(a, { hubId: 'H1', from: 'A', to: 'B', tries: 40, madePct: 50, shiftMin: 3, madeAfterPct: 100 });
  assert.equal(transferAdvice(slack).length, 1); // C>D already made; E>F too few tries
});

test('holding points: the first timepoint where gaps open, and the one before it', () => {
  const sums = (n, gap, sched) => [n, n * gap, n * gap * gap, n * sched, n * sched * sched];
  const byStop = { 'R1|0|A': sums(30, 600, 600), 'R1|0|B': sums(30, 600, 600), 'R1|0|C': [30, 18000, 30 * 1200 * 1200 * 0.5, 18000, 30 * 600 * 600] };
  const delays = { 'R1|0|A': [10, 0, 0], 'R1|0|B': [10, 0, 6000], 'R1|0|C': [10, 0, 12000] };
  const [p] = holdingPoints(byStop, delays);
  assert.equal(p.stopId, 'C');
  assert.equal(p.holdAt, 'B');
  assert.ok(p.excessS >= 60);
});

test('chronic trips, blocks not run, GPS units and congestion by riders', () => {
  const chronic = chronicTrips({ T1: [5, 20, 0, 15], T2: [5, 20, 8, 0], T3: [2, 10, 0, 10], T4: [5, 20, 1, 2] });
  assert.deepEqual(chronic.map(c => [c.tripId, c.kind]), [['T1', 'late'], ['T2', 'early']]);

  const blocks = blocksNotRun([{ tripId: 'a', date: '20261102', routeId: 'R1' }, { tripId: 'b', date: '20261102', routeId: 'R1' }, { tripId: 'c', date: '20261102', routeId: 'R2' }], id => ({ a: '01-1', b: '01-1', c: '02-1' })[id]);
  assert.deepEqual(blocks.map(b => [b.block, b.trips.length]), [['01-1', 2]]);

  const units = gpsUnits({ bus1: [1000, 300, 0, 0], bus2: [1000, 0, 20, 3], bus3: [1000, 10, 1, 0] }, 7);
  assert.deepEqual(units.map(u => [u.id, u.reasons]), [['bus2', ['gaps', 'vanished']], ['bus1', ['stale']]]);

  const segs = congestionByRiders([{ lostPerDayS: 600, routes: ['R1'] }, { lostPerDayS: 1200, routes: ['R2'] }, { lostPerDayS: 0, routes: ['R1'] }], r => ({ R1: 40, R2: 5 })[r]);
  assert.deepEqual(segs.map(s => s.riderMinutes), [400, 100]);
});
