// The Worker's memory: one Durable Object (a single instance, named "bct") with its own SQLite
// database. Every minute the Cron Trigger calls tick(), which reads BCT's vehicle positions and
// trip updates, records each timepoint departure timed from GPS (rules in server/ontime.mjs), and
// notes how the fetch went for /api/health.
//
// On-time counts are kept per (service date, route, hour), one row per day in `ontime_days`, rather
// than one row per departure. `seen` has one row per departure (deleted after 3 days) only so a
// departure is never counted twice. The timetable comes from the GitHub Pages site (PAGES_URL),
// reloaded when a new build is published.
//
// It also measures bus running times between stops from GPS (server/segments.mjs), follows
// canceled trips (server/cancellations.mjs), keeps bunching replays (server/tracks.mjs) and service
// analytics (server/service.mjs). Each day of each is one row, saved every tick.
//
// Cloudflare may stop the object between ticks, and memory goes with it. So everything a tick
// needs from the one before (where each bus was along its trip, each trip's GPS progress) is saved
// in `state` at the end of every tick and read back on the next wake-up.
//
// The free plan allows 5 million rows read and 100,000 written a day, and wake-ups happen most
// minutes. So a wake-up reads only the last two days' per-day rows, the saved state (one row) and
// the timetable (two rows, kept here gzipped rather than downloaded from Pages each time): about 15.
// The per-departure and per-event tables (`seen`, `bunching`) are written to and asked about one
// row at a time, never read whole. Every query is counted, and /api/health shows the day's totals
// against those limits.
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
import { findHubs, ServiceLog } from '../server/service.mjs';
import { dateRange } from '../server/range.mjs';
import { addDelay, emptyCount, summarize, timepointDepartures } from '../server/ontime.mjs';

const TIMEZONE = 'America/New_York';
const KEEP_DAYS = 30; // service days of counts kept
const SEEN_DAYS = 3; // service days of "already recorded" memory kept
const MANIFEST_CHECK_MS = 10 * 60_000;
const SEGMENTS_KEEP_DAYS = 31;
const RECENT_DAYS = 2; // days back a wake-up reads the per-day logs for; summaries read more when asked

const gzip = async text => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
const gunzip = async bytes => new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();

// The free plan's daily database limits (rows), reset at midnight UTC.
export const ROWS_READ_LIMIT = 5_000_000;
export const ROWS_WRITTEN_LIMIT = 100_000;

