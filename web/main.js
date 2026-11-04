// Live map for BCT staff: OpenFreeMap basemap in MapLibre GL, BCT route lines and stops, and each bus
// at its latest reported position (faded when that report is old). Clicking a bus or stop opens its
// trip timeline or departure board (web/panel.js); the left rail opens routes with the route filter,
// search, alerts, the bus table, Analytics and settings (web/sidebar.js). Settings persist in
// localStorage (web/settings.js) and the view lives in the URL (web/links.js).
/* global maplibregl */
import { apiUrl, getApiJson } from './api.js';
import { cityName, describeAmenities } from './amenities.js';
import { unpackBundle } from './gtfs-rt.js';
import { LiveFeed } from './live.js';
import { serviceDayStart } from './gtfs-util.js';
import { routesByStopPair, SPEED_BANDS } from './speeds.js';
import { canceledTripDetails } from './canceled.js';
import { createReplay } from './replay.js';
import { el, formatClock, formatDate, formatTime, routeBadge, setTimeFormat } from './dom.js';
import { linkSearch, parseLink } from './links.js';
import { createPanel } from './panel.js';
import { createSearchIndex } from './search.js';
import { loadSettings, saveSettings } from './settings.js';
import { ShapeLine } from './shapes.js';
import { createSidebar } from './sidebar.js';

const POLL_MS = 10_000; // BCT republishes about every 10 s
const TIMEZONE = 'America/New_York';
const CENTER = [-80.1437, 26.1224]; // Broward Central Terminal, Fort Lauderdale
const MAX_BOUNDS = [[-80.95, 25.55], [-79.85, 26.6]];
const LATE_AFTER_S = 120; // a halo from 2 minutes late
const STALE_AFTER_S = 120; // a GPS report older than this is drawn faded
const CLICK_RADIUS_PX = 14;
const STOP_CLICK_RADIUS_PX = 8;

// Muted basemaps so route colours stand out, like the original's "faded" Mapbox theme.
const THEMES = {
  day: {
    style: 'https://tiles.openfreemap.org/styles/positron',
    stopFill: '#ffffff', stopStroke: '#3c3c43', label: '#3c3c43', labelHalo: '#ffffff', selected: '#1d1d1f',
  },
  night: {
    style: 'https://tiles.openfreemap.org/styles/dark',
    stopFill: '#2c2c2e', stopStroke: '#e5e5ea', label: '#e5e5ea', labelHalo: '#1c1c1e', selected: '#ffffff',
  },
};

const settings = loadSettings();
const link = parseLink(location.search); // what the URL asked to show, applied once the data loads
setTimeFormat(settings.timeFormat);

// `?theme=day|night` in the URL wins, then the saved setting, then day or night by the hour in Broward.
function themeName() {
  const override = new URLSearchParams(location.search).get('theme');
  if (override && Object.hasOwn(THEMES, override)) return override;
  if (settings.theme !== 'auto') return settings.theme;
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  return hour >= 6 && hour < 19 ? 'day' : 'night';
}
const themeKey = themeName();
const theme = THEMES[themeKey];
document.documentElement.dataset.theme = themeKey; // the panels follow the map's theme, not the OS's

const statusEl = document.getElementById('status-text');
const filterNoteEl = document.getElementById('filter-note');

// ---- Header: clock --------------------------------------------------------------------------

const dateEl = document.getElementById('date');
const clockEl = document.getElementById('clock');

function tickClock() {
  const now = new Date();
  dateEl.textContent = formatDate(now);
  clockEl.textContent = formatClock(now);
}
tickClock();
setInterval(tickClock, 1000);

// ---- Rain radar ------------------------------------------------------------------------------

// US NEXRAD composite tiles from Iowa Environmental Mesonet, above the basemap and below the route
// lines. IEM rebuilds it every 5 minutes; the radar time is part of the tile URL so the browser
// fetches fresh tiles, not cached old ones.
const radarNoteEl = document.getElementById('radar-note');
let radarValid = null;
let radarTimer = null;

