// Small helpers shared by the static build, the browser, the Node dev server and the Worker.

// Yields each CSV record as an array of strings. Handles quoted fields, "" escapes, CRLF and a BOM.
export function* csvRecords(text) {
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < n) {
    const row = [];
    for (;;) {
      let field = '';
      if (text.charCodeAt(i) === 34 /* " */) {
        i++;
        for (;;) {
          const q = text.indexOf('"', i);
          if (q < 0) { field += text.slice(i); i = n; break; }
          field += text.slice(i, q);
          i = q + 1;
          if (text.charCodeAt(i) === 34) { field += '"'; i++; } else break;
        }
      } else {
        let j = i;
        while (j < n) {
          const c = text.charCodeAt(j);
          if (c === 44 || c === 10 || c === 13) break;
          j++;
        }
        field = text.slice(i, j);
        i = j;
      }
      row.push(field);
      if (text.charCodeAt(i) === 44 /* , */) { i++; continue; }
      if (text.charCodeAt(i) === 13) i++;
      if (text.charCodeAt(i) === 10) i++;
      break;
    }
    if (row.length === 1 && row[0] === '') continue;
    yield row;
  }
}

// Header plus a lazy row iterator, for large files like stop_times.txt.
export function readCsv(text) {
  const records = csvRecords(text);
  const first = records.next();
  const header = first.done ? [] : first.value.map(h => h.trim());
  return { header, rows: records, col: name => header.indexOf(name) };
}

// Whole file as an array of objects keyed by header, for the small GTFS files.
export function csvObjects(text) {
  const { header, rows } = readCsv(text);
  const out = [];
  for (const r of rows) {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i] ?? ''; });
    out.push(o);
  }
  return out;
}

// "25:10:00" -> 90600. GTFS times may run past 24:00 for trips that end after midnight.
export function gtfsTimeToSeconds(t) {
  if (!t) return null;
  const [h, m, s] = t.trim().split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 3600 + m * 60 + (s || 0) : null;
}

// Calendar date (YYYYMMDD) of `date` as seen in `timeZone`.
export function ymdInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date)
    .replaceAll('-', '');
}

export function addDays(ymd, days) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + days));
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

// Service IDs that run on `ymd`, from calendar.txt rows ({ service_id: { days: [Mon..Sun 0/1], start, end } })
// and calendar_dates.txt exceptions ([date, service_id, 1 added | 2 removed]).
export function servicesOn(ymd, calendar, exceptions = []) {
  const weekday = (new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay() + 6) % 7;
  const running = new Set();
  for (const [id, c] of Object.entries(calendar)) {
    if (c.days[weekday] && c.start <= ymd && ymd <= c.end) running.add(id);
  }
  for (const [date, id, type] of exceptions) {
    if (date !== ymd) continue;
    if (type === 1) running.add(id);
    else running.delete(id);
  }
  return running;
}

// How far `timeZone` is ahead of UTC at `epochMs`, in ms (negative for the Americas).
function zoneOffsetMs(epochMs, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(epochMs).map(p => [p.type, p.value]),
  );
  const wallClockAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return wallClockAsUtc - Math.floor(epochMs / 1000) * 1000;
}

// GTFS stop times count from "noon minus 12 hours" on the service date (local midnight except on
// DST change days). Returns that instant in Unix seconds.
export function serviceDayStart(ymd, timeZone) {
  const noonUtcGuess = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), 12);
  const localNoon = noonUtcGuess - zoneOffsetMs(noonUtcGuess, timeZone);
  return Math.round(localNoon / 1000) - 12 * 3600;
}

const EARTH_RADIUS_M = 6371008.8;
const toRad = d => (d * Math.PI) / 180;

export function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// Initial compass bearing from point 1 to point 2, 0-360 clockwise from north.
export function bearingDegrees(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
