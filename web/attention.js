// What to act on, worked out in the browser from data the Analytics panel already loads (no extra
// requests): sample-size rules and ± ranges, goals, and the recommendations the Needs attention tab
// lists. Pure functions, so the Node tests can check them.
//
// Goals are placeholders until BCT's own targets replace them (see TARGETS).

// ---- Sample sizes and ranges ---------------------------------------------------------------------

export const MIN_SAMPLES = 20; // below this, a share is marked (*) or left out of lists

// 95% Wilson interval for k of n, in percentage points: { pct, lo, hi, pm } (pm: half the width).
export function share(k, n) {
  if (!n) return null;
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  const r = x => Math.round(x * 1000) / 10;
  return { pct: r(p), lo: r(Math.max(0, mid - half)), hi: r(Math.min(1, mid + half)), pm: r(half) };
}

// Whether two shares (k1 of n1 against k2 of n2) differ by more than chance would explain (two-
// proportion z-test at 95%).
export function sharesDiffer(k1, n1, k2, n2) {
  if (!n1 || !n2) return false;
  const p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se > 0 && Math.abs(k1 / n1 - k2 / n2) / se >= 1.96;
}

// Whether two daily rates of events (a over daysA days against b over daysB) differ by more than
// chance (Poisson counts, 95%).
export function ratesDiffer(a, daysA, b, daysB) {
  if (!daysA || !daysB || a + b === 0) return false;
  const se = Math.sqrt(a / (daysA * daysA) + b / (daysB * daysB));
  return se > 0 && Math.abs(a / daysA - b / daysB) / se >= 1.96;
}

// ---- Goals ---------------------------------------------------------------------------------------

// Placeholder goals, not BCT's official targets: replace them with BCT's when known. better: 1 if
// higher is better, -1 if lower is. Percentages are in points; excess wait in seconds.
export const TARGETS_ARE_PLACEHOLDERS = true;
export const TARGETS = {
  onTime: { label: 'On time', goal: 80, unit: '%', better: 1, tab: 'ontime' },
  delivered: { label: 'Trips ran in full', goal: 99, unit: '%', better: 1, tab: 'service' },
  stopsServed: { label: 'Stops served', goal: 99, unit: '%', better: 1, tab: 'service' },
  predictions: { label: 'Predictions accurate', goal: 80, unit: '%', better: 1, tab: 'predictions' },
  transfers: { label: 'Transfers made', goal: 85, unit: '%', better: 1, tab: 'transfers' },
  excessWait: { label: 'Excess wait', goal: 60, unit: 's', better: -1, tab: 'headways' },
  staleGps: { label: 'Stale GPS reports', goal: 2, unit: '%', better: -1, tab: 'feed' },
  timetableOnly: { label: 'Timetable-only predictions', goal: 5, unit: '%', better: -1, tab: 'feed' },
};

// 'met', 'close' (short of the goal, but within the ± range, so it may be noise), 'missed' or null
// (no value). range: share() of the value, for percentages.
export function versusGoal(key, value, range = null) {
  const t = TARGETS[key];
  if (!t || value == null) return null;
  if ((value - t.goal) * t.better >= 0) return 'met';
  const best = range ? (t.better > 0 ? range.hi : range.lo) : value;
  return (best - t.goal) * t.better >= 0 ? 'close' : 'missed';
}

// ---- Who runs it ---------------------------------------------------------------------------------

// Routes BCT contracts out (their buses report through the contractor's own system).
const CONTRACTED = new Set([4, 6, 15, 23, 56]);
export const isContracted = shortName => CONTRACTED.has(Number(shortName));

// ---- Recommendations -----------------------------------------------------------------------------

