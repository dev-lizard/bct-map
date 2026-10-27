// Merges Broward County Transit's three decoded GTFS-Realtime feeds with the timetable into the
// snapshot the map draws, and answers per-stop departure boards and per-trip timelines. Runs in the
// browser; the Worker (or the Node dev server) only relays BCT's raw feeds.
//
// BCT's feeds are thinner than Auckland Transport's, so this fills the gaps:
//   - no bearing or speed on vehicles   -> derived from consecutive positions
//   - trip updates carry absolute times only, no delay -> compared against the timetable
//   - trip updates have no vehicle block -> joined to vehicles by trip_id
import { addDays, bearingDegrees, distanceMeters, serviceDayStart, servicesOn, ymdInZone } from './gtfs-util.js';
import { toSchedule } from './schedule.js';

// Bearing is only recomputed once a bus has moved this far, so GPS jitter at a stop doesn't spin it.
const MIN_MOVE_FOR_BEARING_M = 15;
// Vehicles missing from the feed for this long are forgotten.
const FORGET_AFTER_MS = 10 * 60 * 1000;
// A report this much older than its feed is a parked bus's last position, not a live bus.
const MAX_REPORT_AGE_S = 30 * 60;
// Departure boards look at timetabled times this far before the window too, to catch late buses.
const LATE_LOOKBACK_S = 60 * 60;

// One decoded trip-updates feed -> Map of trip id -> { tripId, routeId, startDate, canceled, delay,
// nextStop, bySeq: Map(stop_sequence -> predicted unix time) }. Shared with the reliability recorders.
// stops: Map of stop id -> { name, lat, lon }, used to describe the next stop (optional).
export function summarizeTripUpdates(feed, { trips, timezone, stops = null, nowS = Date.now() / 1000 }) {
  const feedTs = Number(feed.header.timestamp) || Math.floor(nowS);
  const index = new Map();
  for (const entity of feed.entity ?? []) {
    const update = entity.tripUpdate;
    const tripId = update?.trip?.tripId;
    if (!tripId) continue;
    const scheduled = trips[tripId];
    const startDate = update.trip.startDate || ymdInZone(new Date(feedTs * 1000), timezone);
    // BCT sometimes gives a stop's code where the timetable has a longer id ("3533" for
    // "3533_Merged_2"), so the stop id comes from the timetable row with the same stop_sequence.
    // The contracted routes' feed numbers stops one lower than the timetable, so a stop whose id
    // doesn't match its sequence's row is placed by its id instead, searching on from the last.
    const rowBySeq = scheduled ? new Map(scheduled.s.map(r => [r[0], r])) : null;
    let from = 0;
    const calls = (update.stopTimeUpdate ?? []).map(s => {
      let index = scheduled ? scheduled.s.indexOf(rowBySeq.get(s.stopSequence)) : -1;
      if (scheduled && s.stopId && (index < 0 || !sameStop(scheduled.s[index][1], s.stopId))) {
        const byId = scheduled.s.findIndex((r, i) => i >= from && sameStop(r[1], s.stopId));
        if (byId >= 0) index = byId;
      }
      if (index >= 0) from = index + 1;
      const row = index >= 0 ? scheduled.s[index] : null;
      return {
        seq: row?.[0] ?? s.stopSequence,
        stopId: row?.[1] ?? s.stopId,
        time: Number(s.arrival?.time ?? s.departure?.time) || null,
        delay: s.arrival?.delay ?? s.departure?.delay ?? null,
      };
    });
    // The next stop the bus hasn't reached yet; BCT also lists stops it has already passed.
    const next = calls.find(s => s.time && s.time >= feedTs - 30) ?? calls.at(-1) ?? null;
    const nextStop = next && stops?.get(next.stopId);
    index.set(tripId, {
      tripId,
      routeId: update.trip.routeId ?? scheduled?.r ?? null,
      startDate,
      canceled: update.trip.scheduleRelationship === 'CANCELED',
      delay: update.delay ?? next?.delay ?? delayAgainstSchedule(scheduled, startDate, next, timezone),
      // Coordinates let the map stop dead-reckoning at the stop instead of running past it.
      nextStop: next && {
        stopId: next.stopId,
        stopName: nextStop?.name ?? null,
        seq: next.seq,
        time: next.time,
        lon: nextStop?.lon ?? null,
        lat: nextStop?.lat ?? null,
      },
      bySeq: new Map(calls.filter(s => s.time).map(s => [s.seq, s.time])),
    });
  }
  return { feedTs, trips: index };
}