async function updateRadar() {
  if (!settings.radar) {
    if (map.getLayer('radar')) map.setLayoutProperty('radar', 'visibility', 'none');
    radarNoteEl.hidden = true;
    clearInterval(radarTimer);
    radarTimer = null;
    return;
  }
  radarTimer ??= setInterval(updateRadar, 2.5 * 60_000);
  try {
    const radar = await getApiJson('/api/radar');
    if (!settings.radar) return; // switched off while loading
    const tiles = [`${radar.tiles}?v=${radar.valid}`];
    if (!map.getSource('radar')) {
      map.addSource('radar', { type: 'raster', tiles, tileSize: 256, maxzoom: 12, attribution: radar.attribution });
      const beforeId = ['routes', 'stops'].find(id => map.getLayer(id));
      map.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': 0.55 } }, beforeId);
    } else if (radar.valid !== radarValid) {
      map.getSource('radar').setTiles(tiles);
    }
    radarValid = radar.valid;
    map.setLayoutProperty('radar', 'visibility', 'visible');
    radarNoteEl.textContent = `Rain radar from ${formatTime(radar.valid)}${radar.stale ? ' (not updated recently)' : ''}`;
    radarNoteEl.hidden = false;
  } catch {
    radarNoteEl.textContent = 'Rain radar unavailable right now.';
    radarNoteEl.hidden = false;
  }
}
const isNarrow = () => !window.matchMedia('(min-width: 641px)').matches; // panels become bottom sheets
// The sidebar column (to 412 px) and the detail panel (360 px from the right) both fit from here up;
// below it, opening one closes the other.
const panelsFitSideBySide = () => window.matchMedia('(min-width: 800px)').matches;
const map = new maplibregl.Map({
  container: 'map',
  style: theme.style,
  center: CENTER,
  zoom: 13,
  maxBounds: MAX_BOUNDS,
  // A flat map: north up, no tilting.
  maxPitch: 0,
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
  hash: true, // keeps the camera in the URL (#zoom/lat/lon) so views can be shared
});
map.touchZoomRotate.disableRotation();
// Bottom-left, so the detail panel on the right never covers it.
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');

// ---- Notices ---------------------------------------------------------------------------------

const toastEl = document.getElementById('toast');
let toastTimer = null;

// A short notice above the bottom of the map, with an optional { label, run } action. One at a time.
function showToast(message, action = null) {
  clearTimeout(toastTimer);
  const dismiss = el('button', { type: 'button', className: 'icon-button close', title: 'Dismiss', ariaLabel: 'Dismiss' }, '×');
  dismiss.addEventListener('click', hideToast);
  const parts = [el('span', {}, message)];
  if (action) {
    const actionButton = el('button', { type: 'button', className: 'link' }, action.label);
    actionButton.addEventListener('click', () => {
      hideToast();
      action.run();
    });
    parts.push(actionButton);
  }
  toastEl.replaceChildren(...parts, dismiss);
  toastEl.hidden = false;
  toastTimer = setTimeout(hideToast, 12_000);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastEl.hidden = true;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// ---- Shape coordinates -----------------------------------------------------------------------

// Metres east (x) and north (y) from a fixed origin in Broward, for following a route's shape (the
// bunching replay). Positions go through exact Web Mercator offsets.
const origin = maplibregl.MercatorCoordinate.fromLngLat(CENTER, 0);
const mercatorPerMeter = origin.meterInMercatorCoordinateUnits();

function toScene([lon, lat]) {
  const m = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0);
  return [(m.x - origin.x) / mercatorPerMeter, -(m.y - origin.y) / mercatorPerMeter];
}

function fromScene([x, y]) {
  return new maplibregl.MercatorCoordinate(origin.x + x * mercatorPerMeter, origin.y - y * mercatorPerMeter, 0).toLngLat().toArray();
}

// ---- Route shapes ----------------------------------------------------------------------------

const shapeCoords = new Map(); // shape_id -> [[lon, lat]], filled while drawing the route lines
const shapeLines = new Map(); // shape_id -> ShapeLine in metres, built the first time a replay needs it

function shapeLine(shapeId) {
  if (!shapeId || !shapeCoords.has(shapeId)) return null;
  let line = shapeLines.get(shapeId);
  if (!line) shapeLines.set(shapeId, (line = new ShapeLine(shapeCoords.get(shapeId).map(toScene))));
  return line;
}

// ---- Basemap layers --------------------------------------------------------------------------

const routesList = []; // [{ routeId, routeShortName, routeLongName, routeColor, routeTextColor }], in BCT's order
const routesById = new Map();
const routeShapes = new Map(); // route_id -> [shape_id], for zooming to a route

// Returns routes.json, which the live feed needs too.
async function addRouteLines(folder, beforeId) {
  const routes = await getJson(`data/${folder}/routes.json`);
  for (const r of routes) {
    const route = {
      routeId: r.route_id, routeShortName: r.route_short_name, routeLongName: r.route_long_name,
      routeColor: `#${r.route_color}`, routeTextColor: `#${r.route_text_color}`,
    };
    routesList.push(route);
    routesById.set(route.routeId, route);
  }
  const features = [];
  await Promise.all(routes.map(async route => {
    const data = await getJson(`data/${folder}/route_data/${encodeURIComponent(route.route_id)}.json`);
    routeShapes.set(route.route_id, Object.keys(data.s));
    for (const [shapeId, coordinates] of Object.entries(data.s)) {
      shapeCoords.set(shapeId, coordinates);
      features.push({
        type: 'Feature',
        properties: { color: `#${route.route_color}`, routeId: route.route_id },
        geometry: { type: 'LineString', coordinates },
      });
    }
  }));
  map.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features } });
  map.addLayer({
    id: 'routes',
    type: 'line',
    source: 'routes',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 16, 4],
      'line-opacity': 0.75,
    },
  }, beforeId);
  return routes;
}

