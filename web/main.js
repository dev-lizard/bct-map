// Live 3D map: OpenFreeMap basemap in MapLibre GL, 3D buildings, BCT route lines, and one three.js
// box per bus drawn in a MapLibre custom layer. Buses are snapped to their trip's route shape and
// played back along it a fixed delay behind the feed, dead-reckoning when a report is late (see
// web/reckon.js). Clicking a bus or stop opens its trip timeline or departure board (web/panel.js);
// the left rail opens routes with the route filter, search, alerts and settings (web/sidebar.js).
// Settings persist in localStorage (web/settings.js) and the view lives in the URL (web/links.js).
/* global maplibregl */
import * as THREE from 'three';
import { apiUrl, getApiJson } from './api.js';
import { cityName, describeAmenities } from './amenities.js';
import { unpackBundle } from './gtfs-rt.js';
import { LiveFeed } from './live.js';
import { addDays, serviceDayStart, servicesOn, ymdInZone } from './gtfs-util.js';
import { routesByStopPair, SPEED_BANDS } from './speeds.js';
import { canceledTripDetails } from './canceled.js';
import { createReplay } from './replay.js';
import { createFrameMonitor, kmOutside, serviceArea } from './device.js';
import { el, formatClock, formatDate, formatTime, formatWhen, icon, routeBadge, setTimeFormat } from './dom.js';
import { linkSearch, parseLink } from './links.js';
import { createPanel } from './panel.js';
import { MAX_SPEED_MPS, approach, positionAt, pushReport, reckonCap, updateSpeed } from './reckon.js';
import { createSearchIndex } from './search.js';
import { loadSettings, saveSettings } from './settings.js';
import { ShapeLine } from './shapes.js';
import { createSidebar } from './sidebar.js';

const POLL_MS = 10_000; // BCT republishes about every 10 s
const TIMEZONE = 'America/New_York';
const CENTER = [-80.1437, 26.1224]; // Broward Central Terminal, Fort Lauderdale
const MAX_BOUNDS = [[-80.95, 25.55], [-79.85, 26.6]];
const BUS = { length: 12, width: 2.6, height: 3.2 }; // metres, about a 40 ft bus
const MIN_BUS_PX = 18; // buses never draw shorter than this on screen, however far out you zoom
const LATE_AFTER_S = 120; // aklcommute.nz shows its "late" glow from 2 minutes
const CLICK_RADIUS_PX = 28;
const STOP_CLICK_RADIUS_PX = 8;

// Buses are drawn where the feed says they were this long ago. Replaying 3 minutes of live BCT data
// (2026-10-22), a bus was already drawn more than 50 m past its next report when it arrived 20% of
// the time with no delay, 5.5% at 20 s, 1.2% at 30 s and 0.4% at 40 s; moving buses stood still
// 38%, 21%, 8% and 3% of the time. Lower it for fresher positions, raise it for smoother ones.
const PLAYBACK_DELAY_S = 30;
// Reports further than this from the trip's shape count as off-route (deadheading, detours, depots).
const SNAP_MAX_OFFSET_M = 40;
// Further than this between two reports, glide straight there instead of driving the whole street.
const MAX_SHAPE_JUMP_M = 2500;
// A report up to this far behind the last one is GPS jitter, not the bus reversing.
const BACKTRACK_TOLERANCE_M = 30;
// Drawn further ahead of a new report than this, the bus glides back instead of waiting for it.
const MAX_HOLD_M = 150;
// Moves onto the route (first sighting, trip change, big correction) take this long.
const GLIDE_ONTO_ROUTE_MS = 2000;
// Each bus's report interval, smoothed and kept within these bounds. It sets how far past a report
// the bus may be dead-reckoned, and how long off-route glides last.
const MIN_GAP_S = 5;
const MAX_GAP_S = 30;
const GAP_SMOOTHING = 0.3;
// Longest single frame step, so buses catch up rather than teleport after a stall (e.g. a background tab).
const MAX_FRAME_S = 0.5;

