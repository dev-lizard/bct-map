import test from 'node:test';
import assert from 'node:assert/strict';
import { canceledTripDetails, verdict } from '../web/canceled.js';
import { serviceDayStart } from '../web/gtfs-util.js';

const TZ = 'America/New_York';
const day = serviceDayStart('20261022', TZ);
const H = 3600;
const calendar = { WK: { days: [1, 1, 1, 1, 1, 0, 0], start: '20261001', end: '20261231' }, SU: { days: [0, 0, 0, 0, 0, 0, 1], start: '20261001', end: '20261231' } };
// Route R1 northbound every 30 minutes from stop A; one Sunday trip; one southbound.
const trip = (sv, d, startS) => ({ r: 'R1', d, h: 'North', sv, s: [[1, 'A', startS, 1], [2, 'B', startS + 600], [3, 'C', startS + 1200, 1], [4, 'D', startS + 1800, 1]] });
const trips = { T0: trip('WK', 0, 7.5 * H), T1: trip('WK', 0, 8 * H), T2: trip('WK', 0, 8.5 * H), SUN: trip('SU', 0, 8.25 * H), S1: trip('WK', 1, 8.1 * H) };
const record = { date: '20261022', tripId: 'T1', routeId: 'R1', firstSeenAt: day + 7 * H + 40 * 60, lastSeenAt: day + 8 * H, restoredAt: null, vehicles: [], alerts: [], stopsPassed: 0 };
const opts = { trips, calendar, exceptions: [], timezone: TZ, stopName: id => `Stop ${id}` };

test('canceled trip: timetable, notice given, and the gap at its first stop', () => {
  const d = canceledTripDetails(record, { ...opts, nowS: day + 12 * H });
  assert.equal(d.trip.firstStop.name, 'Stop A');
  assert.equal(d.trip.firstStop.time, day + 8 * H);
  assert.equal(d.trip.durationS, 1800);
  assert.equal(d.noticeS, 20 * 60); // canceled 20 minutes before it was due
  // Sunday and southbound trips don't count: 7:30 and 8:30 northbound, a 60-minute gap instead of 30.
  assert.deepEqual(d.gap, { previous: day + 7.5 * H, next: day + 8.5 * H, gapS: 3600, usualS: 1800 });
  assert.equal(d.verdict.kind, 'missed');
});

test('verdicts: ran anyway, partly run, restored, still under way, bus assigned', () => {
  const t = { stops: 4, lastStop: { time: day + 8.5 * H } };
  assert.equal(verdict({ ...record, vehicles: ['20092'] }, t, day + 8.6 * H).kind, 'watching'); // 6 min after its arrival time
  assert.equal(verdict({ ...record, stopsPassed: 3 }, t).kind, 'ran');
  assert.equal(verdict({ ...record, stopsPassed: 1 }, t).kind, 'partial');
  assert.equal(verdict({ ...record, restoredAt: day }, t, day + 10 * H).kind, 'restored');
  assert.equal(verdict({ ...record, vehicles: ['20092'] }, t, day + 10 * H).kind, 'assigned');
});