// ---- Stops -----------------------------------------------------------------------------------

const stopsById = new Map(); // stop_id -> { id, code, name, lon, lat, routes: [route_id], amenities, city }
// A week of BCT's boardings as totals by stop and by route and hour (web/ridership.json, built by
// scripts/build-ridership.mjs), for weighting Analytics by riders; null if the file is missing.
let ridership = null;
let shownStopsKey = null;

// Stops as circles from zoom 14, with names from 16.5. Which stops show depends on the Stops setting
// and the route filter (see updateStops). Returns stops.json, which the live feed needs too.
async function addStops(folder, circlesBeforeId, labelsBeforeId) {
  const [stops, stopRoutes, amenities, riders] = await Promise.all([
    getJson(`data/${folder}/stops.json`),
    getJson(`data/${folder}/stop_routes.json`),
    // Shelters, benches and so on; optional, since builds before it existed don't have the file.
    getJson(`data/${folder}/amenities.json`).catch(() => null),
    getJson('ridership.json').catch(() => null),
  ]);
  ridership = riders?.v === 1 ? riders : null;
  for (const [id, code, lat, lon, name, locationType] of stops) {
    if (locationType !== 0 || !stopRoutes[id]) continue;
    const [mask, city] = amenities?.stops[id] ?? [0, null];
    stopsById.set(id, {
      id, code, name, lon, lat, routes: stopRoutes[id],
      amenities: amenities ? describeAmenities(mask) : null,
      city: city == null ? null : cityName(amenities.cities[city]),
    });
  }
  map.addSource('stops', { type: 'geojson', data: stopFeatures(new Set()) });
  const active = ['==', ['get', 'shown'], true];
  map.addLayer({
    id: 'stops',
    type: 'circle',
    source: 'stops',
    minzoom: 14,
    filter: active,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 2.5, 17, 6],
      'circle-color': theme.stopFill,
      'circle-stroke-color': theme.stopStroke,
      'circle-stroke-width': 1.5,
    },
  }, circlesBeforeId);
  map.addLayer({
    id: 'stop-selected',
    type: 'circle',
    source: 'stops',
    filter: ['==', ['get', 'id'], ''],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 6, 17, 11],
      'circle-color': 'rgba(0, 0, 0, 0)',
      'circle-stroke-color': theme.selected,
      'circle-stroke-width': 3,
    },
  }, circlesBeforeId);
  map.addLayer({
    id: 'stop-labels',
    type: 'symbol',
    source: 'stops',
    minzoom: 16.5,
    filter: active,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'text-anchor': 'top',
      'text-offset': [0, 0.9],
      'text-max-width': 10,
      'text-optional': true,
    },
    paint: { 'text-color': theme.label, 'text-halo-color': theme.labelHalo, 'text-halo-width': 1.2 },
  }, labelsBeforeId);
  return stops;
}

// `routeIds` is a Set of routes whose stops to show, or 'all'.
function stopFeatures(routeIds) {
  const features = [];
  for (const s of stopsById.values()) {
    features.push({
      type: 'Feature',
      properties: { id: s.id, name: s.name, shown: routeIds === 'all' || s.routes.some(r => routeIds.has(r)) },
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    });
  }
  return { type: 'FeatureCollection', features };
}

// Stops hidden, all stops, or stops on routes with a bus running (from the latest feed); a route
// filter narrows the last two to its routes. Only re-sends the stops when that set changes.
function updateStops() {
  if (!map.getSource('stops')) return;
  let routeIds;
  if (settings.stops === 'none') routeIds = new Set();
  else if (routeFilter) routeIds = routeFilter;
  else if (settings.stops === 'all') routeIds = 'all';
  else routeIds = new Set((lastFeed?.vehiclePositions ?? []).map(v => v.routeId).filter(Boolean));
  const key = routeIds === 'all' ? 'all' : [...routeIds].sort().join('|');
  if (key === shownStopsKey) return;
  shownStopsKey = key;
  map.getSource('stops').setData(stopFeatures(routeIds));
}

// ---- Route filter ----------------------------------------------------------------------------

let routeFilter = null; // Set of route ids shown on the map, or null for all routes
let lastFeed = null;

const routeShown = routeId => !routeFilter || routeFilter.has(routeId);

