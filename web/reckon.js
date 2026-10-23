// Bus motion along a route shape between reports, as pure functions so they can be unit-tested.
//
// Each bus is drawn a fixed delay behind the feed (playback). BCT's reports arrive 5-40 s apart
// and buses stop at lights and stops in between, so a bus dead-reckoned forward from its newest
// report keeps running past where the next report puts it. With the delay, the next report has
// usually arrived before the drawn bus gets there: between two reports it moves at exactly the
// speed observed between them and cannot pass the next one.
//
// When a report is late, the bus dead-reckons past the newest one at its observed speed, but no
// further than it would get by its next expected report and never past the stop it is heading to
// (or on from the stop it is dwelling at). If a report still lands behind the drawn bus, it holds
// still rather than reversing.
//
// Distances are metres along the shape; timestamps are seconds on the feed's clock.

// A bus drawn behind its target closes the gap over about this long...
export const CATCH_UP_S = 3;
// ...but never faster than this above the target's own speed.
export const MAX_CATCH_UP_MPS = 20;
// A bus within this distance of the stop it is serving counts as dwelling there.
export const AT_STOP_M = 15;
// About 67 mph, above any BCT express on I-95; faster readings are GPS glitches.
export const MAX_SPEED_MPS = 30;
// Reports kept per bus; a few more than the playback delay ever needs.
export const KEEP_REPORTS = 6;
const SPEED_SMOOTHING = 0.5;

// Observed speed along the shape between two reports, blended with the previous estimate.
export function updateSpeed(previous, movedM, elapsedS) {
  if (!(elapsedS > 0)) return previous;
  const observed = Math.min(MAX_SPEED_MPS, Math.max(0, movedM / elapsedS));
  return previous == null ? observed : previous + SPEED_SMOOTHING * (observed - previous);
}

// The furthest a bus may be dead-reckoned past a report at `along`: where it would be after `gapS`
// seconds (its usual report interval) at `speed`, but not past `stopAlong`, its next stop.
export function reckonCap(along, speed, gapS, stopAlong = null) {
  let cap = along + speed * gapS;
  if (stopAlong != null && stopAlong > along - AT_STOP_M) cap = Math.min(cap, Math.max(along, stopAlong));
  return cap;
}

// Adds an on-shape report ({ ts, along }) to `reports` (oldest first). Small backward jitter is
// flattened so playback never moves a bus backwards.
export function pushReport(reports, ts, along) {
  const last = reports.at(-1);
  if (last && ts <= last.ts) return reports;
  reports.push({ ts, along: last ? Math.max(along, last.along) : along });
  if (reports.length > KEEP_REPORTS) reports.shift();
  return reports;
}

// Where the bus was at feed time `t`, and how fast it was moving: interpolated between the reports
// either side of `t`, or past the newest report, dead-reckoned at `speed` up to `cap`.
export function positionAt(reports, t, speed, cap) {
  const n = reports.length;
  if (n === 0) return null;
  if (t <= reports[0].ts) return { along: reports[0].along, speed: 0 };
  for (let i = n - 2; i >= 0; i--) {
    const a = reports[i];
    const b = reports[i + 1];
    if (t >= a.ts && t < b.ts) {
      const s = (b.along - a.along) / (b.ts - a.ts);
      return { along: a.along + s * (t - a.ts), speed: s };
    }
  }
  const last = reports[n - 1];
  const limit = Math.max(cap, last.along);
  const along = Math.min(limit, last.along + speed * (t - last.ts));
  return { along, speed: along < limit ? speed : 0 };
}

// Moves a bus drawn at `along` one frame of `dtS` seconds towards `target`, which is itself moving
// at `speed`. Never moves it backwards and never past the target.
export function approach(along, target, speed, dtS) {
  if (along >= target) return along; // drawn ahead: hold until the target catches up
  if (target - along < 0.05) return target;
  const v = Math.min(speed + MAX_CATCH_UP_MPS, speed + (target - along) / CATCH_UP_S);
  return Math.min(target, along + v * dtS);
}
