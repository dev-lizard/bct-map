// The Worker's memory: one Durable Object (a single instance, named "bct") with its own SQLite
// database. Every minute the Cron Trigger calls tick(), which reads BCT's vehicle positions and
// trip updates, records each timepoint departure timed from GPS (rules in server/ontime.mjs), and
// notes how the fetch went for /api/health.
//
// Stored as counts per (service date, route, hour) rather than one row per departure, which keeps
// the database small and inside the free plan (100,000 rows written a day; this writes about
// 60,000: one row per departure in `seen`, deleted after 3 days, plus one count update per route and
// hour per minute, plus a few hundred bunching events). The timetable comes from
// the GitHub Pages site (PAGES_URL), reloaded when a new build is published.
//
// It also measures bus running times between stops from GPS (server/segments.mjs) and follows
// canceled trips (server/cancellations.mjs). Each day of each is one row (`segment_days`,
// `cancel_days`), saved every tick.
//
// Cloudflare may stop the object between ticks, and memory goes with it. So everything a tick
// needs from the one before (where each bus was along its trip, each trip's GPS progress) is saved
// in `state` at the end of every tick and read back on the next wake-up: a few rows a minute,
// about 4,300 writes a day.
import { DurableObject } from 'cloudflare:workers';
import { decodeFeed, feedTimestamp } from '../web/gtfs-rt.js';
import { addDays, ymdInZone } from '../web/gtfs-util.js';
import { summarizeTripUpdates } from '../web/live.js';
import { Schedule } from '../web/schedule.js';
import { fetchAllFeeds, USER_AGENT } from '../server/bct-feed.mjs';
import {
  bunchKey, busesOnTrips, findBunching, newEvents, summarizeBunching,
} from '../server/analytics.mjs';
import { alertsByTrip, CancellationLog } from '../server/cancellations.mjs';
import { healthReport } from '../server/health.mjs';
import { SegmentLog } from '../server/segments.mjs';
import { TrackLog, trackKey } from '../server/tracks.mjs';
import { ServiceLog } from '../server/service.mjs';
import { addDelay, emptyCount, summarize, timepointDepartures } from '../server/ontime.mjs';

const TIMEZONE = 'America/New_York';
const KEEP_DAYS = 30; // service days of counts kept
const SEEN_DAYS = 3; // service days of "already recorded" memory kept
const MANIFEST_CHECK_MS = 10 * 60_000;
const SEGMENTS_KEEP_DAYS = 31;

