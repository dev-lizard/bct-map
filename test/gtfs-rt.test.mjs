import test from 'node:test';
import assert from 'node:assert/strict';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { decodeFeed, packBundle, unpackBundle } from '../web/gtfs-rt.js';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

// Encodes `obj` with the official library and checks our decoder reads back what the official
// decoder does.
function roundTrip(obj) {
  const bytes = FeedMessage.encode(FeedMessage.fromObject(obj)).finish();
  const official = FeedMessage.toObject(FeedMessage.decode(bytes), { longs: Number, enums: String });
  return { ours: decodeFeed(bytes), official };
}

const header = { gtfsRealtimeVersion: '2.0', timestamp: 1792700000 };

test('vehicle positions: ids, trip, float coordinates, bearing, speed, 64-bit timestamp', () => {
  const { ours, official } = roundTrip({
    header,
    entity: [{
      id: 'v1',
      vehicle: {
        trip: { tripId: '26SEPT_01-01_7_muwtf', routeId: 'BCT01', startDate: '20261023' },
        position: { latitude: 26.1224, longitude: -80.1437, bearing: 270, speed: 8.5 },
        timestamp: 5_000_000_000, // past 2^32
        vehicle: { id: '1301', label: 'BCT01 CENTRAL TERMINAL' },
      },
    }],
  });
  assert.deepEqual(ours.entity[0].vehicle, official.entity[0].vehicle);
  assert.equal(ours.header.timestamp, 1792700000);
});

test('trip updates: canceled trips, negative delays, stop times', () => {
  const { ours, official } = roundTrip({
    header,
    entity: [{
      id: 't1',
      tripUpdate: {
        trip: { tripId: 'T1', startDate: '20261023', scheduleRelationship: 'CANCELED', routeId: 'BCT50' },
        delay: -75,
        stopTimeUpdate: [
          { stopSequence: 70, stopId: '2542', arrival: { time: 1792700816, delay: -60, uncertainty: 0 }, departure: { time: 1792700836 } },
          { stopSequence: 71, stopId: '3118', arrival: { time: 1792701409 } },
        ],
      },
    }],
  });
  const o = official.entity[0].tripUpdate;
  const u = ours.entity[0].tripUpdate;
  assert.deepEqual(u.trip, o.trip);
  assert.equal(u.delay, -75);
  assert.deepEqual(u.stopTimeUpdate, o.stopTimeUpdate);
});

test('alerts: periods, informed entities, cause and effect, translations', () => {
  const { ours, official } = roundTrip({
    header,
    entity: [{
      id: 'a1',
      alert: {
        activePeriod: [{ start: 1792700000, end: 1792760000 }],
        informedEntity: [{ trip: { tripId: 'T1' }, stopId: '0825' }, { routeId: 'BCT22' }],
        cause: 'OTHER_CAUSE',
        effect: 'UNKNOWN_EFFECT',
        headerText: { translation: [{ text: 'Delayed', language: 'en' }] },
        descriptionText: { translation: [{ text: 'Trip is Delayed' }] },
      },
    }],
  });
  assert.deepEqual(ours.entity[0].alert, official.entity[0].alert);
});

test('unknown fields, like BCT\'s extension 9000 on each vehicle, are skipped', () => {
  const { VehiclePosition, FeedEntity } = GtfsRealtimeBindings.transit_realtime;
  const vehicle = VehiclePosition.encode(VehiclePosition.fromObject({ timestamp: 1792700000, vehicle: { id: '1818' } })).finish();
  // Field 9000, wire type 2, "North": the same bytes BCT appends.
  const withExtension = new Uint8Array([...vehicle, 0xc2, 0xb2, 0x04, 0x05, ...new TextEncoder().encode('North')]);
  const entity = new Uint8Array([0x0a, 0x01, 0x76, 0x22, withExtension.length, ...withExtension]);
  const feed = new Uint8Array([0x12, entity.length, ...entity]);
  assert.deepEqual(FeedEntity.toObject(FeedEntity.decode(entity)).vehicle.vehicle, { id: '1818' });
  assert.deepEqual(decodeFeed(feed).entity[0].vehicle, { timestamp: 1792700000, vehicle: { id: '1818' } });
});

test('bundle: feeds and older vehicle feeds in one response; a missing feed is null', () => {
  const vp = n => FeedMessage.encode(FeedMessage.fromObject({ header: { ...header, timestamp: n }, entity: [{ id: 'v', vehicle: { position: { latitude: 1, longitude: 2 } } }] })).finish();
  const al = FeedMessage.encode(FeedMessage.fromObject({ header, entity: [] })).finish();
  const out = unpackBundle(packBundle({ vehiclePositions: vp(30), alerts: al, history: [vp(10), vp(20)] }));
  assert.equal(out.vehiclePositions.entity.length, 1);
  assert.equal(out.tripUpdates, null);
  assert.deepEqual(out.alerts.entity, []);
  assert.deepEqual(out.history.map(f => f.header.timestamp), [10, 20]);
  assert.equal(unpackBundle(packBundle({})).vehiclePositions, null);
});

test('merged feeds: every entity, and the last header, read the same way by both decoders', async () => {
  const { mergeFeeds } = await import('../server/bct-feed.mjs');
  const { feedTimestamp } = await import('../web/gtfs-rt.js');
  const encode = obj => FeedMessage.encode(FeedMessage.fromObject(obj)).finish();
  const bus = id => ({ id, vehicle: { position: { latitude: 26.1, longitude: -80.1 }, vehicle: { id } } });
  const contractor = encode({ header: { gtfsRealtimeVersion: '1.0', timestamp: 1792700100 }, entity: [bus('c1'), bus('c2')] });
  const bct = encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: 1792700000 }, entity: [bus('b1')] });
  const merged = mergeFeeds(contractor, bct);
  const ours = decodeFeed(merged);
  const official = FeedMessage.toObject(FeedMessage.decode(merged), { longs: Number, enums: String });
  assert.deepEqual(ours.entity.map(e => e.id), ['c1', 'c2', 'b1']);
  assert.equal(ours.header.timestamp, 1792700000); // BCT's, which comes last
  assert.equal(official.header.timestamp, 1792700000);
  assert.equal(feedTimestamp(merged), 1792700000);
});
