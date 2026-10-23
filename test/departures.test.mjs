import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeed } from '../web/live.js';
import { serviceDayStart, servicesOn } from '../web/gtfs-util.js';

const TZ = 'America/New_York';
const H = 3600;
const calendar = {
  WK: { days: [1, 1, 1, 1, 1, 0, 0], start: '20261001', end: '20261231' },
  SU: { days: [0, 0, 0, 0, 0, 0, 1], start: '20261001', end: '20261231' },
};
const exceptions = [['20261126', 'WK', 2], ['20261126', 'SU', 1]]; // Thanksgiving runs a Sunday service

function makeFeed() {
  return new LiveFeed({
    schedule: {
      meta: { timezone: TZ },
      calendar,
      exceptions,
      trips: {
        T1: { r: 'R1', d: 0, h: 'Downtown', sh: 'S1', sv: 'WK', s: [[1, 'A', 8 * H], [2, 'B', 8 * H + 600], [3, 'C', 8 * H + 1200]] },
        T2: { r: 'R1', d: 0, h: 'Downtown', sh: 'S1', sv: 'WK', s: [[1, 'A', 8 * H + 1800], [2, 'B', 8 * H + 2400], [3, 'C', 8 * H + 3000]] },
        T3: { r: 'R2', d: 1, h: 'Beach', sh: 'S2', sv: 'SU', s: [[1, 'B', 8 * H + 900], [2, 'D', 8 * H + 1500]] },
        NIGHT: { r: 'R2', d: 0, h: 'Late', sh: 'S2', sv: 'WK', s: [[1, 'D', 23 * H + 3000], [2, 'B', 24 * H + 600], [3, 'C', 24 * H + 1800]] },
      },
    },
    routes: [
      { route_id: 'R1', route_short_name: '1', route_color: 'E35335', route_text_color: 'FFFFFF', route_type: 3 },
      { route_id: 'R2', route_short_name: '2', route_color: '1BBADE', route_text_color: '000000', route_type: 3 },
    ],
    stops: ['A', 'B', 'C', 'D'].map((id, i) => [id, `100${i}`, 26.1 + i / 100, -80.1, `Stop ${id}`, 0, '', '']),
  });
}

const thursday = serviceDayStart('20261022', TZ);
const update = (tripId, startDate, stopTimeUpdate, scheduleRelationship = 'SCHEDULED') => ({
  trip: { tripId, startDate, routeId: 'R1', scheduleRelationship },
  stopTimeUpdate,
});
const feedOf = (nowS, kind, items) => ({ header: { timestamp: nowS }, entity: items.map((item, i) => ({ id: String(i), [kind]: item })) });
const busOn = (tripId, nowS) => ({ trip: { tripId }, position: { latitude: 26.1, longitude: -80.1 }, timestamp: nowS, vehicle: { id: `bus-${tripId}` } });

test('servicesOn follows weekdays, date ranges and holiday exceptions', () => {
  assert.deepEqual([...servicesOn('20261022', calendar, exceptions)], ['WK']); // Thursday
  assert.deepEqual([...servicesOn('20261025', calendar, exceptions)], ['SU']); // Sunday
  assert.deepEqual([...servicesOn('20261126', calendar, exceptions)], ['SU']); // Thanksgiving
  assert.deepEqual([...servicesOn('20270105', calendar, exceptions)], []); // after the calendar ends
});

test('timetable-only board: today\'s services in time order, other days\' trips left out', () => {
  const board = makeFeed().stopDepartures('B', { nowS: thursday + 7 * H + 55 * 60 });
  assert.equal(board.stop.name, 'Stop B');
  assert.deepEqual(board.routes.map(r => r.routeShortName), ['1', '2']);
  assert.deepEqual(board.departures.map(d => d.tripId), ['T1', 'T2']); // T3 only runs on Sundays
  assert.equal(board.departures[0].scheduled, thursday + 8 * H + 600);
  assert.equal(board.departures[0].predicted, null);
  assert.equal(board.departures[0].routeColor, '#E35335');
});

test('live board: feed predictions, carried-forward delays, cancellations and the bus on each trip', () => {
  const feed = makeFeed();
  const nowS = thursday + 7 * H + 58 * 60;
  feed.ingest({
    tripUpdates: feedOf(nowS, 'tripUpdate', [
      update('T1', '20261022', [{ stopSequence: 1, stopId: 'A', arrival: { time: thursday + 8 * H + 240 } }]), // 4 min late at A
      update('T2', '20261022', [], 'CANCELED'),
    ]),
    vehiclePositions: feedOf(nowS, 'vehicle', [busOn('T1', nowS)]),
  });
  const [t1, t2] = makeBoard(feed, nowS);
  assert.equal(t1.predicted, thursday + 8 * H + 600 + 240); // no prediction for B itself: delay carried forward
  assert.equal(t1.predictionSource, 'delay');
  assert.equal(t1.delay, 240);
  assert.equal(t1.vehicleId, 'bus-T1');
  assert.equal(t2.canceled, true);

  feed.ingest({
    tripUpdates: feedOf(nowS, 'tripUpdate', [
      update('T1', '20261022', [{ stopSequence: 2, stopId: 'B', arrival: { time: thursday + 8 * H + 900 } }]),
    ]),
  });
  const [direct] = makeBoard(feed, nowS);
  assert.equal(direct.predicted, thursday + 8 * H + 900);
  assert.equal(direct.predictionSource, 'feed');
});

function makeBoard(feed, nowS) {
  return feed.stopDepartures('B', { nowS }).departures;
}

