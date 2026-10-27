// The Analytics panel. One period (today, 7 or 30 days) and one route (or all) apply to every tab:
//   Service      trips delivered, missed without notice, and canceled (/api/service, /api/analytics)
//   On time      GPS-timed departures at timepoints, by route or by hour (/api/reliability)
//   Predictions  how close BCT's predicted arrival was, by how far ahead it was made (/api/service)
//   Headways     extra waiting on frequent service from buses arriving unevenly (/api/service)
//   Schedule     running time against the timetable, by route and by trip (/api/service)
//   Speeds       bus speeds and congestion between stops, with a map layer (/api/segments)
//   Bunching     bunching events, each with a replay (/api/analytics)
//   Weather      on-time and running time in dry, rainy and stormy hours (/api/analytics, /api/segments)
// Rows open the route, stop or trip they describe; tables sort by any column; every tab exports CSV.
import { getApiJson } from './api.js';
import { csvTime, downloadCsv } from './csv.js';
import { el, formatDate, formatTime, formatWhen, routeBadge } from './dom.js';
import { verdictLabel } from './panel.js';
import { slowest, SPEED_BANDS, speedFeatures, speedTable } from './speeds.js';

const PERIODS = [[1, 'Today'], [7, '7 days'], [30, '30 days']];
const TABS = [
  ['service', 'Service'], ['ontime', 'On time'], ['predictions', 'Predictions'], ['headways', 'Headways'],
  ['schedule', 'Schedule'], ['speeds', 'Speeds'], ['bunching', 'Bunching'], ['weather', 'Weather'],
];
const SHOW = 15;
const FEW = 20;
const DIRECTIONS = ['outbound', 'inbound'];