// A timetable stop id and a feed's: the same, or the feed's is the code of a merged stop.
const sameStop = (timetableId, feedId) => timetableId === feedId || timetableId.startsWith(`${feedId}_`);

// Seconds late (+) or early (-) at `stop`, from its predicted time against the timetable.
function delayAgainstSchedule(scheduled, startDate, stop, timezone) {
  if (!scheduled || !stop?.time) return null;
  const row = scheduled.s.find(r => r[0] === stop.seq) ?? scheduled.s.find(r => r[1] === stop.stopId);
  if (!row || row[2] == null) return null;
  return stop.time - (serviceDayStart(startDate, timezone) + row[2]);
}

export class LiveFeed {
  snapshot = null;
  #tracks = new Map(); // vehicle id -> { lat, lon, timestamp, bearing, speed, prev, seenAt }
  #tripIndex = new Map(); // trip id -> latest trip update summary
  #vehicleByTrip = new Map(); // trip id -> id of the bus running it now
  #alerts = [];
  #feedTimestamps = {};

  // schedule: a Schedule (web/schedule.js), or its compact or plain JSON. routes and stops: the
  // build's routes.json and stops.json. now(): unix ms, so the page can correct for a wrong clock.
  constructor({ schedule, routes, stops, now = () => Date.now() }) {
    this.now = now;
    this.setStatic({ schedule, routes, stops });
  }

  // Swaps in a freshly built timetable without dropping live state.
  setStatic({ schedule, routes, stops }) {
    this.schedule = toSchedule(schedule);
    this.trips = this.schedule.trips;
    this.calendar = this.schedule.calendar;
    this.exceptions = this.schedule.exceptions;
    this.timezone = this.schedule.timezone;
    this.routes = new Map(routes.map(r => [r.route_id, r]));
    this.stops = new Map(stops.map(([id, code, lat, lon, name]) => [id, { id, code, name, lat, lon }]));
  }

