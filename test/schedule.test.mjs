import test from 'node:test';
import assert from 'node:assert/strict';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { rollHistory } from '../server/bct-feed.mjs';
import { decodeFeed } from '../web/gtfs-rt.js';
import { LiveFeed } from '../web/live.js';
import { packSchedule, Schedule } from '../web/schedule.js';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
const H = 3600;
const plain = {
  meta: { timezone: 'America/New_York', built_at: '2026-10-23T00:00:00Z' },
  calendar: { WK: { days: [1, 1, 1, 1, 1, 0, 0], start: '20261001', end: '20261231' } },
  exceptions: [['20270102', 'WK', 1]],
  trips: {
    T1: { r: 'R1', d: 0, h: 'Downtown', sh: 'S1', sv: 'WK', s: [[1, 'A', 8 * H, 1], [2, 'B', 8 * H + 600], [3, 'C', 8 * H + 1200, 1]] },
    T2: { r: 'R1', d: 0, h: 'Downtown', sh: 'S1', sv: 'WK', s: [[1, 'A', 9 * H, 1], [2, 'B', 9 * H + 600], [3, 'C', 9 * H + 1200, 1]] },
    T3: { r: 'R2', d: 1, h: 'Beach', sh: 'S2', sv: 'WK', s: [[1, 'B', 7 * H], [2, 'D', null], [3, 'E', 7 * H + 900]] },
  },
};

test('compact schedule: trips with the same stops share a pattern and read back unchanged', () => {
  const packed = packSchedule(plain);
  assert.equal(packed.routes.R1.p.length, 1); // T1 and T2 stop at the same places
  const schedule = new Schedule(JSON.parse(JSON.stringify(packed)));
  for (const [id, trip] of Object.entries(plain.trips)) {
    const t = schedule.trips[id];
    assert.deepEqual([t.r, t.d, t.h, t.sh, t.sv, t.s], [trip.r, trip.d, trip.h, trip.sh, trip.sv, trip.s]);
  }
  assert.equal(schedule.end, '20270102'); // an added date past the calendar's end
});

test('callsAt lists every trip at a stop in time order, marking final stops', () => {
  const schedule = new Schedule(packSchedule(plain));
  assert.deepEqual(schedule.callsAt('B').map(c => [c.tripId, c.secs]), [['T3', 7 * H], ['T1', 8 * H + 600], ['T2', 9 * H + 600]]);
  assert.deepEqual(schedule.callsAt('C').map(c => c.last), [true, true]);
  assert.deepEqual(schedule.callsAt('D'), []); // no timetabled time there
});

const vehicleFeed = (ts, lat) => FeedMessage.encode(FeedMessage.fromObject({
  header: { gtfsRealtimeVersion: '2.0', timestamp: ts },
  entity: [{ id: '1', vehicle: { trip: { tripId: 'T1' }, position: { latitude: lat, longitude: -80.1 }, timestamp: ts, vehicle: { id: 'bus' } } }],
})).finish();

test('rollHistory keeps up to three older, distinct vehicle feeds from the last two minutes', () => {
  const at = ts => vehicleFeed(ts, 26.1);
  const history = rollHistory({ vehiclePositions: at(1000), history: [at(880), at(970), at(980), at(990)] }, at(1010));
  assert.deepEqual(history.map(b => decodeFeed(b).header.timestamp), [980, 990, 1000]);
  assert.deepEqual(rollHistory({ vehiclePositions: at(1010), history: [] }, at(1010)), []); // same feed again
  assert.deepEqual(rollHistory(null, at(1010)), []);
});

test('a page that has just opened gets each bus\'s previous report from the history', () => {
  const live = new LiveFeed({ schedule: plain, routes: [{ route_id: 'R1', route_short_name: '1', route_color: 'E35335' }], stops: [] });
  const snap = live.ingest({ vehiclePositions: decodeFeed(vehicleFeed(1020, 26.101)), history: [decodeFeed(vehicleFeed(1000, 26.1))] });
  assert.equal(snap.previousVehiclePositions.length, 1);
  assert.equal(snap.previousVehiclePositions[0].timestamp, 1000);
  assert.equal(snap.vehiclePositions[0].bearing, 0); // moved north
  assert.equal(snap.vehiclePositions[0].headsign, 'Downtown');
});
