// The Analytics panel: bus speeds and congestion between stops (from GPS; /api/segments), bus
// bunching, schedule adherence in wet and dry weather, and canceled trips (/api/analytics). All are
// recorded by the API every minute (server/segments.mjs, server/analytics.mjs). Each list can be
// downloaded as CSV.
import { getApiJson } from './api.js';
import { csvTime, downloadCsv } from './csv.js';
import { el, formatDate, formatTime, formatWhen, routeBadge } from './dom.js';
import { slowest, SPEED_BANDS, speedFeatures, speedTable } from './speeds.js';

const PERIODS = [[1, 'Today'], [7, '7 days'], [30, '30 days']];
const SHOW_RECENT = 15;
const FEW_SAMPLES = 20;

// route(routeId) -> route info for badges. stopName(stopId). stop(stopId) -> { lat, lon, name }.
// tripInfo(tripId, serviceDate) -> { headsign, start (unix seconds) } or null. stopPairRoutes() ->
// Map of "from>to" -> route ids. onSpeedMap(GeoJSON or null) draws or clears the speed layer.
export function createAnalytics({ route, stopName, stop, tripInfo, stopPairRoutes, onStop, onSpeedMap }) {
  let days = 7;
  let request = 0;
  let speedPeriod = 'all';
  let speedMapOn = false;
  let speedData = null;
  const speedsNode = el('section', { className: 'an-section' });
  const content = el('div', {});
  const periods = el('div', { className: 'segmented', role: 'group', ariaLabel: 'Period' });
  for (const [value, label] of PERIODS) {
    const b = el('button', { type: 'button' }, label);
    b.addEventListener('click', () => {
      days = value;
      load();
    });
    b.dataset.days = String(value);
    periods.append(b);
  }

  async function load() {
    const ticket = ++request;
    for (const b of periods.children) b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days));
    content.replaceChildren(el('p', { className: 'panel-note' }, 'Loading…'));
    try {
      const [data, segments] = await Promise.all([
        getApiJson(`/api/analytics?days=${days}`),
        getApiJson(`/api/segments?days=${days}`).catch(err => ({ error: err.message })),
      ]);
      if (ticket !== request) return;
      speedData = segments;
      renderSpeeds();
      content.replaceChildren(intro(data), speedsNode, bunchingSection(data), weatherSection(data.weather), cancellationSection(data));
    } catch (err) {
      if (ticket === request) content.replaceChildren(el('p', { className: 'empty' }, `Couldn't load analytics: ${err.message}`));
    }
  }

  const periodText = () => (days === 1 ? 'today' : `in the last ${days} days`);

  function intro(data) {
    if (!data.collectingSince) return el('p', { className: 'panel-note' }, 'Recording starts with the next feed update.');
    const since = new Date(data.collectingSince * 1000);
    const day = formatDate(since) === formatDate(new Date()) ? 'today' : formatDate(since);
    return el('p', { className: 'panel-note' }, `Recorded from BCT's live feed since ${formatTime(data.collectingSince)} ${day}.`);
  }

  // ---- Speeds and congestion -------------------------------------------------------------------

  function renderSpeeds() {
    const head = el('div', { className: 'an-head' }, el('h3', {}, 'Bus speeds and congestion'));
    if (!speedData || speedData.error) {
      speedsNode.replaceChildren(head, el('p', { className: 'empty' }, `Couldn't load speeds: ${speedData?.error ?? 'no data'}`));
      return;
    }
    const { segments, totals } = speedTable(speedData, { period: speedPeriod, stop, routes: stopPairRoutes() });
    if (speedMapOn) onSpeedMap(speedFeatures(segments));

    head.append(csvButton(`broward-bus-speeds-${speedPeriod}-${days}d.csv`, () => [
      ['from_stop_id', 'from_stop', 'to_stop_id', 'to_stop', 'routes', 'runs', 'distance_m', 'mean_run_s', 'mean_timetabled_s', 'mph', 'best_period_mph', 'extra_s_per_run', 'congestion_s_per_day'],
      ...segments.map(s => [s.from, s.fromName, s.to, s.toName, s.routes.map(r => route(r).routeShortName).join(' '), s.runs, s.distanceM, s.meanRunS, s.meanTimetabledS, s.mph, s.baselineMph, s.extraPerRunS, s.lostPerDayS]),
    ], segments.length));

    const select = el('select', { className: 'text-input', ariaLabel: 'Time of day' },
      el('option', { value: 'all' }, 'All day'),
      ...speedData.periods.map(p => el('option', { value: p.key }, `${p.label} (${hourLabel(p.from)}–${hourLabel(p.to % 24)})`)));
    select.value = speedPeriod;
    select.addEventListener('change', () => {
      speedPeriod = select.value;
      renderSpeeds();
    });
    const mapButton = el('button', { type: 'button', className: 'small-button', ariaPressed: String(speedMapOn) }, speedMapOn ? 'Hide from map' : 'Show on map');
    mapButton.addEventListener('click', () => {
      speedMapOn = !speedMapOn;
      if (!speedMapOn) onSpeedMap(null);
      renderSpeeds();
    });

    const stretch = s => {
      const b = el('button', { type: 'button', className: 'link' }, `${s.fromName} → ${s.toName}`);
      b.title = 'Show the first stop';
      b.addEventListener('click', () => onStop(s.from));
      return b;
    };
    const badges = s => el('span', { className: 'badges' }, ...s.routes.slice(0, 4).map(r => routeBadge(route(r))));
    const congested = segments.filter(s => s.lostPerDayS > 0).slice(0, 10).map(s => el('div', { className: 'an-stretch' },
      el('div', {}, stretch(s), ' ', badges(s)),
      el('div', { className: 'status' }, `${s.mph} mph (${s.baselineMph} at its best) · +${s.extraPerRunS} s a bus · ${minutes(s.lostPerDayS)} a day`)));
    const slow = slowest(segments).map(s => el('div', { className: 'an-stretch' },
      el('div', {}, stretch(s), ' ', badges(s)),
      el('div', { className: 'status' }, `${s.mph} mph over ${s.distanceM} m · ${s.runs} runs`)));

    const wx = Array.isArray(speedData.weather) ? speedData.weather.filter(w => w.wx !== 'dry') : [];
    // Optional parts are `false` when absent; el() skips those, replaceChildren doesn't.
    speedsNode.replaceChildren(...[head,
      el('div', { className: 'panel-tools an-tools' }, select, mapButton),
      speedMapOn && el('div', { className: 'speed-legend' }, el('span', { className: 'status' }, 'Speed:'), ...SPEED_BANDS.map(b => {
        const swatch = el('span', { className: 'speed-swatch' });
        swatch.style.background = b.color;
        return el('span', {}, swatch, b.label);
      })),
      totals.runs
        ? el('p', { className: 'an-stat' }, el('strong', {}, `${totals.mph} mph`), ' average between stops',
          el('span', { className: 'status' }, ` · ${totals.runs.toLocaleString('en-US')} runs measured · ${Math.round(totals.lostPerDayS / 60).toLocaleString('en-US')} bus-minutes a day lost to congestion`))
        : el('p', { className: 'empty' }, 'No runs measured for this time of day yet.'),
      el('p', { className: 'status' }, 'Measured from bus GPS: the time each bus takes from one stop to the next, including stops along the way. Congestion is time over the same stretch at its fastest time of day.'),
      congested.length > 0 && el('h4', {}, 'Where congestion costs the most time'),
      ...congested,
      slow.length > 0 && el('h4', {}, 'Slowest stretches'),
      ...slow,
      wx.some(w => w.vsDry) && el('h4', {}, 'Running time in wet weather'),
      ...wx.filter(w => w.vsDry).map(w => el('p', { className: 'status' },
        el('strong', {}, w.label), `: ${w.vsDry.indexPts > 0 ? '+' : ''}${w.vsDry.indexPts}% against dry weather at the same hours (${w.vsDry.runs.toLocaleString('en-US')} runs)`)),
    ].filter(Boolean));
  }

  // ---- Bunching --------------------------------------------------------------------------------

  function bunchingSection({ bunching: b }) {
    const rule = `Two buses on the same route and direction reaching a stop within ${b.rule.maxS / 60} minutes of each other, and within a quarter of the gap the timetable plans between them (${b.rule.minScheduledS / 60} minutes or more).`;
    const recent = b.recent.slice(0, SHOW_RECENT).map(e => {
      const stop = el('button', { type: 'button', className: 'link' }, stopName(e.stopId) ?? e.stopId);
      stop.addEventListener('click', () => onStop(e.stopId));
      return el('div', { className: 'an-event' },
        el('span', { className: 'an-when' }, formatWhen(e.at)), routeBadge(route(e.routeId)),
        el('span', {}, stop, el('span', { className: 'status' }, ` ${minutes(e.actualS)} apart, timetabled ${minutes(e.scheduledS)}`)));
    });
    return el('section', { className: 'an-section' },
      el('div', { className: 'an-head' }, el('h3', {}, 'Bus bunching'), csvButton(`broward-bunching-${days}d.csv`, () => [
        ['time', 'route', 'direction', 'stop_id', 'stop', 'gap_seconds', 'timetabled_gap_seconds', 'leading_trip', 'following_trip'],
        ...b.recent.map(e => [csvTime(e.at), route(e.routeId).routeShortName, e.direction, e.stopId, stopName(e.stopId), e.actualS, e.scheduledS, e.leader, e.follower]),
      ], b.recent.length)),
      el('p', { className: 'an-stat' }, el('strong', {}, b.total.toLocaleString('en-US')), ` bunching ${b.total === 1 ? 'event' : 'events'} ${periodText()}`,
        days > 1 && b.total ? el('span', { className: 'status' }, ` · ${Math.round((b.total / days) * 10) / 10} a day`) : null),
      el('p', { className: 'status' }, rule),
      b.total > 0 && el('h4', {}, 'By route'),
      b.total > 0 && countRows(b.byRoute.map(r => ({ label: routeBadge(route(r.routeId)), value: r.events, title: `Route ${route(r.routeId).routeShortName}: ${r.events}` }))),
      b.total > 0 && el('h4', {}, 'By hour of day'),
      b.total > 0 && hourColumns(b.byHour),
      recent.length > 0 && el('h4', {}, 'Latest'),
      ...recent,
    );
  }

  // ---- Weather ---------------------------------------------------------------------------------

  function weatherSection(w) {
    const head = el('div', { className: 'an-head' }, el('h3', {}, 'Schedule adherence and weather'));
    if (!w || w.error) return el('section', { className: 'an-section' }, head, el('p', { className: 'empty' }, w?.error ?? 'No weather data.'));
    head.append(csvButton(`broward-weather-adherence-${days}d.csv`, () => [
      ['weather', 'hours', 'departures', 'on_time_pct', 'early_pct', 'late_pct', 'mean_delay_seconds', 'on_time_pts_vs_dry_same_hours', 'mean_delay_seconds_vs_dry_same_hours'],
      ...w.classes.map(c => [c.label, c.hours, c.samples, c.onTimePct, c.earlyPct, c.latePct, c.meanDelayS, c.vsDry?.onTimePts, c.vsDry?.meanDelayS]),
    ], 1));
    const rows = w.classes.map(c => el('div', { className: 'an-weather' },
      el('div', { className: 'an-weather-name' }, el('strong', {}, c.label), el('span', { className: 'status' }, `${c.hours} h · ${c.samples.toLocaleString('en-US')} departures`)),
      c.samples ? stackedBar(c) : el('div', { className: 'status' }, 'None yet'),
      c.samples ? el('div', { className: 'an-weather-numbers' },
        el('span', {}, `${c.onTimePct}% on time${c.samples < FEW_SAMPLES ? '*' : ''}`),
        el('span', { className: 'status' }, `mean ${signedMinutes(c.meanDelayS)}`),
        c.vsDry && el('span', { className: c.vsDry.onTimePts < 0 ? 'late' : 'early' }, `${c.vsDry.onTimePts > 0 ? '+' : ''}${c.vsDry.onTimePts} pts vs dry`)) : null,
    ));
    return el('section', { className: 'an-section' }, head,
      el('p', { className: 'status' }, 'On-time share of timepoint departures measured from bus GPS (1 minute early to 5 minutes late), by the weather in Fort Lauderdale that hour. "vs dry" compares with dry weather at the same hours of the day, so rush hours are compared with rush hours.'),
      legend(), ...rows,
      el('p', { className: 'status' }, `Rain as measured each hour at Broward's four airport weather stations (Fort Lauderdale–Hollywood, Fort Lauderdale Executive, North Perry and Pompano Beach); an hour is as wet as the wettest station. Rain = 0.01 in or more, heavy = 0.10 in or more. Showers miss stations, so treat it as a guide, especially with few wet hours.${w.unmatchedSamples ? ` ${w.unmatchedSamples.toLocaleString('en-US')} departures had no weather record.` : ''} * under ${FEW_SAMPLES} departures.`));
  }

  // ---- Cancellations ---------------------------------------------------------------------------

  function cancellationSection({ cancellations: c }) {
    const recent = c.recent.slice(0, SHOW_RECENT).map(e => {
      const info = tripInfo(e.tripId, e.date);
      return el('div', { className: 'an-event' },
        el('span', { className: 'an-when' }, info?.start ? formatWhen(info.start) : formatWhen(e.at)), routeBadge(route(e.routeId)),
        el('span', {}, info?.headsign ?? e.tripId));
    });
    return el('section', { className: 'an-section' },
      el('div', { className: 'an-head' }, el('h3', {}, 'Canceled trips'), csvButton(`broward-cancellations-${days}d.csv`, () => [
        ['service_date', 'route', 'trip_id', 'destination', 'first_seen'],
        ...c.recent.map(e => [e.date, route(e.routeId).routeShortName, e.tripId, tripInfo(e.tripId, e.date)?.headsign, csvTime(e.at)]),
      ], c.recent.length)),
      el('p', { className: 'an-stat' }, el('strong', {}, c.total.toLocaleString('en-US')), ` canceled ${c.total === 1 ? 'trip' : 'trips'} ${periodText()}`),
      el('p', { className: 'status' }, 'Trips BCT\'s feed marks as canceled. Trips that never ran without being marked aren\'t counted.'),
      c.total > 0 && countRows(c.byRoute.map(r => ({ label: routeBadge(route(r.routeId)), value: r.trips, title: `Route ${route(r.routeId).routeShortName}: ${r.trips}` }))),
      recent.length > 0 && el('h4', {}, 'Latest (scheduled start)'),
      ...recent,
    );
  }

  // ---- Small charts ----------------------------------------------------------------------------

  // Horizontal bars, one per row, scaled to the largest; the number beside each bar.
  function countRows(rows) {
    const max = Math.max(1, ...rows.map(r => r.value));
    return el('div', { className: 'an-rows' }, ...rows.map(r => {
      const bar = el('span', { className: 'an-bar', title: r.title });
      bar.style.width = `${(100 * r.value) / max}%`;
      return el('div', { className: 'an-row' }, r.label, el('span', { className: 'an-track' }, bar), el('span', { className: 'an-value' }, String(r.value)));
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

  function stackedBar(s) {
    const bar = el('div', { className: 'rel-bar', ariaHidden: 'true' });
    for (const [key, label] of [['early', 'Early'], ['onTime', 'On time'], ['late', 'Late']]) {
      const pct = s[`${key}Pct`];
      if (!pct) continue;
      const seg = el('span', { className: `rel-seg rel-${key}`, title: `${label}: ${pct}%` });
      seg.style.flexGrow = String(pct);
      bar.append(seg);
    }
    return bar;
  }

  function legend() {
    return el('div', { className: 'rel-legend' },
      ...[['early', 'Early'], ['onTime', 'On time'], ['late', 'Late']].map(([key, label]) => el('span', {}, el('span', { className: `rel-swatch rel-${key}` }), label)));
  }

  function csvButton(filename, rows, count) {
    const b = el('button', { type: 'button', className: 'small-button', disabled: !count }, 'CSV');
    b.title = 'Download as CSV';
    b.addEventListener('click', () => downloadCsv(filename, rows()));
    return b;
  }

  return { node: el('div', { className: 'analytics' }, periods, content), sync: load };
}

const minutes = s => (s < 60 ? `${s} s` : `${Math.round(s / 60)} min`);
const signedMinutes = s => (Math.abs(s) < 60 ? `${s > 0 ? '+' : ''}${s} s` : `${s > 0 ? '+' : '−'}${Math.round(Math.abs(s) / 60 * 10) / 10} min`);
const hourLabel = h => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
