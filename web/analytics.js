// The Analytics panel, for BCT staff: what service was delivered, what went wrong, and what to
// change. One period (today, 7 or 30 days, or a range of dates within the last 30) and one route (or
// all) apply to every tab. Tabs are grouped by who acts on them:
//   Needs attention   what to act on, from every tab, and this week against last (everyone)
//   Service           trips delivered, missed without notice, and canceled (dispatch)
//   On time           GPS-timed departures at timepoints, by hour, route and day (operations)
//   Spacing           excess wait on frequent routes, and bunching with replays (dispatch)
//   Running time      running time against the timetable, where delay builds up, and speeds and
//                     congestion between stops with a map layer (scheduling, planning)
//   Connections       timetabled transfers at hubs, made or missed (scheduling)
//   Rider information how right BCT's predictions were, and the quality of its live feed
// Data: /api/service and /api/analytics for everything, /api/segments for speeds, /api/reliability
// for On time. Rows open the route, stop or trip they describe; tables sort by any column; each
// section exports CSV. Measures with a by-day chart show rain as context.
import { getApiJson } from './api.js';
import { addDays } from './gtfs-util.js';
import { csvTime, downloadCsv } from './csv.js';
import { el, formatDate, formatTime, formatWhen, icon, routeBadge } from './dom.js';
import { sharePct, verdictLabel } from './panel.js';
import { slowest, SPEED_BANDS, speedFeatures, speedTable } from './speeds.js';
import {
  blocksNotRun, chronicTrips, congestionByRiders, gpsUnits, holdingPoints, isContracted, MIN_SAMPLES, ratesDiffer, runtimeAdvice, share,
  sharesDiffer, TARGETS, TARGETS_ARE_PLACEHOLDERS, transferAdvice, versusGoal,
} from './attention.js';

const PERIODS = [[1, 'Today'], [7, '7 days'], [30, '30 days'], ['custom', 'Custom']];
const KEPT_DAYS = 30; // how far back the recorder keeps data (server/range.mjs)
const TABS = [
  ['attention', 'Needs attention'], ['service', 'Service'], ['ontime', 'On time'], ['spacing', 'Spacing'],
  ['runtime', 'Running time'], ['connections', 'Connections'], ['info', 'Rider information'],
];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SHOW = 15;
const FEW = MIN_SAMPLES;
const DIRECTIONS = ['outbound', 'inbound'];