// Muted basemaps so route colours stand out, like the original's "faded" Mapbox theme.
const THEMES = {
  day: {
    style: 'https://tiles.openfreemap.org/styles/positron', buildings: '#dcd9d2', ambient: 2.2, sun: 2.2,
    stopFill: '#ffffff', stopStroke: '#3c3c43', label: '#3c3c43', labelHalo: '#ffffff', selected: '#1d1d1f',
  },
  night: {
    style: 'https://tiles.openfreemap.org/styles/dark', buildings: '#303036', ambient: 1.6, sun: 1.0,
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

// ---- Header: clock and weather ---------------------------------------------------------------

const dateEl = document.getElementById('date');
const clockEl = document.getElementById('clock');
const weatherEl = document.getElementById('weather');

function tickClock() {
  const now = new Date();
  dateEl.textContent = formatDate(now);
  clockEl.textContent = formatClock(now);
}
tickClock();
setInterval(tickClock, 1000);

// The API caches Open-Meteo for 10 minutes, so asking it every 5 is cheap.
async function refreshWeather() {
  try {
    const w = await getApiJson('/api/weather');
    weatherEl.replaceChildren(icon(w.kind), el('strong', {}, `${w.temperatureF}°F`), ` ${w.condition}`);
    weatherEl.title = `Feels like ${w.feelsLikeF}°F · wind ${w.windMph} mph${w.stale ? ' · not updated recently' : ''} (Open-Meteo)`;
    weatherEl.hidden = false;
  } catch {
    weatherEl.hidden = true; // the header just goes without weather
  }
}
refreshWeather();
setInterval(refreshWeather, 5 * 60_000);

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
      const beforeId = ['routes', 'stops', '3d-buildings'].find(id => map.getLayer(id));
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
// ---- Weather alerts --------------------------------------------------------------------------

// National Weather Service alerts for Broward go in the Alerts panel. Severe and extreme ones
// (hurricane, tornado and flash flood warnings, say) also get a banner in the header.
const weatherBannerEl = document.getElementById('weather-banner');
let weatherAlerts = { alerts: [], moreUrl: null };

async function refreshWeatherAlerts() {
  try {
    weatherAlerts = await getApiJson('/api/weather-alerts');
  } catch {
    return; // keep the last list rather than flash it away
  }
  sidebar?.setWeatherAlerts(weatherAlerts);
  const top = weatherAlerts.alerts.find(a => a.severity === 'Extreme' || a.severity === 'Severe');
  weatherBannerEl.hidden = !top;
  if (top) {
    const more = weatherAlerts.alerts.length - 1;
    weatherBannerEl.replaceChildren(icon('warning'),
      el('span', {}, el('strong', {}, top.event), top.ends ? ` until ${formatWhen(top.ends)}` : '', more > 0 ? ` · ${more} more` : ''));
    weatherBannerEl.title = top.headline;
  }
}
weatherBannerEl.addEventListener('click', () => sidebar?.show('alerts'));
refreshWeatherAlerts();
setInterval(refreshWeatherAlerts, 3 * 60_000);

// ---- Installable app -------------------------------------------------------------------------

// The service worker (web/sw.js) lets phones install the app and reopens it quickly. It's optional:
// without it (old browsers, private windows) everything works the same.
if ('serviceWorker' in navigator) {
  const register = () => navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register);
}

// ---- Tropical storms -------------------------------------------------------------------------

// The National Hurricane Center's forecast cone, track and points for active Atlantic storms, under
// the route lines. NHC advises every 6 hours (3 when a storm threatens land), so checking every 15
// minutes is plenty. ?storms=all in the URL shows every basin, for testing outside the season.
const stormNoteEl = document.getElementById('storm-note');
const STORM_LAYERS = ['storm-cone', 'storm-cone-edge', 'storm-track', 'storm-points', 'storm-labels'];
const stormQuery = new URLSearchParams(location.search).get('storms') === 'all' ? '?basin=all' : '';
let stormTimer = null;

async function updateStorms() {
  const show = visible => {
    for (const id of STORM_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  };
  if (!settings.storms) {
    show(false);
    stormNoteEl.hidden = true;
    clearInterval(stormTimer);
    stormTimer = null;
    return;
  }
  stormTimer ??= setInterval(updateStorms, 15 * 60_000);
  let data;
  try {
    data = await getApiJson(`/api/storms${stormQuery}`);
  } catch {
    return;
  }
  if (!settings.storms) return; // switched off while loading
  if (!map.getSource('storms')) addStormLayers(data.features);
  else map.getSource('storms').setData(data.features);
  show(true);
  stormNoteEl.hidden = data.storms.length === 0;
  // The map only reaches a little past Broward, so say whether the cone covers the county.
  const lines = data.storms.map(s => el('span', {},
    el('a', { href: s.url, target: '_blank', rel: 'noopener' }, `${s.classification} ${s.name}`),
    s.browardInCone ? ': Broward is inside the forecast cone' : ': its forecast cone does not reach Broward'));
  stormNoteEl.replaceChildren(icon('hurricane'), el('span', { className: 'storm-lines' }, ...lines));
}

function addStormLayers(data) {
  map.addSource('storms', { type: 'geojson', data, attribution: 'Storms: NOAA National Hurricane Center' });
  const beforeId = ['radar', 'routes', 'stops', '3d-buildings'].find(id => map.getLayer(id));
  const kind = k => ['==', ['get', 'kind'], k];
  // Point colours by NHC's label: hurricane or major hurricane, tropical storm, depression, other.
  const pointColor = ['match', ['get', 'label'], ['H', 'M'], '#dc2626', 'S', '#f59e0b', 'D', '#2563eb', '#6b7280'];
  map.addLayer({ id: 'storm-cone', type: 'fill', source: 'storms', filter: kind('cone'), paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.1 } }, beforeId);
  map.addLayer({ id: 'storm-cone-edge', type: 'line', source: 'storms', filter: kind('cone'), paint: { 'line-color': '#dc2626', 'line-width': 1.5, 'line-dasharray': [3, 2] } }, beforeId);
  map.addLayer({ id: 'storm-track', type: 'line', source: 'storms', filter: kind('track'), paint: { 'line-color': theme.label, 'line-width': 2 } }, beforeId);
  map.addLayer({ id: 'storm-points', type: 'circle', source: 'storms', filter: kind('point'), paint: { 'circle-radius': 7, 'circle-color': pointColor, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 } }, beforeId);
  map.addLayer({
    id: 'storm-labels',
    type: 'symbol',
    source: 'storms',
    filter: kind('point'),
    layout: { 'text-field': ['get', 'time'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-allow-overlap': true },
    paint: { 'text-color': theme.label, 'text-halo-color': theme.labelHalo, 'text-halo-width': 1.2 },
  }, beforeId);
}

const isNarrow = () => !window.matchMedia('(min-width: 641px)').matches; // panels become bottom sheets
// The sidebar column (to 412 px) and the detail panel (360 px from the right) both fit from here up;
// below it, opening one closes the other.
const panelsFitSideBySide = () => window.matchMedia('(min-width: 800px)').matches;
const map = new maplibregl.Map({
  container: 'map',
  style: theme.style,
  center: CENTER,
  zoom: 15,
  pitch: 60,
  bearing: -17,
  maxPitch: 75,
  maxBounds: MAX_BOUNDS,
  hash: true, // keeps the camera in the URL (#zoom/lat/lon/bearing/pitch) so views can be shared
});
// Bottom-left, so the detail panel on the right never covers it.
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-left');

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

// ---- Your location ---------------------------------------------------------------------------

const geolocate = new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
  fitBoundsOptions: { maxZoom: 16 },
});
map.addControl(geolocate, 'bottom-left');
let serviceBox = null; // Broward County Transit's service area, once the stops have loaded
let toldOutside = false; // say so once per tracking session, not on every position update
const formatKm = km => Math.max(1, Math.round(km)).toLocaleString('en-US');

// Inside the map's limits but outside BCT's area (e.g. Palm Beach): the control shows you there.
geolocate.on('geolocate', position => {
  const km =serviceBox ? kmOutside([position.coords.longitude, position.coords.latitude], serviceBox) : 0;
  if (km < 1 || toldOutside) return;
  toldOutside = true;
  showToast(`You're about ${formatKm(km)} km outside Broward County Transit's service area.`, {
    label: 'Back to Broward',
    run: () => map.easeTo({ center: CENTER, zoom: 13, duration: 1000 }),
  });
});
// Beyond the map's limits the control leaves the camera where it is, so say why nothing happened.
geolocate.on('outofmaxbounds', position => {
  if (toldOutside) return;
  toldOutside = true;
  const coords = position?.coords;
  const km = serviceBox && coords ? kmOutside([coords.longitude, coords.latitude], serviceBox) : null;
  showToast(km
    ? `You're about ${formatKm(km)} km from Broward, so the map stays on Broward County.`
    : "You're outside Broward, so the map stays on Broward County.");
});
geolocate.on('error', err => {
  showToast(err?.code === 1
    ? 'Location is blocked for this site. Allow it in your browser to see where you are.'
    : "Couldn't find your location.");
});
// Pressing locate takes over the camera, so stop following a bus. (The reverse needs nothing: any
// camera move not made by the control, including follow mode's, drops it out of its locked state.)
geolocate.on('trackuserlocationstart', () => stopFollow());
geolocate.on('trackuserlocationend', () => {
  toldOutside = false;
});

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// ---- Scene coordinates -----------------------------------------------------------------------

// Scene units are metres east (x), north (y) and up (z) from a fixed origin in Broward. Positions go
// through exact Web Mercator offsets, so only sizes and distances depend on the origin's latitude.
const origin = maplibregl.MercatorCoordinate.fromLngLat(CENTER, 0);
const mercatorPerMeter = origin.meterInMercatorCoordinateUnits();
const originMatrix = new THREE.Matrix4()
  .makeTranslation(origin.x, origin.y, origin.z)
  .scale(new THREE.Vector3(mercatorPerMeter, -mercatorPerMeter, mercatorPerMeter));

function toScene([lon, lat]) {
  const m = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0);
  return [(m.x - origin.x) / mercatorPerMeter, -(m.y - origin.y) / mercatorPerMeter];
}

