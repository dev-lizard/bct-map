// The Worker's memory: one Durable Object (a single instance, named "bct") with its own SQLite
// database. Every minute the Cron Trigger calls tick(), which reads BCT's trip updates and records
// each timepoint a bus has passed (rules in server/ontime.mjs), and notes how the fetch went for
// /api/health.
//
// Stored as counts per (service date, route, hour) rather than one row per departure, which keeps
// the database small and inside the free plan (100,000 rows written a day; this writes about
// 60,000: one row per departure in `seen`, deleted after 3 days, plus one count update per route and
// hour per minute). The timetable comes from the GitHub Pages site (PAGES_URL), reloaded when a
// new build is published.
import { DurableObject } from 'cloudflare:workers';
import { decodeFeed, feedTimestamp } from '../web/gtfs-rt.js';
import { addDays, ymdInZone } from '../web/gtfs-util.js';
import { summarizeTripUpdates } from '../web/live.js';
import { Schedule } from '../web/schedule.js';
import { fetchAllFeeds, USER_AGENT } from '../server/bct-feed.mjs';
import { healthReport } from '../server/health.mjs';
import { addDelay, emptyCount, passedTimepoints, summarize } from '../server/ontime.mjs';

const TIMEZONE = 'America/New_York';
const KEEP_DAYS = 30; // service days of counts kept
const SEEN_DAYS = 3; // service days of "already recorded" memory kept
const MANIFEST_CHECK_MS = 10 * 60_000;

export class Recorder extends DurableObject {
  #loaded = false;
  #seen = new Map(); // service date -> Set of "trip_id|stop_sequence"
  #counts = new Map(); // "date|route|hour" -> { date, routeId, hour, n, early, late, sumDelay }
  #schedule = null;
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
    const feeds = await fetchAllFeeds(['vehiclePositions', 'tripUpdates'], { base: this.env.BCT_BASE || undefined });
    status.errors.push(...feeds.errors);
    if (feeds.vehiclePositions) {
      status.okAt = nowS;
      status.vehicleFeedS = feedTimestamp(feeds.vehiclePositions);
    }
    if (feeds.tripUpdates && this.#schedule) status.recorded = this.#record(decodeFeed(feeds.tripUpdates));
    this.#prune();
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

  #record(feed) {
    const schedule = this.#schedule;
    const { feedTs, trips } = summarizeTripUpdates(feed, { trips: schedule.trips, timezone: TIMEZONE });
    const newSeen = [];
    const changed = new Map();
    let first = null;
    for (const d of passedTimepoints(trips.values(), schedule.trips, feedTs, { timezone: TIMEZONE, seen: date => this.#seenFor(date) })) {
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

  // Once per service day: forget old departures and counts.
  #prune() {
    const today = ymdInZone(new Date(), TIMEZONE);
    if (this.#get('prunedFor') === today) return;
    const seenFrom = addDays(today, -SEEN_DAYS);
    const countsFrom = addDays(today, -(KEEP_DAYS - 1));
    this.sql.exec('DELETE FROM seen WHERE date < ?', seenFrom);
    this.sql.exec('DELETE FROM counts WHERE date < ?', countsFrom);
    for (const date of this.#seen.keys()) if (date < seenFrom) this.#seen.delete(date);
    for (const [key, c] of this.#counts) if (c.date < countsFrom) this.#counts.delete(key);
    this.#set('prunedFor', today);
  }

  // Reads the database into memory once per wake-up, so summaries and ticks cost no row reads.
  #load() {
    if (this.#loaded) return;
    for (const { date, key } of this.sql.exec('SELECT date, key FROM seen')) this.#seenFor(date).add(key);
    for (const r of this.sql.exec('SELECT * FROM counts')) {
      this.#counts.set(`${r.date}|${r.route}|${r.hour}`, { date: r.date, routeId: r.route, hour: r.hour, n: r.n, early: r.early, late: r.late, sumDelay: r.sum_delay });
    }
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
    this.#schedule = new Schedule(await get(`data/${folder}/schedule.json`));
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
