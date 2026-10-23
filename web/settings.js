// User settings, kept in localStorage. Storage can be missing or throw (private windows, blocked
// site data), so every access is guarded and the defaults always work.

export const DEFAULT_SETTINGS = {
  theme: 'auto', // 'auto' (by the time in Broward), 'day' or 'night'
  buildings: true, // 3D buildings
  radar: false, // rain radar layer
  storms: true, // National Hurricane Center forecast cones, when there is an Atlantic storm
  vehicles: 'auto', // 'auto' (3D, switching to 2D if the device is slow), '3d' or '2d'
  stops: 'active-routes', // 'active-routes' (routes with a bus running), 'all' or 'none'
  stopNames: true,
  timeFormat: '12h', // or '24h'
  routes: null, // route filter: null for all routes, else the route_ids to show
};

const CHOICES = {
  theme: ['auto', 'day', 'night'],
  vehicles: ['auto', '3d', '2d'],
  stops: ['active-routes', 'all', 'none'],
  timeFormat: ['12h', '24h'],
};

const STORAGE_KEY = 'broward-transit-3d:settings';

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // some browsers throw just for touching localStorage when site data is blocked
  }
}

// Keeps only known keys with valid values; anything else falls back to the default.
export function sanitizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, allowed] of Object.entries(CHOICES)) {
    if (allowed.includes(raw[key])) out[key] = raw[key];
  }
  for (const key of ['buildings', 'radar', 'stopNames']) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  if (Array.isArray(raw.routes)) out.routes = raw.routes.filter(r => typeof r === 'string');
  return out;
}

export function loadSettings(storage = defaultStorage()) {
  try {
    return sanitizeSettings(JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings, storage = defaultStorage()) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(sanitizeSettings(settings)));
  } catch {
    // Full or blocked storage: the settings still apply for this visit.
  }
}