function fromScene([x, y]) {
  return new maplibregl.MercatorCoordinate(origin.x + x * mercatorPerMeter, origin.y - y * mercatorPerMeter, 0).toLngLat().toArray();
}

// Compass bearing (clockwise from north) -> scene angle (counter-clockwise from east).
function bearingToAngle(bearing) {
  return THREE.MathUtils.degToRad(90 - bearing);
}

// ---- Route shapes ----------------------------------------------------------------------------

const shapeCoords = new Map(); // shape_id -> [[lon, lat]], filled while drawing the route lines
const shapeLines = new Map(); // shape_id -> ShapeLine in scene metres, built the first time a bus needs it

function shapeLine(shapeId) {
  if (!shapeId || !shapeCoords.has(shapeId)) return null;
  let line = shapeLines.get(shapeId);
  if (!line) shapeLines.set(shapeId, (line = new ShapeLine(shapeCoords.get(shapeId).map(toScene))));
  return line;
}

// ---- Basemap layers --------------------------------------------------------------------------

// OpenFreeMap's positron and dark styles are flat, so extrude the OpenMapTiles building footprints.
function addBuildings(beforeId) {
  if (!map.getSource('openmaptiles')) return;
  map.addLayer({
    id: '3d-buildings',
    type: 'fill-extrusion',
    source: 'openmaptiles',
    'source-layer': 'building',
    minzoom: 14,
    filter: ['!=', ['get', 'hide_3d'], true],
    paint: {
      'fill-extrusion-color': theme.buildings,
      'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, ['coalesce', ['get', 'render_height'], 0]],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': 0.85,
    },
  }, beforeId);
}

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
let shownStopsKey = null;

