// Replays a bunching event on the map: the two buses' GPS tracks (server/tracks.mjs) drawn as
// "ghost" buses with trails, moving along their route's shape between reports, with a timeline the
// side panel controls.
import { distanceMeters } from './gtfs-util.js';

export const GHOST_COLORS = { leader: '#2563eb', follower: '#f59e0b' };
const SOURCE = 'replay';
const LAYERS = ['replay-trails', 'replay-ghosts', 'replay-labels'];

// A bus's position at unix time t from [[t, lat, lon]] samples (oldest first): null before the
// first, the last after the last, else straight-line in between. Pure, for tests.
export function interpolate(points, t) {
  if (!points.length || t < points[0][0]) return null;
  if (t >= points.at(-1)[0]) return [points.at(-1)[2], points.at(-1)[1]];
  let i = 1;
  while (points[i][0] < t) i++;
  const [t0, lat0, lon0] = points[i - 1];
  const [t1, lat1, lon1] = points[i];
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
  return [lon0 + (lon1 - lon0) * f, lat0 + (lat1 - lat0) * f];
}

// map: the MapLibre map. line(tripId) -> { line: ShapeLine in scene metres, toScene, fromScene } or
// null, so the ghosts follow the street between reports instead of cutting corners.
export function createReplay({ map, line }) {
  let track = null;
  let t = 0;
  let speed = 30;
  let playing = false;
  let frame = null;
  let lastFrame = null;
  let buses = []; // [{ role, vehicleId, points, along: [[t, along]] | null, line }]
  const listeners = new Set();

  function positionOf(bus, time) {
    if (bus.along && bus.along.length >= 2 && time >= bus.along[0][0]) {
      const a = bus.along;
      if (time >= a.at(-1)[0]) return bus.line.fromScene(bus.line.line.pointAt(a.at(-1)[1]));
      let i = 1;
      while (a[i][0] < time) i++;
      const f = (time - a[i - 1][0]) / Math.max(1, a[i][0] - a[i - 1][0]);
      return bus.line.fromScene(bus.line.line.pointAt(a[i - 1][1] + (a[i][1] - a[i - 1][1]) * f));
    }
    return interpolate(bus.points, time);
  }

  function data() {
    const features = [];
    for (const bus of buses) {
      const trail = bus.points.filter(p => p[0] <= t).map(p => [p[2], p[1]]);
      const here = positionOf(bus, t);
      if (here) trail.push(here);
      if (trail.length >= 2) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: trail }, properties: { kind: 'trail', role: bus.role } });
      if (here) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: here },
          properties: { kind: 'ghost', role: bus.role, label: `Bus ${bus.vehicleId} · ${bus.role === 'leader' ? 'ahead' : 'behind'}` },
        });
      }
    }
    return { type: 'FeatureCollection', features };
  }

  function draw() {
    if (!map.getSource(SOURCE)) {
      map.addSource(SOURCE, { type: 'geojson', data: data() });
      const color = ['match', ['get', 'role'], 'leader', GHOST_COLORS.leader, GHOST_COLORS.follower];
      map.addLayer({ id: 'replay-trails', type: 'line', source: SOURCE, filter: ['==', ['get', 'kind'], 'trail'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': color, 'line-width': 4, 'line-opacity': 0.45 } });
      map.addLayer({ id: 'replay-ghosts', type: 'circle', source: SOURCE, filter: ['==', ['get', 'kind'], 'ghost'], paint: { 'circle-radius': 11, 'circle-color': color, 'circle-opacity': 0.75, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
      map.addLayer({
        id: 'replay-labels', type: 'symbol', source: SOURCE, filter: ['==', ['get', 'kind'], 'ghost'],
        layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-allow-overlap': true },
        paint: { 'text-color': color, 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      });
    } else {
      map.getSource(SOURCE).setData(data());
    }
    for (const fn of listeners) fn(state());
  }

  // Straight-line distance between the two ghosts now, in metres (null until both are on the map).
  function gapM() {
    const [a, b] = buses.map(bus => positionOf(bus, t));
    return a && b ? distanceMeters(a[1], a[0], b[1], b[0]) : null;
  }

  const state = () => ({ t, start: track?.start, end: track?.end, playing, speed, gapM: gapM() });

  function tick(now) {
    frame = null;
    if (!playing) return;
    const dt = lastFrame == null ? 0 : (now - lastFrame) / 1000;
    lastFrame = now;
    t = Math.min(track.end, t + dt * speed);
    if (t >= track.end) playing = false;
    draw();
    if (playing) frame = requestAnimationFrame(tick);
  }

  return {
    // Shows a track and returns the bounds to fit the camera to: [[west, south], [east, north]].
    start(next) {
      this.stop();
      track = next;
      t = track.start;
      buses = track.buses.map(bus => {
        const shaped = line(bus.tripId);
        let along = null;
        if (shaped) {
          let near = null;
          along = bus.points.map(([ts, lat, lon]) => {
            const [x, y] = shaped.toScene([lon, lat]);
            const p = shaped.line.project(x, y, { near });
            near = p.along;
            return [ts, p.along];
          });
        }
        return { ...bus, line: shaped, along };
      });
      draw();
      const all = track.buses.flatMap(b => b.points);
      if (!all.length) return null;
      const lons = all.map(p => p[2]);
      const lats = all.map(p => p[1]);
      return [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
    },
    stop() {
      playing = false;
      if (frame) cancelAnimationFrame(frame);
      frame = null;
      track = null;
      buses = [];
      for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SOURCE)) map.removeSource(SOURCE);
    },
    play() {
      if (!track) return;
      if (t >= track.end) t = track.start;
      playing = true;
      lastFrame = null;
      frame ??= requestAnimationFrame(tick);
      draw();
    },
    pause() {
      playing = false;
      draw();
    },
    seek(time) {
      if (!track) return;
      t = Math.max(track.start, Math.min(track.end, time));
      draw();
    },
    setSpeed(next) {
      speed = next;
      draw();
    },
    // fn(state) after every change; returns a function that unsubscribes.
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get active() {
      return track != null;
    },
  };
}