// `ids`: route ids to show, or null for all. Unknown ids (e.g. saved before a timetable change) are
// dropped; if none are left, the filter is cleared rather than hiding everything.
function setRouteFilter(ids, { save = true } = {}) {
  const known = ids?.filter(id => routesById.has(id)) ?? null;
  routeFilter = known && (known.length > 0 || ids.length === 0) ? new Set(known) : null;
  if (save) {
    settings.routes = routeFilter ? [...routeFilter] : null;
    saveSettings(settings);
  }
  drawBuses();
  if (map.getLayer('routes')) map.setFilter('routes', routeFilter ? ['in', ['get', 'routeId'], ['literal', [...routeFilter]]] : null);
  updateStops();
  updateFilterNote();
  updateStatus();
  sidebar?.setFilter(routeFilter);
  writeLink();
  map.triggerRepaint();
}

function updateFilterNote() {
  filterNoteEl.hidden = !routeFilter;
  if (!routeFilter) return;
  const shown = routesList.filter(r => routeFilter.has(r.routeId));
  const showAll = el('button', { type: 'button', className: 'link' }, 'Show all routes');
  showAll.addEventListener('click', () => setRouteFilter(null));
  filterNoteEl.replaceChildren(
    shown.length ? 'Showing ' : 'No routes selected',
    ...shown.slice(0, 8).map(routeBadge),
    shown.length > 8 ? ` +${shown.length - 8}` : '',
    ' · ',
    showAll,
  );
}

// OpenFreeMap's dark style names a "wood-pattern" image it doesn't supply, and MapLibre warns about
// it for every tile (thousands of console warnings). A transparent pixel stands in.
map.on('styleimagemissing', e => {
  if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
});

// Room to leave around a camera fit for the panels that are open.
function cameraPadding() {
  return isNarrow()
    ? { top: 80, bottom: window.innerHeight * 0.5, left: 24, right: 24 }
    : { top: 60, bottom: 60, left: sidebar?.isOpen ? 416 : 72, right: panel.isOpen ? 384 : 24 };
}

// Bunching replays (Analytics → a bunching event): ghost buses along their route shapes.
const replay = createReplay({
  map,
  line(tripId) {
    const shaped = shapeLine(live?.trips[tripId]?.sh);
    return shaped ? { line: shaped, toScene, fromScene } : null;
  },
});

function fitRoute(routeId) {
  const bounds = new maplibregl.LngLatBounds();
  let points = 0;
  for (const shapeId of routeShapes.get(routeId) ?? []) {
    for (const c of shapeCoords.get(shapeId) ?? []) {
      bounds.extend(c);
      points++;
    }
  }
  if (!points) return;
  map.fitBounds(bounds, { padding: cameraPadding(), maxZoom: 15.5, duration: 900 });
}

// ---- Buses -----------------------------------------------------------------------------------

// Each bus is a circle in its route's colour at its latest reported position, with an arrow for its
// heading and a halo when it's running 2+ minutes late; faded when the report is more than
// STALE_AFTER_S old. Positions change once a feed (every 10 s); nothing is animated in between.
let serverClockOffsetS = 0; // API clock minus this browser's clock, from each poll's X-Server-Time
const vehicles = new Map(); // vehicle id -> the feed's vehicle (web/live.js: id, tripId, routeId, lon, lat, ...)
let bunches = []; // LiveFeed.bunchedNow() for the latest feed: pairs of buses bunched right now
let bunchPopup = null;
const BUS_LAYERS = ['buses-late', 'buses', 'buses-heading', 'buses-selected', 'bunching', 'bunching-mark'];

function addBusLayers(beforeId) {
  addArrowImage();
  map.addSource('buses', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const opacity = ['case', ['get', 'stale'], 0.35, 1];
  map.addLayer({
    id: 'buses-late',
    type: 'circle',
    source: 'buses',
    filter: ['==', ['get', 'late'], true],
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 8, 16, 15], 'circle-color': '#ff7a00', 'circle-opacity': ['*', 0.3, opacity] },
  }, beforeId);
  map.addLayer({
    id: 'buses',
    type: 'circle',
    source: 'buses',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 8],
      'circle-color': ['get', 'color'],
      'circle-opacity': opacity,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
      'circle-stroke-opacity': opacity,
    },
  }, beforeId);
  map.addLayer({
    id: 'buses-heading',
    type: 'symbol',
    source: 'buses',
    filter: ['==', ['get', 'hasBearing'], true],
    layout: {
      'icon-image': 'bus-arrow',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.45, 16, 0.8],
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: { 'icon-color': '#ffffff', 'icon-opacity': opacity },
  }, beforeId);
  map.addLayer({
    id: 'buses-selected',
    type: 'circle',
    source: 'buses',
    filter: ['==', ['get', 'id'], ''],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 7, 16, 12],
      'circle-color': 'rgba(0, 0, 0, 0)',
      'circle-stroke-color': theme.selected,
      'circle-stroke-width': 3,
    },
  }, beforeId);
  // Bunching in progress: a red "!" badge between the two buses.
  map.addSource('bunching', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'bunching',
    type: 'circle',
    source: 'bunching',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 8, 16, 13], 'circle-color': '#e0362c', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2, 'circle-translate': [0, -14] },
  }, beforeId);
  map.addLayer({
    id: 'bunching-mark',
    type: 'symbol',
    source: 'bunching',
    layout: { 'text-field': '!', 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 10, 12, 16, 18], 'text-allow-overlap': true, 'text-ignore-placement': true },
    paint: { 'text-color': '#ffffff', 'text-translate': [0, -14] },
  }, beforeId);
}

