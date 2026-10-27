import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackLog, trackKey } from '../server/tracks.mjs';

const t0 = 1_792_770_000;
const feed = (t, buses) => ({
  header: { timestamp: t },
  entity: buses.map(([id, lat, trip]) => ({ id, vehicle: { vehicle: { id }, trip: { tripId: trip }, position: { latitude: lat, longitude: -80.15 }, timestamp: t } })),
});
const event = { date: '20261027', leader: 'T1', follower: 'T2', routeId: 'R1', direction: 0, stopId: 'B', at: t0 + 1200, actualS: 60, scheduledS: 1800 };

test('a bunching event keeps both buses\' tracks from 15 minutes before to 15 after', () => {
  const log = new TrackLog();
  // Positions every minute for 20 minutes before the event is found.
  for (let m = 0; m <= 20; m++) log.observe(feed(t0 + m * 60, [['bus1', 26.1 + m * 0.001, 'T1'], ['bus2', 26.09 + m * 0.0015, 'T2'], ['other', 26.2, 'T9']]), t0 + m * 60);
  assert.equal(log.capture(event, { leaderBus: 'bus1', followerBus: 'bus2' }), true);
  assert.equal(log.capture(event, { leaderBus: 'bus1', followerBus: 'bus2' }), false); // already recording
  const key = trackKey(event);
  assert.equal(log.status(key), 'recording');
  // 15 more minutes, then it finishes.
  for (let m = 21; m <= 36; m++) log.observe(feed(t0 + m * 60, [['bus1', 26.13, 'T1'], ['bus2', 26.13, 'T2']]), t0 + m * 60);
  assert.equal(log.status(key), 'ready');
  const track = log.get(key);
  assert.equal(track.complete, true);
  assert.deepEqual(track.buses.map(b => [b.vehicleId, b.role, b.points[0][0] - t0, b.points.at(-1)[0] - t0]), [['bus1', 'leader', 300, 2100], ['bus2', 'follower', 300, 2100]]);
  assert.deepEqual([...log.dirty], ['20261027']);
});

test('tracks round-trip through storage, including one still recording', () => {
  const log = new TrackLog();
  log.observe(feed(t0 + 900, [['bus1', 26.1, 'T1'], ['bus2', 26.09, 'T2']]), t0 + 900);
  log.capture(event, { leaderBus: 'bus1', followerBus: 'bus2' });
  const copy = new TrackLog();
  copy.importState(JSON.parse(JSON.stringify(log.exportState()))); // as if the host restarted
  copy.observe(feed(t0 + 2000, [['bus1', 26.13, 'T1'], ['bus2', 26.13, 'T2']]), t0 + 2000);
  copy.observe(feed(t0 + 2200, []), t0 + 2200); // past the end: finished
  const key = trackKey(event);
  assert.equal(copy.status(key), 'ready');
  const saved = new TrackLog();
  saved.load('20261027', copy.serialize('20261027'));
  assert.equal(saved.get(key).buses[0].points.length, 2);
  assert.equal(new TrackLog().capture(event, { leaderBus: null, followerBus: 'bus2' }), false); // buses unknown
});

test('replay positions interpolate between GPS samples', async () => {
  const { interpolate } = await import('../web/replay.js');
  const points = [[100, 26.0, -80.2], [160, 26.1, -80.1]];
  assert.equal(interpolate(points, 90), null); // before the first report
  assert.deepEqual(interpolate(points, 130).map(v => Math.round(v * 1000) / 1000), [-80.15, 26.05]);
  assert.deepEqual(interpolate(points, 999), [-80.1, 26.1]);
});