  // Takes decoded feeds (web/gtfs-rt.js). Any may be null: trip updates and alerts keep their last
  // good copy, and the snapshot is only rebuilt when vehicle positions arrive. history: older
  // vehicle feeds, oldest first, so a page that has just opened already knows where buses were.
  ingest({ vehiclePositions = null, tripUpdates = null, alerts = null, history = [] }) {
    if (tripUpdates) this.#readTripUpdates(tripUpdates);
    if (alerts) this.#readAlerts(alerts);
    if (vehiclePositions) {
      const now = this.now();
      for (const older of history) {
        for (const { id, v, timestamp } of this.#reports(older)) this.#updateTrack(id, v.position.latitude, v.position.longitude, timestamp, now);
      }
      this.#feedTimestamps.vehiclePositions = Number(vehiclePositions.header.timestamp) || null;
      this.snapshot = this.#buildSnapshot(vehiclePositions, now);
    }
    return this.snapshot;
  }

  // Scheduled and predicted times for every stop on one trip, on service date `date` (YYYYMMDD;
  // defaults to the date it is running live, else today).
  tripStopTimes(tripId, { date = null, nowS = this.now() / 1000 } = {}) {
    const trip = this.trips[tripId];
    if (!trip) return null;
    const indexed = this.#tripIndex.get(tripId);
    const serviceDate = date ?? indexed?.startDate ?? ymdInZone(new Date(nowS * 1000), this.timezone);
    const live = indexed?.startDate === serviceDate ? indexed : null;
    const dayStart = serviceDayStart(serviceDate, this.timezone);
    return {
      tripId,
      date: serviceDate,
      ...this.routeInfo(trip.r),
      headsign: trip.h,
      vehicleId: live ? this.#vehicleByTrip.get(tripId) ?? null : null,
      canceled: live?.canceled ?? false,
      delay: live?.delay ?? null,
      nextStopSeq: live?.nextStop?.seq ?? null,
      stops: trip.s.map(([seq, stopId, secs]) => {
        const scheduled = secs == null ? null : dayStart + secs;
        const { predicted, source } = this.#predict(live, seq, scheduled);
        const passed = live?.nextStop ? seq < live.nextStop.seq : (predicted ?? scheduled ?? Infinity) < nowS - 60;
        return { seq, stopId, stopName: this.stops.get(stopId)?.name ?? null, scheduled, predicted, predictionSource: source, passed };
      }),
    };
  }

  // Upcoming departures from a stop: timetabled calls on today's (and, after midnight, yesterday's)
  // services with live predictions where there are any, ordered by expected time. Trips that end at
  // this stop are left out, since nobody can board them.
  stopDepartures(stopId, { nowS = this.now() / 1000, windowS = 90 * 60, pastS = 2 * 60, limit = 20 } = {}) {
    const stop = this.stops.get(stopId);
    if (!stop) return null;
    const calls = this.schedule.callsAt(stopId);
    const today = ymdInZone(new Date(nowS * 1000), this.timezone);
    const departures = [];
    for (const date of [addDays(today, -1), today]) {
      const running = servicesOn(date, this.calendar, this.exceptions);
      const dayStart = serviceDayStart(date, this.timezone);
      for (const call of calls) {
        const scheduled = dayStart + call.secs;
        if (call.last || scheduled < nowS - pastS - LATE_LOOKBACK_S || scheduled > nowS + windowS) continue;
        const trip = this.trips[call.tripId];
        if (!running.has(trip.sv)) continue;
        const indexed = this.#tripIndex.get(call.tripId);
        const live = indexed?.startDate === date ? indexed : null;
        const { predicted, source } = this.#predict(live, call.seq, scheduled);
        const expected = predicted ?? scheduled;
        if (expected < nowS - pastS || expected > nowS + windowS) continue;
        departures.push({
          tripId: call.tripId,
          date,
          ...this.routeInfo(trip.r),
          headsign: trip.h,
          scheduled,
          predicted,
          predictionSource: source,
          delay: predicted == null ? null : predicted - scheduled,
          canceled: live?.canceled ?? false,
          vehicleId: live ? this.#vehicleByTrip.get(call.tripId) ?? null : null,
        });
      }
    }
    departures.sort((a, b) => (a.predicted ?? a.scheduled) - (b.predicted ?? b.scheduled));
    return {
      stop,
      routes: [...new Set(calls.map(c => this.trips[c.tripId].r))].sort().map(id => this.routeInfo(id)),
      generatedAt: Math.floor(nowS),
      departures: departures.slice(0, limit),
    };
  }

  // Live time at stop `seq` of a trip: the feed's own prediction, or else the trip's current delay
  // carried forward to stops the bus hasn't reached yet.
  #predict(live, seq, scheduled) {
    if (!live || scheduled == null) return { predicted: null, source: null };
    const time = live.bySeq.get(seq);
    if (time) return { predicted: time, source: 'feed' };
    if (live.delay != null && live.nextStop && seq >= live.nextStop.seq) return { predicted: scheduled + live.delay, source: 'delay' };
    return { predicted: null, source: null };
  }

  routeInfo(routeId) {
    const route = this.routes.get(routeId);
    return {
      routeId,
      routeShortName: route?.route_short_name ?? '',
      routeColor: `#${route?.route_color ?? '888888'}`,
      routeTextColor: `#${route?.route_text_color ?? 'FFFFFF'}`,
    };
  }