export class Recorder extends DurableObject {
  #loaded = false;
  #seen = new Map(); // service date -> Set of "trip_id|stop_sequence"
  #counts = new Map(); // "date|route|hour" -> { date, routeId, hour, n, early, late, sumDelay }
  #bunching = []; // bunching events (server/analytics.mjs), last KEEP_DAYS service days
  #cancellations = new CancellationLog({ timezone: TIMEZONE }); // one row per day in cancel_days
  #tracks = new TrackLog(); // bunching replays, one row per day in track_days
  #service = new ServiceLog({ timezone: TIMEZONE }); // service analytics, one row per day in service_days
  #eventSeen = { bunch: new Map() }; // service date -> Set of event keys
  #schedule = null;
  #stops = null; // stop id -> { lat, lon }, for measuring running times
  #segments = new SegmentLog({ timezone: TIMEZONE });
  #folder = null;
  #manifestCheckedAt = 0;

  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS seen (date TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (date, key)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS counts (
        date TEXT NOT NULL, route TEXT NOT NULL, hour INTEGER NOT NULL,
        n INTEGER NOT NULL, early INTEGER NOT NULL, late INTEGER NOT NULL, sum_delay INTEGER NOT NULL,
        PRIMARY KEY (date, route, hour)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS bunching (
        date TEXT NOT NULL, leader TEXT NOT NULL, follower TEXT NOT NULL, route TEXT, direction INTEGER, stop TEXT,
        at INTEGER NOT NULL, actual INTEGER NOT NULL, scheduled INTEGER NOT NULL,
        PRIMARY KEY (date, leader, follower)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS segment_days (date TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS cancel_days (date TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS track_days (date TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS service_days (date TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID;
      DROP TABLE IF EXISTS canceled;
    `);
  }

  // Called by the Cron Trigger every minute.
  async tick() {
    this.#load();
    const nowS = Date.now() / 1000;
    const previous = this.#get('tick');
    const status = { at: nowS, okAt: previous?.okAt ?? null, vehicleFeedS: previous?.vehicleFeedS ?? null, errors: [], recorded: 0 };
    try {
      await this.#ensureSchedule();
    } catch (err) {
      status.errors.push(`Timetable: ${err.message}`);
    }
    const feeds = await fetchAllFeeds(['vehiclePositions', 'tripUpdates', 'alerts'], { base: this.env.BCT_BASE || undefined });
    status.errors.push(...feeds.errors);
    if (feeds.vehiclePositions) {
      status.okAt = nowS;
      status.vehicleFeedS = feedTimestamp(feeds.vehiclePositions);
    }
    const vehicles = feeds.vehiclePositions ? decodeFeed(feeds.vehiclePositions) : null;
    const passages = [];
    if (vehicles && this.#schedule && this.#stops) {
      status.runs = this.#segments.observe(vehicles, { trips: this.#schedule.trips, stops: this.#stops, onPass: p => passages.push(p) });
      status.recorded = this.#record(passages);
      this.#tracks.observe(vehicles, nowS);
    }
    if (feeds.tripUpdates && this.#schedule) {
      const live = summarizeTripUpdates(decodeFeed(feeds.tripUpdates), { trips: this.#schedule.trips, timezone: TIMEZONE });
      const busOnTrip = vehicles ? busesOnTrips(vehicles) : null;
      Object.assign(status, this.#analyze(live, busOnTrip));
      status.cancels = this.#cancellations.observe({
        liveTrips: live.trips.values(), trips: this.#schedule.trips, feedTs: live.feedTs, busOnTrip,
        alerts: alertsByTrip(feeds.alerts ? decodeFeed(feeds.alerts) : null), passages,
      });
      this.#service.observe({ vehicles, liveTrips: live.trips.values(), passages, trips: this.#schedule.trips, nowS });
    }
    this.#prune();
    this.#saveDaily();
    this.#set('tracking', { buses: this.#segments.exportTracking(), progress: this.#cancellations.exportProgress() });
    this.#set('trackBuffer', this.#tracks.exportState());
    this.#set('serviceState', this.#service.exportState());
    this.#set('tick', status);
    return status;
  }

  // On-time stats for the last `days` service days (today included).
  async summary({ days = 7, routeId = null } = {}) {
    this.#load();
    const from = addDays(ymdInZone(new Date(), TIMEZONE), -(days - 1));
    const counts = [...this.#counts.values()].filter(c => c.date >= from);
    return summarize(counts, { days, routeId, collectingSince: this.#get('since') });
  }

  // Bunching and cancellations for the last `days` service days, plus hourly on-time counts by
  // calendar date for the Worker to set against the weather.
  async analytics({ days = 7 } = {}) {
    this.#load();
    const opts = { days, timezone: TIMEZONE };
    const from = addDays(ymdInZone(new Date(), TIMEZONE), -(days - 1));
    const hours = new Map();
    for (const c of this.#counts.values()) {
      if (c.date < from) continue;
      // Counts are by service date; departures before 4 AM belong to the previous day's service.
      const date = c.hour < 4 ? addDays(c.date, 1) : c.date;
      const key = `${date}|${c.hour}`;
      if (!hours.has(key)) hours.set(key, { date, hour: c.hour, ...emptyCount() });
      const h = hours.get(key);
      h.n += c.n;
      h.early += c.early;
      h.late += c.late;
      h.sumDelay += c.sumDelay;
    }
    return {
      windowDays: days,
      collectingSince: this.#get('analyticsSince'),
      bunching: (b => ({ ...b, recent: b.recent.map(e => ({ ...e, track: this.#tracks.status(trackKey(e)) })) }))(summarizeBunching(this.#bunching, opts)),
      cancellations: this.#cancellations.summary({ days }),
      hourCounts: [...hours.values()],
    };
  }

  // Measured running times between stops for the last `days` days, with hourly network totals for
  // the Worker to set against the weather.
  async segments({ days = 7 } = {}) {
    this.#load();
    return this.#segments.query({ days });
  }

  // Service delivered, prediction accuracy, headways and schedule fit for the last `days` days.
  async service({ days = 7 } = {}) {
    this.#load();
    await this.#ensureSchedule();
    return this.#service.summary({ days, schedule: this.#schedule, canceled: this.#cancellations.keys({ days }) });
  }

  // Both buses' GPS tracks around one bunching event, or null.
  async track(key) {
    this.#load();
    return this.#tracks.get(key);
  }

  async health() {
    this.#load();
    try {
      await this.#ensureSchedule();
    } catch {
      // Reported through the timetable check below.
    }
    const nowS = Date.now() / 1000;
    const tick = this.#get('tick');
    const today = ymdInZone(new Date(), TIMEZONE);
    const end = this.#schedule?.end ?? null;
    const toUtcDay = ymd => Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
    const report = healthReport({
      nowS,
      lastRefreshS: tick?.okAt ?? null,
      vehicleFeedS: tick?.vehicleFeedS ?? null,
      feedErrors: tick?.errors ?? [],
      timetableEnd: end,
      today,
      daysLeft: end ? Math.round((toUtcDay(end) - toUtcDay(today)) / 86_400_000) : null,
      lastBuild: this.#schedule ? null : { ok: false, error: `could not load the timetable from ${this.env.PAGES_URL}` },
      builtAtS: Date.parse(this.#schedule?.meta.built_at ?? '') / 1000 || null,
    });
    return {
      ...report,
      lastTick: tick?.at ?? null,
      departuresRecorded: tick?.recorded ?? null,
      folder: this.#folder,
      feedVersion: this.#schedule?.meta.feed_version ?? null,
    };
  }

  // passages: stops buses were seen to pass (SegmentLog.observe's onPass).
  #record(passages) {
    const schedule = this.#schedule;
    const newSeen = [];
    const changed = new Map();
    let first = null;
    for (const d of timepointDepartures(passages, schedule.trips, { timezone: TIMEZONE, seen: date => this.#seenFor(date) })) {
      newSeen.push([d.date, `${d.tripId}|${d.seq}`]);
      const key = `${d.date}|${d.routeId}|${d.hour}`;
      let count = this.#counts.get(key);
      if (!count) this.#counts.set(key, (count = { date: d.date, routeId: d.routeId, hour: d.hour, ...emptyCount() }));
      addDelay(count, d.delay);
      changed.set(key, count);
      first = Math.min(first ?? d.time, d.time);
    }
    if (!newSeen.length) return 0;
    this.ctx.storage.transactionSync(() => {
      for (const [date, key] of newSeen) this.sql.exec('INSERT OR IGNORE INTO seen (date, key) VALUES (?, ?)', date, key);
      for (const c of changed.values()) {
        this.sql.exec(
          `INSERT INTO counts (date, route, hour, n, early, late, sum_delay) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (date, route, hour) DO UPDATE SET n = excluded.n, early = excluded.early, late = excluded.late, sum_delay = excluded.sum_delay`,
          c.date, c.routeId, c.hour, c.n, c.early, c.late, c.sumDelay,
        );
      }
      if (this.#get('since') == null) this.#set('since', first);
    });
    return newSeen.length;
  }

  // New bunching events in the latest trip updates.
  #analyze({ feedTs, trips }, busOnTrip) {
    const live = [...trips.values()];
    const bunches = newEvents(findBunching(live, this.#schedule.trips, { timezone: TIMEZONE, busOnTrip }), bunchKey, date => this.#eventSeenFor('bunch', date));
    for (const e of bunches) this.#tracks.capture(e, { leaderBus: busOnTrip?.get(e.leader), followerBus: busOnTrip?.get(e.follower) });
    if (this.#get('analyticsSince') == null) this.#set('analyticsSince', Math.floor(feedTs));
    if (!bunches.length) return { bunches: 0 };
    this.#bunching.push(...bunches);
    this.ctx.storage.transactionSync(() => {
      for (const e of bunches) {
        this.sql.exec('INSERT OR IGNORE INTO bunching VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', e.date, e.leader, e.follower, e.routeId, e.direction, e.stopId, e.at, e.actualS, e.scheduledS);
      }
    });
    return { bunches: bunches.length };
  }

  #eventSeenFor(type, date) {
    const map = this.#eventSeen[type];
    if (!map.has(date)) map.set(date, new Set());
    return map.get(date);
  }

  // Writes the days whose running-time totals or cancellations changed: one row each.
  #saveDaily() {
    this.ctx.storage.transactionSync(() => {
      for (const [log, table] of [[this.#segments, 'segment_days'], [this.#cancellations, 'cancel_days'], [this.#tracks, 'track_days'], [this.#service, 'service_days']]) {
        for (const date of log.dirty) {
          const json = log.serialize(date);
          if (json) this.sql.exec(`INSERT INTO ${table} (date, data) VALUES (?, ?) ON CONFLICT (date) DO UPDATE SET data = excluded.data`, date, json);
        }
        log.dirty.clear();
      }
    });
  }

  // Once per service day: forget old departures and counts.
  #prune() {
    const today = ymdInZone(new Date(), TIMEZONE);
    if (this.#get('prunedFor') === today) return;
    const seenFrom = addDays(today, -SEEN_DAYS);
    const countsFrom = addDays(today, -(KEEP_DAYS - 1));
    this.sql.exec('DELETE FROM seen WHERE date < ?', seenFrom);
    this.sql.exec('DELETE FROM counts WHERE date < ?', countsFrom);
    this.sql.exec('DELETE FROM bunching WHERE date < ?', countsFrom);
    this.#cancellations.prune(countsFrom);
    this.sql.exec('DELETE FROM cancel_days WHERE date < ?', countsFrom);
    this.#tracks.prune(countsFrom);
    this.sql.exec('DELETE FROM track_days WHERE date < ?', countsFrom);
    this.#service.prune(countsFrom);
    this.sql.exec('DELETE FROM service_days WHERE date < ?', countsFrom);
    this.#bunching = this.#bunching.filter(e => e.date >= countsFrom);
    this.#saveDaily();
    const segmentsFrom = addDays(today, -(SEGMENTS_KEEP_DAYS - 1));
    this.#segments.prune(segmentsFrom);
    this.sql.exec('DELETE FROM segment_days WHERE date < ?', segmentsFrom);
    for (const map of Object.values(this.#eventSeen)) for (const date of map.keys()) if (date < countsFrom) map.delete(date);
    for (const date of this.#seen.keys()) if (date < seenFrom) this.#seen.delete(date);
    for (const [key, c] of this.#counts) if (c.date < countsFrom) this.#counts.delete(key);
    this.#set('prunedFor', today);
  }

  // Reads the database into memory once per wake-up, so summaries and ticks cost no row reads.
  #load() {
    if (this.#loaded) return;
    // On-time counts made from trip-update times (before GPS timing) aren't comparable: start over.
    if (this.#get('ontimeSource') !== 'gps') {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('DELETE FROM counts');
        this.sql.exec('DELETE FROM seen');
        this.sql.exec("DELETE FROM state WHERE k = 'since'");
        this.#set('ontimeSource', 'gps');
      });
    }
    for (const { date, key } of this.sql.exec('SELECT date, key FROM seen')) this.#seenFor(date).add(key);
    for (const r of this.sql.exec('SELECT * FROM counts')) {
      this.#counts.set(`${r.date}|${r.route}|${r.hour}`, { date: r.date, routeId: r.route, hour: r.hour, n: r.n, early: r.early, late: r.late, sumDelay: r.sum_delay });
    }
    for (const r of this.sql.exec('SELECT * FROM bunching')) {
      const e = { date: r.date, leader: r.leader, follower: r.follower, routeId: r.route, direction: r.direction, stopId: r.stop, at: r.at, actualS: r.actual, scheduledS: r.scheduled };
      this.#bunching.push(e);
      this.#eventSeenFor('bunch', e.date).add(bunchKey(e));
    }
    for (const r of this.sql.exec('SELECT date, data FROM segment_days')) this.#segments.load(r.date, r.data);
    for (const r of this.sql.exec('SELECT date, data FROM cancel_days')) this.#cancellations.load(r.date, r.data);
    for (const r of this.sql.exec('SELECT date, data FROM track_days')) this.#tracks.load(r.date, r.data);
    this.#tracks.importState(this.#get('trackBuffer'));
    for (const r of this.sql.exec('SELECT date, data FROM service_days')) this.#service.load(r.date, r.data);
    this.#service.importState(this.#get('serviceState'));
    const tracking = this.#get('tracking');
    this.#segments.importTracking(tracking?.buses);
    this.#cancellations.importProgress(tracking?.progress);
    this.#loaded = true;
  }

  // Loads the timetable from the Pages site, and again whenever a new build is published there.
  async #ensureSchedule() {
    if (this.#schedule && Date.now() - this.#manifestCheckedAt < MANIFEST_CHECK_MS) return;
    const base = String(this.env.PAGES_URL ?? '').replace(/\/+$/, '');
    if (!base) throw new Error('PAGES_URL is not set (wrangler.toml)');
    const get = async path => {
      const res = await fetch(`${base}/${path}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`GET ${base}/${path} -> HTTP ${res.status}`);
      return res.json();
    };
    const { folder } = await get(`data/manifest.json?t=${Date.now()}`);
    this.#manifestCheckedAt = Date.now();
    if (folder === this.#folder && this.#schedule) return;
    const [schedule, stops] = await Promise.all([get(`data/${folder}/schedule.json`), get(`data/${folder}/stops.json`)]);
    this.#schedule = new Schedule(schedule);
    this.#stops = new Map(stops.map(([id, , lat, lon]) => [id, { lat, lon }]));
    this.#folder = folder;
  }

  #seenFor(date) {
    if (!this.#seen.has(date)) this.#seen.set(date, new Set());
    return this.#seen.get(date);
  }

  #get(key) {
    const row = this.sql.exec('SELECT v FROM state WHERE k = ?', key).toArray()[0];
    return row ? JSON.parse(row.v) : null;
  }

  #set(key, value) {
    this.sql.exec('INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', key, JSON.stringify(value));
  }
}