// Stops as circles from zoom 14, with names from 16.5. Which stops show depends on the Stops setting
// and the route filter (see updateStops). Returns stops.json, which the live feed needs too.
async function addStops(folder, circlesBeforeId, labelsBeforeId) {
  const [stops, stopRoutes, amenities] = await Promise.all([
    getJson(`data/${folder}/stops.json`),
    getJson(`data/${folder}/stop_routes.json`),
    // Shelters, benches and so on; optional, since builds before it existed don't have the file.
    getJson(`data/${folder}/amenities.json`).catch(() => null),
  ]);
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
  for (const v of vehicles.values()) v.mesh.visible = routeShown(v.data.routeId);
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

// ---- 3D vehicles -----------------------------------------------------------------------------

const scene = new THREE.Scene();
const camera = new THREE.Camera();
scene.add(new THREE.AmbientLight(0xffffff, theme.ambient));
const sun = new THREE.DirectionalLight(0xffffff, theme.sun);
sun.position.set(-0.4, -0.8, 1); // high in the south-south-west
scene.add(sun);

// Box with its base at z=0 so scaling it up for visibility never sinks it into the road.
const busGeometry = new THREE.BoxGeometry(BUS.length, BUS.width, BUS.height).translate(0, 0, BUS.height / 2);
const glowGeometry = new THREE.SphereGeometry(BUS.length * 0.75, 16, 12).translate(0, 0, BUS.height / 2);
const lateMaterial = new THREE.MeshBasicMaterial({ color: 0xff7a00, transparent: true, opacity: 0.3, depthWrite: false });
const routeMaterials = new Map();

function materialFor(color) {
  if (!routeMaterials.has(color)) routeMaterials.set(color, new THREE.MeshLambertMaterial({ color }));
  return routeMaterials.get(color);
}

// Outline for the selected bus: a slightly larger box showing only its inside faces, so it reads as
// a border around the bus. Re-parented onto whichever bus is selected.
const selectionOutline = new THREE.Mesh(busGeometry, new THREE.MeshBasicMaterial({ color: theme.selected, side: THREE.BackSide }));
selectionOutline.scale.set(1.2, 1.6, 1.25);
selectionOutline.frustumCulled = false;

// True size up close; zoomed out, held at MIN_BUS_PX long on screen like the original's constant
// pixel-size scaling.
function scaleForZoom(zoom) {
  const metersPerPixel = (40_075_016.686 * Math.cos((CENTER[1] * Math.PI) / 180)) / (512 * 2 ** zoom);
  return Math.max(1, (MIN_BUS_PX * metersPerPixel) / BUS.length);
}

let renderer = null;
let lastScaleZoom = null;
let lastFrameMs = null;
let serverClockOffsetS = 0; // API clock minus this browser's clock, from each poll's X-Server-Time
// id -> per-bus state:
//   xy, heading        where and which way the bus is drawn now (scene metres, radians)
//   line, along        its trip's ShapeLine and how far along it the bus is drawn (null off-route)
//   reports, cap       recent on-shape reports ({ ts, along }) to play back, and how far past the
//                      newest one it may be dead-reckoned
//   glide              a straight-line move in progress (off-route, or getting onto the route)
//   lastTs, gapS       latest report timestamp and the bus's smoothed report interval (s)
//   lastReport, speed  latest on-route report ({ along, ts }) and smoothed speed along the shape (m/s)
const vehicles = new Map();

const vehicleLayer = {
  id: 'vehicles-3d',
  type: 'custom',
  renderingMode: '3d',
  onAdd(m, gl) {
    renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
    renderer.autoClear = false;
  },
  render(gl, args) {
    if (use2D) return; // the 2D timer moves the buses and MapLibre draws them
    const now = performance.now();
    const moving = stepMoves(now);
    keepFollowing();
    watchFrameRate(now);
    const zoom = map.getZoom();
    if (lastScaleZoom === null || Math.abs(zoom - lastScaleZoom) > 0.05) {
      lastScaleZoom = zoom;
      const s = scaleForZoom(zoom);
      for (const v of vehicles.values()) v.mesh.scale.setScalar(s);
    }
    camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(originMatrix);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    renderer.resetState();
    renderer.render(scene, camera);
    if (moving) map.triggerRepaint();
  },
};

function addVehicle(v, xy) {
  const mesh = new THREE.Mesh(busGeometry, materialFor(v.routeColor));
  mesh.scale.setScalar(scaleForZoom(map.getZoom()));
  mesh.frustumCulled = false; // three.js can't derive a reliable frustum from MapLibre's matrix
  const glow = new THREE.Mesh(glowGeometry, lateMaterial);
  glow.visible = false;
  glow.frustumCulled = false;
  mesh.add(glow);
  scene.add(mesh);
  const state = {
    mesh, glow, data: v, xy, heading: null, line: null, along: null, reports: [], cap: 0, glide: null,
    lastTs: null, gapS: POLL_MS / 1000, lastReport: null, speed: null,
  };
  placeMesh(state);
  vehicles.set(v.id, state);
  return state;
}

function placeMesh(state) {
  state.mesh.position.set(state.xy[0], state.xy[1], 0);
  if (state.heading != null) state.mesh.rotation.z = state.heading;
}

// Called with each new report. Works out where the bus is along its shape and how fast it's going,
// and queues the report for playback, or starts a straight glide when it can't follow the street.
function onReport(state, v, now) {
  const reported = toScene([v.lon, v.lat]);
  const line = shapeLine(v.shapeId);
  if (line !== state.line) {
    // New trip, or no shape: nothing learned on the old shape applies.
    Object.assign(state, { line, along: null, reports: [], lastReport: null, speed: null });
  }
  const reportedHeading = v.bearing == null ? null : bearingToAngle(v.bearing);
  // Anchor on the last *report*, not the drawn position: dead-reckoning can draw the bus ahead of the
  // data, and on an out-and-back stretch that would pull a lagging report onto the return leg.
  const near = state.lastReport?.along ?? state.along;
  const hit = line?.project(reported[0], reported[1], near != null ? { near } : { heading: reportedHeading });

  if (!hit || hit.offset > SNAP_MAX_OFFSET_M) {
    // Off its route (deadheading, detour, depot): straight line between reports, facing the way it moves.
    Object.assign(state, { reports: [], lastReport: null });
    glide(state, reported, null, reportedHeading, now, state.gapS * 1000);
    return;
  }

  // Speed along the shape since the last report; the server's straight-line estimate until then.
  const last = state.lastReport;
  const moved = last ? hit.along - last.along : null;
  if (last && moved > -BACKTRACK_TOLERANCE_M && moved < MAX_SHAPE_JUMP_M) {
    state.speed = updateSpeed(state.speed, moved, v.timestamp - last.ts);
  } else if (state.speed == null && v.speed != null) {
    state.speed = Math.min(MAX_SPEED_MPS, v.speed);
  }
  state.lastReport = { along: hit.along, ts: v.timestamp };

  if (state.along == null) {
    // Coming onto the shape (first sighting, or back from off-route): start from where it is drawn.
    const here = line.project(state.xy[0], state.xy[1], { heading: reportedHeading });
    const ahead = hit.along - here.along;
    if (here.offset <= SNAP_MAX_OFFSET_M && ahead > -BACKTRACK_TOLERANCE_M && ahead < MAX_SHAPE_JUMP_M) {
      state.glide = null;
      state.along = here.along;
    }
  }
  const drawnAhead = state.along == null ? null : state.along - hit.along;
  if (drawnAhead == null || drawnAhead <= -MAX_SHAPE_JUMP_M || drawnAhead > MAX_HOLD_M) {
    // Too far to drive along the street, or far past the report: glide onto the route instead.
    glide(state, line.pointAt(hit.along), hit.along, null, now, GLIDE_ONTO_ROUTE_MS);
  }
  pushReport(state.reports, v.timestamp, hit.along);
  const newest = state.reports.at(-1).along;
  state.cap = reckonCap(newest, state.speed ?? 0, state.gapS, nextStopAlong(line, v.nextStop, newest));
}

// The bus's next stop as a distance along its shape, or null if unknown or not on the shape.
function nextStopAlong(line, stop, along) {
  if (stop?.lon == null || stop?.lat == null) return null;
  const [x, y] = toScene([stop.lon, stop.lat]);
  const hit = line.project(x, y, { near: along });
  return hit.offset <= SNAP_MAX_OFFSET_M ? hit.along : null;
}

function glide(state, to, endAlong, fallbackHeading, now, duration) {
  const dx = to[0] - state.xy[0];
  const dy = to[1] - state.xy[1];
  state.along = null;
  state.glide = {
    from: state.xy,
    to,
    endAlong,
    heading: Math.hypot(dx, dy) > 3 ? Math.atan2(dy, dx) : fallbackHeading,
    start: now,
    duration,
  };
}

// Advances every bus to `now`. Returns true while any bus still has somewhere to go.
function stepMoves(now) {
  const dt = lastFrameMs == null ? 0 : Math.min(MAX_FRAME_S, (now - lastFrameMs) / 1000);
  lastFrameMs = now;
  const playbackTs = Date.now() / 1000 + serverClockOffsetS - PLAYBACK_DELAY_S;
  let moving = false;
  for (const v of vehicles.values()) {
    if (v.glide) {
      stepGlide(v, now);
      moving = true;
    } else if (v.reports.length && v.along != null) {
      const target = positionAt(v.reports, playbackTs, v.speed ?? 0, v.cap);
      v.along = approach(v.along, target.along, Math.max(0, target.speed), dt);
      v.xy = v.line.pointAt(v.along);
      v.heading = v.line.headingAt(v.along);
      if (v.along < target.along || target.speed > 0) moving = true;
    }
    placeMesh(v);
  }
  return moving;
}

function stepGlide(v, now) {
  const g = v.glide;
  const t = Math.min(1, (now - g.start) / g.duration);
  v.xy = [g.from[0] + (g.to[0] - g.from[0]) * t, g.from[1] + (g.to[1] - g.from[1]) * t];
  if (g.heading != null) v.heading = g.heading;
  if (t < 1) return;
  v.glide = null;
  if (g.endAlong != null) {
    v.along = g.endAlong; // on the shape now: playback takes over from the next frame
    v.heading = v.line.headingAt(v.along);
  }
}

function applyFeed(feed) {
  const now = performance.now();
  const previous = new Map(feed.previousVehiclePositions.map(p => [p.vehicleId, p]));
  const seen = new Set();
  for (const v of feed.vehiclePositions) {
    seen.add(v.id);
    let state = vehicles.get(v.id);
    if (!state) {
      // Seed playback with the report before this one, so a freshly loaded page has motion to show.
      const prev = previous.get(v.id);
      state = addVehicle(v, toScene(prev ? [prev.longitude, prev.latitude] : [v.lon, v.lat]));
      if (prev && prev.timestamp < v.timestamp) {
        state.lastTs = prev.timestamp;
        onReport(state, { ...v, lon: prev.longitude, lat: prev.latitude, timestamp: prev.timestamp, bearing: prev.bearing }, now);
      }
    } else if (v.routeColor !== state.data.routeColor) {
      state.mesh.material = materialFor(v.routeColor);
    }
    state.data = v;
    state.mesh.visible = routeShown(v.routeId);
    state.glow.visible = v.delay != null && v.delay >= LATE_AFTER_S;
    // Same report as the last poll (about a third of buses each time): nothing new to play back.
    if (v.timestamp === state.lastTs) continue;
    if (state.lastTs != null) {
      const gap = Math.min(MAX_GAP_S, Math.max(MIN_GAP_S, v.timestamp - state.lastTs));
      state.gapS += GAP_SMOOTHING * (gap - state.gapS);
    }
    state.lastTs = v.timestamp;
    onReport(state, v, now);
  }
  for (const [id, state] of vehicles) {
    if (!seen.has(id)) {
      scene.remove(state.mesh); // geometry and materials are shared, so nothing to dispose
      vehicles.delete(id);
    }
  }
  map.triggerRepaint();
  if (use2D) tick2D(); // show new and departed buses now, not at the next tick
  monitorFromMs ??= performance.now() + 3000; // let the first tiles and buses settle before judging

  lastFeed = feed;
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
  const age = Math.max(0, Math.round(Date.now() / 1000 + serverClockOffsetS - (lastFeed.feedTimestamps.vehiclePositions ?? lastFeed.generatedAt)));
  const buses = routeFilter ? `${shown.length} of ${all.length}` : `${all.length}`;
  statusEl.textContent = `${buses} buses live · ${late} running 2+ min late · data ${age}s old · drawn ${PLAYBACK_DELAY_S}s behind`;
}

// ---- Polling (paused while the tab is hidden, like the original) ------------------------------

let pollTimer = null;
let booted = false; // polling must wait for the map and route shapes, even if the tab becomes visible first
let live = null; // the LiveFeed (web/live.js), once the timetable has loaded
let firstPoll = true;

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
    // Older vehicle feeds are only needed once, to give a freshly opened page motion to show.
    const feeds = unpackBundle(bytes, { history: firstPoll });
    if (!feeds.vehiclePositions) throw new Error('no vehicle positions this time');
    firstPoll = false;
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

// ---- 2D buses: the lighter fallback ----------------------------------------------------------

// In 2D the buses are MapLibre circles with a heading arrow. A timer moves them five times a second
// instead of redrawing the whole map every frame, which is most of what makes 3D heavy.
const TWO_D_UPDATE_MS = 200;
const TWO_D_LAYERS = ['buses-2d-late', 'buses-2d', 'buses-2d-heading', 'buses-2d-selected'];
let use2D = settings.vehicles === '2d';
let twoDTimer = null;
const frameMonitor = createFrameMonitor();
let monitorFromMs = null; // when to start judging the frame rate: a few seconds after the first feed

function addBuses2D(beforeId) {
  addArrowImage();
  map.addSource('buses-2d', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'buses-2d-late',
    type: 'circle',
    source: 'buses-2d',
    filter: ['==', ['get', 'late'], true],
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 8, 16, 15], 'circle-color': '#ff7a00', 'circle-opacity': 0.3 },
  }, beforeId);
  map.addLayer({
    id: 'buses-2d',
    type: 'circle',
    source: 'buses-2d',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 8],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
    },
  }, beforeId);
  map.addLayer({
    id: 'buses-2d-heading',
    type: 'symbol',
    source: 'buses-2d',
    filter: ['==', ['get', 'hasBearing'], true],
    layout: {
      'icon-image': 'bus-arrow',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.45, 16, 0.8],
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: { 'icon-color': '#ffffff' },
  }, beforeId);
  map.addLayer({
    id: 'buses-2d-selected',
    type: 'circle',
    source: 'buses-2d',
    filter: ['==', ['get', 'id'], ''],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 7, 16, 12],
      'circle-color': 'rgba(0, 0, 0, 0)',
      'circle-stroke-color': theme.selected,
      'circle-stroke-width': 3,
    },
  }, beforeId);
  setVehicleMode(use2D);
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