  #readTripUpdates(feed) {
    const { feedTs, trips } = summarizeTripUpdates(feed, { trips: this.trips, timezone: this.timezone, stops: this.stops, nowS: this.now() / 1000 });
    this.#feedTimestamps.tripUpdates = feedTs;
    this.#tripIndex = trips;
  }

  // BCT's alerts name trips and stops by id only, so each is filled in from the timetable: trips get
  // their route and headsign, the alert's routes include its trips' routes, and stops get names.
  #readAlerts(feed) {
    this.#feedTimestamps.alerts = Number(feed.header.timestamp) || null;
    const text = t => t?.translation?.find(x => !x.language || x.language.startsWith('en'))?.text ?? t?.translation?.[0]?.text ?? null;
    const unique = values => [...new Set(values.filter(Boolean))];
    this.#alerts = (feed.entity ?? []).filter(e => e.alert).map(({ id, alert }) => {
      const entities = alert.informedEntity ?? [];
      const tripIds = unique(entities.map(e => e.trip?.tripId));
      const routeIds = unique([...entities.map(e => e.routeId ?? e.trip?.routeId), ...tripIds.map(t => this.trips[t]?.r)]);
      return {
        id,
        cause: alert.cause ?? null,
        effect: alert.effect ?? null,
        header: text(alert.headerText),
        description: text(alert.descriptionText),
        activePeriods: (alert.activePeriod ?? []).map(p => ({ start: Number(p.start) || null, end: Number(p.end) || null })),
        routes: routeIds.map(r => this.routeInfo(r)),
        trips: tripIds.map(t => ({ tripId: t, headsign: this.trips[t]?.h ?? null, ...this.routeInfo(this.trips[t]?.r ?? null) })),
        stops: unique(entities.map(e => e.stopId)).map(s => ({ stopId: s, stopName: this.stops.get(s)?.name ?? null })),
      };
    });
  }

  // Each bus's report, leaving out ones much older than the feed: the contracted routes' feed keeps
  // a parked bus's last position for days.
  * #reports(feed) {
    const feedTs = Number(feed.header.timestamp);
    for (const entity of feed.entity ?? []) {
      const v = entity.vehicle;
      if (!v?.position) continue;
      const timestamp = Number(v.timestamp) || feedTs;
      if (feedTs && feedTs - timestamp > MAX_REPORT_AGE_S) continue;
      yield { id: v.vehicle?.id ?? entity.id, v, timestamp };
    }
  }

  #buildSnapshot(feed, now) {
    const vehicles = [];
    const previous = [];
    const countsByType = {};
    const vehicleByTrip = new Map();

    for (const { id, v, timestamp } of this.#reports(feed)) {
      const { latitude: lat, longitude: lon } = v.position;
      const track = this.#updateTrack(id, lat, lon, timestamp, now);

      const tripId = v.trip?.tripId ?? null;
      const scheduled = tripId ? this.trips[tripId] : null;
      const routeId = v.trip?.routeId ?? scheduled?.r ?? null;
      const route = this.routes.get(routeId);
      const live = tripId ? this.#tripIndex.get(tripId) : null;
      const feedBearing = v.position.bearing ?? null;
      const routeType = route?.route_type ?? 3;
      countsByType[routeType] = (countsByType[routeType] ?? 0) + 1;
      if (tripId) vehicleByTrip.set(tripId, id);

      vehicles.push({
        id,
        label: v.vehicle?.label ?? '',
        tripId,
        routeId,
        routeType,
        routeShortName: route?.route_short_name ?? '',
        routeColor: `#${route?.route_color ?? '888888'}`,
        headsign: scheduled?.h ?? null,
        directionId: scheduled?.d ?? null,
        shapeId: scheduled?.sh ?? null,
        lat,
        lon,
        bearing: feedBearing ?? track.bearing,
        bearingSource: feedBearing != null ? 'feed' : track.bearing != null ? 'computed' : null,
        speed: v.position.speed ?? track.speed,
        timestamp,
        delay: live?.delay ?? null,
        canceled: live?.canceled ?? false,
        nextStop: live?.nextStop ?? null,
      });
      if (track.prev) {
        previous.push({
          vehicleId: id,
          latitude: track.prev.lat,
          longitude: track.prev.lon,
          bearing: track.prev.bearing,
          timestamp: track.prev.timestamp,
        });
      }
    }

    for (const [id, track] of this.#tracks) {
      if (now - track.seenAt > FORGET_AFTER_MS) this.#tracks.delete(id);
    }
    this.#vehicleByTrip = vehicleByTrip;

    return {
      generatedAt: Math.floor(now / 1000),
      feedTimestamps: { ...this.#feedTimestamps },
      vehiclePositions: vehicles,
      previousVehiclePositions: previous,
      tripUpdates: [...this.#tripIndex.values()].map(({ bySeq, ...summary }) => summary),
      alerts: this.#alerts,
      totalVehicleCounts: countsByType,
    };
  }

  // Remembers each vehicle's last distinct report so bearing and speed can be derived.
  #updateTrack(id, lat, lon, timestamp, now) {
    let track = this.#tracks.get(id);
    if (!track) {
      track = { lat, lon, timestamp, bearing: null, speed: null, prev: null, seenAt: now };
      this.#tracks.set(id, track);
      return track;
    }
    track.seenAt = now;
    if (timestamp <= track.timestamp) return track;
    const moved = distanceMeters(track.lat, track.lon, lat, lon);
    const elapsed = timestamp - track.timestamp;
    track.prev = { lat: track.lat, lon: track.lon, timestamp: track.timestamp, bearing: track.bearing };
    if (moved >= MIN_MOVE_FOR_BEARING_M) track.bearing = Math.round(bearingDegrees(track.lat, track.lon, lat, lon));
    track.speed = Math.round((moved / elapsed) * 10) / 10;
    Object.assign(track, { lat, lon, timestamp });
    return track;
  }
}
