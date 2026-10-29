// The left-hand rail and the panels it opens: routes (with the route filter), search, alerts, a
// table of live buses, analytics (including on-time reliability) and settings. It reaches the map
// only through the callbacks, so it knows nothing of MapLibre or three.js.
import { createAnalytics } from './analytics.js';
import { createBusTable } from './buses.js';
import { el, formatTime, formatWhen, icon, routeBadge } from './dom.js';

const PANELS = [
  { name: 'routes', label: 'Routes' },
  { name: 'search', label: 'Search' },
  { name: 'alerts', label: 'Alerts' },
  { name: 'buses', label: 'Buses' },
  { name: 'analytics', label: 'Analytics' },
  { name: 'settings', label: 'Settings' },
];
const MAX_BADGES = 6;
// Panels with tables get a wider column on large screens.
const WIDE = new Set(['buses', 'analytics']);

// routes: [{ routeId, routeShortName, routeLongName, routeColor, routeTextColor }], in display order.
// search(query, limit): see search.js. settings: the live settings object (read only here).
// onBus(vehicle) shows a bus. stopName, stop, tripInfo, stopPairRoutes, shelterStops, ridership
// and onSpeedMap serve the Analytics panel (see analytics.js).
export function createSidebar(railEl, panelEl, { routes, search, settings, onFilter, onShowRoute, onStop, onTrip, onBus, onSettings, onOpen, stopName, stop, tripInfo, stopPairRoutes, shelterStops, ridership, onSpeedMap, onCanceled, onBunching }) {
  const routesById = new Map(routes.map(r => [r.routeId, r]));
  const routeOrder = new Map(routes.map((r, i) => [r.routeId, i]));
  // Route details for badges and sorting, with a grey fallback for a route the timetable lacks.
  const route = id => ({ routeId: id, routeShortName: id ?? '?', routeColor: '#888888', routeTextColor: '#FFFFFF', ...routesById.get(id), order: routeOrder.get(id) });
  let buses = { vehicles: [], nowS: Date.now() / 1000 };
  let openName = null;
  let filter = null; // Set of route ids shown, or null for all
  let counts = new Map(); // route id -> buses running now
  let alerts = [];
  let weather = { alerts: [], moreUrl: null }; // National Weather Service alerts for Broward

  const titleEl = el('h2', {});
  const closeButton = el('button', { type: 'button', className: 'icon-button close', title: 'Close', ariaLabel: 'Close panel' }, '×');
  const bodyEl = el('div', { className: 'detail-body' });
  panelEl.append(el('div', { className: 'detail-header' }, el('div', { className: 'detail-title' }, titleEl), closeButton), bodyEl);
  closeButton.addEventListener('click', () => close());
  panelEl.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    e.stopPropagation(); // don't also close the detail panel
    close();
  });

  const buttons = new Map();
  const alertCount = el('span', { className: 'rail-count', hidden: true });
  for (const { name, label } of PANELS) {
    const button = el('button', { type: 'button', className: 'rail-button', title: label, ariaLabel: label }, icon(name), name === 'alerts' && alertCount);
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => (openName === name ? close() : show(name)));
    buttons.set(name, button);
    railEl.append(button);
  }

  const sections = {};
  const builders = {
    routes: buildRoutes,
    search: buildSearch,
    alerts: buildAlerts,
    buses: () => createBusTable({ route, onBus }),
    analytics: () => createAnalytics({ routes, route, stopName, stop, tripInfo, stopPairRoutes, shelterStops, ridership, onStop, onTrip, onSpeedMap, onCanceled, onBunching, settings }),
    settings: buildSettings,
  };
  const section = name => (sections[name] ??= builders[name]());

  function show(name) {
    openName = name;
    panelEl.hidden = false;
    panelEl.parentElement.classList.toggle('wide', WIDE.has(name));
    for (const [n, b] of buttons) b.setAttribute('aria-pressed', String(n === name));
    titleEl.textContent = PANELS.find(p => p.name === name).label;
    const s = section(name);
    bodyEl.replaceChildren(s.node);
    s.sync?.(name === 'buses' ? buses : undefined);
    onOpen(name);
    s.focus?.();
  }

  function close() {
    if (!openName) return;
    openName = null;
    panelEl.hidden = true;
    panelEl.parentElement.classList.remove('wide');
    for (const b of buttons.values()) b.setAttribute('aria-pressed', 'false');
    onOpen(null);
  }

  // ---- Routes --------------------------------------------------------------------------------

  function buildRoutes() {
    const query = el('input', { type: 'search', className: 'text-input', placeholder: 'Filter routes', ariaLabel: 'Filter the route list' });
    const showAll = el('button', { type: 'button', className: 'small-button' }, 'Show all');
    const summary = el('p', { className: 'panel-note' });
    const rows = routes.map(r => {
      const box = el('input', { type: 'checkbox', ariaLabel: `Show route ${r.routeShortName}` });
      box.addEventListener('change', () => toggleRoute(r.routeId, box.checked));
      const name = el('button', { type: 'button', className: 'route-name', title: `Show only route ${r.routeShortName} and zoom to it` },
        routeBadge(r), el('span', { className: 'headsign' }, r.routeLongName));
      name.addEventListener('click', () => onShowRoute(r.routeId));
      const count = el('span', { className: 'count-text' });
      const row = el('div', { className: 'route-row' }, box, name, count);
      return { route: r, row, box, count, text: `${r.routeShortName} ${r.routeLongName}`.toLowerCase() };
    });
    query.addEventListener('input', () => {
      const q = query.value.trim().toLowerCase();
      for (const x of rows) x.row.hidden = Boolean(q) && !x.text.includes(q);
    });
    showAll.addEventListener('click', () => onFilter(null));
    return {
      node: el('div', {}, el('div', { className: 'toolbar' }, query, showAll), summary, el('div', {}, ...rows.map(x => x.row))),
      sync() {
        const running = routes.filter(r => counts.get(r.routeId)).length;
        summary.textContent = `${running} of ${routes.length} routes have buses running.` +
          (filter ? ` Showing ${filter.size} on the map.` : ' Untick a route to hide it, or pick one to show only that route.');
        for (const x of rows) {
          x.box.checked = !filter || filter.has(x.route.routeId);
          const n = counts.get(x.route.routeId) ?? 0;
          x.count.textContent = n ? `${n} ${n === 1 ? 'bus' : 'buses'}` : '';
        }
        showAll.disabled = !filter;
      },
    };
  }

  function toggleRoute(routeId, shown) {
    const next = new Set(filter ?? routes.map(r => r.routeId));
    if (shown) next.add(routeId);
    else next.delete(routeId);
    onFilter(next.size === routes.length ? null : [...next]);
  }

  // ---- Search --------------------------------------------------------------------------------

  function buildSearch() {
    const input = el('input', { type: 'search', className: 'text-input', placeholder: 'Stop name, stop number or route', ariaLabel: 'Search stops and routes' });
    const results = el('div', {});
    let hits = [];
    const choose = hit => (hit.kind === 'route' ? onShowRoute(hit.item.routeId) : onStop(hit.item.id));
    function render() {
      hits = search(input.value, 25);
      if (!input.value.trim()) {
        results.replaceChildren(el('p', { className: 'panel-note' }, 'Try a stop name like "NW 4th St", a stop number like 0210, or a route number like 22.'));
        return;
      }
      if (!hits.length) {
        results.replaceChildren(el('p', { className: 'panel-note' }, 'No stops or routes match.'));
        return;
      }
      results.replaceChildren(...hits.map(hit => {
        const { item } = hit;
        const row = hit.kind === 'route'
          ? el('button', { type: 'button', className: 'row result' },
            routeBadge(item), el('div', { className: 'what' }, el('div', { className: 'headsign' }, item.routeLongName), el('div', { className: 'status' }, 'Route')))
          : el('button', { type: 'button', className: 'row result' },
            el('span', { className: 'stop-glyph', ariaHidden: 'true' }),
            el('div', { className: 'what' }, el('div', { className: 'headsign' }, item.name), el('div', { className: 'status badges' }, `Stop ${item.code}`, ...badgesFor(item.routes))));
        row.addEventListener('click', () => choose(hit));
        return row;
      }));
    }
    input.addEventListener('input', render);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && hits[0]) choose(hits[0]);
    });
    render();
    return { node: el('div', {}, el('div', { className: 'toolbar' }, input), results), focus: () => input.focus() };
  }

  function badgesFor(routeIds = []) {
    const known = routeIds.map(id => routesById.get(id)).filter(Boolean);
    const badges = known.slice(0, MAX_BADGES).map(routeBadge);
    if (known.length > MAX_BADGES) badges.push(el('span', {}, `+${known.length - MAX_BADGES}`));
    return badges;
  }

  // ---- Alerts --------------------------------------------------------------------------------

  function buildAlerts() {
    const note = el('p', { className: 'panel-note' });
    const list = el('div', {});
    let shownKey = null;
    return {
      node: el('div', {}, note, list),
      // Called on every feed update (every 10 s); the cards are only rebuilt when the alerts change,
      // so an opened "Details" or "stops affected" stays open.
      sync({ force = false } = {}) {
        // BCT restamps every alert's active period on each publish (start = now), so periods are
        // left out of the comparison.
        const key = JSON.stringify([weather.alerts, alerts.map(({ activePeriods, ...a }) => a), filter && [...filter]]);
        if (key === shownKey && !force) return;
        shownKey = key;
        const shown = filter ? alerts.filter(a => !a.routes.length || a.routes.some(r => filter.has(r.routeId))) : alerts;
        const transit = !alerts.length
          ? 'No service alerts right now.'
          : filter && shown.length !== alerts.length
            ? `${shown.length} of ${alerts.length} service alerts affect the routes you're showing.`
            : `${alerts.length} active service ${alerts.length === 1 ? 'alert' : 'alerts'} from Broward County Transit.`;
        const n = weather.alerts.length;
        note.textContent = n ? `${n} weather ${n === 1 ? 'alert' : 'alerts'} for Broward from the National Weather Service. ${transit}` : transit;
        list.replaceChildren(...weather.alerts.map(weatherCard), ...shown.map(alertCard));
      },
    };
  }

  function weatherCard(a) {
    // NWS text is hard-wrapped at about 70 characters, with blank lines between paragraphs.
    const paragraphs = text => (text ?? '').split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).map(p => el('p', {}, p));
    return el('article', { className: `alert nws severity-${a.severity.toLowerCase()}` },
      el('h3', {}, icon('warning'), a.event),
      el('p', { className: 'status' }, [a.severity !== 'Unknown' && a.severity, a.ends && `until ${formatWhen(a.ends)}`].filter(Boolean).join(', ')),
      (a.description || a.instruction) && el('details', {},
        el('summary', {}, 'Details'),
        ...paragraphs(a.description),
        ...(a.instruction ? [el('h4', {}, 'What to do'), ...paragraphs(a.instruction)] : [])),
      el('p', { className: 'status' }, weather.moreUrl ? el('a', { href: weather.moreUrl, target: '_blank', rel: 'noopener' }, a.sender) : a.sender),
    );
  }

  function alertCard(a) {
    const end = a.activePeriods.map(p => p.end).filter(Boolean).sort((x, y) => x - y).at(-1);
    const trips = a.trips.map(t => {
      const b = el('button', { type: 'button', className: 'link-row' }, routeBadge(t), ' ', t.headsign ?? t.tripId);
      b.addEventListener('click', () => onTrip(t.tripId));
      return b;
    });
    const stops = a.stops.map(s => {
      const b = el('button', { type: 'button', className: 'link-row' }, s.stopName ?? s.stopId);
      b.addEventListener('click', () => onStop(s.stopId));
      return b;
    });
    return el('article', { className: 'alert' },
      el('h3', {}, a.header ?? 'Service alert'),
      a.description && a.description !== a.header && el('p', {}, a.description),
      !trips.length && a.routes.length > 0 && el('div', { className: 'badges' }, ...a.routes.map(routeBadge)),
      ...trips,
      stops.length > 0 && el('details', {}, el('summary', {}, `${stops.length} ${stops.length === 1 ? 'stop' : 'stops'} affected`), ...stops),
      end && el('p', { className: 'status' }, `Until ${formatTime(end)}`),
    );
  }

  // ---- Settings ------------------------------------------------------------------------------

  function buildSettings() {
    const choices = (legend, key, options, note) => {
      const group = el('fieldset', { className: 'setting' }, el('legend', {}, legend));
      for (const [value, label] of options) {
        const input = el('input', { type: 'radio', name: `setting-${key}`, value, checked: settings[key] === value });
        input.addEventListener('change', () => input.checked && onSettings({ [key]: value }));
        group.append(el('label', { className: 'choice' }, input, label));
      }
      if (note) group.append(el('p', { className: 'status' }, note));
      return group;
    };
    const toggle = (label, key) => {
      const input = el('input', { type: 'checkbox', checked: settings[key] });
      input.addEventListener('change', () => onSettings({ [key]: input.checked }));
      return el('label', { className: 'setting choice' }, input, label);
    };
    return {
      node: el('div', { className: 'settings' },
        choices('Map theme', 'theme', [['auto', 'Automatic: day or night in Broward'], ['day', 'Day'], ['night', 'Night']], 'Changing the theme reloads the map.'),
        choices('Buses', 'vehicles', [['auto', 'Automatic: 3D, or 2D if the map runs slowly'], ['3d', '3D'], ['2d', '2D (lighter on older devices)']]),
        toggle('3D buildings', 'buildings'),
        toggle('Rain radar', 'radar'),
        toggle('Hurricane forecast cones (when there is an Atlantic storm)', 'storms'),
        choices('Stops', 'stops', [['active-routes', 'On routes with a bus running'], ['all', 'All stops'], ['none', 'Hidden']]),
        toggle('Stop names', 'stopNames'),
        choices('Times', 'timeFormat', [['12h', '12-hour'], ['24h', '24-hour']]),
        el('div', { className: 'about' },
          el('h3', {}, 'About'),
          el('p', {}, 'Live data from Broward County Transit, refreshed every 10 seconds. Buses are drawn about 30 seconds behind the feed so they can move smoothly along their streets.'),
          el('p', {}, 'Modelled on aklcommute.nz. Basemap: OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors.')),
      ),
    };
  }

  function updateCount() {
    const n = alerts.length + weather.alerts.length;
    alertCount.hidden = n === 0;
    alertCount.textContent = String(n);
  }

  return {
    show,
    close,
    get isOpen() {
      return openName != null;
    },
    setFilter(next) {
      filter = next;
      sections.routes?.sync();
      sections.alerts?.sync();
    },
    // Re-renders text that depends on settings, e.g. after the 12/24-hour setting changes or the
    // buses switch to 2D on their own.
    refresh() {
      sections.alerts?.sync({ force: true });
      if (sections.settings) {
        sections.settings = buildSettings();
        if (openName === 'settings') bodyEl.replaceChildren(sections.settings.node);
      }
    },
    // New feed data: live bus counts per route, the current alerts, and the buses themselves
    // ({ vehicles, nowS }).
    update(next) {
      counts = next.counts;
      alerts = next.alerts;
      buses = next.buses;
      updateCount();
      sections.routes?.sync();
      sections.alerts?.sync();
      if (openName === 'buses') sections.buses.sync(buses);
    },
    // { alerts, moreUrl } from /api/weather-alerts.
    setWeatherAlerts(next) {
      weather = next;
      updateCount();
      sections.alerts?.sync();
    },
  };
}