// routes: [{ routeId, routeShortName, ... }] in display order. route(routeId) -> route info.
// stopName(id); stop(id) -> { lat, lon, name }; tripInfo(tripId, serviceDate) -> { headsign, start, end,
// stops, routeId, dir, block, startSecs (seconds into the service day) }.
// stopPairRoutes() -> Map "from>to" -> route ids. ridership() -> the week of boardings
// (web/ridership.json) or null. onStop(id); onTrip(tripId, date); onSpeedMap(GeoJSON or null);
// onCanceled(record, related); onBunching(event). settings: for the 12/24-hour clock.
export function createAnalytics({ routes, route, stopName, stop, tripInfo, stopPairRoutes, ridership, onStop, onTrip, onSpeedMap, onCanceled, onBunching, settings }) {
  let days = 7; // how many days the period covers
  let custom = null; // { from, to } (YYYYMMDD) when the viewer picked dates, else null for the last `days`
  let routeId = null;
  let tab = 'attention';
  let data = null; // { analytics, segments, service } for the period
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
    b.addEventListener('click', () => (value === 'custom' ? setRange(custom ?? lastDays(7)) : setDays(value)));
    periodBar.append(b);
  }
  // Custom: two dates within the last KEPT_DAYS days.
  const fromInput = el('input', { type: 'date', className: 'text-input', id: 'an-from', ariaLabel: 'First day' });
  const toInput = el('input', { type: 'date', className: 'text-input', id: 'an-to', ariaLabel: 'Last day' });
  const rangeRow = el('div', { className: 'an-range', hidden: true },
    el('label', { htmlFor: 'an-from' }, 'First day'), el('label', { htmlFor: 'an-to' }, 'Last day'), fromInput, toInput);
  for (const input of [fromInput, toInput]) {
    input.addEventListener('change', () => {
      const from = fromYmdInput(fromInput.value);
      const to = fromYmdInput(toInput.value);
      if (from && to) setRange({ from, to });
    });
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
  // Opens the illustrated guide (web/guide.html) at the open tab's chapter, in the app's theme.
  const helpLink = el('a', { className: 'small-button an-help', target: '_blank', rel: 'noopener', title: 'Help: how to read these numbers (opens the guide)', ariaLabel: 'Help: how to read these numbers' }, icon('help'));
  const note = el('p', { className: 'panel-note an-note' });
  const content = el('div', { className: 'an-content' });

  function setRoute(id) {
    routeId = id;
    routeSelect.value = id ?? '';
    render();
  }

  function setDays(value) {
    days = value;
    custom = null;
    load();
  }

  // Picks a range of dates, put in order and held inside the days the recorder keeps.
  function setRange({ from, to }) {
    const last = today();
    const first = addDays(last, -(KEPT_DAYS - 1));
    if (from > to) [from, to] = [to, from];
    to = to > last ? last : to < first ? first : to;
    from = from < first ? first : from > to ? to : from;
    custom = { from, to };
    days = dayCount(from, to);
    load();
  }

  const lastDays = n => ({ from: addDays(today(), -(n - 1)), to: today() });
  // The period as API query parameters, and as a short tag for file names.
  const query = () => (custom ? `from=${custom.from}&to=${custom.to}` : `days=${days}`);
  const slug = () => (custom ? `${custom.from}-${custom.to}` : `${days}d`);

  async function load() {
    const ticket = ++request;
    for (const b of periodBar.children) b.setAttribute('aria-pressed', String(custom ? b.dataset.days === 'custom' : Number(b.dataset.days) === days));
    rangeRow.hidden = !custom;
    if (custom) {
      fromInput.min = toInput.min = toYmdInput(addDays(today(), -(KEPT_DAYS - 1)));
      fromInput.max = toInput.max = toYmdInput(today());
      fromInput.value = toYmdInput(custom.from);
      toInput.value = toYmdInput(custom.to);
    }
    content.replaceChildren(el('p', { className: 'panel-note' }, 'Loading…'));
    const get = path => getApiJson(path).catch(err => ({ error: err.message }));
    const [analytics, segments, service] = await Promise.all([
      get(`/api/analytics?${query()}`), get(`/api/segments?${query()}`), get(`/api/service?${query()}`),
    ]);
    if (ticket !== request) return;
    data = { analytics, segments, service };
    render();
  }

  function render() {
    for (const b of tabBar.children) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    helpLink.href = `guide.html?theme=${document.documentElement.dataset.theme ?? 'day'}#${tab}`;
    const since = data?.analytics?.collectingSince;
    note.textContent = since ? `Recorded from BCT's live feed since ${formatTime(since)} ${sameDay(since) ? 'today' : formatDate(new Date(since * 1000))}.` : '';
    if (!data) return;
    // A tab is one or more sections, one after another.
    const renderers = {
      attention: [renderAttention], service: [renderService], ontime: [renderOnTime, onTimeByDay], spacing: [renderHeadways, renderBunching],
      runtime: [renderSchedule, renderSpeeds], connections: [renderTransfers], info: [renderPredictions, renderFeed],
    };
    const parts = (renderers[tab] ?? renderers.attention).flatMap(f => f() ?? []);
    content.replaceChildren(...parts.filter(Boolean));
    if (tab !== 'runtime' && speedMapOn) {
      speedMapOn = false;
      onSpeedMap(null);
    }
  }

  const periodText = () => (custom
    ? (custom.from === custom.to ? `on ${dateLabel(custom.from)}` : `from ${dateLabel(custom.from)} to ${dateLabel(custom.to)}`)
    : days === 1 ? 'today' : `in the last ${days} days`);
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

  // "±1.2 pts": the 95% range of a share (k of n), so a reader can tell a real difference from noise.
  const plusMinus = (k, n) => {
    const r = share(k, n);
    return r ? el('span', { className: 'status an-pm', title: `95% range: ${r.lo}–${r.hi}%. With ${n.toLocaleString('en-US')} counted, a figure inside this range could be the same performance on another week.` }, ` ±${r.pm} pts`) : null;
  };
  // How a measure stands against its goal (TARGETS in web/attention.js), in words as well as colour.
  const goalChip = (key, value, range = null) => {
    const t = TARGETS[key];
    const status = versusGoal(key, value, range);
    if (!status) return null;
    const goal = `${t.better > 0 ? '≥' : '≤'} ${t.unit === 's' ? seconds(t.goal) : `${t.goal}%`}`;
    const text = { met: 'meets goal', close: 'just short of goal (could be noise)', missed: 'misses goal' }[status];
    return el('span', { className: `an-goal an-goal-${status}`, title: `Goal ${goal}${TARGETS_ARE_PLACEHOLDERS ? ' (a placeholder until BCT\'s own targets are set, in web/attention.js)' : ''}` }, `${status === 'met' ? '✓ ' : ''}${text} ${goal}`);
  };
  // About how many riders board a route's trip starting at that hour on a weekday (fare-box week).
  const ridersAt = (id, hour) => ridership()?.perTrip[id]?.weekday?.[hour] ?? null;
  const ridersPerTrip = id => {
    const hours = (ridership()?.perTrip[id]?.weekday ?? []).filter(x => x != null);
    return hours.length ? hours.reduce((a, b) => a + b, 0) / hours.length : null;
  };
  const clockOf = secs => (secs == null ? '' : formatTime(Date.UTC(2026, 0, 5, 5) / 1000 + secs)); // a winter day: EST, no DST jump
  const blockText = info => (info?.block ? ` · block ${info.block}` : '');
  const tripLabel = (tripId, info = tripInfo(tripId, null)) => `${clockOf(info?.startSecs)} to ${info?.headsign ?? tripId}${blockText(info)}`;
  const contractedNote = id => (isContracted(route(id)?.routeShortName) ? ' · contracted route' : '');

  // ---- Needs attention -----------------------------------------------------------------------------

  // One list of what to act on, from every tab, each item with who runs it and what to change.
  // Everything comes from data the panel already loaded (no extra requests).
  function renderAttention() {
    const s = data.service;
    if (s.error) return failed('service data', s.error);
    const a = data.analytics;
    const mine = id => !routeId || id === routeId;
    const sections = [];
    const item = (title, detail, onClick, tip = '') => {
      const b = el(onClick ? 'button' : 'div', { className: 'an-item', ...(onClick ? { type: 'button' } : {}), title: tip }, el('span', { className: 'an-item-title' }, ...[].concat(title)), el('span', { className: 'status' }, ...[].concat(detail)));
      if (onClick) b.addEventListener('click', onClick);
      return b;
    };
    const openTab = (next, id = routeId) => () => {
      tab = next;
      setRoute(id);
    };
    const emptyLists = new Set();
    const section = (id, title, intro, items) => {
      if (!items.length) {
        emptyLists.add(id);
        return;
      }
      sections.push(el('h4', {}, `${title} (${items.length})`), el('p', { className: 'status' }, intro), ...items.slice(0, shown[id] ?? 5), moreButton(id, items.length, 5));
    };

    // 1. Measures short of their goals.
    const goals = goalStandings().filter(g => g.status !== 'met');
    section('att-goals', 'Short of goal', `Measures for ${routeText()}, ${periodText()}, against their goals${TARGETS_ARE_PLACEHOLDERS ? ' (placeholders until BCT\'s own targets are set)' : ''}. "Could be noise" means the goal is inside the figure's 95% range.`,
      goals.map(g => item([el('strong', {}, g.label), ` ${g.text}`], [goalChip(g.key, g.value, g.range), g.n ? ` · ${g.n.toLocaleString('en-US')} counted` : ''], openTab(TARGETS[g.key].tab))));

    // 2. Blocks with several trips not run: a bus or operator that never went out.
    const notRunTrips = [...(s.delivered.missed ?? []), ...(a.cancellations?.notRun ?? [])].filter(t => mine(t.routeId)).map(t => ({ tripId: t.tripId, date: t.date, routeId: t.routeId }));
    const blocks = blocksNotRun(notRunTrips, id => tripInfo(id, null)?.block);
    section('att-blocks', 'Blocks not run', 'Blocks (the run of trips one bus works) with two or more trips no bus ran on the same day, missed without notice or canceled. Several on one block points at a bus or operator that never went out: a matter for dispatch.',
      blocks.map(b => {
        const riders = b.trips.reduce((t, x) => t + (ridersAt(x.routeId, Math.floor((tripInfo(x.tripId, null)?.startSecs ?? 0) / 3600) % 24) ?? 0), 0);
        return item([`Block ${b.block} · ${dateLabel(b.date)}: `, el('strong', {}, `${b.trips.length} trips not run`)], [...b.routeIds.map(id => routeBadge(route(id))), `${riders ? ` about ${Math.round(riders)} riders` : ''}${b.routeIds.map(contractedNote).find(Boolean) ?? ''}`], () => onTrip(b.trips[0].tripId, b.date));
      }));

    // 3. Trips late or early at most timepoints on most days.
    const chronic = chronicTrips(s.ontimeByTrip).map(c => ({ ...c, info: tripInfo(c.tripId, null) })).filter(c => c.info && mine(c.info.routeId))
      .map(c => ({ ...c, riders: ridersAt(c.info.routeId, Math.floor((c.info.startSecs ?? 0) / 3600) % 24) }))
      .sort((x, y) => (y.riders ?? 0) * y.sharePct - (x.riders ?? 0) * x.sharePct || y.sharePct - x.sharePct);
    section('att-chronic', 'Trips late or early again and again', `Scheduled trips that left half or more of their timepoints 5+ minutes late, or 30% or more 1+ minute early, over at least 3 days (${periodText()}). Early is within the operator's control; repeated lateness usually means the trip's running time or the one before it.`,
      chronic.map(c => item([routeBadge(route(c.info.routeId)), ` ${tripLabel(c.tripId, c.info)}`], [el('strong', { className: c.kind }, `${c.kind} at ${c.sharePct}% of timepoints`), ` · ${c.days} days${c.riders ? ` · about ${Math.round(c.riders)} riders a trip` : ''}${contractedNote(c.info.routeId)}`], () => onTrip(c.tripId, null))));

    // 4. Running times to change.
    const bands = runtimeAdvice(s.runtimeBands).filter(b => mine(b.routeId));
    section('att-runtime', 'Running times to change', 'Route, direction and time-of-day bands where the timetable should allow what 85% of runs take (the usual rule), and that differs by 2+ minutes and 10%+ of the trip.',
      bands.map(b => item([routeBadge(route(b.routeId)), ` ${DIRECTIONS[b.dir] ?? ''}, ${periodLabel(b.period).toLowerCase()}: `, el('strong', { className: b.changeS > 0 ? 'late' : 'early' }, `${b.changeS > 0 ? 'add' : 'cut'} ${Math.round(Math.abs(b.changeS) / 60)} min`)],
        `timetable ${Math.round(b.timetabledS / 60)} min; 85% of ${b.runs} runs took up to ${Math.round(b.p85S / 60)}${contractedNote(b.routeId)}`, openTab('runtime', b.routeId))));

    // 5. Connections worth retiming.
    const hubName = new Map(s.transfers.hubs.map(h => [h.id, h.name]));
    const retime = transferAdvice(s.transfers.slack, { goal: TARGETS.transfers.goal, minTransferMin: s.rules.minTransferS / 60 }).filter(f => !routeId || f.from === routeId || f.to === routeId);
    section('att-transfers', 'Connections to retime', `Timetabled connections at hubs made by fewer than ${TARGETS.transfers.goal}% of riders, and how many minutes later the second bus would have to leave to reach that (from how long riders really had; counted from Nov 3, 2026). Holding a bus delays the riders on it, so weigh both routes.`,
      retime.map(f => item([`${hubName.get(f.hubId) ?? f.hubId}: `, routeBadge(route(f.from)), ' → ', routeBadge(route(f.to)), ` ${f.madePct}% made`], [el('strong', {}, `leave ${f.shiftMin} min later → ${f.madeAfterPct}%`), ` · ${f.tries} tries`], () => {
        hubId = f.hubId;
        openTab('connections')();
      })));

    // 6. Where gaps between buses open (holding points).
    const holds = holdingPoints(s.headways.byStop, s.delays).filter(h => mine(h.routeId));
    section('att-holds', 'Where gaps open on frequent routes', 'The first timepoint along each frequent route where buses arrive unevenly enough to add a minute or more to riders\' average wait. Holding buses to the timetable at the timepoint before usually evens them out.',
      holds.map(h => item([routeBadge(route(h.routeId)), ` ${DIRECTIONS[h.dir] ?? ''}: gaps open by ${stopName(h.stopId) ?? h.stopId}`], [el('strong', { className: 'late' }, `${signed(h.excessS)} excess wait`), h.holdAt ? ` · hold at ${stopName(h.holdAt) ?? h.holdAt}` : ' · from the start of the line', ` · ${h.gaps} gaps`], openTab('spacing', h.routeId))));

    // 7. Congestion, by rider-minutes.
    if (!data.segments.error) {
      const segs = speedTable(data.segments, { period: 'all', stop, routes: stopPairRoutes() }).segments.filter(x => !routeId || x.routes.includes(routeId));
      const worst = (ridership() ? congestionByRiders(segs, ridersPerTrip) : segs.filter(x => x.lostPerDayS > 0)).slice(0, 25);
      section('att-congestion', 'Congestion costing riders the most', 'Stretches where buses lose the most time against their best time of day, weighted by how many riders a bus there carries: candidates for signal priority, queue jumps or bus lanes.',
        worst.map(x => item(`${x.fromName} → ${x.toName}`, [...x.routes.slice(0, 3).map(id => routeBadge(route(id))), ` ${minutesText(x.lostPerDayS)} of bus time a day${x.riderMinutes != null ? ` · about ${x.riderMinutes.toLocaleString('en-US')} rider-minutes` : ''}`], () => onStop(x.from))));
    }

    // 8. GPS units to check.
    if (!routeId) {
      const units = gpsUnits(s.feedVehicle, days);
      const why = { stale: 'stale reports', gaps: 'GPS gaps', vanished: 'vanished mid-trip' };
      section('att-gps', 'GPS units to check', 'Buses whose GPS reports are often stale, keep going silent, or vanish mid-trip: a maintenance ticket, and the reason some of the other figures miss trips.',
        units.map(u => item(`Bus ${u.id}`, [el('strong', {}, u.reasons.map(r => why[r]).join(', ')), ` · ${u.stalePct ?? 0}% stale · ${u.gaps} gaps · vanished ${u.vanished}×`], openTab('info'))));
    }

    const intro = el('p', { className: 'status' }, `What to act on, ${routeText()}, ${periodText()}, drawn from every tab, most important first within each list. Each item opens what it's about.`);
    // Lists built from data recorded only since Nov 3, 2026: say so while they're empty.
    const waiting = [['att-chronic', 'trips late or early again and again (3+ days each)'], ['att-runtime', 'running times to change (10+ runs a band)'], ['att-transfers', 'connections to retime'], ['att-gps', 'GPS units to check']]
      .filter(([id]) => emptyLists.has(id) && (id !== 'att-gps' || !routeId)).map(([, label]) => label);
    const note = waiting.length ? el('p', { className: 'status' }, `Nothing yet in: ${waiting.join('; ')}. Recording for these began on Nov 3, 2026, so they may need a few more days.`) : null;
    // This week against the last, for 14 days or more.
    let weeks = [];
    if (days >= 14) weeks = weekOnWeek(trendRows());
    else {
      const b = el('button', { type: 'button', className: 'link' }, custom ? 'Pick 14 days or more to compare a week with the one before' : 'See 30 days to compare this week with last');
      b.addEventListener('click', () => setDays(30));
      weeks = [b];
    }
    return [head('Needs attention', null), intro, ...weeks, ...(sections.length ? sections : [el('p', { className: 'empty' }, 'Nothing needs attention for this route and period, or not enough has been recorded yet.')]), note];
  }

  // Every measure with a goal, for the period and route: { key, label, value, text, range, n, status }.
  function goalStandings() {
    const s = data.service;
    const out = [];
    const push = (key, value, text, k = null, n = null) => {
      if (value == null) return;
      const range = k != null && n ? share(k, n) : null;
      out.push({ key, label: TARGETS[key].label, value, text, range, n, status: versusGoal(key, value, range) });
    };
    const pctText = (k, n) => `${rate(k, n)}%`;
    // On time, from the daily on-time counts (route -> [departures, early, late, Σ delay]).
    const ot = sumArrays(s.daily.flatMap(d => Object.entries(d.ontime).filter(([id]) => !routeId || id === routeId).map(([, v]) => v)));
    if (ot?.[0]) push('onTime', rate(ot[0] - ot[1] - ot[2], ot[0]), pctText(ot[0] - ot[1] - ot[2], ot[0]), ot[0] - ot[1] - ot[2], ot[0]);
    const del = s.delivered.byRoute.filter(r => !routeId || r.routeId === routeId).reduce((t, r) => [t[0] + r.operated, t[1] + r.scheduled - r.unknown, t[2] + (r.stopsServed ?? 0), t[3] + (r.stops ?? 0)], [0, 0, 0, 0]);
    if (del[1]) push('delivered', rate(del[0], del[1]), pctText(del[0], del[1]), del[0], del[1]);
    if (del[3]) push('stopsServed', rate(del[2], del[3]), pctText(del[2], del[3]), del[2], del[3]);
    const pr = sumArrays(Object.entries(s.predictions.byRoute).filter(([id]) => !routeId || id === routeId).flatMap(([, b]) => Object.values(b)));
    if (pr?.[0]) push('predictions', rate(pr[2], pr[0]), pctText(pr[2], pr[0]), pr[2], pr[0]);
    const tr = sumArrays(Object.values(s.transfers.byHub).flatMap(pairs => Object.entries(pairs).filter(([pair]) => !routeId || pair.split('>').includes(routeId)).map(([, v]) => v)));
    if (tr?.[0]) push('transfers', rate(tr[1], tr[0]), pctText(tr[1], tr[0]), tr[1], tr[0]);
    const hw = sumArrays(Object.entries(s.headways.byPeriod).filter(([k]) => !routeId || k.startsWith(`${routeId}|`)).map(([, v]) => v));
    const excess = hw ? excessOf(hw) : null;
    if (excess != null) push('excessWait', excess, signed(excess));
    if (!routeId) {
      const f = s.feed.byDate.reduce((t, d) => [t[0] + (d.stale ?? 0), t[1] + (d.reports ?? 0), t[2] + (d.timetableOnly ?? 0), t[3] + (d.predictedTrips ?? 0)], [0, 0, 0, 0]);
      if (f[1]) push('staleGps', rate(f[0], f[1]), pctText(f[0], f[1]), f[0], f[1]);
      if (f[3]) push('timetableOnly', rate(f[2], f[3]), pctText(f[2], f[3]), f[2], f[3]);
    }
    return out;
  }

  // ---- Service delivered -------------------------------------------------------------------------

  function renderService() {
    const s = data.service;
    if (s.error) return failed('service data', s.error);
    const d = s.delivered;
    const rows = routeId ? d.byRoute.filter(r => r.routeId === routeId) : d.byRoute;
    const t = rows.reduce((a, r) => { for (const k of Object.keys(a)) a[k] += r[k] ?? 0; return a; }, { scheduled: 0, operated: 0, partial: 0, canceled: 0, missed: 0, unknown: 0, stops: 0, stopsServed: 0, waitN: 0, waitS: 0 });
    const judged = t.scheduled - t.unknown;
    const pct = (n, of) => (of ? `${Math.round((1000 * n) / of) / 10}%` : '–');
    const mine = list => (list ?? []).filter(m => !routeId || m.routeId === routeId);
    const tripRow = (m, note, className) => {
      const info = tripInfo(m.tripId, m.date);
      const b = el('button', { type: 'button', className: 'an-event an-canceled' },
        el('span', { className: 'an-when' }, formatWhen(m.start)), routeBadge(route(m.routeId)), el('span', {}, info?.headsign ?? m.tripId, el('span', { className: `status ${className}` }, `${blockText(info)} · ${note}`)));
      b.title = 'Open this trip\'s timetable';
      b.addEventListener('click', () => onTrip(m.tripId, m.date));
      return b;
    };
    const missed = mine(d.missed);
    const partial = mine(d.partial);
    // Day-by-day bars for all routes or the chosen one, from the first day with a judged trip
    // (days before recording began have nothing to show).
    const allDays = (routeId ? d.byRouteDate?.[routeId] : d.byDate) ?? [];
    const firstJudged = allDays.findIndex(x => x.scheduled > x.unknown);
    const judgedDays = firstJudged < 0 ? [] : allDays.slice(firstJudged);
    const partNote = m => [
      m.notRunStartS >= s.rules.partialS && `first ${Math.round(m.notRunStartS / 60)} min not run`,
      m.notRunEndS >= s.rules.partialS && `last ${Math.round(m.notRunEndS / 60)} min not run`,
    ].filter(Boolean).join(', ');
    return [
      head('Service delivered', csvButton(`broward-service-delivered-${slug()}.csv`, () => [
        ['route', 'scheduled_trips', 'ran_in_full', 'ran_in_part', 'canceled', 'missed_unannounced', 'not_judged', 'ran_in_full_pct', 'stop_visits_promised', 'stop_visits_made', 'trips_not_run_with_a_later_bus', 'extra_wait_s_total'],
        ...d.byRoute.map(r => [route(r.routeId).routeShortName, r.scheduled, r.operated, r.partial ?? 0, r.canceled, r.missed, r.unknown, judgedPct(r), r.stops ?? '', r.stopsServed ?? '', r.waitN ?? '', r.waitS ?? '']),
      ], d.byRoute.length)),
      // Until the recorder has watched some trips from start to finish, a percentage would mislead.
      t.operated + t.partial + t.missed > 0
        ? el('p', { className: 'an-stat' }, el('strong', {}, pct(t.operated, judged)), plusMinus(t.operated, judged), ` of ${judged.toLocaleString('en-US')} scheduled trips ran in full (${routeText()}, ${periodText()}) `, goalChip('delivered', rate(t.operated, judged), share(t.operated, judged)))
        : el('p', { className: 'empty' }, 'Not enough recording yet: a trip is judged once the recorder has watched its whole run and it has been over for half an hour.'),
      t.stops > 0 && el('div', { className: 'an-kv' }, el('span', {}, 'Stops served'), el('strong', {}, `${rate(t.stopsServed, t.stops)}%`), el('span', { className: 'status' }, `of ${t.stops.toLocaleString('en-US')} stop visits promised `, goalChip('stopsServed', rate(t.stopsServed, t.stops), share(t.stopsServed, t.stops)))),
      ...ridersNotRun(missed),
      t.waitN > 0 && el('div', { className: 'an-kv' }, el('span', {}, 'Extra wait from trips not run'), el('strong', {}, `+${seconds(Math.round(t.waitS / t.waitN))}`), el('span', { className: 'status' }, `on average, ${t.waitN} ${t.waitN === 1 ? 'trip' : 'trips'}; ${t.waitS >= 5400 ? `${Math.round(t.waitS / 360) / 10} hours` : minutesText(t.waitS)} in all`)),
      el('p', { className: 'status' }, `${t.operated.toLocaleString('en-US')} in full · ${t.partial} only partly · ${t.canceled} canceled · ${t.missed} missed without notice${t.unknown ? ` · ${t.unknown.toLocaleString('en-US')} not judged (the recorder wasn't running for their whole trip)` : ''}`),
      el('p', { className: 'status' }, `A trip ran if a bus was seen on it, in the vehicle feed or by GPS. Only partly: GPS first saw it ${s.rules.partialS / 60}+ minutes into its timetable, or last saw it ${s.rules.partialS / 60}+ minutes before the end; a bus whose GPS failed looks the same (see Rider information). Missed without notice: no bus ever showed and BCT never marked it canceled. Only finished trips count.`),
      serviceLegend(),
      judgedDays.length > 0 && el('h4', {}, 'By day'),
      judgedDays.length > 0 && el('div', { className: 'an-rows' }, ...dayRows(judgedDays)),
      !routeId && el('h4', {}, 'By route (worst first)'),
      !routeId && table('service-routes', [
        { key: 'route', label: 'Route', value: r => route(r.routeId).order ?? 999, render: r => routeBadge(route(r.routeId)) },
        { key: 'delivered', label: 'In full', num: true, value: r => judgedPct(r) ?? 101, render: r => (judgedPct(r) == null ? '–' : `${judgedPct(r)}%`) },
        { key: 'partial', label: 'Partly', num: true, value: r => r.partial ?? 0 },
        { key: 'stopsServed', label: 'Stops served', num: true, value: r => (r.stops ? r.stopsServed / r.stops : 2), render: r => (r.stops ? `${rate(r.stopsServed, r.stops)}%` : '–') },
        { key: 'wait', label: 'Extra wait', num: true, value: r => (r.waitN ? r.waitS / r.waitN : -1), render: r => (r.waitN ? `+${seconds(Math.round(r.waitS / r.waitN))}` : '–') },
        { key: 'canceled', label: 'Canceled', num: true, value: r => r.canceled },
        { key: 'missed', label: 'Missed', num: true, value: r => r.missed },
        { key: 'scheduled', label: 'Trips', num: true, value: r => r.scheduled - r.unknown },
      ], d.byRoute, { sort: { key: 'delivered', dir: 1 }, onRow: r => setRoute(r.routeId) }),
      partial.length > 0 && el('h4', {}, `Ran only partly (${partial.length})`),
      ...partial.slice(0, shown.partial ?? SHOW).map(m => tripRow(m, partNote(m), '')),
      moreButton('partial', partial.length),
      missed.length > 0 && el('h4', {}, `Missed without notice (${missed.length})`),
      ...missed.slice(0, shown.missed ?? SHOW).map(m => {
        const riders = ridersOnTrip(m.routeId, m.start);
        return tripRow(m, `no bus seen, not announced${riders ? `; about ${Math.round(riders)} riders` : ''}${m.extraWaitS ? `, who waited +${seconds(m.extraWaitS)} for the next bus` : ''}`, 'cancel-missed');
      }),
      moreButton('missed', missed.length),
      ...cancellations(),
    ];
  }

  // Riders on the trips not run (missed without notice, and canceled ones GPS never saw run), and
  // the rider-hours of extra waiting on the missed ones, estimated from the week of boardings.
  function ridersNotRun(missed) {
    if (!ridership()) return [];
    const c = data.analytics.cancellations;
    const canceled = (c?.notRun ?? []).filter(r => !routeId || r.routeId === routeId).map(r => ({ routeId: r.routeId, start: tripInfo(r.tripId, r.date)?.start }));
    let riders = 0;
    let trips = 0;
    let riderWaitS = 0;
    for (const m of [...missed, ...canceled]) {
      const n = ridersOnTrip(m.routeId, m.start);
      if (n == null) continue;
      riders += n;
      trips++;
      if (m.extraWaitS) riderWaitS += n * m.extraWaitS;
    }
    if (!trips) return [];
    return [
      el('div', { className: 'an-kv' }, el('span', {}, 'Riders on trips not run'), el('strong', {}, `about ${Math.round(riders).toLocaleString('en-US')}`), el('span', { className: 'status' }, `on ${trips} ${trips === 1 ? 'trip' : 'trips'} missed or canceled, from a week of boardings`)),
      riderWaitS > 0 && el('div', { className: 'an-kv' }, el('span', {}, 'Riders\' extra waiting'), el('strong', {}, `about ${Math.round(riderWaitS / 3600).toLocaleString('en-US')} h`), el('span', { className: 'status' }, 'rider-hours, on missed trips with a later bus')),
    ];
  }

  // The share of judged trips that ran in full.
  const judgedPct = r => (r.scheduled - r.unknown ? Math.round((1000 * r.operated) / (r.scheduled - r.unknown)) / 10 : null);

  function serviceLegend() {
    return el('div', { className: 'rel-legend an-legend' },
      ...[['ran', 'In full'], ['partial', 'Only partly'], ['canceled', 'Canceled'], ['missed', 'Missed without notice']].map(([k, label]) => el('span', {}, el('span', { className: `rel-swatch svc-${k}` }), label)));
  }

  function dayRows(byDate) {
    return byDate.map(d => {
      const judged = d.scheduled - d.unknown;
      const bar = el('div', { className: 'rel-bar', ariaHidden: 'true' });
      for (const [k, label, n] of [['ran', 'In full', d.operated], ['partial', 'Only partly', d.partial ?? 0], ['canceled', 'Canceled', d.canceled], ['missed', 'Missed', d.missed]]) {
        if (!n) continue;
        const seg = el('span', { className: `rel-seg svc-${k}`, title: `${label}: ${n}` });
        seg.style.flexGrow = String(n);
        bar.append(seg);
      }
      const label = formatDate(new Date(Date.UTC(+d.date.slice(0, 4), +d.date.slice(4, 6) - 1, +d.date.slice(6, 8), 17)));
      return el('div', { className: 'rel-row svc-day' }, el('span', { className: 'rel-hour' }, label), judged ? bar : el('span', { className: 'status' }, 'not judged'), el('span', { className: 'rel-pct' }, judged ? `${Math.round((1000 * d.operated) / judged) / 10}%` : ''));
    });
  }

  // About how many riders a trip carries: the route's average boardings per trip starting that hour,
  // on that kind of day (weekday, Saturday, Sunday), from the week of fare-box data. null without it.
  function ridersOnTrip(routeId, startS) {
    const rides = ridership();
    if (!rides || !startS) return null;
    const when = new Date(startS * 1000);
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(when));
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(when);
    const type = weekday === 'Sat' ? 'saturday' : weekday === 'Sun' ? 'sunday' : 'weekday';
    return rides.perTrip[routeId]?.[type]?.[hour] ?? null;
  }

  // Canceled trips (from /api/analytics), each opening its details. BCT marks many trips canceled
  // that buses then run, so the ones GPS never saw run come first; the rest are counted, with
  // their list folded away.
  function cancellations() {
    const c = data.analytics.cancellations;
    if (!c) return [];
    const mine = list => (routeId ? list.filter(r => r.routeId === routeId) : list);
    // Every record we have, once each (notRun is complete; recent is the newest of both kinds).
    const all = [...new Map([...(c.notRun ?? []), ...c.recent].map(r => [`${r.date}|${r.tripId}`, r])).values()].sort((a, b) => b.firstSeenAt - a.firstSeenAt);
    const records = mine(all);
    const notRun = records.filter(r => r.stopsPassed === 0);
    const ranShown = records.filter(r => r.stopsPassed > 0);
    const counts = routeId ? c.byRoute.find(r => r.routeId === routeId) ?? { trips: 0, ran: 0 } : { trips: c.total, ran: c.ranAnyway };
    // A trip still within its timetabled run (plus half an hour) isn't over yet: say so.
    const stillRunning = (r, info) => (!info?.end || info.end + 1800 < Date.now() / 1000 ? '' : r.stopsPassed > 0 ? ' so far' : ' · still within its run');
    const row = r => {
      const info = tripInfo(r.tripId, r.date);
      const b = el('button', { type: 'button', className: 'an-event an-canceled' },
        el('span', { className: 'an-when' }, info?.start ? formatWhen(info.start) : formatWhen(r.firstSeenAt)), routeBadge(route(r.routeId)),
        el('span', {}, info?.headsign ?? r.tripId, el('span', { className: `status cancel-${r.stopsPassed > 0 ? 'ran' : r.restoredAt != null ? 'restored' : 'missed'}` }, ` · ${verdictLabel(r, info?.stops)}${stillRunning(r, info)}`)));
      b.title = 'Show the details of this canceled trip';
      b.addEventListener('click', () => onCanceled(r, all.filter(x => x.routeId === r.routeId && x.date === r.date)));
      return b;
    };
    const showRan = el('button', { type: 'button', className: 'link an-more' }, `Show these trips${counts.ran > ranShown.length ? ` (the newest ${ranShown.length})` : ''}`);
    showRan.addEventListener('click', () => {
      shown.canceledRan = SHOW;
      render();
    });
    const ranOpen = shown.canceledRan != null;
    return [
      head(`Canceled trips (${counts.trips})`, csvButton(`broward-cancellations-${slug()}.csv`, () => [
        ['service_date', 'route', 'block', 'trip_id', 'destination', 'scheduled_start', 'first_marked_canceled', 'last_marked_canceled', 'back_on_schedule', 'buses_assigned', 'stops_seen_by_gps', 'gps_first_seen', 'gps_last_seen', 'bct_predicted_start', 'alerts', 'what_happened', 'trip_stops', 'pct_of_stops_run'],
        ...records.map(r => {
          const info = tripInfo(r.tripId, r.date);
          return [r.date, route(r.routeId).routeShortName, info?.block ?? '', r.tripId, info?.headsign, csvTime(info?.start), csvTime(r.firstSeenAt), csvTime(r.lastSeenAt), csvTime(r.restoredAt),
            r.vehicles.join(' '), r.stopsPassed, csvTime(r.firstPassAt), csvTime(r.lastPassAt), csvTime(r.predictedStartAt),
            r.alerts.map(a => [a.header, a.description].filter(Boolean).join(': ')).join(' | '), verdictLabel(r, info?.stops), info?.stops, info?.stops ? sharePct(r, info.stops) : ''];
        }),
      ], records.length)),
      el('p', { className: 'status' }, 'Trips BCT\'s feed marked canceled at some point. Most of them a bus ran anyway: BCT often flags late-running trips this way, sometimes for only a few minutes. Click a trip for the details.'),
      el('h4', {}, `Not run (${notRun.length})`),
      notRun.length
        ? el('p', { className: 'status' }, 'Marked canceled, and GPS never saw a bus on them: the cancellations riders really faced.')
        : el('p', { className: 'empty' }, 'None: GPS saw a bus run every trip marked canceled.'),
      ...notRun.slice(0, shown.canceled ?? SHOW).map(row),
      moreButton('canceled', notRun.length),
      counts.ran > 0 && el('h4', {}, `Marked canceled but ran (${counts.ran})`),
      counts.ran > 0 && el('p', { className: 'status' }, `Riders checking BCT's real-time information were told these trips were canceled, but GPS saw a bus run ${counts.ran} of the ${counts.trips}, at least partly. Anyone who trusted the cancellation may have let the bus go, or waited for a later one. Each says how much of its trip was run.`),
      counts.ran > 0 && !ranOpen && showRan,
      ...(ranOpen ? ranShown.slice(0, shown.canceledRan).map(row) : []),
      ranOpen && moreButton('canceledRan', ranShown.length),
    ];
  }

  // ---- On time -----------------------------------------------------------------------------------

  let onTimeCache = null; // { key, data }
  function renderOnTime() {
    const key = `${query()}|${routeId ?? ''}`;
    if (onTimeCache?.key !== key) {
      const ticket = request;
      getApiJson(`/api/reliability?${query()}${routeId ? `&route=${encodeURIComponent(routeId)}` : ''}`)
        .then(d => ({ key, data: d }), err => ({ key, data: { error: err.message } }))
        .then(result => {
          onTimeCache = result;
          if (ticket === request && tab === 'ontime' && `${query()}|${routeId ?? ''}` === key) render();
        });
      return [el('p', { className: 'panel-note' }, 'Loading…')];
    }
    const d = onTimeCache.data;
    if (d.error) return failed('on-time data', d.error);
    const intro = el('p', { className: 'status' }, `Departures from timepoints, timed from bus GPS as the bus pulls away. BCT's rule: 1 minute or more early is early, 5 minutes or more late is late. ${d.samples.toLocaleString('en-US')} ${d.samples === 1 ? 'departure' : 'departures'}, ${routeText()}, ${periodText()}.`);
    const total = el('div', { className: 'rel-row rel-total' }, el('strong', {}, routeId ? 'All day' : 'All'), stackedBar(d), el('strong', { className: 'rel-pct' }, pct(d)));
    const onTimeK = Math.round((d.samples * (d.onTimePct ?? 0)) / 100);
    const againstGoal = d.samples ? el('p', { className: 'status' }, `${d.onTimePct}% on time`, plusMinus(onTimeK, d.samples), ' ', goalChip('onTime', d.onTimePct, share(onTimeK, d.samples))) : null;
    const csv = csvButton(`broward-on-time-${routeId ? route(routeId).routeShortName : 'all'}-${slug()}.csv`, () => (routeId
      ? [['hour', 'departures', 'on_time_pct', 'early_pct', 'late_pct', 'over_10_min_late_pct', 'mean_delay_s', 'mean_lateness_of_late_s'], ...d.byHour.map(h => [h.hour, h.samples, h.onTimePct, h.earlyPct, h.latePct, h.veryLatePct, h.meanDelayS, h.meanLateS])]
      : [['route', 'departures', 'on_time_pct', 'early_pct', 'late_pct', 'over_10_min_late_pct', 'mean_delay_s', 'mean_lateness_of_late_s', 'worst_hour', 'worst_hour_on_time_pct'], ...d.routes.map(r => [route(r.routeId).routeShortName, r.samples, r.onTimePct, r.earlyPct, r.latePct, r.veryLatePct, r.meanDelayS, r.meanLateS, r.worstHour?.hour ?? '', r.worstHour?.onTimePct ?? ''])]), d.samples);
    if (!d.samples) return [head('On time', csv), intro, el('p', { className: 'empty' }, 'No departures recorded yet.')];
    const hourRows = (d.byHour ?? []).map(h => el('div', { className: 'rel-row' }, el('span', { className: 'rel-hour' }, hourText(h.hour)), stackedBar(h), el('span', { className: 'rel-pct' }, pct(h))));
    const routeRows = routeId ? [] : d.routes.map(r => {
      const worst = r.worstHour ? `${hourText(r.worstHour.hour)} ${r.worstHour.onTimePct}%` : '';
      const b = el('button', { type: 'button', className: 'rel-row ot-route' }, routeBadge(route(r.routeId)), stackedBar(r), el('span', { className: 'rel-pct' }, pct(r)), el('span', { className: 'status ot-worst' }, worst));
      b.title = `Route ${route(r.routeId).routeShortName}: ${r.onTimePct}% on time${r.worstHour ? `; worst at ${hourText(r.worstHour.hour)} (${r.worstHour.onTimePct}%)` : ''}. Click for its hours.`;
      b.addEventListener('click', () => setRoute(r.routeId));
      return b;
    });
    // What riders at every stop and at the end of the line saw (from /api/service).
    const sv = data.service.error ? null : data.service;
    const mineOrAll = byRoute => (routeId ? byRoute?.[routeId] : sumArrays(Object.values(byRoute ?? {})));
    const any = sv && mineOrAll(sv.anyStop);
    const arr = sv && mineOrAll(sv.arrival);
    const kv = (label, value, note) => el('div', { className: 'an-kv' }, el('span', {}, label), el('strong', {}, value), el('span', { className: 'status' }, note));
    return [head('On time', csv), intro, total, againstGoal, legend(),
      ...riderWeightedOnTime(d, kv),
      d.latePct != null && kv('More than 10 min late', `${d.veryLatePct}%`, d.meanLateS != null ? `late buses averaged ${signed(d.meanLateS)}` : ''),
      any?.[0] && Object.assign(kv('Left any stop early', `${rate(any[1], any[0])}%`, `of ${any[0].toLocaleString('en-US')} departures, at every stop`), {
        title: 'Every stop riders board at, not just timepoints. Times at ordinary stops are BCT\'s timetable estimates between timepoints, as riders see them in trip planners.',
      }),
      arr?.[0] && kv('Reached the end on time', `${rate(arr[0] - arr[1], arr[0])}%`, `less than 5 min late, of ${arr[0].toLocaleString('en-US')} trips; ${rate(arr[2], arr[0])}% over 10 min late`),
      el('h4', {}, routeId ? 'By hour of departure' : 'By hour of departure, all routes'), ...hourRows,
      !routeId && el('h4', {}, 'By route, with its worst hour (click for its hours)'), ...routeRows];
  }
  const pct = s => (s.samples < FEW ? `${s.onTimePct}%*` : `${s.onTimePct}%`);

  // On time as riders experienced it: each route and hour counted by how many people board then
  // (average over the week of boardings), rather than by how many buses depart.
  function riderWeightedOnTime(d, kv) {
    const rides = ridership();
    if (!rides) return [];
    const weekly = id => {
      const h = rides.routeHours[id];
      if (!h) return null;
      return h.weekday.map((n, i) => (n * rides.days.weekday + h.saturday[i] * rides.days.saturday + h.sunday[i] * rides.days.sunday));
    };
    const cells = routeId
      ? (d.byHour ?? []).map(h => ({ routeId, hour: h.hour, n: h.samples, onTime: (h.onTimePct ?? 0) / 100 }))
      : Object.entries(d.routeHours ?? {}).flatMap(([id, hours]) => Object.entries(hours).map(([hour, [n, early, late]]) => ({ routeId: id, hour: Number(hour), n, onTime: n ? (n - early - late) / n : 0 })));
    let weight = 0;
    let onTime = 0;
    for (const c of cells) {
      const w = weekly(c.routeId)?.[c.hour] ?? 0;
      if (!c.n || !w) continue;
      weight += w;
      onTime += w * c.onTime;
    }
    if (!weight) return [];
    return [Object.assign(kv('On time for riders', `${Math.round((1000 * onTime) / weight) / 10}%`, 'each route and hour counted by how many people board then'), {
      title: `From BCT's fare boxes, ${weekText(rides)}: a late 5 PM bus on a busy route counts for more than a late 6 AM bus on a quiet one.`,
    })];
  }

  // ---- Predictions -------------------------------------------------------------------------------

  function renderPredictions() {
    const s = data.service;
    if (s.error) return failed('prediction data', s.error);
    // Per bucket: [live predictions, Σ |error| s, accurate, bus early, bus late, bus never came,
    // timetable only]. Days recorded before the last two were kept have five numbers.
    const sum = list => {
      const out = s.buckets.map(() => [0, 0, 0, 0, 0, 0, 0]);
      for (const buckets of list) for (const [b, v] of Object.entries(buckets)) v.forEach((x, i) => { out[b][i] += x; });
      return out;
    };
    const routeBuckets = routeId ? [s.predictions.byRoute[routeId] ?? {}] : Object.values(s.predictions.byRoute);
    const buckets = sum(routeBuckets);
    const total = buckets.reduce((a, b) => a.map((x, i) => x + b[i]), [0, 0, 0, 0, 0, 0, 0]);
    const n = total[0];
    const share = (x, b) => (b[0] ? Math.round((1000 * x) / b[0]) / 10 : null);
    const accuracy = b => share(b[2], b);
    const meanMiss = b => (b[0] > b[5] ? Math.round(b[1] / (b[0] - b[5])) : null); // over buses that came
    const bucketRows = s.buckets.map((info, i) => {
      const b = buckets[i];
      if (!b[0]) return el('div', { className: 'rel-row' }, el('span', { className: 'rel-hour' }, info.label), el('span', { className: 'status' }, 'no data yet'), el('span', {}));
      const p = { earlyPct: share(b[3], b), onTimePct: accuracy(b), latePct: share(b[4], b), neverPct: share(b[5], b), samples: b[0] };
      const row = el('div', { className: 'rel-row' }, el('span', { className: 'rel-hour' }, info.label), stackedBar(p, ['Bus came early', 'Accurate', 'Bus came late', 'Bus never came']), el('span', { className: 'rel-pct' }, `${p.onTimePct}%${b[0] < FEW ? '*' : ''}`));
      row.title = `${info.label} ahead: ${p.onTimePct}% accurate, ${p.earlyPct}% bus came more than 1 min early, ${p.latePct}% more than 3 min late${b[5] ? `, ${p.neverPct}% bus never came` : ''}; average miss ${meanMiss(b) ?? '–'} s (${b[0]} predictions${b[6] ? `; ${b[6]} more were only the timetable` : ''})`;
      return row;
    });
    const routeRows = Object.entries(s.predictions.byRoute).map(([id, bs]) => {
      const t = sum([bs]);
      const all = t.reduce((a, b) => a.map((x, i) => x + b[i]), [0, 0, 0, 0, 0, 0, 0]);
      return { routeId: id, n: all[0], accuracy: accuracy(all), early: share(all[3], all), never: all[5], mean: meanMiss(all), near: accuracy(t[2]), timetable: all[6] };
    }).filter(r => r.n || r.timetable);
    const asides = [
      total[5] ? `${total[5].toLocaleString('en-US')} were for buses that never came (BCT canceled the trip after predicting it, and GPS never saw a bus on it); they count as misses.` : '',
      total[6] ? `Another ${total[6].toLocaleString('en-US')} were only the timetable, with no live information, so they aren't graded.` : '',
    ].filter(Boolean).join(' ');
    return [
      head('Prediction accuracy', csvButton(`broward-predictions-${routeId ? route(routeId).routeShortName : 'all'}-${slug()}.csv`, () => [
        ['how_far_ahead', 'predictions', 'accurate_pct', 'bus_early_pct', 'bus_late_pct', 'bus_never_came_pct', 'mean_miss_s', 'timetable_only_not_graded'],
        ...s.buckets.map((info, i) => { const b = buckets[i]; return [info.label, b[0], accuracy(b), share(b[3], b), share(b[4], b), share(b[5], b), meanMiss(b), b[6]]; }),
      ], n)),
      el('p', { className: 'status' }, `BCT's predicted arrival at each timepoint, checked against when GPS saw the bus arrive. Accurate: the bus came no more than 1 minute before the prediction or 3 minutes after. Early arrivals matter most: riders following the prediction miss the bus. ${n.toLocaleString('en-US')} predictions, ${routeText()}, ${periodText()}.${asides ? ` ${asides}` : ''}`),
      n > 0 && el('p', { className: 'an-stat' }, el('strong', {}, `${accuracy(total)}%`), plusMinus(total[2], n), ' accurate overall ', goalChip('predictions', accuracy(total), share(total[2], n))),
      el('div', { className: 'rel-legend an-legend' }, ...[['early', 'Bus came early'], ['onTime', 'Accurate'], ['late', 'Bus came late'], ['never', 'Bus never came']].map(([k, label]) => el('span', {}, el('span', { className: `rel-swatch rel-${k}` }), label))),
      el('h4', {}, 'By how far ahead the prediction was made'),
      ...bucketRows,
      ...dayBars('Accurate by day', trendRows(), r => r.predictions, { n: r => r.predictionsN }),
      !routeId && routeRows.length > 0 && el('h4', {}, 'By route'),
      !routeId && routeRows.length > 0 && table('prediction-routes', [
        { key: 'route', label: 'Route', value: r => route(r.routeId).order ?? 999, render: r => routeBadge(route(r.routeId)) },
        { key: 'accuracy', label: 'Accurate', num: true, value: r => r.accuracy ?? -1, render: r => (r.accuracy == null ? '–' : `${r.accuracy}%`) },
        { key: 'near', label: '5–10 min', num: true, value: r => r.near ?? -1, render: r => (r.near == null ? '–' : `${r.near}%`) },
        { key: 'early', label: 'Bus early', num: true, value: r => r.early ?? -1, render: r => (r.early == null ? '–' : `${r.early}%`) },
        { key: 'never', label: 'Never came', num: true, value: r => r.never, render: r => (r.never ? String(r.never) : '–') },
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
    const csv = csvButton(`broward-headways-${slug()}.csv`, () => [
      ['route', 'direction', 'stop_id', 'stop', 'headways', 'avg_wait_s', 'timetabled_wait_s', 'excess_wait_s'],
      ...Object.entries(s.headways.byStop).filter(([k]) => !routeId || k.startsWith(`${routeId}|`)).map(([k, v]) => {
        const [r, d, stopId] = k.split('|');
        const w = ewt(v);
        return [route(r).routeShortName, DIRECTIONS[d] ?? d, stopId, stopName(stopId), v[0], w && Math.round(w.actual), w && Math.round(w.scheduled), w && Math.round(w.actual - w.scheduled)];
      }),
    ], Object.keys(s.headways.byStop).length);
    if (!lines.length) return [head('Headways', csv), intro, el('p', { className: 'empty' }, `No frequent service measured for ${routeText()} ${periodText()} yet.`)];
    const network = excessOf(merge(lines.flatMap(l => Object.values(l.periods))));
    const overall = network == null ? null : el('p', { className: 'an-stat' }, el('strong', {}, signed(network)), ` excess wait (${routeText()}, ${periodText()}) `, goalChip('excessWait', network));
    const holds = holdingPoints(s.headways.byStop, s.delays);
    const excessDays = dayBars('Excess wait by day', trendRows(), r => r.excess, { fmt: v => signed(v), scale: null });
    if (!routeId) {
      return [head('Headways', csv), intro, overall, ...excessDays, el('h4', {}, 'Excess wait by route and direction (worst first)'),
        table('headway-routes', [
          { key: 'route', label: 'Route', value: l => route(l.routeId).order ?? 999, render: l => el('span', {}, routeBadge(route(l.routeId)), ` ${DIRECTIONS[l.dir] ?? ''}`) },
          { key: 'excess', label: 'Excess wait', num: true, value: l => l.excess ?? -1, render: l => (l.excess == null ? '–' : signed(l.excess)) },
          { key: 'actual', label: 'Avg wait', num: true, value: l => l.actual ?? -1, render: l => (l.actual == null ? '–' : seconds(l.actual)) },
          { key: 'n', label: 'Gaps', num: true, value: l => l.n },
        ], lines, { sort: { key: 'excess', dir: -1 }, onRow: l => setRoute(l.routeId) })];
    }
    const parts = [head('Headways', csv), intro, overall];
    for (const l of lines.sort((a, b) => a.dir - b.dir)) {
      const hold = holds.find(h => h.routeId === l.routeId && h.dir === l.dir);
      parts.push(el('h4', {}, `${DIRECTIONS[l.dir] ?? 'Direction'}: ${l.excess == null ? '–' : signed(l.excess)} excess wait (average ${seconds(l.actual)} against ${seconds(l.scheduled)} timetabled)`));
      const periodRows = Object.entries(l.periods).map(([p, v]) => ({ p: Number(p), w: ewt(v) })).filter(x => x.w).sort((a, b) => a.p - b.p);
      parts.push(...periodRows.map(({ p, w }) => el('div', { className: 'an-kv' }, el('span', {}, periodLabel(p)), el('span', { className: excessClass(w.actual - w.scheduled) }, signed(Math.round(w.actual - w.scheduled))), el('span', { className: 'status' }, `${w.n} gaps`))));
      if (hold) parts.push(el('p', { className: 'status an-advice' }, 'Gaps open by ', stopLink(hold.stopId), ` (${signed(hold.excessS)} excess wait). `, hold.holdAt ? el('span', {}, 'Holding buses to the timetable at ', stopLink(hold.holdAt), ', the timepoint before, would even them out.') : 'It\'s the first timepoint: look at departures from the start of the line.'));
      const allStops = Object.entries(s.headways.byStop).filter(([k]) => k.startsWith(`${l.routeId}|${l.dir}|`)).map(([k, v]) => ({ stopId: k.split('|')[2], w: ewt(v) })).filter(x => x.w);
      const stopRows = allStops.filter(x => x.w.n >= FEW);
      if (allStops.length > stopRows.length) parts.push(el('p', { className: 'status' }, `${allStops.length - stopRows.length} ${allStops.length - stopRows.length === 1 ? 'timepoint' : 'timepoints'} with fewer than ${FEW} gaps left out (too few to tell; they're in the CSV). A longer period adds more.`));
      parts.push(table(`headway-stops-${l.dir}`, [
        { key: 'stop', label: 'Timepoint', value: x => stopName(x.stopId) ?? x.stopId, render: x => stopLink(x.stopId) },
        { key: 'excess', label: 'Excess', num: true, value: x => x.w.actual - x.w.scheduled, render: x => signed(Math.round(x.w.actual - x.w.scheduled)) },
        { key: 'n', label: 'Gaps', num: true, value: x => x.w.n },
      ], stopRows, { sort: { key: 'excess', dir: -1 } }));
    }
    return parts;
  }

  // ---- Transfers ---------------------------------------------------------------------------------

  let hubId = null; // the hub whose connections are open
  function renderTransfers() {
    const s = data.service;
    if (s.error) return failed('transfers', s.error);
    const { hubs, byHub } = s.transfers;
    const touches = pair => !routeId || pair.split('>').includes(routeId);
    const rows = hubs.map(h => {
      const t = [0, 0, 0, 0, 0];
      for (const [pair, v] of Object.entries(byHub[h.id] ?? {})) if (touches(pair)) v.forEach((x, i) => { t[i] += x; });
      return { ...h, n: t[0], madeN: t[1], made: rate(t[1], t[0]), wait: t[1] ? Math.round(t[2] / t[1]) : null, extra: t[4] ? Math.round(t[3] / t[4]) : null };
    }).filter(h => h.n);
    const all = rows.reduce((a, h) => [a[0] + h.n, a[1] + h.madeN], [0, 0]);
    const rules = s.rules;
    const intro = el('p', { className: 'status' }, `At stations served by 3 or more routes: a rider coming in on one route, heading for the next bus the timetable gives them on another (leaving ${rules.minTransferS / 60} to ${rules.maxConnectionWaitS / 60} minutes later). Made: the second bus left at least ${rules.minTransferS / 60} minutes after the first really arrived. Missed, they wait for the bus after.`);
    const csv = csvButton(`broward-transfers-${slug()}.csv`, () => [
      ['hub', 'from_route', 'to_route', 'connections', 'made_pct', 'mean_wait_when_made_s', 'mean_extra_wait_when_missed_s'],
      ...hubs.flatMap(h => Object.entries(byHub[h.id] ?? {}).filter(([pair]) => touches(pair)).map(([pair, v]) => {
        const [from, to] = pair.split('>');
        return [h.name, route(from).routeShortName, route(to).routeShortName, v[0], rate(v[1], v[0]), v[1] ? Math.round(v[2] / v[1]) : null, v[4] ? Math.round(v[3] / v[4]) : null];
      })),
    ], rows.length);
    if (!rows.length) return [head('Transfers', csv), intro, el('p', { className: 'empty' }, `No connections measured for ${routeText()} ${periodText()} yet. Both buses have to be seen at the hub by GPS.`)];
    const hub = rows.find(h => h.id === hubId);
    const transferDays = dayBars('Connections made by day', trendRows(), r => r.transfers, { n: r => r.transfersN });
    const parts = [head('Transfers', csv), intro,
      el('p', { className: 'an-stat' }, el('strong', {}, `${Math.round((1000 * all[1]) / all[0]) / 10}%`), plusMinus(all[1], all[0]), ` of ${all[0].toLocaleString('en-US')} timetabled connections were made (${routeText()}, ${periodText()}) `, goalChip('transfers', rate(all[1], all[0]), share(all[1], all[0])))];
    if (!hub) {
      parts.push(el('h4', {}, 'By hub (worst first; click for its connections)'), table('transfer-hubs', [
        { key: 'name', label: 'Hub', value: h => h.name },
        { key: 'made', label: 'Made', num: true, value: h => h.made, render: h => `${h.made}%${h.n < FEW ? '*' : ''}` },
        { key: 'extra', label: 'Wait if missed', num: true, value: h => h.extra ?? -1, render: h => (h.extra == null ? '–' : `+${seconds(h.extra)}`) },
        { key: 'n', label: 'Connections', num: true, value: h => h.n },
      ], rows, { sort: { key: 'made', dir: 1 }, onRow: h => { hubId = h.id; render(); } }), ...transferDays);
      return parts;
    }
    const back = el('button', { type: 'button', className: 'link' }, '← All hubs');
    back.addEventListener('click', () => { hubId = null; render(); });
    const fixes = new Map(transferAdvice({ [hub.id]: s.transfers.slack?.[hub.id] ?? {} }, { goal: TARGETS.transfers.goal, minTransferMin: rules.minTransferS / 60 }).map(f => [`${f.from}>${f.to}`, f]));
    const allPairs = Object.entries(byHub[hub.id] ?? {}).filter(([pair]) => touches(pair)).map(([pair, v]) => {
      const [from, to] = pair.split('>');
      return { from, to, n: v[0], made: rate(v[1], v[0]), wait: v[1] ? Math.round(v[2] / v[1]) : null, extra: v[4] ? Math.round(v[3] / v[4]) : null, fix: fixes.get(pair) };
    });
    const pairs = allPairs.filter(x => x.n >= FEW);
    parts.push(back, el('h4', {}, `${hub.name}: ${hub.made}% made`), el('div', { className: 'status' }, 'Stops: ', ...hub.stops.flatMap((id, i) => [i ? ', ' : '', stopLink(id)])),
      table('transfer-pairs', [
        { key: 'from', label: 'From', value: p => route(p.from).order ?? 999, render: p => routeLink(p.from) },
        { key: 'to', label: 'To', value: p => route(p.to).order ?? 999, render: p => routeLink(p.to) },
        { key: 'made', label: 'Made', num: true, value: p => p.made, render: p => `${p.made}%${p.n < FEW ? '*' : ''}` },
        { key: 'wait', label: 'Wait', num: true, value: p => p.wait ?? -1, render: p => (p.wait == null ? '–' : seconds(p.wait)) },
        { key: 'extra', label: 'If missed', num: true, value: p => p.extra ?? -1, render: p => (p.extra == null ? '–' : `+${seconds(p.extra)}`) },
        { key: 'fix', label: 'To fix', num: true, value: p => p.fix?.shiftMin ?? 0, render: p => (p.fix ? `+${p.fix.shiftMin} min → ${p.fix.madeAfterPct}%` : '–') },
        { key: 'n', label: 'Tries', num: true, value: p => p.n },
      ], pairs, { sort: { key: 'made', dir: 1 } }),
      el('p', { className: 'status' }, `Wait: average time between the two buses when the connection was made. To fix: how many minutes later the second bus would have to leave for ${TARGETS.transfers.goal}% of riders to make it, from how long riders really had (counted from Nov 3, 2026). Holding a bus delays the riders already on it, so check both routes' loads first.${allPairs.length > pairs.length ? ` ${allPairs.length - pairs.length} pairs with fewer than ${FEW} tries are left out (they're in the CSV).` : ''}`));
    return parts;
  }

  // ---- Schedule fit ------------------------------------------------------------------------------

  function renderSchedule() {
    const s = data.service;
    if (s.error) return failed('running times', s.error);
    const trips = Object.entries(s.runtime.byTrip).map(([tripId, [r, n, a, sc, over, starts = 0, startSum = 0, late = 0]]) =>
      ({ tripId, routeId: r, n, actual: a / n, scheduled: sc / n, over, starts, startDelay: starts ? startSum / starts : null, late }));
    const lateStartMin = s.rules.lateStartS / 60;
    const intro = el('p', { className: 'status' }, `Each trip's running time between the first and last timepoints GPS saw it pass (at least 80% of the trip), against the timetable. Trips always over are scheduled too tight; always well under, too loose. A late start is leaving the first timepoint more than ${lateStartMin} minutes late: that points at layovers and operators, while time lost along the way points at the street.`);
    const csv = csvButton(`broward-schedule-fit-${slug()}.csv`, () => [
      ['route', 'trip_id', 'destination', 'scheduled_start', 'runs', 'mean_running_s', 'timetabled_s', 'difference_s', 'runs_over_by_10pct', 'mean_start_delay_s', 'late_starts'],
      ...trips.filter(t => !routeId || t.routeId === routeId).map(t => {
        const info = tripInfo(t.tripId, today());
        return [route(t.routeId).routeShortName, t.tripId, info?.headsign, info?.start ? formatTime(info.start) : '', t.n, Math.round(t.actual), Math.round(t.scheduled), Math.round(t.actual - t.scheduled), t.over, t.startDelay == null ? '' : Math.round(t.startDelay), t.late];
      }),
    ], trips.length);
    if (!trips.length) return [head('Schedule fit', csv), intro, el('p', { className: 'empty' }, 'No complete trips measured yet.'), ...(routeId ? delayProfile() : [])];
    const byRoute = new Map();
    for (const t of trips) {
      const r = byRoute.get(t.routeId) ?? byRoute.set(t.routeId, { routeId: t.routeId, n: 0, a: 0, s: 0, over: 0, starts: 0, startSum: 0, late: 0 }).get(t.routeId);
      r.n += t.n;
      r.a += t.actual * t.n;
      r.s += t.scheduled * t.n;
      r.over += t.over;
      r.starts += t.starts;
      r.startSum += (t.startDelay ?? 0) * t.starts;
      r.late += t.late;
    }
    const rows = [...byRoute.values()].map(r => ({
      ...r, diffPct: Math.round((1000 * (r.a - r.s)) / r.s) / 10, overPct: Math.round((1000 * r.over) / r.n) / 10,
      latePct: r.starts ? Math.round((1000 * r.late) / r.starts) / 10 : null, startDelay: r.starts ? Math.round(r.startSum / r.starts) : null, lost: Math.round((r.a - r.s) / r.n),
    }));
    const advice = runtimeAdvice(s.runtimeBands);
    if (!routeId) {
      return [head('Schedule fit', csv), intro,
        advice.length > 0 && el('p', { className: 'status an-advice' }, `${advice.length} route, direction and time-of-day ${advice.length === 1 ? 'band needs' : 'bands need'} a running-time change: pick a route to see them, or open Needs attention.`),
        el('h4', {}, 'By route (most often over first)'),
        table('schedule-routes', [
          { key: 'route', label: 'Route', value: r => route(r.routeId).order ?? 999, render: r => routeBadge(route(r.routeId)) },
          { key: 'overPct', label: '10%+ over', num: true, value: r => r.overPct, render: r => `${r.overPct}%` },
          { key: 'diffPct', label: 'vs timetable', num: true, value: r => r.diffPct, render: r => `${r.diffPct > 0 ? '+' : ''}${r.diffPct}%` },
          { key: 'latePct', label: 'Late starts', num: true, value: r => r.latePct ?? -1, render: r => (r.latePct == null ? '–' : `${r.latePct}%`) },
          { key: 'lost', label: 'Lost en route', num: true, value: r => r.lost, render: r => el('span', { className: excessClass(r.lost) }, signed(r.lost)) },
          { key: 'n', label: 'Runs', num: true, value: r => r.n },
        ], rows, { sort: { key: 'overPct', dir: -1 }, onRow: r => setRoute(r.routeId) })];
    }
    const r = rows.find(x => x.routeId === routeId);
    const mine = trips.filter(t => t.routeId === routeId).map(t => ({ ...t, info: tripInfo(t.tripId, today()) }));
    return [head('Schedule fit', csv), intro,
      r && el('div', { className: 'an-kv' }, el('span', {}, 'Late starts'), el('strong', {}, r.latePct == null ? '–' : `${r.latePct}%`), el('span', { className: 'status' }, r.startDelay == null ? '' : `average start ${signed(r.startDelay)}`)),
      r && el('div', { className: 'an-kv' }, el('span', {}, 'Lost along the way'), el('strong', { className: excessClass(r.lost) }, signed(r.lost)), el('span', { className: 'status' }, `a trip, ${r.n} runs`)),
      ...runningTimes(),
      ...delayProfile(),
      el('h4', {}, `Trips on route ${route(routeId).routeShortName} (click for the timetable)`),
      table('schedule-trips', [
        { key: 'start', label: 'Starts', value: t => t.info?.start ?? 0, render: t => (t.info?.start ? formatTime(t.info.start) : '') },
        { key: 'headsign', label: 'To', value: t => t.info?.headsign ?? '', render: t => t.info?.headsign ?? t.tripId },
        { key: 'startDelay', label: 'Left', num: true, value: t => t.startDelay ?? -1e9, render: t => (t.startDelay == null ? '–' : el('span', { className: t.startDelay > s.rules.lateStartS ? 'late' : '' }, signed(Math.round(t.startDelay)))) },
        { key: 'diff', label: 'vs timetable', num: true, value: t => t.actual - t.scheduled, render: t => el('span', { className: excessClass(t.actual - t.scheduled) }, signed(Math.round(t.actual - t.scheduled))) },
        { key: 'n', label: 'Runs', num: true, value: t => t.n },
      ], mine, { sort: { key: 'start', dir: 1 }, onRow: t => onTrip(t.tripId, null) })];
  }

  // Running time the timetable should allow on the selected route, by direction and time of day:
  // enough for 85% of runs, the usual scheduling rule (web/attention.js runtimeAdvice).
  function runningTimes() {
    const bands = Object.entries(data.service.runtimeBands ?? {}).filter(([k]) => k.startsWith(`${routeId}|`)).map(([k, [runs, median, p85, wholeS]]) => {
      const [, dir, period] = k.split('|').map(Number);
      return { dir, period, runs, wholeS, medianS: Math.round(median * wholeS), p85S: Math.round(p85 * wholeS) };
    });
    if (!bands.length) return [];
    const changes = new Map(runtimeAdvice(data.service.runtimeBands).filter(a => a.routeId === routeId).map(a => [`${a.dir}|${a.period}`, a.changeS]));
    const mins = sec => `${Math.round(sec / 60)} min`;
    return [el('h4', {}, 'Running time to allow'),
      table('runtime-bands', [
        { key: 'when', label: 'When', value: b => b.dir * 10 + b.period, render: b => `${periodLabel(b.period)}, ${DIRECTIONS[b.dir] ?? ''}` },
        { key: 'timetabled', label: 'Timetable', num: true, value: b => b.wholeS, render: b => mins(b.wholeS) },
        { key: 'median', label: 'Typical', num: true, value: b => b.medianS, render: b => mins(b.medianS) },
        { key: 'p85', label: '85% within', num: true, value: b => b.p85S, render: b => mins(b.p85S) },
        { key: 'change', label: 'Change', num: true, value: b => changes.get(`${b.dir}|${b.period}`) ?? 0, render: b => {
          const c = changes.get(`${b.dir}|${b.period}`);
          return c == null ? (b.runs < 10 ? 'too few runs' : 'keep') : el('strong', { className: c > 0 ? 'late' : 'early' }, `${c > 0 ? 'add' : 'cut'} ${mins(Math.abs(c))}`);
        } },
        { key: 'runs', label: 'Runs', num: true, value: b => b.runs },
      ], bands, { sort: { key: 'when', dir: 1 } }),
      el('p', { className: 'status' }, 'Whole-trip running time by when trips start. A timetable that allows what 85% of runs take is the usual rule: tighter, and most trips run late; looser, and buses run early or wait at timepoints. Changes under 2 minutes or 10% of the trip are left alone, as is any band with fewer than 10 runs.')];
  }

  // Where along the selected route delay builds up: the average delay at each timepoint, in order.
  function delayProfile() {
    const parts = [];
    for (const dir of [0, 1]) {
      const prefix = `${routeId}|${dir}|`;
      const points = Object.entries(data.service.delays).filter(([k]) => k.startsWith(prefix))
        .map(([k, [n, sum, offset]]) => ({ stopId: k.slice(prefix.length), n, delay: Math.round(sum / n), offset: offset / n }))
        .sort((a, b) => a.offset - b.offset);
      if (!points.length) continue;
      const max = Math.max(60, ...points.map(p => Math.abs(p.delay)));
      parts.push(el('h4', {}, `Where delay builds up: ${DIRECTIONS[dir]}`), el('div', { className: 'an-rows' }, ...points.map((p, i) => {
        const bar = el('span', { className: `an-bar ${p.delay < 0 ? 'an-bar-early' : p.delay > 300 ? 'an-bar-late' : ''}` });
        bar.style.width = `${(100 * Math.abs(p.delay)) / max}%`;
        const change = i ? p.delay - points[i - 1].delay : null;
        const row = el('button', { type: 'button', className: 'an-row an-row-button' }, el('span', { className: 'an-delay-stop' }, stopName(p.stopId) ?? p.stopId), el('span', { className: 'an-track' }, bar), el('span', { className: 'an-value' }, signed(p.delay)));
        row.title = `${stopName(p.stopId) ?? p.stopId}: ${signed(p.delay)} on average${change == null ? '' : ` (${signed(change)} since the timepoint before)`}, ${p.n} buses. Click to open the stop.`;
        row.addEventListener('click', () => onStop(p.stopId));
        return row;
      })));
    }
    if (parts.length) parts.push(el('p', { className: 'status' }, 'Average delay at each timepoint, in route order (timed from GPS). Where the bars jump is where buses lose time.'));
    return parts;
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
    const congested = (ridership() ? congestionByRiders(segments, ridersPerTrip) : segments.filter(s => s.lostPerDayS > 0)).slice(0, shown.congested ?? 10);
    const slow = slowest(segments, shown.slow ?? 10);
    return [
      head('Bus speeds and congestion', csvButton(`broward-bus-speeds-${speedPeriod}-${slug()}.csv`, () => [
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
      congested.length > 0 && el('h4', {}, ridership() ? 'Where congestion costs riders the most time' : 'Where congestion costs the most time'),
      ...congested.map(s => el('div', { className: 'an-stretch' }, stretch(s), el('div', { className: 'status' }, `${s.mph} mph (${s.baselineMph} at its best) · +${s.extraPerRunS} s a bus · ${minutesText(s.lostPerDayS)} a day${s.riderMinutes != null ? ` · about ${s.riderMinutes.toLocaleString('en-US')} rider-minutes a day` : ''}`))),
      ridership() && congested.length > 0 && el('p', { className: 'status' }, 'Rider-minutes: bus time lost times the riders a bus on those routes typically carries (boardings per trip, from the fare-box week), a rough stand-in for how full buses are there. It ranks stretches for signal priority or bus lanes.'),
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
      head('Bus bunching', csvButton(`broward-bunching-${slug()}.csv`, () => [
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
      ...dayBars('Bunching by day', trendRows(), r => r.bunching, { fmt: v => String(v), scale: null }),
    ];
  }

  // ---- By day ------------------------------------------------------------------------------------

  // One row per recorded day, every measure, for the by-day charts and week-on-week: on time,
  // trips in full, predictions, excess wait, transfers, bunching, cancellations, and rain hours.
  function trendRows() {
    const s = data.service;
    if (s.error) return [];
    const a = data.analytics;
    const wet = a.weather?.byDate ?? {};
    const mine = list => (list ?? []).filter(x => x.routeId === routeId);
    return s.daily.map(d => {
      const ot = routeId ? d.ontime[routeId] : sumArrays(Object.values(d.ontime));
      const pr = routeId ? d.pred[routeId] : sumArrays(Object.values(d.pred));
      const del = d.delivered;
      const judged = del.scheduled - del.unknown;
      return {
        date: d.date,
        departures: ot?.[0] ?? 0,
        onTime: ot?.[0] ? rate(ot[0] - ot[1] - ot[2], ot[0]) : null,
        delivered: !routeId && del.operated + (del.partial ?? 0) + del.missed ? rate(del.operated, judged) : null,
        deliveredN: judged,
        predictions: pr?.[0] ? rate(pr[1], pr[0]) : null,
        predictionsN: pr?.[0] ?? 0,
        transfersN: d.transfers[0] ?? 0,
        excess: routeId ? null : excessOf(d.headway),
        transfers: !routeId && d.transfers[0] ? rate(d.transfers[1], d.transfers[0]) : null,
        bunching: routeId ? mine(a.bunching?.recent).filter(e => e.date === d.date).length : a.bunching?.byDate?.[d.date] ?? 0,
        canceled: routeId ? mine(a.cancellations?.recent).filter(c => c.date === d.date).length : a.cancellations?.byDate?.[d.date] ?? 0,
        rain: wet[d.date] ? wet[d.date][0] + wet[d.date][1] : null,
        heavy: wet[d.date]?.[1] ?? 0,
      };
    }).filter(r => r.departures || r.predictions != null || r.delivered != null || r.bunching || r.canceled);
  }

  // A measure day by day, one bar each, with ☂ on days with 2+ hours of rain. value(row) -> number or
  // null. scale: the value of a full bar (null: the largest). n(row): the count behind a share, for *.
  function dayBars(title, rows, value, { fmt = v => `${v}%`, scale = 100, n = null } = {}) {
    const shown = rows.filter(r => value(r) != null);
    if (shown.length < 2) return [];
    const max = scale ?? Math.max(1, ...shown.map(r => Math.abs(value(r))));
    return [el('h4', {}, title), el('div', { className: 'an-rows' }, ...shown.map(r => {
      const v = value(r);
      const bar = el('span', { className: `an-bar${v < 0 ? ' an-bar-early' : ''}` });
      bar.style.width = `${Math.min(100, (100 * Math.abs(v)) / max)}%`;
      const row = el('div', { className: 'an-row an-day' }, el('span', {}, `${dateLabel(r.date)}${r.rain >= 2 ? ' ☂' : ''}`), el('span', { className: 'an-track' }, bar), el('span', { className: 'an-value' }, `${fmt(v)}${n && n(r) < FEW ? '*' : ''}`));
      row.title = `${dateLabel(r.date)}: ${fmt(v)}${r.rain ? ` · ${r.rain} h of rain${r.heavy ? ` (${r.heavy} heavy)` : ''}` : ' · dry'}`;
      return row;
    }))];
  }

  // On time day by day, the worst days with what else happened, and by day of the week.
  function onTimeByDay() {
    const rows = trendRows();
    const parts = [...dayBars('On time by day', rows, r => r.onTime, { n: r => r.departures })];
    const ranked = rows.filter(r => r.departures >= FEW && r.onTime != null).sort((x, y) => x.onTime - y.onTime);
    if (ranked.length >= 3) {
      const avg = key => rows.reduce((t, r) => t + (r[key] ?? 0), 0) / rows.length;
      const [bunchAvg, cancelAvg] = [avg('bunching'), avg('canceled')];
      parts.push(el('h4', {}, 'Worst days, and what else happened'), ...ranked.slice(0, 3).map(r => {
        const causes = [
          r.rain ? `${r.rain} h of rain${r.heavy ? ` (${r.heavy} heavy)` : ''}` : 'dry',
          `${r.canceled} canceled${r.canceled > cancelAvg * 1.5 && r.canceled >= 3 ? ' (high)' : ''}`,
          `${r.bunching} bunching${r.bunching > bunchAvg * 1.5 && r.bunching >= 3 ? ' (high)' : ''}`,
        ];
        return el('div', { className: 'an-kv' }, el('span', {}, dateLabel(r.date)), el('strong', { className: 'late' }, `${r.onTime}%`), el('span', { className: 'status' }, causes.join(' · ')));
      }));
    }
    if (rows.length > 7) {
      const byDay = WEEKDAYS.map((label, i) => ({ label, days: rows.filter(r => weekdayIndex(r.date) === i) }));
      parts.push(el('h4', {}, 'By day of the week'), el('div', { className: 'an-rows' }, ...byDay.filter(d => d.days.length).map(d => {
        const n = d.days.reduce((t, r) => t + r.departures, 0);
        const on = d.days.reduce((t, r) => t + ((r.onTime ?? 0) * r.departures) / 100, 0);
        const p = n ? Math.round((1000 * on) / n) / 10 : null;
        const bar = el('span', { className: 'an-bar' });
        bar.style.width = `${p ?? 0}%`;
        const row = el('div', { className: 'an-row' }, el('span', {}, d.label), el('span', { className: 'an-track' }, bar), el('span', { className: 'an-value' }, p == null ? '–' : `${p}%`));
        row.title = `${d.label}: ${p ?? '–'}% on time over ${d.days.length} ${d.days.length === 1 ? 'day' : 'days'}`;
        return row;
      })));
    }
    if (parts.length) parts.push(el('p', { className: 'status' }, '☂: 2 or more hours of rain that day at Broward\'s airport weather stations.'));
    return parts;
  }

  // The last 7 days against the 7 before, for each measure.
  function weekOnWeek(rows) {
    const end = custom?.to ?? today();
    const last = addDays(end, -6);
    const prev = addDays(end, -13);
    const thisWeek = rows.filter(r => r.date >= last);
    const lastWeek = rows.filter(r => r.date >= prev && r.date < last);
    if (!thisWeek.length || !lastWeek.length) return [el('p', { className: 'status' }, 'Week-on-week comparison needs recording from both of the last two weeks.')];
    const mean = (list, key, weight) => {
      const w = list.filter(r => r[key] != null);
      const total = w.reduce((t, r) => t + (weight ? r[weight] : 1), 0);
      return total ? w.reduce((t, r) => t + r[key] * (weight ? r[weight] : 1), 0) / total : null;
    };
    // [label, key, weight (the count behind a share), better, unit]
    const measures = [
      ['On time', 'onTime', 'departures', 1, '%'], ['Trips ran in full', 'delivered', 'deliveredN', 1, '%'], ['Predictions accurate', 'predictions', 'predictionsN', 1, '%'],
      ['Transfers made', 'transfers', 'transfersN', 1, '%'], ['Excess wait', 'excess', null, -1, 's'], ['Bunching a day', 'bunching', null, -1, ''], ['Canceled a day', 'canceled', null, -1, ''],
    ];
    // Whether a change is more than day-to-day noise: shares by a two-proportion test on the counts
    // behind them, events by their daily rates; excess wait (no count to test) by 30 s or more.
    const pooled = (list, key, weight) => {
      const w = list.filter(r => r[key] != null);
      const n = w.reduce((t, r) => t + (r[weight] ?? 0), 0);
      return [w.reduce((t, r) => t + (r[key] * (r[weight] ?? 0)) / 100, 0), n];
    };
    const real = (key, weight, unit) => {
      if (unit === '%') return sharesDiffer(...pooled(thisWeek, key, weight), ...pooled(lastWeek, key, weight));
      if (unit === 's') return Math.abs(mean(thisWeek, key) - mean(lastWeek, key)) >= 30;
      const total = list => list.reduce((t, r) => t + (r[key] ?? 0), 0);
      return ratesDiffer(total(thisWeek), thisWeek.length, total(lastWeek), lastWeek.length);
    };
    return [el('h4', {}, custom ? 'The range\'s last 7 days against the 7 before' : 'Last 7 days against the 7 before'), ...measures.map(([label, key, weight, better, unit]) => {
      const now = mean(thisWeek, key, weight);
      const before = mean(lastWeek, key, weight);
      if (now == null || before == null) return null;
      const diff = now - before;
      const good = diff * better > 0;
      const fmt = v => (unit === 's' ? seconds(Math.round(v)) : `${Math.round(v * 10) / 10}${unit}`);
      const change = unit === 's' ? signed(Math.round(diff)) : `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${Math.round(Math.abs(diff) * 10) / 10}${unit === '%' ? ' pts' : ''}`;
      const isReal = Math.abs(diff) >= 0.05 && real(key, weight, unit);
      return el('div', { className: 'an-kv' }, el('span', {}, label), el('strong', {}, fmt(now)), el('span', { className: !isReal ? 'status' : good ? 'early' : 'late', title: isReal ? 'More than day-to-day variation explains.' : 'Within normal day-to-day variation: not a real change yet.' }, `${change} (was ${fmt(before)})${isReal ? '' : ' · within normal variation'}`));
    })].filter(Boolean);
  }

  // ---- Feed quality ------------------------------------------------------------------------------

  function renderFeed() {
    const s = data.service;
    if (s.error) return failed('feed quality', s.error);
    const { byDate, byRoute } = s.feed;
    const r = s.rules;
    const dayRows = byDate.filter(d => d.reports || d.predictedTrips);
    const t = dayRows.reduce((acc, d) => { for (const k of Object.keys(acc)) acc[k] += d[k] ?? 0; return acc; }, { reports: 0, stale: 0, gaps: 0, dropouts: 0, predictedTrips: 0, timetableOnly: 0 });
    const routeRows = Object.entries(byRoute).map(([id, [gaps, dropouts, checks, timetable]]) => ({ routeId: id, gaps, dropouts, checks, timetablePct: rate(timetable, checks) }));
    const c = data.analytics.cancellations;
    const csv = csvButton(`broward-feed-quality-${slug()}.csv`, () => [
      ['scope', 'date_or_route', 'gps_reports', 'stale_reports_pct', 'gps_gaps', 'buses_vanished_mid_trip', 'prediction_checks', 'timetable_only_pct'],
      ...dayRows.map(d => ['day', d.date, d.reports, rate(d.stale, d.reports), d.gaps, d.dropouts, d.predictedTrips, rate(d.timetableOnly, d.predictedTrips)]),
      ...routeRows.map(x => ['route', route(x.routeId).routeShortName, '', '', x.gaps, x.dropouts, x.checks, x.timetablePct]),
    ], dayRows.length);
    const intro = el('p', { className: 'status' }, `How well BCT's live feed describes its buses, ${periodText()}: a report to send BCT. Stale: a GPS report more than ${r.staleS / 60} minutes old when the feed was published. Gap: a bus on a trip silent for ${r.gpsGapS / 60}+ minutes. Vanished: GPS lost a bus with ${r.dropoutRemainingS / 60}+ timetabled minutes of its trip left. Timetable only: the prediction for a bus's next stop was exactly the timetable, so it carries no live information.`);
    if (!dayRows.length) return [head('Feed quality', csv), intro, el('p', { className: 'empty' }, 'Nothing recorded yet.')];
    const mineRow = routeId && routeRows.find(x => x.routeId === routeId);
    const kv = (label, value, note) => el('div', { className: 'an-kv' }, el('span', {}, label), el('strong', {}, value), el('span', { className: 'status' }, note));
    return [
      head('Feed quality', csv), intro,
      routeId && el('h4', {}, `Route ${route(routeId).routeShortName}`),
      routeId && (mineRow
        ? el('div', {}, kv('GPS gaps', String(mineRow.gaps), ''), kv('Vanished mid-trip', String(mineRow.dropouts), ''), kv('Timetable-only predictions', mineRow.timetablePct == null ? '–' : `${mineRow.timetablePct}%`, `of ${mineRow.checks.toLocaleString('en-US')} checks`))
        : el('p', { className: 'empty' }, 'Nothing recorded for this route yet.')),
      el('h4', {}, 'All routes'),
      kv('Stale GPS reports', `${rate(t.stale, t.reports) ?? 0}%`, el('span', {}, `of ${t.reports.toLocaleString('en-US')} reports `, goalChip('staleGps', rate(t.stale, t.reports), share(t.stale, t.reports)))),
      kv('GPS gaps', t.gaps.toLocaleString('en-US'), ''),
      kv('Vanished mid-trip', t.dropouts.toLocaleString('en-US'), ''),
      kv('Timetable-only predictions', `${rate(t.timetableOnly, t.predictedTrips) ?? 0}%`, el('span', {}, `of ${t.predictedTrips.toLocaleString('en-US')} checks `, goalChip('timetableOnly', rate(t.timetableOnly, t.predictedTrips), share(t.timetableOnly, t.predictedTrips)))),
      c && kv('Canceled but ran anyway', `${c.ranAnyway} of ${c.total}`, 'trips BCT marked canceled that GPS saw running'),
      dayRows.length > 1 && el('h4', {}, 'By day'),
      dayRows.length > 1 && table('feed-days', [
        { key: 'date', label: 'Day', value: d => d.date, render: d => dateLabel(d.date) },
        { key: 'stale', label: 'Stale', num: true, value: d => rate(d.stale, d.reports) ?? -1, render: d => pctCell(rate(d.stale, d.reports)) },
        { key: 'gaps', label: 'Gaps', num: true, value: d => d.gaps },
        { key: 'dropouts', label: 'Vanished', num: true, value: d => d.dropouts },
        { key: 'timetable', label: 'Timetable only', num: true, value: d => rate(d.timetableOnly, d.predictedTrips) ?? -1, render: d => pctCell(rate(d.timetableOnly, d.predictedTrips)) },
      ], dayRows, { sort: { key: 'date', dir: -1 } }),
      ...gpsUnitList(),
      !routeId && routeRows.length > 0 && el('h4', {}, 'By route (click to narrow)'),
      !routeId && routeRows.length > 0 && table('feed-routes', [
        { key: 'route', label: 'Route', value: x => route(x.routeId).order ?? 999, render: x => routeBadge(route(x.routeId)) },
        { key: 'timetablePct', label: 'Timetable only', num: true, value: x => x.timetablePct ?? -1, render: x => pctCell(x.timetablePct) },
        { key: 'dropouts', label: 'Vanished', num: true, value: x => x.dropouts },
        { key: 'gaps', label: 'Gaps', num: true, value: x => x.gaps },
      ], routeRows, { sort: { key: 'timetablePct', dir: -1 }, onRow: x => setRoute(x.routeId) }),
    ];
  }

  // Buses whose GPS units look faulty (web/attention.js gpsUnits), for maintenance.
  function gpsUnitList() {
    const units = gpsUnits(data.service.feedVehicle, days);
    if (!units.length) return [];
    const why = { stale: 'stale reports', gaps: 'GPS gaps', vanished: 'vanished mid-trip' };
    return [el('h4', {}, `GPS units to check (${units.length})`),
      el('p', { className: 'status' }, `Buses with 10%+ of reports stale, ${2} or more GPS gaps a day, or vanishing mid-trip twice or more, ${periodText()} (counted from Nov 3, 2026).`),
      table('gps-units', [
        { key: 'id', label: 'Bus', value: u => u.id },
        { key: 'stale', label: 'Stale', num: true, value: u => u.stalePct ?? -1, render: u => pctCell(u.stalePct) },
        { key: 'gaps', label: 'Gaps', num: true, value: u => u.gaps },
        { key: 'vanished', label: 'Vanished', num: true, value: u => u.vanished },
        { key: 'why', label: 'Why', value: u => u.reasons.length, render: u => u.reasons.map(r => why[r]).join(', ') },
      ], units, { sort: { key: 'why', dir: -1 } })];
  }

  const pctCell = (p, n = Infinity) => (p == null ? '–' : `${p}%${n < FEW ? '*' : ''}`);

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

  // s: { earlyPct, onTimePct, latePct, neverPct (predictions only), samples }.
  function stackedBar(s, labels = ['Early', 'On time', 'Late']) {
    const bar = el('div', { className: 'rel-bar', ariaHidden: 'true' });
    ['early', 'onTime', 'late', 'never'].forEach((key, i) => {
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
    node: el('div', { className: 'analytics' }, el('div', { className: 'an-controls' }, el('div', { className: 'an-top' }, periodBar, helpLink), rangeRow, routeSelect, tabBar), note, content),
    sync: load,
    // Opens a tab, optionally for one route (e.g. from elsewhere in the app).
    show(nextTab, nextRoute = routeId) {
      tab = nextTab;
      setRoute(nextRoute);
    },
  };
}

const rate = (k, n) => (n ? Math.round((1000 * k) / n) / 10 : null);
const sumArrays = list => (list.length ? list.reduce((t, v) => { v.forEach((x, i) => { t[i] = (t[i] ?? 0) + x; }); return t; }, []) : null);
// Excess wait from headway sums [n, Σ actual, Σ actual², Σ timetabled, Σ timetabled²] (see renderHeadways).
const excessOf = ([n, a, a2, s, s2] = []) => (n && a && s ? Math.round(a2 / (2 * a) - s2 / (2 * s)) : null);
const ymdDate = d => new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), 17));
const weekdayIndex = d => (ymdDate(d).getUTCDay() + 6) % 7;
const dateLabel = d => formatDate(ymdDate(d));
// "the week of Oct 18–24" for the fare-box data.
const weekText = rides => `the week of ${dateLabel(rides.week[0])}–${dateLabel(rides.week[1])}`;
// YYYYMMDD <-> a date input's YYYY-MM-DD.
const toYmdInput = d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const fromYmdInput = v => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v.replaceAll('-', '') : null);
const dayCount = (from, to) => Math.round((ymdDate(to) - ymdDate(from)) / 86_400_000) + 1;
const sameDay = s => formatDate(new Date(s * 1000)) === formatDate(new Date());
const minutesText = s => (s < 60 ? `${s} s` : `${Math.round(s / 60)} min`);
const seconds = s => (Math.abs(s) < 90 ? `${s} s` : `${Math.round((s / 60) * 10) / 10} min`);
const signed = s => `${s > 0 ? '+' : s < 0 ? '−' : ''}${seconds(Math.abs(s))}`;
const signedMinutes = s => (Math.abs(s) < 60 ? `${s > 0 ? '+' : ''}${s} s` : `${s > 0 ? '+' : '−'}${Math.round((Math.abs(s) / 60) * 10) / 10} min`);
const excessClass = s => (s > 120 ? 'late' : s < -120 ? 'early' : '');
const hourLabel = h => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
const periodLabel = p => ['Night', 'Morning peak', 'Midday', 'Afternoon peak', 'Evening'][p] ?? `Period ${p}`;
