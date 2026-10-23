// Bus speeds between stops, from /api/segments (measured from GPS; see server/segments.mjs), turned
// into what the Analytics panel and the map show. Pure, so it can be tested in Node.
//
// Congestion is judged against each stretch's own best time of day: the fastest period with at least
// MIN_RUNS runs is its baseline, and time over that baseline in the chosen period is time lost.
// The timetable isn't the yardstick, because BCT's has 1-minute resolution and is padded around
// timepoints, so buses beat it on most stretches.
import { distanceMeters } from './gtfs-util.js';

export const MIN_RUNS = 3; // for ranking a stretch
export const MIN_MAP_RUNS = 2; // for drawing it
const MIN_DISTANCE_M = 100; // shorter stretches are mostly dwell time
const MPS_TO_MPH = 2.23694;

// Speed bands for the map, slowest first: dark for slow so the problem stretches stand out.
export const SPEED_BANDS = [
  { max: 8, color: '#7f1d1d', label: 'under 8 mph' },
  { max: 12, color: '#b91c1c', label: '8–12' },
  { max: 18, color: '#ef4444', label: '12–18' },
  { max: 25, color: '#f87171', label: '18–25' },
  { max: Infinity, color: '#fca5a5', label: '25+' },
];
export const bandOf = mph => SPEED_BANDS.findIndex(b => mph < b.max);

// data: /api/segments. period: a period key or 'all'. stop(id) -> { lat, lon, name } or null.
// routes: Map of "from>to" -> [route ids]. -> { segments, totals }, segments sorted by time lost.
export function speedTable(data, { period = 'all', stop, routes = new Map() }) {
  const P = data.periods.length;
  const chosen = period === 'all' ? data.periods.map((_, i) => i) : [data.periods.findIndex(p => p.key === period)];
  const days = data.days;
  const segments = [];
  let runs = 0;
  let metres = 0;
  let seconds = 0;
  for (const row of data.segments) {
    const [from, to] = row;
    const a = stop(from);
    const b = stop(to);
    if (!a || !b) continue;
    const distanceM = distanceMeters(a.lat, a.lon, b.lat, b.lon);
    if (distanceM < MIN_DISTANCE_M) continue;
    const per = Array.from({ length: P }, (_, i) => ({ n: row[2 + i * 3], run: row[3 + i * 3], sched: row[4 + i * 3] }));
    // Baseline: the stretch's fastest typical period.
    const typical = per.filter(p => p.n >= MIN_RUNS).map(p => p.run / p.n);
    const baselineS = typical.length ? Math.min(...typical) : null;
    let n = 0;
    let run = 0;
    let sched = 0;
    let lostS = 0;
    for (const i of chosen) {
      const p = per[i];
      if (!p?.n) continue;
      n += p.n;
      run += p.run;
      sched += p.sched;
      if (baselineS != null && p.n >= MIN_RUNS) lostS += Math.max(0, p.run - p.n * baselineS);
    }
    if (!n) continue;
    runs += n;
    metres += distanceM * n;
    seconds += run;
    const meanS = run / n;
    segments.push({
      from, to,
      fromName: a.name, toName: b.name,
      coordinates: [[a.lon, a.lat], [b.lon, b.lat]],
      routes: routes.get(`${from}>${to}`) ?? [],
      runs: n,
      distanceM: Math.round(distanceM),
      meanRunS: Math.round(meanS),
      meanTimetabledS: Math.round(sched / n),
      mph: round1((distanceM / meanS) * MPS_TO_MPH),
      baselineMph: baselineS ? round1((distanceM / baselineS) * MPS_TO_MPH) : null,
      extraPerRunS: baselineS ? Math.max(0, Math.round(meanS - baselineS)) : null,
      lostPerDayS: Math.round(lostS / days),
    });
  }
  segments.sort((x, y) => y.lostPerDayS - x.lostPerDayS || x.mph - y.mph);
  return { segments, totals: { runs, mph: seconds ? round1((metres / seconds) * MPS_TO_MPH) : null, lostPerDayS: segments.reduce((s, x) => s + x.lostPerDayS, 0) } };
}

// The slowest stretches with enough runs to trust.
export const slowest = (segments, count = 10) => segments.filter(s => s.runs >= MIN_RUNS).sort((a, b) => a.mph - b.mph).slice(0, count);

// GeoJSON for the map: every stretch measured at least twice, coloured by speed band.
export function speedFeatures(segments) {
  return {
    type: 'FeatureCollection',
    features: segments.filter(s => s.runs >= MIN_MAP_RUNS).map(s => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: s.coordinates },
      properties: { band: bandOf(s.mph), mph: s.mph, label: `${s.fromName} → ${s.toName}: ${s.mph} mph` },
    })),
  };
}

// The timetable's stop pairs -> the routes that run them, for labelling stretches.
export function routesByStopPair(trips) {
  const out = new Map();
  for (const trip of Object.values(trips)) {
    const rows = trip.s;
    for (let i = 0; i < rows.length - 1; i++) {
      const key = `${rows[i][1]}>${rows[i + 1][1]}`;
      const list = out.get(key) ?? out.set(key, []).get(key);
      if (!list.includes(trip.r)) list.push(trip.r);
    }
  }
  return out;
}

const round1 = v => Math.round(v * 10) / 10;