// Running time the timetable should allow, by route, direction and time of day: enough for 85% of
// runs (the usual scheduling rule). bands: /api/service runtimeBands ("route|dir|period" ->
// [runs, median ratio, 85th-percentile ratio, mean timetabled s, trips]). A change is suggested when
// it's at least 2 minutes and 10% of the trip, from at least minRuns runs.
export function runtimeAdvice(bands, { minRuns = 10 } = {}) {
  const out = [];
  for (const [key, [runs, median, p85, wholeS, trips]] of Object.entries(bands ?? {})) {
    if (runs < minRuns) continue;
    const [routeId, dir, period] = key.split('|');
    const changeS = Math.round(((p85 - 1) * wholeS) / 60) * 60;
    if (Math.abs(changeS) < Math.max(120, 0.1 * wholeS)) continue;
    out.push({ routeId, dir: Number(dir), period: Number(period), runs, trips, timetabledS: wholeS, medianS: Math.round(median * wholeS), p85S: Math.round(p85 * wholeS), changeS });
  }
  return out.sort((a, b) => Math.abs(b.changeS) * b.runs - Math.abs(a.changeS) * a.runs);
}

// Transfers worth retiming: for each route pair at a hub made less often than `goal`% (with at least
// minTries tries), how many minutes later the departing bus would have to leave for `goal`% of riders
// to make it (up to maxShift), from how long riders really had. slack: /api/service transfers.slack
// (hub -> pair -> { minutes: connections }). minTransferMin: the time needed to walk between bays.
export function transferAdvice(slack, { goal = 85, minTries = MIN_SAMPLES, minTransferMin = 2, maxShift = 10 } = {}) {
  const out = [];
  for (const [hubId, pairs] of Object.entries(slack ?? {})) {
    for (const [pair, hist] of Object.entries(pairs)) {
      const entries = Object.entries(hist).map(([m, n]) => [Number(m), n]);
      const tries = entries.reduce((t, [, n]) => t + n, 0);
      if (tries < minTries) continue;
      const madeWith = shift => entries.reduce((t, [m, n]) => t + (m + shift >= minTransferMin ? n : 0), 0) / tries;
      const now = madeWith(0);
      if (now * 100 >= goal) continue;
      let shift = 1;
      while (shift < maxShift && madeWith(shift) * 100 < goal) shift++;
      const [from, to] = pair.split('>');
      out.push({ hubId, from, to, tries, madePct: Math.round(now * 1000) / 10, shiftMin: shift, madeAfterPct: Math.round(madeWith(shift) * 1000) / 10 });
    }
  }
  return out.sort((a, b) => b.tries * (100 - b.madePct) - a.tries * (100 - a.madePct));
}

// Average wait for a random arrival (Σh² / 2Σh) less the timetable's, from headway sums
// [n, Σ actual, Σ actual², Σ timetabled, Σ timetabled²].
export function excessOf([n, a, a2, s, s2] = []) {
  if (!n || !a || !s) return null;
  return a2 / (2 * a) - s2 / (2 * s);
}

// Where gaps between buses open up: for each route and direction, the first timepoint along the route
// (with at least minGaps gaps) whose excess wait reaches minExcessS. Holding buses to the timetable at
// the timepoint before it is the usual remedy. byStop: headways.byStop ("route|dir|stop" -> sums);
// delays: /api/service delays (for timepoint order: Σ timetabled seconds from the trip's start).
export function holdingPoints(byStop, delays, { minGaps = MIN_SAMPLES, minExcessS = 60 } = {}) {
  const lines = new Map();
  for (const [key, sums] of Object.entries(byStop ?? {})) {
    const [routeId, dir, stopId] = key.split('|');
    const d = delays?.[key];
    if (!d?.[0]) continue;
    const line = lines.get(`${routeId}|${dir}`) ?? lines.set(`${routeId}|${dir}`, []).get(`${routeId}|${dir}`);
    line.push({ routeId, dir: Number(dir), stopId, offset: d[2] / d[0], gaps: sums[0], excessS: excessOf(sums) });
  }
  const out = [];
  for (const line of lines.values()) {
    line.sort((a, b) => a.offset - b.offset);
    const i = line.findIndex(p => p.gaps >= minGaps && p.excessS >= minExcessS);
    if (i < 0) continue;
    out.push({ ...line[i], excessS: Math.round(line[i].excessS), holdAt: i > 0 ? line[i - 1].stopId : null });
  }
  return out.sort((a, b) => b.excessS * b.gaps - a.excessS * a.gaps);
}