// An arrowhead pointing north, drawn on a canvas; as an SDF image the style can tint and rotate it.
function addArrowImage() {
  const size = 32;
  const ctx = Object.assign(document.createElement('canvas'), { width: size, height: size }).getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(16, 5);
  ctx.lineTo(25, 25);
  ctx.lineTo(16, 20);
  ctx.lineTo(7, 25);
  ctx.closePath();
  ctx.fill();
  map.addImage('bus-arrow', ctx.getImageData(0, 0, size, size), { sdf: true, pixelRatio: 2 });
}

// Hands MapLibre the buses on the routes shown, and a "!" between each bunched pair of them.
function drawBuses() {
  if (!map.getSource('buses')) return;
  const nowS = Date.now() / 1000 + serverClockOffsetS;
  const features = [];
  for (const v of vehicles.values()) {
    if (!routeShown(v.routeId)) continue;
    features.push({
      type: 'Feature',
      properties: {
        id: v.id,
        tripId: v.tripId ?? '',
        color: v.routeColor,
        late: v.delay != null && v.delay >= LATE_AFTER_S,
        stale: nowS - v.timestamp > STALE_AFTER_S,
        hasBearing: v.bearing != null,
        bearing: v.bearing ?? 0,
      },
      geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
    });
  }
  map.getSource('buses').setData({ type: 'FeatureCollection', features });
  const pairs = [];
  bunches.forEach((b, i) => {
    const a = vehicles.get(b.leaderBus);
    const f = vehicles.get(b.followerBus);
    if (!a || !f || !routeShown(a.routeId)) return;
    pairs.push({ type: 'Feature', properties: { index: i }, geometry: { type: 'Point', coordinates: [(a.lon + f.lon) / 2, (a.lat + f.lat) / 2] } });
  });
  map.getSource('bunching').setData({ type: 'FeatureCollection', features: pairs });
}

function applyFeed(feed) {
  vehicles.clear();
  for (const v of feed.vehiclePositions) vehicles.set(v.id, v);
  bunches = live.bunchedNow();
  lastFeed = feed;
  drawBuses();
  updateStops();
  updateStatus();
  const counts = new Map();
  for (const v of feed.vehiclePositions) if (v.routeId) counts.set(v.routeId, (counts.get(v.routeId) ?? 0) + 1);
  sidebar?.update({ counts, alerts: feed.alerts ?? [], buses: { vehicles: feed.vehiclePositions, nowS: feed.generatedAt } });
  // A trip from a link: select its bus as soon as the feed has it.
  const focusId = pendingTripFocus && vehicleForTrip(pendingTripFocus);
  if (focusId) {
    pendingTripFocus = null;
    selectBus(focusId);
    showBus(focusId);
  }
}

function updateStatus() {
  if (!lastFeed) return;
  const all = lastFeed.vehiclePositions;
  const shown = routeFilter ? all.filter(v => routeShown(v.routeId)) : all;
  const late = shown.filter(v => v.delay != null && v.delay >= LATE_AFTER_S).length;
  const nowS = Date.now() / 1000 + serverClockOffsetS;
  const stale = shown.filter(v => nowS - v.timestamp > STALE_AFTER_S).length;
  const age = Math.max(0, Math.round(nowS - (lastFeed.feedTimestamps.vehiclePositions ?? lastFeed.generatedAt)));
  const buses = routeFilter ? `${shown.length} of ${all.length}` : `${all.length}`;
  statusEl.textContent = `${buses} buses live · ${late} running 2+ min late${stale ? ` · ${stale} with GPS over 2 min old (faded)` : ''} · data ${age}s old`;
}

// ---- Polling (paused while the tab is hidden, like the original) ------------------------------

let pollTimer = null;
let booted = false; // polling must wait for the map and route shapes, even if the tab becomes visible first
let live = null; // the LiveFeed (web/live.js), once the timetable has loaded

