// Deep links. The camera lives in the URL hash (MapLibre's `hash` option); the query string
// carries the rest of what's on screen, so any view can be bookmarked or shared:
//   ?routes=01,22             route filter, by route number
//   ?stop=0210                a stop's departure board
//   ?trip=<trip_id>&date=YYYYMMDD   a trip's timeline
//   ?theme=day|night          read by main.js; left untouched here

const OWN_KEYS = ['routes', 'stop', 'trip', 'date'];

export function parseLink(search) {
  const params = new URLSearchParams(search);
  const routes = params.get('routes');
  const date = params.get('date');
  return {
    routes: routes == null ? null : routes.split(',').map(r => r.trim()).filter(Boolean),
    stop: params.get('stop') || null,
    trip: params.get('trip') || null,
    date: date && /^\d{8}$/.test(date) ? date : null,
  };
}

// The query string for `state` ({ routes: [route numbers] | null, view }), keeping any parameters
// this module doesn't own. Returns '' or '?...'.
export function linkSearch(search, { routes, view }) {
  const params = new URLSearchParams(search);
  for (const key of OWN_KEYS) params.delete(key);
  if (routes) params.set('routes', routes.join(','));
  if (view?.kind === 'stop') params.set('stop', view.stopId);
  if (view?.kind === 'trip') {
    params.set('trip', view.tripId);
    if (view.date) params.set('date', view.date);
  }
  const query = params.toString().replace(/%2C/g, ','); // keep "routes=01,22" readable
  return query ? `?${query}` : '';
}