test('a late bus stays on the board after its timetabled time; a departed one drops off', () => {
  const feed = makeFeed();
  const nowS = thursday + 8 * H + 20 * 60; // T1 was due at B ten minutes ago
  feed.ingest({
    tripUpdates: feedOf(nowS, 'tripUpdate', [
      update('T1', '20261022', [{ stopSequence: 2, stopId: 'B', arrival: { time: nowS + 60 } }]),
    ]),
  });
  assert.deepEqual(makeBoard(feed, nowS).map(d => d.tripId), ['T1', 'T2']);
  const noLiveData = makeFeed();
  assert.deepEqual(makeBoard(noLiveData, nowS).map(d => d.tripId), ['T2']);
});

test('trips that end at the stop are left off its board', () => {
  assert.deepEqual(makeFeed().stopDepartures('C', { nowS: thursday + 7 * H + 55 * 60 }).departures, []);
});

test('live data for another service date is ignored', () => {
  const feed = makeFeed();
  const nowS = thursday + 7 * H + 55 * 60;
  feed.ingest({
    tripUpdates: feedOf(nowS, 'tripUpdate', [
      update('T1', '20261021', [{ stopSequence: 2, stopId: 'B', arrival: { time: thursday + 8 * H + 900 } }], 'CANCELED'),
    ]),
  });
  const [t1] = makeBoard(feed, nowS);
  assert.equal(t1.predicted, null);
  assert.equal(t1.canceled, false);
});

test('after midnight, the board includes yesterday\'s late-night trips', () => {
  const friday = serviceDayStart('20261023', TZ);
  const [night] = makeFeed().stopDepartures('B', { nowS: friday + 5 * 60 }).departures;
  assert.equal(night.tripId, 'NIGHT');
  assert.equal(night.date, '20261022');
  assert.equal(night.scheduled, friday + 10 * 60); // 24:10 on Thursday's service = 00:10 Friday
});

test('trip timeline marks passed stops and live predictions', () => {
  const feed = makeFeed();
  const nowS = thursday + 8 * H + 12 * 60;
  feed.ingest({
    tripUpdates: feedOf(nowS, 'tripUpdate', [
      update('T1', '20261022', [
        { stopSequence: 1, stopId: 'A', arrival: { time: thursday + 8 * H + 120 } },
        { stopSequence: 2, stopId: 'B', arrival: { time: thursday + 8 * H + 13 * 60 } },
      ]),
    ]),
    vehiclePositions: feedOf(nowS, 'vehicle', [busOn('T1', nowS)]),
  });
  const trip = feed.tripStopTimes('T1', { nowS });
  assert.equal(trip.date, '20261022');
  assert.equal(trip.vehicleId, 'bus-T1');
  assert.equal(trip.nextStopSeq, 2);
  assert.deepEqual(trip.stops.map(s => s.passed), [true, false, false]);
  assert.equal(trip.stops[1].predictionSource, 'feed');
  assert.equal(trip.stops[2].predictionSource, 'delay'); // B's 3-minute delay carried to C
  assert.equal(trip.stops[2].predicted, thursday + 8 * H + 1200 + 180);

  const otherDay = feed.tripStopTimes('T1', { date: '20261023', nowS });
  assert.equal(otherDay.vehicleId, null);
  assert.ok(otherDay.stops.every(s => s.predicted === null));
});

test('alerts name their trips, routes and stops from the timetable', () => {
  const feed = makeFeed();
  const nowS = thursday + 8 * H;
  feed.ingest({
    alerts: feedOf(nowS, 'alert', [{
      cause: 'OTHER_CAUSE',
      effect: 'UNKNOWN_EFFECT',
      headerText: { translation: [{ text: 'Delayed', language: 'en' }] },
      descriptionText: { translation: [{ text: 'Trip is Delayed', language: 'en' }] },
      activePeriod: [{ start: nowS, end: nowS + 3600 }],
      informedEntity: [{ trip: { tripId: 'T1' }, stopId: 'A' }, { trip: { tripId: 'T1' }, stopId: 'B' }],
    }]),
    vehiclePositions: feedOf(nowS, 'vehicle', []),
  });
  const [alert] = feed.snapshot.alerts;
  assert.equal(alert.header, 'Delayed');
  assert.deepEqual(alert.routes.map(r => r.routeShortName), ['1']); // from the trip, though the alert names no route
  assert.deepEqual(alert.trips, [{ tripId: 'T1', headsign: 'Downtown', routeId: 'R1', routeShortName: '1', routeColor: '#E35335', routeTextColor: '#FFFFFF' }]);
  assert.deepEqual(alert.stops, [{ stopId: 'A', stopName: 'Stop A' }, { stopId: 'B', stopName: 'Stop B' }]);
  assert.deepEqual(alert.activePeriods, [{ start: nowS, end: nowS + 3600 }]);
});

test('a trip update naming a stop by its code still finds the timetable stop', () => {
  const feed = makeFeed();
  const nowS = thursday + 7 * H + 58 * 60;
  // Stop B's code is 1001; BCT sometimes sends that instead of the stop id.
  feed.ingest({
    tripUpdates: feedOf(nowS, 'tripUpdate', [update('T1', '20261022', [{ stopSequence: 2, stopId: '1001', arrival: { time: thursday + 8 * H + 700 } }])]),
    vehiclePositions: feedOf(nowS, 'vehicle', [busOn('T1', nowS)]),
  });
  const bus = feed.snapshot.vehiclePositions[0];
  assert.equal(bus.nextStop.stopId, 'B');
  assert.equal(bus.nextStop.stopName, 'Stop B');
  assert.ok(Math.abs(bus.nextStop.lat - 26.11) < 1e-9);
});