// routes: [{ routeId, routeShortName, ... }] in display order. route(routeId) -> route info.
// stopName(id); stop(id) -> { lat, lon, name }; tripInfo(tripId, serviceDate) -> { headsign, start }.
// stopPairRoutes() -> Map "from>to" -> route ids. onStop(id); onTrip(tripId, date); onSpeedMap(GeoJSON
// or null); onCanceled(record, related); onBunching(event). settings: for the 12/24-hour clock.
export function createAnalytics({ routes, route, stopName, stop, tripInfo, stopPairRoutes, onStop, onTrip, onSpeedMap, onCanceled, onBunching, settings }) {
  let days = 7;
  let routeId = null;
  let tab = 'service';
  let data = null; // { analytics, segments, service } for `days`
  let request = 0;
  let speedPeriod = 'all';
  let speedMapOn = false;
  const sorts = {}; // table id -> { key, dir }
  const shown = {}; // list id -> how many rows are shown

  // ---- Frame: period, route, tabs ----------------------------------------------------------------

  const periodBar = el('div', { className: 'segmented', role: 'group', ariaLabel: 'Period' });
  for (const [value, label] of PERIODS) {
    const b = el('button', { type: 'button' }, label);
    b.dataset.days = String(value);
    b.addEventListener('click', () => {
      days = value;
      load();
    });
    periodBar.append(b);
  }
  const routeSelect = el('select', { className: 'text-input', ariaLabel: 'Route' },
    el('option', { value: '' }, 'All routes'),
    ...routes.map(r => el('option', { value: r.routeId }, `${r.routeShortName}  ${r.routeLongName ?? ''}`)));
  routeSelect.addEventListener('change', () => setRoute(routeSelect.value || null));
  const tabBar = el('div', { className: 'an-tabs', role: 'tablist', ariaLabel: 'Analytics' });
  for (const [key, label] of TABS) {
    const b = el('button', { type: 'button', role: 'tab' }, label);
    b.dataset.tab = key;
    b.addEventListener('click', () => {
      tab = key;
      render();
    });
    tabBar.append(b);
  }
  const note = el('p', { className: 'panel-note an-note' });
  const content = el('div', { className: 'an-content' });

  function setRoute(id) {
    routeId = id;
    routeSelect.value = id ?? '';
    render();
  }

  async function load() {
    const ticket = ++request;
    for (const b of periodBar.children) b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days));
    content.replaceChildren(el('p', { className: 'panel-note' }, 'Loading…'));
    const get = path => getApiJson(path).catch(err => ({ error: err.message }));
    const [analytics, segments, service] = await Promise.all([
      get(`/api/analytics?days=${days}`), get(`/api/segments?days=${days}`), get(`/api/service?days=${days}`),
    ]);
    if (ticket !== request) return;
    data = { analytics, segments, service };
    render();
  }

  function render() {
    for (const b of tabBar.children) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    const since = data?.analytics?.collectingSince;
    note.textContent = since ? `Recorded from BCT's live feed since ${formatTime(since)} ${sameDay(since) ? 'today' : formatDate(new Date(since * 1000))}.` : '';
    if (!data) return;
    const renderers = { service: renderService, ontime: renderOnTime, predictions: renderPredictions, headways: renderHeadways, schedule: renderSchedule, speeds: renderSpeeds, bunching: renderBunching, weather: renderWeather };
    const parts = renderers[tab]();
    if (parts) content.replaceChildren(...parts.filter(Boolean));
    if (tab !== 'speeds' && speedMapOn) {
      speedMapOn = false;
      onSpeedMap(null);
    }
  }

  const periodText = () => (days === 1 ? 'today' : `in the last ${days} days`);
  const routeText = () => (routeId ? `route ${route(routeId).routeShortName}` : 'all routes');
  const failed = (what, err) => [el('p', { className: 'empty' }, `Couldn't load ${what}: ${err}`)];
  const head = (title, csv) => el('div', { className: 'an-head' }, el('h3', {}, title), csv);
  // A route badge that narrows every tab to that route.
  const routeLink = id => {
    const b = el('button', { type: 'button', className: 'an-route-link', title: `Show only route ${route(id).routeShortName}` }, routeBadge(route(id)));
    b.addEventListener('click', e => {
      e.stopPropagation();
      setRoute(id);
    });
    return b;
  };
  const stopLink = id => {
    const b = el('button', { type: 'button', className: 'link' }, stopName(id) ?? id);
    b.addEventListener('click', e => {
      e.stopPropagation();
      onStop(id);
    });
    return b;
  };
  const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/New_York' }).replaceAll('-', '');

  // ---- Service delivered -------------------------------------------------------------------------

  function renderService() {
    const s = data.service;
    if (s.error) return failed('service data', s.error);
    const d = s.delivered;
    const rows = routeId ? d.byRoute.filter(r => r.routeId === routeId) : d.byRoute;
    const t = rows.reduce((a, r) => ({ scheduled: a.scheduled + r.scheduled, operated: a.operated + r.operated, canceled: a.canceled + r.canceled, missed: a.missed + r.missed, unknown: a.unknown + r.unknown }), { scheduled: 0, operated: 0, canceled: 0, missed: 0, unknown: 0 });
    const judged = t.scheduled - t.unknown;
    const pct = (n, of) => (of ? `${Math.round((1000 * n) / of) / 10}%` : '–');
    const missed = d.missed.filter(m => !routeId || m.routeId === routeId);
    const missedRows = missed.slice(0, shown.missed ?? SHOW).map(m => {
      const info = tripInfo(m.tripId, m.date);
      const b = el('button', { type: 'button', className: 'an-event an-canceled' },
        el('span', { className: 'an-when' }, formatWhen(m.start)), routeBadge(route(m.routeId)), el('span', {}, info?.headsign ?? m.tripId, el('span', { className: 'status cancel-missed' }, ' · no bus seen, not announced')));
      b.title = 'Open this trip\'s timetable';
      b.addEventListener('click', () => onTrip(m.tripId, m.date));
      return b;
    });
    return [
      head('Service delivered', csvButton(`broward-service-delivered-${days}d.csv`, () => [
        ['route', 'scheduled_trips', 'ran', 'canceled', 'missed_unannounced', 'not_judged', 'delivered_pct'],
        ...d.byRoute.map(r => [route(r.routeId).routeShortName, r.scheduled, r.operated, r.canceled, r.missed, r.unknown, judgedPct(r)]),
      ], d.byRoute.length)),
      // Until the recorder has watched some trips from start to finish, a percentage would mislead.
      t.operated + t.missed > 0
        ? el('p', { className: 'an-stat' }, el('strong', {}, pct(t.operated, judged)), ` of ${judged.toLocaleString('en-US')} scheduled trips ran (${routeText()}, ${periodText()})`)
        : el('p', { className: 'empty' }, 'Not enough recording yet: a trip is judged once the recorder has watched its whole run and it has been over for half an hour.'),
      el('p', { className: 'status' }, `${t.operated.toLocaleString('en-US')} ran · ${t.canceled} canceled · ${t.missed} missed without notice${t.unknown ? ` · ${t.unknown.toLocaleString('en-US')} not judged (the recorder wasn't running for their whole trip)` : ''}`),
      el('p', { className: 'status' }, 'A trip ran if a bus was seen on it, in the vehicle feed or by GPS. "Missed without notice": no bus ever showed and BCT never marked it canceled. Only finished trips count.'),
      serviceLegend(),
      // Day-by-day counts are kept for all routes together.
      !routeId && d.byDate.length > 1 && el('h4', {}, 'By day'),
      !routeId && d.byDate.length > 1 && el('div', { className: 'an-rows' }, ...dayRows(d.byDate)),
      !routeId && el('h4', {}, 'By route (worst first)'),
      !routeId && table('service-routes', [
        { key: 'route', label: 'Route', value: r => route(r.routeId).order ?? 999, render: r => routeBadge(route(r.routeId)) },
        { key: 'delivered', label: 'Ran', num: true, value: r => judgedPct(r) ?? 101, render: r => (judgedPct(r) == null ? '–' : `${judgedPct(r)}%`) },
        { key: 'canceled', label: 'Canceled', num: true, value: r => r.canceled },
        { key: 'missed', label: 'Missed', num: true, value: r => r.missed },
        { key: 'scheduled', label: 'Trips', num: true, value: r => r.scheduled - r.unknown },
      ], d.byRoute, { sort: { key: 'delivered', dir: 1 }, onRow: r => setRoute(r.routeId) }),
      missedRows.length > 0 && el('h4', {}, `Missed without notice (${missed.length})`),
      ...missedRows,
      moreButton('missed', missed.length),
      ...cancellations(),
    ];
  }

  const judgedPct = r => (r.scheduled - r.unknown ? Math.round((1000 * r.operated) / (r.scheduled - r.unknown)) / 10 : null);

  function serviceLegend() {
    return el('div', { className: 'rel-legend an-legend' },
      ...[['ran', 'Ran'], ['canceled', 'Canceled'], ['missed', 'Missed without notice']].map(([k, label]) => el('span', {}, el('span', { className: `rel-swatch svc-${k}` }), label)));
  }

  function dayRows(byDate) {
    return byDate.map(d => {
      const judged = d.scheduled - d.unknown;
      const bar = el('div', { className: 'rel-bar', ariaHidden: 'true' });
      for (const [k, n] of [['ran', d.operated], ['canceled', d.canceled], ['missed', d.missed]]) {
        if (!n) continue;
        const seg = el('span', { className: `rel-seg svc-${k}`, title: `${k}: ${n}` });
        seg.style.flexGrow = String(n);
        bar.append(seg);
      }
      const label = formatDate(new Date(Date.UTC(+d.date.slice(0, 4), +d.date.slice(4, 6) - 1, +d.date.slice(6, 8), 17)));
      return el('div', { className: 'rel-row' }, el('span', { className: 'rel-hour' }, label), judged ? bar : el('span', { className: 'status' }, 'not judged'), el('span', { className: 'rel-pct' }, judged ? `${Math.round((1000 * d.operated) / judged) / 10}%` : ''));
    });
  }

  // Canceled trips (from /api/analytics), each opening its details.
  function cancellations() {
    const c = data.analytics.cancellations;
    if (!c) return [];
    const records = routeId ? c.recent.filter(r => r.routeId === routeId) : c.recent;
    const rows = records.slice(0, shown.canceled ?? SHOW).map(r => {
      const info = tripInfo(r.tripId, r.date);
      const b = el('button', { type: 'button', className: 'an-event an-canceled' },
        el('span', { className: 'an-when' }, info?.start ? formatWhen(info.start) : formatWhen(r.firstSeenAt)), routeBadge(route(r.routeId)),
        el('span', {}, info?.headsign ?? r.tripId, el('span', { className: `status cancel-${r.stopsPassed > 0 ? 'ran' : r.restoredAt != null ? 'restored' : 'missed'}` }, ` · ${verdictLabel(r)}`)));
      b.title = 'Show the details of this canceled trip';
      b.addEventListener('click', () => onCanceled(r, c.recent.filter(x => x.routeId === r.routeId && x.date === r.date)));
      return b;
    });
    return [
      head(`Canceled trips (${records.length})`, csvButton(`broward-cancellations-${days}d.csv`, () => [
        ['service_date', 'route', 'trip_id', 'destination', 'scheduled_start', 'first_marked_canceled', 'last_marked_canceled', 'back_on_schedule', 'buses_assigned', 'stops_seen_by_gps', 'gps_first_seen', 'gps_last_seen', 'bct_predicted_start', 'alerts', 'what_happened'],
        ...records.map(r => {
          const info = tripInfo(r.tripId, r.date);
          return [r.date, route(r.routeId).routeShortName, r.tripId, info?.headsign, csvTime(info?.start), csvTime(r.firstSeenAt), csvTime(r.lastSeenAt), csvTime(r.restoredAt),
            r.vehicles.join(' '), r.stopsPassed, csvTime(r.firstPassAt), csvTime(r.lastPassAt), csvTime(r.predictedStartAt),
            r.alerts.map(a => [a.header, a.description].filter(Boolean).join(': ')).join(' | '), verdictLabel(r)];
        }),
      ], records.length)),
      el('p', { className: 'status' }, 'BCT also marks trips canceled that buses then run, often with a "Delayed" alert: each shows what GPS saw. Click one for the details.'),
      ...rows,
      moreButton('canceled', records.length),
    ];
  }

  // ---- On time -----------------------------------------------------------------------------------

  let onTimeCache = null; // { key, data }
  function renderOnTime() {
    const key = `${days}|${routeId ?? ''}`;
    if (onTimeCache?.key !== key) {
      const ticket = request;
      getApiJson(`/api/reliability?days=${days}${routeId ? `&route=${encodeURIComponent(routeId)}` : ''}`)
        .then(d => ({ key, data: d }), err => ({ key, data: { error: err.message } }))
        .then(result => {
          onTimeCache = result;
          if (ticket === request && tab === 'ontime' && `${days}|${routeId ?? ''}` === key) render();
        });
      return [el('p', { className: 'panel-note' }, 'Loading…')];
    }
    const d = onTimeCache.data;
    if (d.error) return failed('on-time data', d.error);
    const intro = el('p', { className: 'status' }, `Departures from timepoints, timed from bus GPS: on time is no more than 1 minute early or 5 minutes late. ${d.samples.toLocaleString('en-US')} ${d.samples === 1 ? 'departure' : 'departures'}, ${routeText()}, ${periodText()}.`);
    const total = el('div', { className: 'rel-row rel-total' }, el('strong', {}, routeId ? 'All day' : 'All'), stackedBar(d), el('strong', { className: 'rel-pct' }, pct(d)));
    const csv = csvButton(`broward-on-time-${routeId ? route(routeId).routeShortName : 'all'}-${days}d.csv`, () => (routeId
      ? [['hour', 'departures', 'on_time_pct', 'early_pct', 'late_pct', 'mean_delay_s'], ...d.byHour.map(h => [h.hour, h.samples, h.onTimePct, h.earlyPct, h.latePct, h.meanDelayS])]
      : [['route', 'departures', 'on_time_pct', 'early_pct', 'late_pct', 'mean_delay_s'], ...d.routes.map(r => [route(r.routeId).routeShortName, r.samples, r.onTimePct, r.earlyPct, r.latePct, r.meanDelayS])]), d.samples);
    if (!d.samples) return [head('On time', csv), intro, el('p', { className: 'empty' }, 'No departures recorded yet.')];
    const rows = routeId
      ? d.byHour.map(h => el('div', { className: 'rel-row' }, el('span', { className: 'rel-hour' }, hourText(h.hour)), stackedBar(h), el('span', { className: 'rel-pct' }, pct(h))))
      : d.routes.map(r => {
        const b = el('button', { type: 'button', className: 'rel-row' }, routeBadge(route(r.routeId)), stackedBar(r), el('span', { className: 'rel-pct' }, pct(r)));
        b.title = `Route ${route(r.routeId).routeShortName}: ${r.onTimePct}% on time. Click for its hours.`;
        b.addEventListener('click', () => setRoute(r.routeId));
        return b;
      });
    return [head('On time', csv), intro, total, legend(), el('h4', {}, routeId ? 'By hour of departure' : 'By route (click for its hours)'), ...rows];
  }
  const pct = s => (s.samples < FEW ? `${s.onTimePct}%*` : `${s.onTimePct}%`);

  // ---- Predictions -------------------------------------------------------------------------------

  function renderPredictions() {
    const s = data.service;
    if (s.error) return failed('prediction data', s.error);
    const sum = list => {
      const out = s.buckets.map(() => [0, 0, 0, 0, 0]);
      for (const buckets of list) for (const [b, v] of Object.entries(buckets)) v.forEach((x, i) => { out[b][i] += x; });
      return out;
    };
    const routeBuckets = routeId ? [s.predictions.byRoute[routeId] ?? {}] : Object.values(s.predictions.byRoute);
    const buckets = sum(routeBuckets);
    const n = buckets.reduce((a, b) => a + b[0], 0);
    const accuracy = b => (b[0] ? Math.round((1000 * b[2]) / b[0]) / 10 : null);
    const bucketRows = s.buckets.map((info, i) => {
      const b = buckets[i];
      if (!b[0]) return el('div', { className: 'rel-row' }, el('span', { className: 'rel-hour' }, info.label), el('span', { className: 'status' }, 'no data yet'), el('span', {}));
      const p = { earlyPct: Math.round((1000 * b[3]) / b[0]) / 10, onTimePct: accuracy(b), latePct: Math.round((1000 * b[4]) / b[0]) / 10, samples: b[0] };
      const row = el('div', { className: 'rel-row' }, el('span', { className: 'rel-hour' }, info.label), stackedBar(p, ['Bus came early', 'Accurate', 'Bus came late']), el('span', { className: 'rel-pct' }, `${p.onTimePct}%${b[0] < FEW ? '*' : ''}`));
      row.title = `${info.label} ahead: ${p.onTimePct}% accurate, ${p.earlyPct}% bus came more than 1 min early, ${p.latePct}% more than 3 min late; average miss ${Math.round(b[1] / b[0])} s (${b[0]} predictions)`;
      return row;
    });
    const routeRows = Object.entries(s.predictions.byRoute).map(([id, bs]) => {
      const t = sum([bs]);
      const all = t.reduce((a, b) => a.map((x, i) => x + b[i]), [0, 0, 0, 0, 0]);
      return { routeId: id, n: all[0], accuracy: accuracy(all), early: all[0] ? Math.round((1000 * all[3]) / all[0]) / 10 : null, mean: all[0] ? Math.round(all[1] / all[0]) : null, near: accuracy(t[2]) };
    });
    return [
      head('Prediction accuracy', csvButton(`broward-predictions-${routeId ? route(routeId).routeShortName : 'all'}-${days}d.csv`, () => [
        ['how_far_ahead', 'predictions', 'accurate_pct', 'bus_early_pct', 'bus_late_pct', 'mean_miss_s'],
        ...s.buckets.map((info, i) => [info.label, buckets[i][0], accuracy(buckets[i]), buckets[i][0] ? Math.round((1000 * buckets[i][3]) / buckets[i][0]) / 10 : null, buckets[i][0] ? Math.round((1000 * buckets[i][4]) / buckets[i][0]) / 10 : null, buckets[i][0] ? Math.round(buckets[i][1] / buckets[i][0]) : null]),
      ], n)),
      el('p', { className: 'status' }, `BCT's predicted arrival at each timepoint, checked against when GPS saw the bus there. Accurate: the bus came no more than 1 minute before the prediction or 3 minutes after. Early arrivals matter most: riders following the prediction miss the bus. ${n.toLocaleString('en-US')} predictions, ${routeText()}, ${periodText()}.`),
      el('div', { className: 'rel-legend an-legend' }, ...[['early', 'Bus came early'], ['onTime', 'Accurate'], ['late', 'Bus came late']].map(([k, label]) => el('span', {}, el('span', { className: `rel-swatch rel-${k}` }), label))),
      el('h4', {}, 'By how far ahead the prediction was made'),
      ...bucketRows,
      !routeId && routeRows.length > 0 && el('h4', {}, 'By route'),
      !routeId && routeRows.length > 0 && table('prediction-routes', [
        { key: 'route', label: 'Route', value: r => route(r.routeId).order ?? 999, render: r => routeBadge(route(r.routeId)) },
        { key: 'accuracy', label: 'Accurate', num: true, value: r => r.accuracy ?? -1, render: r => (r.accuracy == null ? '–' : `${r.accuracy}%`) },
        { key: 'near', label: '5–10 min', num: true, value: r => r.near ?? -1, render: r => (r.near == null ? '–' : `${r.near}%`) },
        { key: 'early', label: 'Bus early', num: true, value: r => r.early ?? -1, render: r => (r.early == null ? '–' : `${r.early}%`) },
        { key: 'mean', label: 'Avg miss', num: true, value: r => r.mean ?? -1, render: r => (r.mean == null ? '–' : seconds(r.mean)) },
        { key: 'n', label: 'Predictions', num: true, value: r => r.n },
      ], routeRows, { sort: { key: 'accuracy', dir: 1 }, onRow: r => setRoute(r.routeId) }),
    ];
  }

  // ---- Headways ----------------------------------------------------------------------------------

  function renderHeadways() {
    const s = data.service;
    if (s.error) return failed('headway data', s.error);
    const ewt = v => {
      const [n, a, a2, sc, s2] = v;
      if (!n || !a || !sc) return null;
      return { n, actual: a2 / (2 * a), scheduled: s2 / (2 * sc) };
    };
    const merge = list => list.reduce((acc, v) => acc.map((x, i) => x + v[i]), [0, 0, 0, 0, 0]);
    const groups = new Map(); // "route|dir" -> [values by period]
    for (const [k, v] of Object.entries(s.headways.byPeriod)) {
      const [r, d, p] = k.split('|');
      if (routeId && r !== routeId) continue;
      const g = groups.get(`${r}|${d}`) ?? groups.set(`${r}|${d}`, { routeId: r, dir: Number(d), periods: {} }).get(`${r}|${d}`);
      g.periods[p] = v;
    }
    const lines = [...groups.values()].map(g => {
      const w = ewt(merge(Object.values(g.periods)));
      return { ...g, n: w?.n ?? 0, excess: w ? Math.round(w.actual - w.scheduled) : null, actual: w ? Math.round(w.actual) : null, scheduled: w ? Math.round(w.scheduled) : null };
    });
    const intro = el('p', { className: 'status' }, 'On frequent service (timetabled 20 minutes apart or less), riders turn up without checking times. Uneven gaps between buses make their average wait longer than the timetable promises; the extra is "excess wait". Measured at timepoints from GPS.');
    const csv = csvButton(`broward-headways-${days}d.csv`, () => [
      ['route', 'direction', 'stop_id', 'stop', 'headways', 'avg_wait_s', 'timetabled_wait_s', 'excess_wait_s'],
      ...Object.entries(s.headways.byStop).filter(([k]) => !routeId || k.startsWith(`${routeId}|`)).map(([k, v]) => {
        const [r, d, stopId] = k.split('|');
        const w = ewt(v);
        return [route(r).routeShortName, DIRECTIONS[d] ?? d, stopId, stopName(stopId), v[0], w && Math.round(w.actual), w && Math.round(w.scheduled), w && Math.round(w.actual - w.scheduled)];
      }),
    ], Object.keys(s.headways.byStop).length);
    if (!lines.length) return [head('Headways', csv), intro, el('p', { className: 'empty' }, `No frequent service measured for ${routeText()} ${periodText()} yet.`)];
    if (!routeId) {
      return [head('Headways', csv), intro, el('h4', {}, 'Excess wait by route and direction (worst first)'),
        table('headway-routes', [
          { key: 'route', label: 'Route', value: l => route(l.routeId).order ?? 999, render: l => el('span', {}, routeBadge(route(l.routeId)), ` ${DIRECTIONS[l.dir] ?? ''}`) },
          { key: 'excess', label: 'Excess wait', num: true, value: l => l.excess ?? -1, render: l => (l.excess == null ? '–' : signed(l.excess)) },
          { key: 'actual', label: 'Avg wait', num: true, value: l => l.actual ?? -1, render: l => (l.actual == null ? '–' : seconds(l.actual)) },
          { key: 'n', label: 'Gaps', num: true, value: l => l.n },
        ], lines, { sort: { key: 'excess', dir: -1 }, onRow: l => setRoute(l.routeId) })];
    }
    const parts = [head('Headways', csv), intro];
    for (const l of lines.sort((a, b) => a.dir - b.dir)) {
      parts.push(el('h4', {}, `${DIRECTIONS[l.dir] ?? 'Direction'}: ${l.excess == null ? '–' : signed(l.excess)} excess wait (average ${seconds(l.actual)} against ${seconds(l.scheduled)} timetabled)`));
      const periodRows = Object.entries(l.periods).map(([p, v]) => ({ p: Number(p), w: ewt(v) })).filter(x => x.w).sort((a, b) => a.p - b.p);
      parts.push(...periodRows.map(({ p, w }) => el('div', { className: 'an-kv' }, el('span', {}, periodLabel(p)), el('span', { className: excessClass(w.actual - w.scheduled) }, signed(Math.round(w.actual - w.scheduled))), el('span', { className: 'status' }, `${w.n} gaps`))));
      const stopRows = Object.entries(s.headways.byStop).filter(([k]) => k.startsWith(`${l.routeId}|${l.dir}|`)).map(([k, v]) => ({ stopId: k.split('|')[2], w: ewt(v) })).filter(x => x.w);
      parts.push(table(`headway-stops-${l.dir}`, [
        { key: 'stop', label: 'Timepoint', value: x => stopName(x.stopId) ?? x.stopId, render: x => stopLink(x.stopId) },
        { key: 'excess', label: 'Excess', num: true, value: x => x.w.actual - x.w.scheduled, render: x => signed(Math.round(x.w.actual - x.w.scheduled)) },
        { key: 'n', label: 'Gaps', num: true, value: x => x.w.n },
      ], stopRows, { sort: { key: 'excess', dir: -1 } }));
    }
    return parts;
  }

  // ---- Schedule fit ------------------------------------------------------------------------------

  function renderSchedule() {
    const s = data.service;
    if (s.error) return failed('running times', s.error);
    const trips = Object.entries(s.runtime.byTrip).map(([tripId, [r, n, a, sc, over]]) => ({ tripId, routeId: r, n, actual: a / n, scheduled: sc / n, over }));
    const intro = el('p', { className: 'status' }, 'Each trip\'s running time between the first and last timepoints GPS saw it pass (at least 80% of the trip), against the timetable. Trips always over are scheduled too tight; always well under, too loose.');
    const csv = csvButton(`broward-schedule-fit-${days}d.csv`, () => [
      ['route', 'trip_id', 'destination', 'scheduled_start', 'runs', 'mean_running_s', 'timetabled_s', 'difference_s', 'runs_over_by_10pct'],
      ...trips.filter(t => !routeId || t.routeId === routeId).map(t => {
        const info = tripInfo(t.tripId, today());
        return [route(t.routeId).routeShortName, t.tripId, info?.headsign, info?.start ? formatTime(info.start) : '', t.n, Math.round(t.actual), Math.round(t.scheduled), Math.round(t.actual - t.scheduled), t.over];
      }),
    ], trips.length);
    if (!trips.length) return [head('Schedule fit', csv), intro, el('p', { className: 'empty' }, 'No complete trips measured yet.')];
    if (!routeId) {
      const byRoute = new Map();
      for (const t of trips) {
        const r = byRoute.get(t.routeId) ?? byRoute.set(t.routeId, { routeId: t.routeId, n: 0, a: 0, s: 0, over: 0 }).get(t.routeId);
        r.n += t.n;
        r.a += t.actual * t.n;
        r.s += t.scheduled * t.n;
        r.over += t.over;
      }
      const rows = [...byRoute.values()].map(r => ({ ...r, diffPct: Math.round((1000 * (r.a - r.s)) / r.s) / 10, overPct: Math.round((1000 * r.over) / r.n) / 10 }));
      return [head('Schedule fit', csv), intro, el('h4', {}, 'By route (most often over first)'),
        table('schedule-routes', [
          { key: 'route', label: 'Route', value: r => route(r.routeId).order ?? 999, render: r => routeBadge(route(r.routeId)) },
          { key: 'overPct', label: 'Runs 10%+ over', num: true, value: r => r.overPct, render: r => `${r.overPct}%` },
          { key: 'diffPct', label: 'vs timetable', num: true, value: r => r.diffPct, render: r => `${r.diffPct > 0 ? '+' : ''}${r.diffPct}%` },
          { key: 'n', label: 'Runs', num: true, value: r => r.n },
        ], rows, { sort: { key: 'overPct', dir: -1 }, onRow: r => setRoute(r.routeId) })];
    }
    const mine = trips.filter(t => t.routeId === routeId).map(t => ({ ...t, info: tripInfo(t.tripId, today()) }));
    return [head('Schedule fit', csv), intro, el('h4', {}, `Trips on route ${route(routeId).routeShortName} (click for the timetable)`),
      table('schedule-trips', [
        { key: 'start', label: 'Starts', value: t => t.info?.start ?? 0, render: t => (t.info?.start ? formatTime(t.info.start) : '') },
        { key: 'headsign', label: 'To', value: t => t.info?.headsign ?? '', render: t => t.info?.headsign ?? t.tripId },
        { key: 'diff', label: 'vs timetable', num: true, value: t => t.actual - t.scheduled, render: t => el('span', { className: excessClass(t.actual - t.scheduled) }, signed(Math.round(t.actual - t.scheduled))) },
        { key: 'n', label: 'Runs', num: true, value: t => t.n },
      ], mine, { sort: { key: 'start', dir: 1 }, onRow: t => onTrip(t.tripId, null) })];
  }

  // ---- Speeds ------------------------------------------------------------------------------------

  function renderSpeeds() {
    const sd = data.segments;
    if (sd.error) return failed('speeds', sd.error);
    const all = speedTable(sd, { period: speedPeriod, stop, routes: stopPairRoutes() });
    const segments = routeId ? all.segments.filter(s => s.routes.includes(routeId)) : all.segments;
    const runs = segments.reduce((a, s) => a + s.runs, 0);
    const mph = runs ? Math.round((segments.reduce((a, s) => a + s.distanceM * s.runs, 0) / segments.reduce((a, s) => a + s.meanRunS * s.runs, 0)) * 2.23694 * 10) / 10 : null;
    const lost = segments.reduce((a, s) => a + s.lostPerDayS, 0);
    if (speedMapOn) onSpeedMap(speedFeatures(segments));
    const select = el('select', { className: 'text-input', ariaLabel: 'Time of day' },
      el('option', { value: 'all' }, 'All day'),
      ...sd.periods.map(p => el('option', { value: p.key }, `${p.label} (${hourLabel(p.from)}–${hourLabel(p.to % 24)})`)));
    select.value = speedPeriod;
    select.addEventListener('change', () => {
      speedPeriod = select.value;
      render();
    });
    const mapButton = el('button', { type: 'button', className: 'small-button', ariaPressed: String(speedMapOn) }, speedMapOn ? 'Hide from map' : 'Show on map');
    mapButton.addEventListener('click', () => {
      speedMapOn = !speedMapOn;
      if (!speedMapOn) onSpeedMap(null);
      render();
    });
    const stretch = s => {
      const b = el('button', { type: 'button', className: 'link' }, `${s.fromName} → ${s.toName}`);
      b.addEventListener('click', () => onStop(s.from));
      return el('div', {}, b, ' ', el('span', { className: 'badges' }, ...s.routes.slice(0, 4).map(routeLink)));
    };
    const congested = segments.filter(s => s.lostPerDayS > 0).slice(0, shown.congested ?? 10);
    const slow = slowest(segments, shown.slow ?? 10);
    return [
      head('Bus speeds and congestion', csvButton(`broward-bus-speeds-${speedPeriod}-${days}d.csv`, () => [
        ['from_stop_id', 'from_stop', 'to_stop_id', 'to_stop', 'routes', 'runs', 'distance_m', 'mean_run_s', 'mean_timetabled_s', 'mph', 'best_period_mph', 'extra_s_per_run', 'congestion_s_per_day'],
        ...segments.map(s => [s.from, s.fromName, s.to, s.toName, s.routes.map(r => route(r).routeShortName).join(' '), s.runs, s.distanceM, s.meanRunS, s.meanTimetabledS, s.mph, s.baselineMph, s.extraPerRunS, s.lostPerDayS]),
      ], segments.length)),
      el('div', { className: 'panel-tools an-tools' }, select, mapButton),
      speedMapOn && el('div', { className: 'speed-legend' }, el('span', { className: 'status' }, 'Speed:'), ...SPEED_BANDS.map(b => {
        const swatch = el('span', { className: 'speed-swatch' });
        swatch.style.background = b.color;
        return el('span', {}, swatch, b.label);
      })),
      runs
        ? el('p', { className: 'an-stat' }, el('strong', {}, `${mph} mph`), ' average between stops',
          el('span', { className: 'status' }, ` · ${runs.toLocaleString('en-US')} runs · ${Math.round(lost / 60).toLocaleString('en-US')} bus-minutes a day lost to congestion`))
        : el('p', { className: 'empty' }, 'No runs measured for this time of day yet.'),
      el('p', { className: 'status' }, 'Measured from bus GPS: the time from one stop to the next, including stops along the way. Congestion is time over the same stretch at its fastest time of day. Click a stretch to see its first stop, or a route to narrow everything to it.'),
      congested.length > 0 && el('h4', {}, 'Where congestion costs the most time'),
      ...congested.map(s => el('div', { className: 'an-stretch' }, stretch(s), el('div', { className: 'status' }, `${s.mph} mph (${s.baselineMph} at its best) · +${s.extraPerRunS} s a bus · ${minutesText(s.lostPerDayS)} a day`))),
      moreButton('congested', segments.filter(s => s.lostPerDayS > 0).length, 10),
      slow.length > 0 && el('h4', {}, 'Slowest stretches'),
      ...slow.map(s => el('div', { className: 'an-stretch' }, stretch(s), el('div', { className: 'status' }, `${s.mph} mph over ${s.distanceM} m · ${s.runs} runs`))),
      moreButton('slow', segments.filter(s => s.runs >= 3).length, 10),
    ];
  }

  // ---- Bunching ----------------------------------------------------------------------------------

  function renderBunching() {
    const b = data.analytics.bunching;
    if (!b) return failed('bunching', data.analytics.error ?? 'no data');
    const events = routeId ? b.recent.filter(e => e.routeId === routeId) : b.recent;
    const total = routeId ? events.length : b.total;
    const byHour = new Map();
    for (const e of events) {
      const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(e.at * 1000));
      byHour.set(h, (byHour.get(h) ?? 0) + 1);
    }
    const rows = events.slice(0, shown.bunching ?? SHOW).map(e => {
      const label = el('span', {}, stopName(e.stopId) ?? e.stopId, el('span', { className: 'status' }, ` ${minutesText(e.actualS)} apart, timetabled ${minutesText(e.scheduledS)}`),
        el('span', { className: `status ${e.track ? 'replay-tag' : ''}` }, e.track === 'ready' ? ' · ▶ Replay' : e.track === 'recording' ? ' · ▶ Replay (recording)' : ' · no replay'));
      if (!e.track) return el('div', { className: 'an-event' }, el('span', { className: 'an-when' }, formatWhen(e.at)), routeBadge(route(e.routeId)), label);
      const btn = el('button', { type: 'button', className: 'an-event an-canceled' }, el('span', { className: 'an-when' }, formatWhen(e.at)), routeBadge(route(e.routeId)), label);
      btn.title = 'Replay the two buses on the map';
      btn.addEventListener('click', () => onBunching(e));
      return btn;
    });
    return [
      head('Bus bunching', csvButton(`broward-bunching-${days}d.csv`, () => [
        ['time', 'route', 'direction', 'stop_id', 'stop', 'gap_seconds', 'timetabled_gap_seconds', 'leading_trip', 'following_trip'],
        ...events.map(e => [csvTime(e.at), route(e.routeId).routeShortName, e.direction, e.stopId, stopName(e.stopId), e.actualS, e.scheduledS, e.leader, e.follower]),
      ], events.length)),
      el('p', { className: 'an-stat' }, el('strong', {}, total.toLocaleString('en-US')), ` bunching ${total === 1 ? 'event' : 'events'} (${routeText()}, ${periodText()})`, days > 1 && total ? el('span', { className: 'status' }, ` · ${Math.round((total / days) * 10) / 10} a day`) : null),
      el('p', { className: 'status' }, `Two buses on the same route and direction reaching a stop within ${b.rule.maxS / 60} minutes of each other, where the timetable has them ${b.rule.minScheduledS / 60}+ minutes apart. Events marked ▶ replay both buses on the map.`),
      !routeId && b.total > 0 && el('h4', {}, 'By route (click to narrow)'),
      !routeId && b.total > 0 && countRows(b.byRoute.map(r => ({ label: routeBadge(route(r.routeId)), value: r.events, title: `Route ${route(r.routeId).routeShortName}: ${r.events}`, onClick: () => setRoute(r.routeId) }))),
      total > 0 && el('h4', {}, 'By hour of day'),
      total > 0 && hourColumns([...byHour].map(([hour, n]) => ({ hour, events: n }))),
      rows.length > 0 && el('h4', {}, 'Events'),
      ...rows,
      moreButton('bunching', events.length),
    ];
  }

  // ---- Weather -----------------------------------------------------------------------------------

  function renderWeather() {
    const w = data.analytics.weather;
    if (!w || w.error) return failed('weather', w?.error ?? 'no data');
    const rt = Array.isArray(data.segments.weather) ? data.segments.weather : [];
    const rows = w.classes.map(c => {
      const run = rt.find(x => x.wx === c.wx);
      return el('div', { className: 'an-weather' },
        el('div', { className: 'an-weather-name' }, el('strong', {}, c.label), el('span', { className: 'status' }, `${c.hours} h · ${c.samples.toLocaleString('en-US')} departures`)),
        c.samples ? stackedBar(c) : el('div', { className: 'status' }, 'None yet'),
        el('div', { className: 'an-weather-numbers' },
          c.samples ? el('span', {}, `${c.onTimePct}% on time${c.samples < FEW ? '*' : ''}`) : null,
          c.samples ? el('span', { className: 'status' }, `mean ${signedMinutes(c.meanDelayS)}`) : null,
          c.vsDry && el('span', { className: c.vsDry.onTimePts < 0 ? 'late' : 'early' }, `${c.vsDry.onTimePts > 0 ? '+' : ''}${c.vsDry.onTimePts} pts on time vs dry`),
          run?.vsDry && el('span', { className: run.vsDry.indexPts > 0 ? 'late' : 'early' }, `running time ${run.vsDry.indexPts > 0 ? '+' : ''}${run.vsDry.indexPts}% vs dry`)));
    });
    return [
      head('Weather', csvButton(`broward-weather-${days}d.csv`, () => [
        ['weather', 'hours', 'departures', 'on_time_pct', 'early_pct', 'late_pct', 'mean_delay_seconds', 'on_time_pts_vs_dry_same_hours', 'running_time_pct_vs_dry_same_hours'],
        ...w.classes.map(c => [c.label, c.hours, c.samples, c.onTimePct, c.earlyPct, c.latePct, c.meanDelayS, c.vsDry?.onTimePts, rt.find(x => x.wx === c.wx)?.vsDry?.indexPts]),
      ], 1)),
      el('p', { className: 'status' }, 'On time at timepoints (from GPS) and running time between stops, by the weather that hour, all routes. "vs dry" compares with dry weather at the same hours of the day.'),
      legend(), ...rows,
      el('p', { className: 'status' }, `Rain as measured each hour at Broward's four airport weather stations; an hour is as wet as the wettest. Rain = 0.01 in or more, heavy = 0.10 in or more. Showers miss stations, so treat it as a guide.${w.unmatchedSamples ? ` ${w.unmatchedSamples.toLocaleString('en-US')} departures had no weather record yet.` : ''}`),
    ];
  }

  // ---- Building blocks ---------------------------------------------------------------------------

  // A table that sorts by any column (click a heading) and opens a row's subject on click.
  // columns: [{ key, label, num, value(row), render(row) }]. options: { sort, onRow }.
  function table(id, columns, rows, { sort = null, onRow = null } = {}) {
    sorts[id] ??= sort ?? { key: columns[0].key, dir: 1 };
    const { key, dir } = sorts[id];
    const col = columns.find(c => c.key === key) ?? columns[0];
    const sorted = [...rows].sort((a, b) => {
      const x = col.value(a);
      const y = col.value(b);
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
    const headRow = el('tr', {}, ...columns.map(c => {
      const b = el('button', { type: 'button' }, c.label);
      b.addEventListener('click', () => {
        sorts[id] = { key: c.key, dir: sorts[id].key === c.key ? -sorts[id].dir : c.num ? -1 : 1 };
        render();
      });
      const th = el('th', { scope: 'col', className: c.num ? 'num' : '' }, b);
      th.setAttribute('aria-sort', c.key === key ? (dir > 0 ? 'ascending' : 'descending') : 'none');
      return th;
    }));
    const limit = shown[id] ?? 25;
    const body = el('tbody', {}, ...sorted.slice(0, limit).map(r => {
      const tr = el('tr', { tabIndex: onRow ? 0 : -1 }, ...columns.map(c => el('td', { className: c.num ? 'num' : '' }, c.render ? c.render(r) : String(c.value(r)))));
      if (onRow) {
        tr.addEventListener('click', () => onRow(r));
        tr.addEventListener('keydown', e => e.key === 'Enter' && onRow(r));
      } else tr.style.cursor = 'default';
      return tr;
    }));
    return el('div', {}, el('div', { className: 'table-scroll' }, el('table', { className: 'bus-table an-table' }, el('thead', {}, headRow), body)), moreButton(id, rows.length, 25));
  }

  function moreButton(id, total, step = SHOW) {
    const limit = shown[id] ?? step;
    if (total <= limit) return null;
    const b = el('button', { type: 'button', className: 'link an-more' }, `Show all ${total}`);
    b.addEventListener('click', () => {
      shown[id] = Infinity;
      render();
    });
    return b;
  }

  // Horizontal bars, one per row, scaled to the largest; a row with onClick is a button.
  function countRows(rows) {
    const max = Math.max(1, ...rows.map(r => r.value));
    return el('div', { className: 'an-rows' }, ...rows.map(r => {
      const bar = el('span', { className: 'an-bar', title: r.title });
      bar.style.width = `${(100 * r.value) / max}%`;
      const parts = [r.label, el('span', { className: 'an-track' }, bar), el('span', { className: 'an-value' }, String(r.value))];
      if (!r.onClick) return el('div', { className: 'an-row' }, ...parts);
      const b = el('button', { type: 'button', className: 'an-row an-row-button', title: r.title }, ...parts);
      b.addEventListener('click', r.onClick);
      return b;
    }));
  }

  // 24 columns, midnight to 11 PM.
  function hourColumns(byHour) {
    const counts = new Map(byHour.map(h => [h.hour, h.events]));
    const max = Math.max(1, ...counts.values());
    const cols = Array.from({ length: 24 }, (_, hour) => {
      const n = counts.get(hour) ?? 0;
      const col = el('span', { className: 'an-col', title: `${hourLabel(hour)}: ${n}` });
      col.style.height = `${n ? Math.max(4, (100 * n) / max) : 0}%`;
      return el('span', { className: 'an-col-slot' }, col);
    });
    return el('div', { className: 'an-hours' },
      el('div', { className: 'an-cols', role: 'img', ariaLabel: byHour.map(h => `${hourLabel(h.hour)}: ${h.events}`).join(', ') }, ...cols),
      el('div', { className: 'an-axis' }, ...['12 AM', '6 AM', '12 PM', '6 PM'].map(t => el('span', {}, t))));
  }

  function stackedBar(s, labels = ['Early', 'On time', 'Late']) {
    const bar = el('div', { className: 'rel-bar', ariaHidden: 'true' });
    ['early', 'onTime', 'late'].forEach((key, i) => {
      const value = s[`${key}Pct`];
      if (!value) return;
      const seg = el('span', { className: `rel-seg rel-${key}`, title: `${labels[i]}: ${value}%${s.samples ? ` of ${s.samples}` : ''}` });
      seg.style.flexGrow = String(value);
      bar.append(seg);
    });
    return bar;
  }

  function legend() {
    return el('div', { className: 'rel-legend an-legend' },
      ...[['early', 'Early'], ['onTime', 'On time'], ['late', 'Late']].map(([key, label]) => el('span', {}, el('span', { className: `rel-swatch rel-${key}` }), label)),
      el('span', { className: 'muted' }, `* under ${FEW} departures`));
  }

  function csvButton(filename, rows, count) {
    const b = el('button', { type: 'button', className: 'small-button', disabled: !count }, 'CSV');
    b.title = 'Download as CSV';
    b.addEventListener('click', () => downloadCsv(filename, rows()));
    return b;
  }

  const hourText = h => (settings.timeFormat === '24h' ? `${String(h).padStart(2, '0')}:00` : hourLabel(h));

  return {
    node: el('div', { className: 'analytics' }, el('div', { className: 'an-controls' }, periodBar, routeSelect, tabBar), note, content),
    sync: load,
    // Opens a tab, optionally for one route (e.g. from elsewhere in the app).
    show(nextTab, nextRoute = routeId) {
      tab = nextTab;
      setRoute(nextRoute);
    },
  };
}

const sameDay = s => formatDate(new Date(s * 1000)) === formatDate(new Date());
const minutesText = s => (s < 60 ? `${s} s` : `${Math.round(s / 60)} min`);
const seconds = s => (Math.abs(s) < 90 ? `${s} s` : `${Math.round((s / 60) * 10) / 10} min`);
const signed = s => `${s > 0 ? '+' : s < 0 ? '−' : ''}${seconds(Math.abs(s))}`;
const signedMinutes = s => (Math.abs(s) < 60 ? `${s > 0 ? '+' : ''}${s} s` : `${s > 0 ? '+' : '−'}${Math.round((Math.abs(s) / 60) * 10) / 10} min`);
const excessClass = s => (s > 120 ? 'late' : s < -120 ? 'early' : '');
const hourLabel = h => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
const periodLabel = p => ['Night', 'Morning peak', 'Midday', 'Afternoon peak', 'Evening'][p] ?? `Period ${p}`;
