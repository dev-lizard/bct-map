import test from 'node:test';
import assert from 'node:assert/strict';
import { alertsByTrip, CancellationLog } from '../server/cancellations.mjs';
import { serviceDayStart } from '../web/gtfs-util.js';

const TZ = 'America/New_York';
const day = serviceDayStart('20261023', TZ);
const H = 3600;
const trips = { T1: { r: 'R1', s: [[1, 'A', 8 * H, 1], [2, 'B', 8 * H + 600], [3, 'C', 8 * H + 1200, 1]] } };
const live = (canceled, extra = {}) => ({
  tripId: 'T1', startDate: '20261023', canceled, routeId: 'R1',
  bySeq: new Map([[1, day + 8 * H + 120]]), ...extra,
});

test('a canceled trip is followed: first and last seen, bus, alert, predicted start', () => {
  const log = new CancellationLog({ timezone: TZ });
  const alerts = alertsByTrip({ entity: [{ alert: { headerText: { translation: [{ text: 'Delayed' }] }, descriptionText: { translation: [{ text: 'Trip is Delayed' }] }, cause: 'OTHER_CAUSE', informedEntity: [{ trip: { tripId: 'T1' } }] } }] });
  assert.equal(log.observe({ liveTrips: [live(true)], trips, feedTs: day + 7 * H, busOnTrip: new Map([['T1', '20092']]), alerts }), 1);
  assert.equal(log.observe({ liveTrips: [live(true)], trips, feedTs: day + 7 * H + 600, alerts }), 0); // already followed
  const [r] = log.summary({ days: 1, nowS: day + 9 * H }).recent;
  assert.deepEqual([r.date, r.routeId, r.firstSeenAt, r.lastSeenAt, r.vehicles, r.predictedStartAt], ['20261023', 'R1', day + 7 * H, day + 7 * H + 600, ['20092'], day + 8 * H + 120]);
  assert.deepEqual(r.alerts, [{ header: 'Delayed', description: 'Trip is Delayed', cause: 'OTHER_CAUSE', effect: null }]);
});

test('GPS shows whether a canceled trip ran anyway; a trip back on the schedule is noted', () => {
  const log = new CancellationLog({ timezone: TZ });
  log.observe({ liveTrips: [live(true)], trips, feedTs: day + 7 * H });
  const passages = [{ tripId: 'T1', seq: 1, time: day + 8 * H + 130 }, { tripId: 'T1', seq: 2, time: day + 8 * H + 700 }, { tripId: 'T9', seq: 1, time: day }];
  log.observe({ liveTrips: [], trips, feedTs: day + 8 * H + 700, passages });
  log.observe({ liveTrips: [], trips, feedTs: day + 8 * H + 710, passages: [passages[1]] }); // the same stop again
  log.observe({ liveTrips: [live(false)], trips, feedTs: day + 8 * H + 800 });
  const s = log.summary({ days: 1, nowS: day + 9 * H });
  const [r] = s.recent;
  assert.deepEqual([r.stopsPassed, r.firstPassAt, r.lastPassAt, r.restoredAt], [2, day + 8 * H + 130, day + 8 * H + 700, day + 8 * H + 800]);
  assert.deepEqual([s.total, s.ranAnyway, s.restored], [1, 1, 1]);
});

test('a day round-trips through its saved form', () => {
  const log = new CancellationLog({ timezone: TZ });
  log.observe({ liveTrips: [live(true)], trips, feedTs: day + 7 * H });
  const copy = new CancellationLog({ timezone: TZ });
  copy.load('20261023', log.serialize('20261023'));
  assert.deepEqual(copy.summary({ days: 1, nowS: day + 9 * H }), log.summary({ days: 1, nowS: day + 9 * H }));
  assert.deepEqual(copy.prune('20261024'), ['20261023']);
});

test('a trip canceled late gets credit for the stops GPS saw it pass before then', () => {
  const log = new CancellationLog({ timezone: TZ });
  const passages = [{ tripId: 'T1', seq: 1, time: day + 8 * H + 30 }, { tripId: 'T1', seq: 2, time: day + 8 * H + 650 }];
  log.observe({ liveTrips: [live(false)], trips, feedTs: day + 8 * H + 660, passages }); // running, not canceled
  log.observe({ liveTrips: [live(true)], trips, feedTs: day + 8 * H + 900 }); // canceled near the end
  const [r] = log.summary({ days: 1, nowS: day + 9 * H }).recent;
  assert.deepEqual([r.stopsPassed, r.firstPassAt, r.lastPassAt], [2, day + 8 * H + 30, day + 8 * H + 650]);
});