// The API relays BCT's raw feeds; everything else (delays, bearings, departure boards) is worked
// out here from them and the timetable.
async function poll() {
  if (!live) return;
  try {
    const sentAt = Date.now();
    const res = await fetch(apiUrl('/api/rt'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const serverTime = Number(res.headers.get('X-Server-Time'));
    if (serverTime) serverClockOffsetS = (serverTime - (sentAt + Date.now()) / 2) / 1000;
    const feeds = unpackBundle(bytes);
    if (!feeds.vehiclePositions) throw new Error('no vehicle positions this time');
    applyFeed(live.ingest(feeds));
    panel.refresh();
  } catch (err) {
    statusEl.textContent = `Live feed unavailable: ${err.message}`;
  }
}

function startPolling() {
  clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearInterval(pollTimer);
  else if (booted) startPolling();
});

// ---- Selection and the detail panel ----------------------------------------------------------

function selectBus(vehicleId) {
  if (map.getLayer('buses-selected')) map.setFilter('buses-selected', ['==', ['get', 'id'], vehicleId && vehicles.has(vehicleId) ? vehicleId : '']);
}

function selectStop(stopId) {
  if (map.getLayer('stop-selected')) map.setFilter('stop-selected', ['==', ['get', 'id'], stopId ?? '']);
}

// Screen offset that puts a point in the middle of the part of the map the panels leave visible. On
// wide screens the detail panel covers the right-hand 372 px and the rail (plus the sidebar, when
// open) the left; on narrow ones an open panel is a bottom sheet over the lower half.
function visibleCenterOffset() {
  if (isNarrow()) return panel.isOpen || sidebar?.isOpen ? [0, -window.innerHeight * 0.2] : [0, 0];
  const left = sidebar?.isOpen ? 404 : 60;
  const right = panel.isOpen ? 372 : 0;
  return [(left - right) / 2, 0];
}

function flyTo(lngLat) {
  map.easeTo({ center: lngLat, zoom: Math.max(map.getZoom(), 16.5), offset: visibleCenterOffset(), duration: 800 });
}

function vehicleForTrip(tripId) {
  for (const v of vehicles.values()) if (v.tripId === tripId) return v.id;
  return null;
}

// The panel opens first so the camera move can allow for it.
function openStop(stopId, { fly = true } = {}) {
  selectBus(null);
  selectStop(stopId);
  panel.showStop(stopId);
  const stop = stopsById.get(stopId);
  if (stop && fly) flyTo([stop.lon, stop.lat]);
}

function openTrip(tripId, date = null, vehicleId = vehicleForTrip(tripId)) {
  selectStop(null);
  selectBus(vehicleId);
  panel.showTrip(tripId, date);
}

function showBus(vehicleId) {
  const v = vehicles.get(vehicleId);
  if (v) flyTo([v.lon, v.lat]);
}

let panelView = null; // what the detail panel shows, mirrored into the URL
let pendingTripFocus = null; // trip id from a link whose bus hasn't appeared in the feed yet

const panel = createPanel(document.getElementById('panel'), {
  load(view) {
    if (!live) throw new Error('The timetable has not loaded.');
    if (view.kind === 'bunch') {
      const { track } = view;
      const bounds = replay.start(track);
      if (bounds) map.fitBounds(bounds, { padding: cameraPadding(), maxZoom: 16, duration: 900 });
      return {
        track,
        route: live.routeInfo(track.routeId),
        stopName: stopsById.get(track.stopId)?.name ?? null,
        buses: track.buses.map(b => ({ ...b, headsign: live.trips[b.tripId]?.h ?? null })),
        replay,
      };
    }
    if (view.kind === 'canceled') {
      const details = canceledTripDetails(view.record, {
        trips: live.trips, calendar: live.calendar, exceptions: live.exceptions, timezone: live.timezone,
        stopName: id => stopsById.get(id)?.name ?? null,
      });
      const related = view.related.filter(r => r.tripId !== view.record.tripId).map(r => ({ ...r, headsign: live.trips[r.tripId]?.h ?? null }));
      return { details, related, route: live.routeInfo(view.record.routeId) };
    }
    if (view.kind === 'trip') return live.tripStopTimes(view.tripId, { date: view.date });
    const board = live.stopDepartures(view.stopId);
    const stop = stopsById.get(view.stopId);
    return board && { ...board, amenities: stop?.amenities ?? null, city: stop?.city ?? null };
  },
  onStop: stopId => openStop(stopId),
  onTrip: (tripId, date, vehicleId) => openTrip(tripId, date, vehicleId),
  onBus: showBus,
  onRoute(routeId) {
    setRouteFilter([routeId]);
    fitRoute(routeId);
  },
  onView(view) {
    panelView = view;
    if (view?.kind !== 'bunch') replay.stop();
    if (!view) {
      selectBus(null);
      selectStop(null);
    } else if (!panelsFitSideBySide()) {
      sidebar?.close();
    }
    writeLink();
  },
});

// ---- Bus speed layer (Analytics → Show on map) -----------------------------------------------

let stopPairRoutesCache = null;

// Stretches between stops coloured by measured bus speed (web/speeds.js), above the route lines and
// below the stops and buses. data: GeoJSON, or null to remove the layer.
function showSpeedLayer(data) {
  // The route lines fade while speeds are shown, so a red route isn't mistaken for a slow stretch.
  if (map.getLayer('routes')) map.setPaintProperty('routes', 'line-opacity', data ? 0.2 : 0.75);
  if (!data) {
    if (map.getLayer('bus-speeds')) map.setLayoutProperty('bus-speeds', 'visibility', 'none');
    return;
  }
  if (!map.getSource('bus-speeds')) {
    map.addSource('bus-speeds', { type: 'geojson', data });
    const color = ['match', ['get', 'band'], ...SPEED_BANDS.flatMap((b, i) => [i, b.color]), '#888888'];
    map.addLayer({
      id: 'bus-speeds',
      type: 'line',
      source: 'bus-speeds',
      layout: { 'line-cap': 'round' },
      // Slower stretches are drawn wider so they stand out.
      paint: { 'line-color': color, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['-', 4, ['*', 0.5, ['get', 'band']]], 16, ['-', 10, ['get', 'band']]] },
    }, ['stops'].find(id => map.getLayer(id)));
  } else {
    map.getSource('bus-speeds').setData(data);
  }
  map.setLayoutProperty('bus-speeds', 'visibility', 'visible');
}