export class Recorder extends DurableObject {
  #loaded = false;
  // Departures and bunching events recorded since this wake-up, so a tick doesn't ask the database
  // twice about the same one. The tables are the record: inserts into them say what's new.
  #seen = new Map(); // service date -> Set of "trip_id|stop_sequence"
  #ontime = new Map(); // service date -> { "route|hour": [n, early, late, sum of delays] }, days touched since waking
  #ontimeDirty = new Set();
  #usage = null; // { day (UTC, YYYY-MM-DD), read, written }: database rows today, against the free plan
  #lastTick = null; // the last tick's status, for the next tick and /api/health
  #daysFrom = null; // the earliest date the per-day logs have been read from the database for
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
      CREATE TABLE IF NOT EXISTS ontime_days (date TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS timetable (name TEXT PRIMARY KEY, folder TEXT NOT NULL, data BLOB NOT NULL) WITHOUT ROWID;
      DROP TABLE IF EXISTS canceled;
    `);
  }

  // Every query goes through here, so the rows it reads and writes count towards today's usage.
  #exec(query, ...args) {
    const cursor = this.sql.exec(query, ...args);
    const rows = cursor.toArray();
    this.#countRows(cursor.rowsRead, cursor.rowsWritten);
    return { rows, written: cursor.rowsWritten };
  }

  #countRows(read, written) {
    const day = new Date().toISOString().slice(0, 10);
    if (this.#usage?.day !== day) this.#usage = { day, read: 0, written: 0 };
    this.#usage.read += read;
    this.#usage.written += written;
  }

  // Called by the Cron Trigger every minute.
  async tick() {
    this.#load();
    const nowS = Date.now() / 1000;
    const previous = this.#lastTick;
    const status = { at: nowS, okAt: previous?.okAt ?? null, vehicleFeedS: previous?.vehicleFeedS ?? null, errors: [], recorded: 0 };
    try {
      await this.#ensureSchedule();
    } catch (err) {
      status.errors.push(`Timetable: ${err.message}`);
    }
    const feeds = await fetchAllFeeds(['vehiclePositions', 'tripUpdates', 'alerts'], { base: this.env.BCT_BASE || undefined, contractBase: this.env.CONTRACT_FEED_BASE || null });
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
    this.#lastTick = status;
    // Everything the next wake-up needs, in one row: one write a minute rather than five.
    this.#set('tickState', {
      tracking: { buses: this.#segments.exportTracking(), progress: this.#cancellations.exportProgress() },
      trackBuffer: this.#tracks.exportState(),
      serviceState: this.#service.exportState(),
      tick: status,
      timetableCheckedAt: this.#manifestCheckedAt,
      usage: this.#usage,
    });
    return status;
  }

  // On-time stats for the last `days` service days (today included), or from..to (server/range.mjs).
  async summary({ days = 7, from = null, to = null, routeId = null } = {}) {
    this.#load();
    const range = dateRange({ days, from, to, timezone: TIMEZONE });
    return summarize(this.#ontimeCounts(range.from, range.to), { days: range.days, routeId, collectingSince: this.#get('since') });
  }

  // Bunching and cancellations for the last `days` service days, plus hourly on-time counts by
  // calendar date for the Worker to set against the weather.
  async analytics({ days = 7, from = null, to = null } = {}) {
    this.#load();
    const range = dateRange({ days, from, to, timezone: TIMEZONE });
    const opts = { days, from: range.from, to: range.to, timezone: TIMEZONE };
    this.#ensureDays(range.from);
    const hours = new Map();
    for (const c of this.#ontimeCounts(range.from, range.to)) {
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
      windowDays: range.days,
      from: range.from,
      to: range.to,
      collectingSince: this.#get('analyticsSince'),
      bunching: (b => ({ ...b, recent: b.recent.map(e => ({ ...e, track: this.#tracks.status(trackKey(e)) })) }))(summarizeBunching(this.#bunchingSince(range.from, range.to), opts)),
      cancellations: this.#cancellations.summary(opts),
      hourCounts: [...hours.values()],
    };
  }

  // Measured running times between stops for the last `days` days, with hourly network totals for
  // the Worker to set against the weather.
  async segments({ days = 7, from = null, to = null } = {}) {
    this.#load();
    const range = dateRange({ days, from, to, timezone: TIMEZONE });
    this.#ensureDays(addDays(range.from, -1));
    return this.#segments.query({ from: range.from, to: range.to });
  }

  // Service delivered, prediction accuracy, headways and schedule fit for the last `days` days.
  async service({ days = 7, from = null, to = null } = {}) {
    this.#load();
    const range = dateRange({ days, from, to, timezone: TIMEZONE });
    this.#ensureDays(addDays(range.from, -1)); // the day before too, for trips past midnight
    await this.#ensureSchedule();
    const period = { from: range.from, to: range.to };
    return this.#service.summary({ ...period, schedule: this.#schedule, canceled: this.#cancellations.keys(period) });
  }

  // Both buses' GPS tracks around one bunching event, or null.
  async track(key) {
    this.#load();
    if (/^d{8}|/.test(key)) this.#ensureDays(key.slice(0, 8));
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
    const tick = this.#lastTick;
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
      dbUsage: this.#usage && { read: this.#usage.read, written: this.#usage.written, readLimit: ROWS_READ_LIMIT, writtenLimit: ROWS_WRITTEN_LIMIT },
    });
    return {
      ...report,
      database: this.#usage && { day: this.#usage.day, rowsRead: this.#usage.read, rowsWritten: this.#usage.written, rowsReadLimit: ROWS_READ_LIMIT, rowsWrittenLimit: ROWS_WRITTEN_LIMIT },
      lastTick: tick?.at ?? null,
      departuresRecorded: tick?.recorded ?? null,
      folder: this.#folder,
      feedVersion: this.#schedule?.meta.feed_version ?? null,
    };
  }

  // passages: stops buses were seen to pass (SegmentLog.observe's onPass). A departure counts only
  // if its row in `seen` is new, which also covers ones recorded before a wake-up.
  #record(passages) {
    const schedule = this.#schedule;
    let recorded = 0;
    let first = null;
    this.ctx.storage.transactionSync(() => {
      for (const d of timepointDepartures(passages, schedule.trips, { timezone: TIMEZONE, seen: date => this.#seenFor(date) })) {
        if (!this.#exec('INSERT OR IGNORE INTO seen (date, key) VALUES (?, ?)', d.date, `${d.tripId}|${d.seq}`).written) continue;
        const day = this.#ontimeDay(d.date);
        const count = (day[`${d.routeId}|${d.hour}`] ??= [0, 0, 0, 0]);
        const c = addDelay(emptyCount(), d.delay);
        count[0] += c.n;
        count[1] += c.early;
        count[2] += c.late;
        count[3] += c.sumDelay;
        this.#ontimeDirty.add(d.date);
        recorded++;
        first = Math.min(first ?? d.time, d.time);
      }
      if (recorded && this.#get('since') == null) this.#set('since', first);
    });
    return recorded;
  }

  // One service date's on-time counts, read from the database the first time it's needed.
  #ontimeDay(date) {
    if (!this.#ontime.has(date)) {
      const row = this.#exec('SELECT data FROM ontime_days WHERE date = ?', date).rows[0];
      this.#ontime.set(date, row ? JSON.parse(row.data) : {});
    }
    return this.#ontime.get(date);
  }

  // On-time counts for service dates from..to, as { date, routeId, hour, n, early, late, sumDelay }.
  #ontimeCounts(from, to) {
    const out = [];
    for (const { date, data } of this.#exec('SELECT date, data FROM ontime_days WHERE date >= ? AND date <= ?', from, to).rows) {
      // Today's may have changes not saved yet.
      const day = this.#ontime.get(date) ?? JSON.parse(data);
      for (const [key, [n, early, late, sumDelay]] of Object.entries(day)) {
        const [routeId, hour] = key.split('|');
        out.push({ date, routeId, hour: Number(hour), n, early, late, sumDelay });
      }
    }
    return out;
  }

  // New bunching events in the latest trip updates. An event is new if its row in `bunching` is.
  #analyze({ feedTs, trips }, busOnTrip) {
    const live = [...trips.values()];
    const candidates = newEvents(findBunching(live, this.#schedule.trips, { timezone: TIMEZONE, busOnTrip }), bunchKey, date => this.#eventSeenFor('bunch', date));
    if (this.#get('analyticsSince') == null) this.#set('analyticsSince', Math.floor(feedTs));
    const bunches = [];
    this.ctx.storage.transactionSync(() => {
      for (const e of candidates) {
        if (this.#exec('INSERT OR IGNORE INTO bunching VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', e.date, e.leader, e.follower, e.routeId, e.direction, e.stopId, e.at, e.actualS, e.scheduledS).written) bunches.push(e);
      }
    });
    for (const e of bunches) this.#tracks.capture(e, { leaderBus: busOnTrip?.get(e.leader), followerBus: busOnTrip?.get(e.follower) });
    return { bunches: bunches.length };
  }

  // Bunching events for service dates from..to.
  #bunchingSince(from, to) {
    return this.#exec('SELECT * FROM bunching WHERE date >= ? AND date <= ?', from, to).rows.map(r => ({
      date: r.date, leader: r.leader, follower: r.follower, routeId: r.route, direction: r.direction, stopId: r.stop, at: r.at, actualS: r.actual, scheduledS: r.scheduled,
    }));
  }

  #eventSeenFor(type, date) {
    const map = this.#eventSeen[type];
    if (!map.has(date)) map.set(date, new Set());
    return map.get(date);
  }

  // Writes the days whose totals changed: one row each.
  #saveDaily() {
    const upsert = (table, date, json) => this.#exec(`INSERT INTO ${table} (date, data) VALUES (?, ?) ON CONFLICT (date) DO UPDATE SET data = excluded.data`, date, json);
    this.ctx.storage.transactionSync(() => {
      for (const [log, table] of [[this.#segments, 'segment_days'], [this.#cancellations, 'cancel_days'], [this.#tracks, 'track_days'], [this.#service, 'service_days']]) {
        for (const date of log.dirty) {
          const json = log.serialize(date);
          if (json) upsert(table, date, json);
        }
        log.dirty.clear();
      }
      for (const date of this.#ontimeDirty) upsert('ontime_days', date, JSON.stringify(this.#ontime.get(date)));
      this.#ontimeDirty.clear();
    });
  }

  // Once per service day: forget old departures and counts.
  #prune() {
    const today = ymdInZone(new Date(), TIMEZONE);
    if (this.#get('prunedFor') === today) return;
    const seenFrom = addDays(today, -SEEN_DAYS);
    const countsFrom = addDays(today, -(KEEP_DAYS - 1));
    this.#exec('DELETE FROM seen WHERE date < ?', seenFrom);
    this.#exec('DELETE FROM ontime_days WHERE date < ?', countsFrom);
    this.#exec('DELETE FROM bunching WHERE date < ?', countsFrom);
    this.#cancellations.prune(countsFrom);
    this.#exec('DELETE FROM cancel_days WHERE date < ?', countsFrom);
    this.#tracks.prune(countsFrom);
    this.#exec('DELETE FROM track_days WHERE date < ?', countsFrom);
    this.#service.prune(countsFrom);
    this.#exec('DELETE FROM service_days WHERE date < ?', countsFrom);
    this.#saveDaily();
    const segmentsFrom = addDays(today, -(SEGMENTS_KEEP_DAYS - 1));
    this.#segments.prune(segmentsFrom);
    this.#exec('DELETE FROM segment_days WHERE date < ?', segmentsFrom);
    for (const map of Object.values(this.#eventSeen)) for (const date of map.keys()) if (date < seenFrom) map.delete(date);
    for (const date of this.#seen.keys()) if (date < seenFrom) this.#seen.delete(date);
    for (const date of this.#ontime.keys()) if (date < seenFrom) this.#ontime.delete(date);
    this.#set('prunedFor', today);
  }

  // Reads the recent per-day rows and the saved state into memory once per wake-up (about 15 rows).
  // The per-departure and per-event tables are only queried a row or a window at a time.
  #load() {
    if (this.#loaded) return;
    // On-time counts made from trip-update times (before GPS timing) aren't comparable: start over.
    if (this.#get('ontimeSource') !== 'gps') {
      this.ctx.storage.transactionSync(() => {
        this.#exec('DELETE FROM counts');
        this.#exec('DELETE FROM ontime_days');
        this.#exec('DELETE FROM seen');
        this.#exec("DELETE FROM state WHERE k = 'since'");
        this.#set('ontimeSource', 'gps');
      });
    }
    // Once: on-time counts move from one row per (date, route, hour) to one row per date.
    if (this.#get('ontimeStore') !== 'days') {
      this.ctx.storage.transactionSync(() => {
        const days = new Map();
        for (const r of this.#exec('SELECT * FROM counts').rows) {
          if (!days.has(r.date)) days.set(r.date, {});
          days.get(r.date)[`${r.route}|${r.hour}`] = [r.n, r.early, r.late, r.sum_delay];
        }
        for (const [date, day] of days) this.#exec('INSERT OR REPLACE INTO ontime_days (date, data) VALUES (?, ?)', date, JSON.stringify(day));
        this.#exec('DELETE FROM counts');
        this.#set('ontimeStore', 'days');
      });
    }
    // Ticks only touch today's and yesterday's rows (trips past midnight belong to yesterday's
    // service), so a wake-up reads those; summaries read further back when asked (#ensureDays).
    this.#daysFrom = addDays(ymdInZone(new Date(), TIMEZONE), -RECENT_DAYS);
    for (const [log, table] of this.#dayLogs()) {
      for (const r of this.#exec(`SELECT date, data FROM ${table} WHERE date >= ?`, this.#daysFrom).rows) log.load(r.date, r.data);
    }
    // What the last tick left: one row, or the five it used to be.
    const saved = this.#get('tickState') ?? {
      tracking: this.#get('tracking'), trackBuffer: this.#get('trackBuffer'), serviceState: this.#get('serviceState'), tick: this.#get('tick'), usage: this.#get('usage'),
    };
    this.#tracks.importState(saved.trackBuffer);
    this.#service.importState(saved.serviceState);
    this.#segments.importTracking(saved.tracking?.buses);
    this.#cancellations.importProgress(saved.tracking?.progress);
    this.#lastTick = saved.tick ?? null;
    this.#manifestCheckedAt = saved.timetableCheckedAt ?? 0;
    // Today's saved usage, plus what this wake-up has read so far.
    if (saved.usage?.day === this.#usage?.day) {
      this.#usage.read += saved.usage.read;
      this.#usage.written += saved.usage.written;
    }
    this.#loaded = true;
  }

  // The per-day logs and their tables.
  #dayLogs() {
    return [[this.#segments, 'segment_days'], [this.#cancellations, 'cancel_days'], [this.#tracks, 'track_days'], [this.#service, 'service_days']];
  }

  // Makes sure the per-day logs hold every day from `from` on, reading the ones they don't yet.
  #ensureDays(from) {
    if (from >= this.#daysFrom) return;
    for (const [log, table] of this.#dayLogs()) {
      for (const r of this.#exec(`SELECT date, data FROM ${table} WHERE date >= ? AND date < ?`, from, this.#daysFrom).rows) log.load(r.date, r.data);
    }
    this.#daysFrom = from;
  }

  // The timetable and stops come from the Pages site, which is checked for a new build every 10
  // minutes. A gzipped copy is kept in `timetable` (about 250 KB), so a wake-up reads two rows
  // rather than downloading 2.4 MB from GitHub Pages most minutes.
  async #ensureSchedule() {
    if (!this.#schedule) await this.#loadStoredTimetable();
    if (this.#schedule && Date.now() - this.#manifestCheckedAt < MANIFEST_CHECK_MS) return;
    const base = String(this.env.PAGES_URL ?? '').replace(/\/+$/, '');
    if (!base) throw new Error('PAGES_URL is not set (wrangler.toml)');
    const get = async path => {
      const res = await fetch(`${base}/${path}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`GET ${base}/${path} -> HTTP ${res.status}`);
      return res.text();
    };
    const { folder } = JSON.parse(await get(`data/manifest.json?t=${Date.now()}`));
    this.#manifestCheckedAt = Date.now();
    if (folder === this.#folder && this.#schedule) return;
    const [schedule, stops] = await Promise.all([get(`data/${folder}/schedule.json`), get(`data/${folder}/stops.json`)]);
    this.#useTimetable(folder, JSON.parse(schedule), JSON.parse(stops));
    const [scheduleGz, stopsGz] = await Promise.all([gzip(schedule), gzip(stops)]);
    this.ctx.storage.transactionSync(() => {
      this.#exec('DELETE FROM timetable');
      this.#exec('INSERT INTO timetable (name, folder, data) VALUES (?, ?, ?), (?, ?, ?)', 'schedule', folder, scheduleGz, 'stops', folder, stopsGz);
    });
  }

  async #loadStoredTimetable() {
    const rows = Object.fromEntries(this.#exec('SELECT name, folder, data FROM timetable').rows.map(r => [r.name, r]));
    if (!rows.schedule || !rows.stops || rows.schedule.folder !== rows.stops.folder) return;
    const [schedule, stops] = await Promise.all([gunzip(rows.schedule.data), gunzip(rows.stops.data)]);
    this.#useTimetable(rows.schedule.folder, JSON.parse(schedule), JSON.parse(stops));
  }

  #useTimetable(folder, schedule, stops) {
    this.#schedule = new Schedule(schedule);
    this.#stops = new Map(stops.map(([id, , lat, lon]) => [id, { lat, lon }]));
    this.#service.setHubs(findHubs(stops, this.#schedule), this.#schedule);
    this.#folder = folder;
  }

  #seenFor(date) {
    if (!this.#seen.has(date)) this.#seen.set(date, new Set());
    return this.#seen.get(date);
  }

  #get(key) {
    const row = this.#exec('SELECT v FROM state WHERE k = ?', key).rows[0];
    return row ? JSON.parse(row.v) : null;
  }

  #set(key, value) {
    this.#exec('INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', key, JSON.stringify(value));
  }
}
