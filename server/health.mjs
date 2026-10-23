// What /api/health reports. Pure, so the rules can be unit-tested.
//
// status is 'ok', 'degraded' (working, but something needs attention soon) or 'down' (the map is
// showing stale or wrong data). index.mjs answers 'down' with HTTP 503 so any uptime monitor that
// only looks at status codes still notices.

const FEED_STALE_S = 2 * 60; // no fresh vehicle positions for this long: degraded
const FEED_DOWN_S = 10 * 60; // ...for this long: down
const TIMETABLE_WARN_DAYS = 7; // the static timetable ends within this many days: degraded
const BUILD_STALE_S = 36 * 3600; // the nightly rebuild hasn't succeeded for this long: degraded

// nowS: unix seconds. lastRefreshS: when the last feed refresh succeeded. vehicleFeedS: the vehicle
// feed's own header timestamp. timetableEnd: last service date in the static data (YYYYMMDD).
// today: today's date in Broward (YYYYMMDD). lastBuild: { ok, at, error } for the last nightly
// rebuild, or null if none has run in this process. builtAt: when the static data in use was built.
export function healthReport({ nowS, lastRefreshS, vehicleFeedS, feedErrors = [], timetableEnd, today, daysLeft, lastBuild, builtAtS }) {
  const checks = [];
  const add = (name, level, detail) => checks.push({ name, level, detail });

  const refreshAge = lastRefreshS == null ? Infinity : nowS - lastRefreshS;
  if (refreshAge > FEED_DOWN_S) add('feed', 'down', lastRefreshS == null ? 'No successful refresh yet' : `Last successful refresh ${Math.round(refreshAge / 60)} min ago`);
  else if (refreshAge > FEED_STALE_S) add('feed', 'degraded', `Last successful refresh ${Math.round(refreshAge)} s ago`);
  else add('feed', 'ok', `Refreshed ${Math.round(refreshAge)} s ago`);

  // BCT's own timestamp: the server can be refreshing fine while BCT keeps republishing old data.
  if (vehicleFeedS != null) {
    const age = nowS - vehicleFeedS;
    add('bct-data', age > FEED_DOWN_S ? 'down' : age > FEED_STALE_S ? 'degraded' : 'ok', `BCT vehicle data is ${Math.round(age)} s old`);
  }
  if (feedErrors.length) add('feed-errors', 'degraded', feedErrors.join('; '));

  if (timetableEnd && timetableEnd < today) add('timetable', 'down', `Static timetable ended ${timetableEnd}; rebuild from BCT's latest GTFS`);
  else if (timetableEnd && daysLeft <= TIMETABLE_WARN_DAYS) add('timetable', 'degraded', `Static timetable ends ${timetableEnd} (${daysLeft} days)`);
  else if (timetableEnd) add('timetable', 'ok', `Static timetable runs to ${timetableEnd}`);

  if (lastBuild && !lastBuild.ok) add('nightly-build', 'degraded', `Last rebuild failed: ${lastBuild.error}`);
  else if (builtAtS != null && nowS - builtAtS > BUILD_STALE_S) add('nightly-build', 'degraded', `Static data is ${Math.round((nowS - builtAtS) / 3600)} h old`);
  else if (builtAtS != null) add('nightly-build', 'ok', `Static data built ${Math.round((nowS - builtAtS) / 3600)} h ago`);

  const status = checks.some(c => c.level === 'down') ? 'down' : checks.some(c => c.level === 'degraded') ? 'degraded' : 'ok';
  return { status, checks };
}