// ---- Sidebar, settings and links -------------------------------------------------------------

let sidebar = null; // created once routes and stops have loaded
let shellReady = false; // until then the URL still holds the link being opened; don't overwrite it

function createShell() {
  sidebar = createSidebar(document.getElementById('rail'), document.getElementById('sidebar'), {
    routes: routesList,
    search: createSearchIndex({ routes: routesList, stops: [...stopsById.values()] }),
    settings,
    onFilter: ids => setRouteFilter(ids),
    onShowRoute(routeId) {
      setRouteFilter([routeId]);
      fitRoute(routeId);
    },
    onStop: stopId => openStop(stopId),
    onTrip: (tripId, date = null) => openTrip(tripId, date),
    onBus(v) {
      if (v.tripId) openTrip(v.tripId, null, v.id);
      else selectBus(v.id);
      showBus(v.id);
    },
    stopName: stopId => stopsById.get(stopId)?.name ?? null,
    stop: stopId => stopsById.get(stopId) ?? null,
    stopPairRoutes: () => (stopPairRoutesCache ??= live ? routesByStopPair(live.trips) : new Map()),
    ridership: () => ridership,
    onSpeedMap: showSpeedLayer,
    async onBunching(event) {
      const key = `${event.date}|${event.leader}|${event.follower}`;
      try {
        const track = await getApiJson(`/api/bunching-track?key=${encodeURIComponent(key)}`);
        selectBus(null);
        selectStop(null);
        panel.showBunching(track);
      } catch (err) {
        showToast?.(`Couldn't load this replay: ${err.message}`);
      }
    },
    onCanceled(record, related) {
      selectBus(null);
      selectStop(null);
      panel.showCanceled(record, related);
    },
    tripInfo(tripId, date) {
      const trip = live?.trips[tripId];
      if (!trip) return null;
      const first = trip.s.find(r => r[2] != null);
      const last = trip.s.findLast(r => r[2] != null);
      const dayStart = date ? serviceDayStart(date, live.timezone) : null;
      return { headsign: trip.h, start: date && first ? dayStart + first[2] : null, end: date && last ? dayStart + last[2] : null, stops: trip.s.length, routeId: trip.r, dir: trip.d, block: trip.b ?? null, startSecs: first?.[2] ?? null };
    },
    onSettings: changeSettings,
    onOpen(name) {
      if (name && !panelsFitSideBySide()) panel.close();
    },
  });
  applyDisplaySettings();

  // Open what the link asked for: its route filter (else the saved one), then a stop or trip.
  const routeIdByNumber = new Map(routesList.map(r => [r.routeShortName, r.routeId]));
  const linked = link.routes?.map(n => routeIdByNumber.get(n) ?? (routesById.has(n) ? n : null)).filter(Boolean);
  shellReady = true;
  if (linked?.length) setRouteFilter(linked);
  else setRouteFilter(settings.routes, { save: false });
  if (link.stop) openStop(link.stop);
  else if (link.trip) {
    pendingTripFocus = link.trip;
    openTrip(link.trip, link.date, null);
  }
}

function writeLink() {
  if (!shellReady) return;
  const routes = routeFilter ? routesList.filter(r => routeFilter.has(r.routeId)).map(r => r.routeShortName) : null;
  const search = linkSearch(location.search, { routes, view: panelView });
  if (search !== location.search) history.replaceState(history.state, '', `${location.pathname}${search}${location.hash}`);
}

