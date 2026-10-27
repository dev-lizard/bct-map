// Details for one canceled trip (a record from /api/analytics, see server/cancellations.mjs), worked
// out against the timetable: when it was due, how far ahead BCT canceled it, the gap riders faced at
// its first stop, and whether a bus ran it anyway. Pure, so it can be tested in Node.
import { serviceDayStart, servicesOn } from './gtfs-util.js';

// A bus seen passing at least this share of the trip's stops ran it, cancellation or not.
const RAN_SHARE = 0.5;

// schedule: { trips, calendar, exceptions, timezone }. stopName(id) -> name or null. nowS: the
// time now, so a trip still under way is reported as being watched rather than missed.
export function canceledTripDetails(record, { trips, calendar, exceptions, timezone, stopName = () => null, nowS = Date.now() / 1000 }) {
  const trip = trips[record.tripId];
  if (!trip) return { record, trip: null, verdict: verdict(record, null, nowS) };
  const timed = trip.s.filter(r => r[2] != null);
  const first = timed[0];
  const last = timed.at(-1);
  const dayStart = serviceDayStart(record.date, timezone);
  const start = dayStart + first[2];
  const end = dayStart + last[2];

  // The other trips on the same route and direction that day, at this trip's first stop.
  const running = servicesOn(record.date, calendar, exceptions);
  const times = [];
  for (const [id, t] of Object.entries(trips)) {
    if (id === record.tripId || t.r !== trip.r || t.d !== trip.d || !running.has(t.sv)) continue;
    const row = t.s.find(r => r[1] === first[1] && r[2] != null);
    if (row) times.push(dayStart + row[2]);
  }
  times.sort((a, b) => a - b);
  const previous = times.filter(t => t < start).at(-1) ?? null;
  const next = times.find(t => t > start) ?? null;

  const details = {
    record,
    trip: {
      routeId: trip.r,
      headsign: trip.h,
      direction: trip.d,
      stops: trip.s.length,
      firstStop: { stopId: first[1], name: stopName(first[1]), time: start },
      lastStop: { stopId: last[1], name: stopName(last[1]), time: end },
      durationS: end - start,
    },
    // Seconds between BCT first marking it canceled and its timetabled departure (negative: after).
    noticeS: start - record.firstSeenAt,
    gap: previous != null && next != null
      ? { previous, next, gapS: next - previous, usualS: Math.round((next - previous) / 2) }
      : { previous, next, gapS: null, usualS: null },
  };
  details.verdict = verdict(record, details.trip, nowS);
  return details;
}

// A canceled trip counts as under way until this long after its timetabled arrival.
const WATCH_AFTER_END_S = 30 * 60;

// What the evidence says happened, in one line.
export function verdict(record, trip, nowS = Date.now() / 1000) {
  const stops = trip?.stops ?? null;
  if (stops && record.stopsPassed >= stops * RAN_SHARE) {
    return { kind: 'ran', text: `A bus ran it anyway: GPS shows it passing ${record.stopsPassed} of ${stops} stops. Probably delayed, not missed.` };
  }
  if (record.stopsPassed > 0) {
    return { kind: 'partial', text: `Partly run: a bus was seen passing ${record.stopsPassed}${stops ? ` of ${stops}` : ''} stops.` };
  }
  if (record.restoredAt != null) return { kind: 'restored', text: 'BCT put it back on the schedule later.' };
  if (trip && nowS < trip.lastStop.time + WATCH_AFTER_END_S) {
    const bus = record.vehicles.length ? `Bus ${record.vehicles.join(', ')} is assigned. ` : '';
    return { kind: 'watching', text: `Still within its timetabled run. ${bus}GPS will show whether a bus runs it.` };
  }
  if (record.vehicles.length) return { kind: 'assigned', text: `Bus ${record.vehicles.join(', ')} stayed assigned, but wasn't seen running it.` };
  return { kind: 'missed', text: 'No bus was seen running it: riders likely missed this trip.' };
}