function setVehicleMode(on2D) {
  use2D = on2D;
  for (const id of TWO_D_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', use2D ? 'visible' : 'none');
  clearInterval(twoDTimer);
  if (use2D) {
    twoDTimer = setInterval(tick2D, TWO_D_UPDATE_MS);
    tick2D();
  }
  map.triggerRepaint();
}

// One 2D step: move the buses, keep a followed bus centred, and hand MapLibre their new positions.
function tick2D() {
  stepMoves(performance.now());
  keepFollowing();
  if (!map.getSource('buses-2d')) return;
  const features = [];
  for (const v of vehicles.values()) {
    if (!v.mesh.visible) continue; // filtered out
    features.push({
      type: 'Feature',
      properties: {
        id: v.data.id,
        color: v.data.routeColor,
        late: v.glow.visible,
        hasBearing: v.heading != null,
        bearing: v.heading == null ? 0 : 90 - THREE.MathUtils.radToDeg(v.heading),
      },
      geometry: { type: 'Point', coordinates: fromScene(v.xy) },
    });
  }
  map.getSource('buses-2d').setData({ type: 'FeatureCollection', features });
}

// Automatic mode: if frames come too slowly while the buses animate, switch to 2D (once a visit).
function watchFrameRate(now) {
  if (settings.vehicles !== 'auto' || monitorFromMs == null || now < monitorFromMs) return;
  if (frameMonitor.frame(now) !== 'slow') return;
  monitorFromMs = Infinity;
  setVehicleMode(true);
  showToast('Buses switched to 2D to keep the map smooth on this device.', {
    label: 'Keep 3D',
    run: () => changeSettings({ vehicles: '3d' }),
  });
}

// ---- Selection and the detail panel ----------------------------------------------------------

function selectBus(vehicleId) {
  selectionOutline.removeFromParent();
  const v = vehicleId && vehicles.get(vehicleId);
  if (v) v.mesh.add(selectionOutline);
  if (map.getLayer('buses-2d-selected')) map.setFilter('buses-2d-selected', ['==', ['get', 'id'], v ? vehicleId : '']);
  map.triggerRepaint();
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
  for (const v of vehicles.values()) if (v.data.tripId === tripId) return v.data.id;
  return null;
}

// The panel opens first so the camera move can allow for it.
function openStop(stopId, { fly = true } = {}) {
  stopFollow();
  selectBus(null);
  selectStop(stopId);
  panel.showStop(stopId);
  const stop = stopsById.get(stopId);
  if (stop && fly) flyTo([stop.lon, stop.lat]);
}

function openTrip(tripId, date = null, vehicleId = vehicleForTrip(tripId)) {
  if (vehicleId !== followedId) stopFollow();
  selectStop(null);
  selectBus(vehicleId);
  panel.showTrip(tripId, date);
}

// ---- Follow a bus ----------------------------------------------------------------------------

let followedId = null;
let followHoldUntil = 0; // while the camera eases onto the bus, don't fight the animation

function startFollow(vehicleId) {
  followedId = vehicleId;
  selectBus(vehicleId);
  showBus(vehicleId);
  followHoldUntil = performance.now() + 850;
  panel.updateFollow();
}

function stopFollow() {
  if (!followedId) return;
  followedId = null;
  panel.updateFollow();
}

// Every frame while following: re-centre if the bus has drifted from the middle of the visible map,
// whether it moved or the user zoomed around the pointer.
function keepFollowing() {
  if (!followedId || performance.now() < followHoldUntil) return;
  const v = vehicles.get(followedId);
  if (!v || !v.mesh.visible) {
    stopFollow(); // the bus left the feed or was filtered out
    return;
  }
  const center = fromScene(v.xy);
  const [dx, dy] = visibleCenterOffset();
  const canvas = map.getCanvas();
  const p = map.project(center);
  if (Math.hypot(p.x - (canvas.clientWidth / 2 + dx), p.y - (canvas.clientHeight / 2 + dy)) < 0.5) return;
  map.easeTo({ center, offset: [dx, dy], duration: 0 });
}

map.on('dragstart', () => stopFollow()); // dragging means the user wants to look elsewhere

function showBus(vehicleId) {
  const v = vehicles.get(vehicleId);
  if (v) flyTo(fromScene(v.xy));
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
  onFollow: vehicleId => (followedId === vehicleId ? stopFollow() : startFollow(vehicleId)),
  isFollowing: vehicleId => followedId === vehicleId,
  onView(view) {
    panelView = view;
    if (view?.kind !== 'bunch') replay.stop();
    if (!view) {
      stopFollow();
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
let shelterStopsCache = null;

// Every stop with what's there and how many buses leave it on a weekday (the next one from today),
// for the Analytics "Shelters" tab.
function shelterStops() {
  if (shelterStopsCache || !live) return shelterStopsCache ?? [];
  let date = ymdInZone(new Date(), live.timezone);
  const weekday = d => new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8))).getUTCDay();
  while (weekday(date) === 0 || weekday(date) === 6) date = addDays(date, 1);
  const buses = live.schedule.departuresByStop(servicesOn(date, live.calendar, live.exceptions));
  shelterStopsCache = [...stopsById.values()].map(s => ({ ...s, buses: buses.get(s.id) ?? 0 }));
  return shelterStopsCache;
}

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
    }, ['stops', '3d-buildings'].find(id => map.getLayer(id)));
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
    shelterStops,
    onSpeedMap: showSpeedLayer,
    async onBunching(event) {
      const key = `${event.date}|${event.leader}|${event.follower}`;
      try {
        const track = await getApiJson(`/api/bunching-track?key=${encodeURIComponent(key)}`);
        stopFollow();
        selectBus(null);
        selectStop(null);
        panel.showBunching(track);
      } catch (err) {
        showToast?.(`Couldn't load this replay: ${err.message}`);
      }
    },
    onCanceled(record, related) {
      stopFollow();
      selectBus(null);
      selectStop(null);
      panel.showCanceled(record, related);
    },
    tripInfo(tripId, date) {
      const trip = live?.trips[tripId];
      if (!trip) return null;
      const first = trip.s.find(r => r[2] != null);
      return { headsign: trip.h, start: date && first ? serviceDayStart(date, live.timezone) + first[2] : null };
    },
    onSettings: changeSettings,
    onOpen(name) {
      if (name && !panelsFitSideBySide()) panel.close();
    },
  });
  applyDisplaySettings();
  serviceBox = serviceArea([...stopsById.values()]);
  sidebar.setWeatherAlerts(weatherAlerts);

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
  if ('storms' in patch) updateStorms();
  if ('vehicles' in patch) {
    setVehicleMode(settings.vehicles === '2d');
    sidebar.refresh(); // e.g. "Keep 3D" from the notice, while Settings is open
  }
  applyDisplaySettings();
}

