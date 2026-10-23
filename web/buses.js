// The Buses panel: every bus in the live feed as a sortable table, with its route, where it's
// going, its next stop and how far ahead of or behind the timetable it is. Refreshed with each poll.
import { downloadCsv, csvTime } from './csv.js';
import { el, formatTime, routeBadge } from './dom.js';

// The same on-time window as the reliability stats (server/ontime.mjs).
const EARLY_S = -60;
const LATE_S = 300;

// Seconds of delay -> how the table shows it, and which group it counts in.
export function adherence(delay, canceled = false) {
  if (canceled) return { text: 'Canceled', className: 'muted', group: 'canceled' };
  if (delay == null) return { text: 'No data', className: 'muted', group: 'unknown' };
  const minutes = Math.round(Math.abs(delay) / 60);
  const text = minutes === 0 ? 'On time' : `${minutes} min ${delay > 0 ? 'late' : 'early'}`;
  if (delay < EARLY_S) return { text, className: 'early', group: 'early' };
  if (delay > LATE_S) return { text, className: 'late', group: 'late' };
  return { text, className: '', group: 'onTime' };
}

const COLUMNS = [
  { key: 'route', label: 'Route' },
  { key: 'bus', label: 'Bus' },
  { key: 'headsign', label: 'To' },
  { key: 'next', label: 'Next stop' },
  { key: 'delay', label: 'Schedule', numeric: true },
  { key: 'age', label: 'Report', numeric: true },
];

// route(routeId) -> { routeShortName, routeColor, routeTextColor, order }. onBus(vehicle) shows a bus.
export function createBusTable({ route, onBus }) {
  let vehicles = [];
  let nowS = Date.now() / 1000;
  let sort = { key: 'route', dir: 1 };
  let query = '';

  const filter = el('input', { type: 'search', className: 'text-input', placeholder: 'Filter by route, bus, destination or stop', ariaLabel: 'Filter buses' });
  filter.addEventListener('input', () => {
    query = filter.value.trim().toLowerCase();
    render();
  });
  const summary = el('p', { className: 'panel-note' });
  const download = el('button', { type: 'button', className: 'small-button' }, 'Download CSV');
  download.addEventListener('click', () => downloadCsv(`broward-buses-${csvTime(nowS).slice(0, 10)}.csv`, [
    ['route', 'bus', 'trip_id', 'destination', 'next_stop', 'next_stop_expected', 'schedule_seconds', 'schedule', 'report_time'],
    ...shown().map(v => [route(v.routeId).routeShortName || v.routeId, v.id, v.tripId, v.headsign, v.nextStop?.stopName, csvTime(v.nextStop?.time), v.delay, adherence(v.delay, v.canceled).text, csvTime(v.timestamp)]),
  ]));
  const headRow = el('tr', {});
  const body = el('tbody', {});
  const table = el('table', { className: 'bus-table' }, el('thead', {}, headRow), body);
  for (const col of COLUMNS) {
    const button = el('button', { type: 'button' }, col.label);
    button.addEventListener('click', () => {
      sort = { key: col.key, dir: sort.key === col.key ? -sort.dir : col.key === 'delay' ? -1 : 1 };
      render();
    });
    headRow.append(el('th', { scope: 'col', className: col.numeric ? 'num' : '' }, button));
  }

  const sortValue = {
    route: v => route(v.routeId).order ?? 9999,
    bus: v => Number(v.id) || v.id,
    headsign: v => v.headsign ?? '',
    next: v => v.nextStop?.time ?? Infinity,
    delay: v => (v.canceled || v.delay == null ? -Infinity : v.delay),
    age: v => nowS - v.timestamp,
  };

  function shown() {
    const list = query
      ? vehicles.filter(v => [route(v.routeId).routeShortName, v.id, v.headsign, v.nextStop?.stopName].some(s => String(s ?? '').toLowerCase().includes(query)))
      : vehicles;
    const value = sortValue[sort.key];
    return [...list].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || (sortValue.route(a) - sortValue.route(b)) || String(a.id).localeCompare(String(b.id));
    });
  }

  function render() {
    const list = shown();
    const groups = { early: 0, onTime: 0, late: 0, unknown: 0, canceled: 0 };
    for (const v of list) groups[adherence(v.delay, v.canceled).group]++;
    summary.replaceChildren(
      el('strong', {}, `${list.length}${query ? ` of ${vehicles.length}` : ''} buses`),
      ` · ${groups.onTime} on time · ${groups.late} more than 5 min late · ${groups.early} more than 1 min early`,
      groups.unknown ? ` · ${groups.unknown} without a prediction` : '',
    );
    COLUMNS.forEach((col, i) => headRow.children[i].setAttribute('aria-sort', sort.key === col.key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'));
    body.replaceChildren(...list.map(v => {
      const a = adherence(v.delay, v.canceled);
      const age = Math.max(0, Math.round(nowS - v.timestamp));
      const row = el('tr', { tabIndex: 0 },
        el('td', {}, routeBadge({ ...route(v.routeId), routeShortName: route(v.routeId).routeShortName || v.routeShortName })),
        el('td', { className: 'num-id' }, v.id),
        el('td', {}, v.headsign ?? ''),
        el('td', {}, v.nextStop?.stopName ?? '', v.nextStop?.time ? el('div', { className: 'status' }, formatTime(v.nextStop.time)) : null),
        el('td', { className: `num ${a.className}` }, a.text),
        el('td', { className: `num${age > 120 ? ' late' : ''}` }, age < 60 ? `${age} s` : `${Math.round(age / 60)} min`),
      );
      row.title = `Bus ${v.id}: show on the map`;
      row.addEventListener('click', () => onBus(v));
      row.addEventListener('keydown', e => e.key === 'Enter' && onBus(v));
      return row;
    }));
  }

  return {
    node: el('div', { className: 'buses' },
      el('div', { className: 'panel-tools' }, filter, download), summary, el('div', { className: 'table-scroll' }, table)),
    // next: { vehicles (the snapshot's vehiclePositions), nowS }
    sync(next) {
      if (next) ({ vehicles, nowS } = next);
      render();
    },
    focus: () => filter.focus(),
  };
}