function changeSettings(patch) {
  Object.assign(settings, patch);
  saveSettings(settings);
  if ('theme' in patch) {
    // A different basemap style means rebuilding every layer, so reload instead. Drop any ?theme=
    // from the URL first, or it would override the new setting.
    const params = new URLSearchParams(location.search);
    params.delete('theme');
    const query = params.toString().replace(/%2C/g, ',');
    location.replace(`${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
    return;
  }
  if ('timeFormat' in patch) {
    setTimeFormat(settings.timeFormat);
    tickClock();
    panel.refresh();
    sidebar.refresh();
  }
  if ('radar' in patch || 'timeFormat' in patch) updateRadar();
  applyDisplaySettings();
}

function applyDisplaySettings() {
  if (map.getLayer('stop-labels')) map.setLayoutProperty('stop-labels', 'visibility', settings.stopNames ? 'visible' : 'none');
  updateStops();
}

// A bunching marker first, then a bus, then a stop under the pointer.
map.on('click', e => {
  const near = radius => [[e.point.x - radius, e.point.y - radius], [e.point.x + radius, e.point.y + radius]];
  const [bunch] = map.getLayer('bunching') ? map.queryRenderedFeatures(near(CLICK_RADIUS_PX), { layers: ['bunching'] }) : [];
  if (bunch && bunches[bunch.properties.index]) {
    showBunchPopup(bunches[bunch.properties.index], e.lngLat);
    return;
  }
  const bus = (map.getLayer('buses') ? map.queryRenderedFeatures(near(CLICK_RADIUS_PX), { layers: ['buses'] }) : []).find(f => f.properties.tripId);
  if (bus) {
    openTrip(bus.properties.tripId, null, bus.properties.id);
    return;
  }
  const r = STOP_CLICK_RADIUS_PX;
  const [stop] = map.getLayer('stops')
    ? map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers: ['stops'] })
    : [];
  if (stop) openStop(stop.properties.id, { fly: false });
  else panel.close();
});

// What a bunching marker says when clicked: the route, how close the two buses are against the
// timetable, at which stop, and a way to open either bus's trip.
function showBunchPopup(event, lngLat) {
  bunchPopup?.remove();
  const gap = s => (s < 60 ? `${s} s` : `${Math.round(s / 60)} min`);
  const busButton = (label, tripId, busId) => {
    const b = el('button', { type: 'button', className: 'small-button' }, label);
    b.addEventListener('click', () => {
      bunchPopup?.remove();
      openTrip(tripId, null, busId);
    });
    return b;
  };
  const body = el('div', { className: 'bunch-popup' },
    el('div', { className: 'bunch-title' }, routeBadge(live.routeInfo(event.routeId)), el('strong', {}, 'Buses bunched')),
    el('p', {}, `Due at ${event.stopName ?? 'the same stop'} ${gap(event.actualS)} apart; the timetable has them ${gap(event.scheduledS)} apart.`),
    el('p', { className: 'status' }, 'Riders there get two buses at once, then a long wait for the next.'),
    el('div', { className: 'bunch-actions' }, busButton(`Front bus ${event.leaderBus}`, event.leader, event.leaderBus), busButton(`Following bus ${event.followerBus}`, event.follower, event.followerBus)));
  bunchPopup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px', className: 'bunch-popup-shell' }).setLngLat(lngLat).setDOMContent(body).addTo(map);
}

// ---- Boot ------------------------------------------------------------------------------------

// The first layer of the style's top block of labels. "The first symbol layer" isn't safe:
// OpenFreeMap's dark style draws water labels underneath its roads.
function topLabelLayerId() {
  const layers = map.getStyle().layers;
  let lastNonLabel = -1;
  layers.forEach((layer, i) => { if (layer.type !== 'symbol') lastNonLabel = i; });
  return layers[lastNonLabel + 1]?.id;
}

map.on('load', async () => {
  // Draw order: the style's roads, then route lines, stops, buses, stop names, and the style's
  // labels on top.
  const labelsId = topLabelLayerId();
  addBusLayers(labelsId);
  const belowBuses = 'buses-late';
  try {
    const { folder } = await getJson('data/manifest.json');
    const [routes, stops, schedule] = await Promise.all([
      addRouteLines(folder, belowBuses),
      addStops(folder, belowBuses, labelsId),
      getJson(`data/${folder}/schedule.json`),
    ]);
    live = new LiveFeed({ schedule, routes, stops, now: () => Date.now() + serverClockOffsetS * 1000 });
    // The two load in parallel, so either may have been added first: keep the lines under the stops.
    if (map.getLayer('routes') && map.getLayer('stops')) map.moveLayer('routes', 'stops');
    createShell();
    updateRadar(); // after the route lines exist, so the radar can go underneath them
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Route data missing: run "npm run build:static".';
  }
  booted = true;
  startPolling();
});
