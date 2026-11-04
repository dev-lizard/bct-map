// Service analytics, shared by the Node server (analytics-log.mjs) and the Worker's Durable Object
// (worker/recorder.js): bus bunching, and rain hours by date for the by-day charts. (Canceled trips
// are followed in cancellations.mjs.)
//
// Bunching (the rule is in web/bunching.js, shared with the browser): each pair of buses is one event
// per service day, recorded when first seen.
import { addDays } from '../web/gtfs-util.js';
import { dateRange } from './range.mjs';
import { BUNCHED_MAX_S, BUNCHED_SHARE, MIN_SCHEDULED_GAP_S } from '../web/bunching.js';

// The rule itself is shared with the browser.
export { BUNCHED_MAX_S, BUNCHED_SHARE, busesOnTrips, findBunching, MIN_SCHEDULED_GAP_S } from '../web/bunching.js';

const MAX_RECENT = 300;

// Keeps only events not seen before. seen(date) returns that service date's Set of keys.
export function newEvents(events, keyOf, seen) {
  return events.filter(e => {
    const set = seen(e.date);
    const key = keyOf(e);
    if (set.has(key)) return false;
    set.add(key);
    return true;
  });
}
export const bunchKey = e => `${e.leader}|${e.follower}`;

const countBy = (rows, key) => {
  const counts = new Map();
  for (const r of rows) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
  return counts;
};

// events: every recorded bunching event (any order). -> totals, by route, by hour, by date, and the latest.
// The window is the last `days` service days, or from..to (see range.mjs).
export function summarizeBunching(events, { days, from = null, to = null, timezone, nowS = Date.now() / 1000 }) {
  const range = dateRange({ days, from, to, timezone, nowS });
  const rows = events.filter(e => e.date >= range.from && e.date <= range.to);
  const hourFormat = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' });
  return {
    total: rows.length,
    byRoute: [...countBy(rows, e => e.routeId)].map(([routeId, events]) => ({ routeId, events })).sort((a, b) => b.events - a.events),
    byHour: [...countBy(rows, e => Number(hourFormat.format(e.at * 1000)))].map(([hour, events]) => ({ hour, events })).sort((a, b) => a.hour - b.hour),
    byDate: Object.fromEntries(countBy(rows, e => e.date)),
    recent: rows.sort((a, b) => b.at - a.at).slice(0, MAX_RECENT),
    rule: { maxS: BUNCHED_MAX_S, share: BUNCHED_SHARE, minScheduledS: MIN_SCHEDULED_GAP_S },
  };
}

// ---- Weather -----------------------------------------------------------------------------------

// An hour's rain (inches, the wettest station's) -> 'dry', 'rain' or 'heavy'. A trace counts as dry.
export function classifyRain(inches) {
  if (inches >= 0.1) return 'heavy'; // 2.5 mm
  if (inches >= 0.01) return 'rain';
  return 'dry';
}

// Station rain (the CSV from loadWeatherHistory in extras.mjs) -> Map "YYYYMMDD|hour" -> weather
// class, by Broward local time. The county's hour is as wet as its wettest station, since showers
// here are often a few miles across. A report "valid" at 14:00 covers 13:00–14:00, so it's hour 13.
// Hours no station reported are left out, rather than counted as dry.
export function weatherByHour(csv) {
  const wettest = new Map();
  for (const line of String(csv).split('\n').slice(1)) {
    const [, , valid, inches] = line.split(',');
    const m = valid?.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):/);
    const amount = Number(inches);
    if (!m || !Number.isFinite(amount)) continue;
    let date = `${m[1]}${m[2]}${m[3]}`;
    let hour = Number(m[4]) - 1;
    if (hour < 0) {
      date = addDays(date, -1);
      hour = 23;
    }
    const key = `${date}|${hour}`;
    wettest.set(key, Math.max(wettest.get(key) ?? 0, amount));
  }
  return new Map([...wettest].map(([key, inches]) => [key, classifyRain(inches)]));
}

// Each date from..to (YYYYMMDD) -> [rainy hours, heavy-rain hours], from weatherByHour's classes.
export function rainByDate(from, to, weather) {
  const byDate = {};
  for (let d = from; d <= to; d = addDays(d, 1)) byDate[d] = [0, 0];
  for (const [key, wx] of weather) {
    const wet = byDate[key.slice(0, 8)];
    if (wet && wx !== 'dry') wet[wx === 'heavy' ? 1 : 0]++;
  }
  return byDate;
}
