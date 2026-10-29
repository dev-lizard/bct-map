// Bus bunching, the rule shared by the browser (a live "!" over buses bunched right now) and the
// servers (server/analytics.mjs records each event for the Analytics panel).
//
// Bunching: two buses on the same route and direction reaching the same stop within BUNCHED_MAX_S
// of each other, and within BUNCHED_SHARE of the gap the timetable plans between them, for trips
// scheduled at least MIN_SCHEDULED_GAP_S apart. Times come from BCT's trip updates (predicted for
// stops ahead, actual for stops just passed), so no map geometry is needed.
import { serviceDayStart } from './gtfs-util.js';

export const BUNCHED_MAX_S = 180;
export const BUNCHED_SHARE = 0.25;
export const MIN_SCHEDULED_GAP_S = 600;

// Seconds after the service day's start that `trip` is timetabled at `stopId`, with that row's
// stop_sequence, or null. A trip that visits a stop twice (loops) is matched at its first visit.
function scheduledRow(trip, stopId) {
  const row = trip.s.find(r => r[1] === stopId && r[2] != null);
  return row ? { seq: row[0], secs: row[2] } : null;
}

// liveTrips: summaries from summarizeTripUpdates (web/live.js). trips: the timetable's trips.
// busOnTrip: Map of trip id -> vehicle id from the vehicle feed. When given, only trips with a bus
// on them count (BCT also predicts trips no bus has started), and never two trips of one bus.
// -> [{ date, leader, follower, routeId, direction, stopId, at, actualS, scheduledS }]
export function findBunching(liveTrips, trips, { timezone, busOnTrip = null }) {
  const dayStarts = new Map();
  const dayStart = date => dayStarts.get(date) ?? dayStarts.set(date, serviceDayStart(date, timezone)).get(date);
  const groups = new Map(); // "route|direction" -> live trips
  for (const live of liveTrips) {
    const trip = trips[live.tripId];
    if (!trip || live.canceled || !live.nextStop?.time || !live.startDate) continue;
    if (busOnTrip && !busOnTrip.has(live.tripId)) continue;
    const key = `${trip.r}|${trip.d}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(live);
  }
  const events = [];
  for (const group of groups.values()) {
    for (const follower of group) {
      const { stopId, time: followerAt } = follower.nextStop;
      const fTrip = trips[follower.tripId];
      const fRow = scheduledRow(fTrip, stopId);
      if (!fRow) continue;
      // The bus just ahead: the latest other trip at the same stop no later than this one.
      let leader = null;
      for (const other of group) {
        if (other === follower) continue;
        if (busOnTrip && busOnTrip.get(other.tripId) === busOnTrip.get(follower.tripId)) continue;
        const row = scheduledRow(trips[other.tripId], stopId);
        const at = row && other.bySeq.get(row.seq);
        if (!at || at > followerAt) continue;
        if (!leader || at > leader.at) leader = { live: other, row, at };
      }
      if (!leader) continue;
      const scheduledS = (dayStart(follower.startDate) + fRow.secs) - (dayStart(leader.live.startDate) + leader.row.secs);
      const actualS = followerAt - leader.at;
      if (scheduledS < MIN_SCHEDULED_GAP_S || actualS > BUNCHED_MAX_S || actualS > scheduledS * BUNCHED_SHARE) continue;
      events.push({
        date: follower.startDate,
        leader: leader.live.tripId,
        follower: follower.tripId,
        routeId: fTrip.r,
        direction: fTrip.d,
        stopId,
        at: followerAt,
        actualS,
        scheduledS,
      });
    }
  }
  return events;
}

// Vehicle feed -> Map of trip id -> vehicle id, for findBunching.
export function busesOnTrips(vehicleFeed) {
  const out = new Map();
  for (const e of vehicleFeed?.entity ?? []) {
    const tripId = e.vehicle?.trip?.tripId;
    if (tripId) out.set(tripId, e.vehicle.vehicle?.id ?? e.id);
  }
  return out;
}