function applyDisplaySettings() {
  if (map.getLayer('3d-buildings')) map.setLayoutProperty('3d-buildings', 'visibility', settings.buildings ? 'visible' : 'none');
  if (map.getLayer('stop-labels')) map.setLayoutProperty('stop-labels', 'visibility', settings.stopNames ? 'visible' : 'none');
  updateStops();
}

// Buses win over stops: the nearest bus within CLICK_RADIUS_PX, else a stop under the pointer.
map.on('click', e => {
  let bus = null;
  let bestDistance = CLICK_RADIUS_PX;
  for (const v of vehicles.values()) {
    const p = map.project(fromScene(v.xy));
    const d = Math.hypot(p.x - e.point.x, p.y - e.point.y);
    if (d < bestDistance && v.data.tripId && v.mesh.visible) {
      bus = v;
      bestDistance = d;
    }
  }
  if (bus) {
    openTrip(bus.data.tripId, null, bus.data.id);
    return;
  }
  const r = STOP_CLICK_RADIUS_PX;
  const [stop] = map.getLayer('stops')
    ? map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers: ['stops'] })
    : [];
  if (stop) openStop(stop.properties.id, { fly: false });
  else panel.close();
});

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
  // Draw order: the style's roads, then route lines, stops, buildings, buses, stop names, and the
  // style's labels on top.
  const labelsId = topLabelLayerId();
  addBuildings(labelsId);
  map.addLayer(vehicleLayer, labelsId);
  addBuses2D(labelsId);
  const belowBuildings = map.getLayer('3d-buildings') ? '3d-buildings' : 'vehicles-3d';
  try {
    const { folder } = await getJson('data/manifest.json');
    // Route lines also fill shapeCoords, which the buses snap to, so they must load before polling.
    const [routes, stops, schedule] = await Promise.all([
      addRouteLines(folder, belowBuildings),
      addStops(folder, belowBuildings, labelsId),
      getJson(`data/${folder}/schedule.json`),
    ]);
    live = new LiveFeed({ schedule, routes, stops, now: () => Date.now() + serverClockOffsetS * 1000 });
    // The two load in parallel, so either may have been added first: keep the lines under the stops.
    if (map.getLayer('routes') && map.getLayer('stops')) map.moveLayer('routes', 'stops');
    createShell();
    updateRadar(); // after the route lines exist, so the radar can go underneath them
    updateStorms();
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Route data missing: run "npm run build:static". Buses will not follow their streets.';
  }
  booted = true;
  startPolling();
});