// Trips late (or early) at most of their timepoints on most days they ran. byTrip: ontimeByTrip
// (trip id -> [days, departures, early, late]). Early is held to a lower bar: it's within the
// operator's control, and riders who come on time miss the bus.
export function chronicTrips(byTrip, { minDays = 3, lateShare = 0.5, earlyShare = 0.3 } = {}) {
  const out = [];
  for (const [tripId, [days, n, early, late]] of Object.entries(byTrip ?? {})) {
    if (days < minDays || n < minDays * 2) continue;
    const kind = late / n >= lateShare ? 'late' : early / n >= earlyShare ? 'early' : null;
    if (kind) out.push({ tripId, kind, days, departures: n, sharePct: Math.round((1000 * (kind === 'late' ? late : early)) / n) / 10 });
  }
  return out;
}

// Trips not run, by block and day: a block with several means a bus (or its operator) never went
// out, which is a dispatch matter rather than a one-off. trips: [{ tripId, date, routeId }];
// blockOf(tripId) -> block id or null.
export function blocksNotRun(trips, blockOf, { minTrips = 2 } = {}) {
  const groups = new Map();
  for (const t of trips) {
    const block = blockOf(t.tripId);
    if (!block) continue;
    const key = `${t.date}|${block}`;
    (groups.get(key) ?? groups.set(key, { date: t.date, block, routeIds: new Set(), trips: [] }).get(key)).trips.push(t);
  }
  return [...groups.values()].filter(g => g.trips.length >= minTrips)
    .map(g => ({ ...g, routeIds: [...new Set(g.trips.map(t => t.routeId))] }))
    .sort((a, b) => b.trips.length - a.trips.length || (a.date < b.date ? 1 : -1));
}

// Buses whose GPS units look faulty: many stale reports, repeated gaps, or vanishing mid-trip.
// byVehicle: feedVehicle (id -> [reports, stale, gaps, vanished]); days: days in the period.
export function gpsUnits(byVehicle, days, { minReports = 200, staleShare = 0.1, gapsPerDay = 2, vanished = 2 } = {}) {
  const out = [];
  for (const [id, [reports = 0, stale = 0, gaps = 0, gone = 0]] of Object.entries(byVehicle ?? {})) {
    const reasons = [];
    if (reports >= minReports && stale / reports >= staleShare) reasons.push('stale');
    if (gaps / Math.max(1, days) >= gapsPerDay) reasons.push('gaps');
    if (gone >= vanished) reasons.push('vanished');
    if (reasons.length) out.push({ id, reports, stalePct: reports ? Math.round((1000 * stale) / reports) / 10 : null, gaps, vanished: gone, reasons });
  }
  return out.sort((a, b) => b.reasons.length - a.reasons.length || b.gaps + 5 * b.vanished - (a.gaps + 5 * a.vanished));
}

// Congested stretches by rider-minutes lost a day: bus time lost to congestion, times the riders a
// bus on those routes typically carries (from boardings per trip, a rough stand-in for load).
// segments: speedTable rows ({ lostPerDayS, routes }); ridersPerTrip(routeId) -> number or null.
export function congestionByRiders(segments, ridersPerTrip) {
  return segments.filter(s => s.lostPerDayS > 0).map(s => {
    const riders = s.routes.map(ridersPerTrip).filter(x => x != null);
    const perBus = riders.length ? riders.reduce((a, b) => a + b, 0) / riders.length : null;
    return { ...s, ridersPerBus: perBus, riderMinutes: perBus == null ? null : Math.round((s.lostPerDayS / 60) * perBus) };
  }).sort((a, b) => (b.riderMinutes ?? -1) - (a.riderMinutes ?? -1) || b.lostPerDayS - a.lostPerDayS);
}
