// Live bunching markers: a red "!" floating between two buses bunched right now (the rule in
// web/bunching.js, run on the feed the page already loads, so it costs the API nothing). In 3D it's
// a bobbing three.js "!" above the pair; in 2D, a flat badge MapLibre draws. Clicking one says which
// buses, where, and how close they are against the timetable.
import * as THREE from 'three';

const COLOR = 0xe0362c;
const BAR_M = 15; // the "!"'s bar and dot at true size (a bus is 12 m long), scaled up with the buses when zoomed out
const DOT_M = 2.2;
const LIFT_M = 6; // how far above the buses it floats
const BOB_M = 2;
const BOB_MS = 1400;

// map: MapLibre map. scene: the three.js scene the buses are in. fromScene([x, y]) -> [lon, lat].
// reducedMotion: hold it still.
export function createBunchMarkers({ map, scene, fromScene, reducedMotion = false }) {
  const material = new THREE.MeshBasicMaterial({ color: COLOR });
  // The bar stands along z (up), tapering toward the dot below it.
  const barGeometry = new THREE.CylinderGeometry(1.6, 0.9, BAR_M, 16).rotateX(Math.PI / 2).translate(0, 0, DOT_M * 2.2 + BAR_M / 2);
  const dotGeometry = new THREE.SphereGeometry(DOT_M, 16, 12).translate(0, 0, DOT_M);
  let pairs = new Map(); // "leader|follower" -> { event, group }

  function makeGroup() {
    const group = new THREE.Group();
    for (const geometry of [barGeometry, dotGeometry]) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false; // three.js can't derive a reliable frustum from MapLibre's matrix
      group.add(mesh);
    }
    scene.add(group);
    return group;
  }

  // The two buses' drawn positions, or null if either isn't on the map (or is filtered out).
  function ends(pair, vehicles) {
    const a = vehicles.get(pair.event.leaderBus);
    const b = vehicles.get(pair.event.followerBus);
    if (!a || !b || !a.mesh.visible || !b.mesh.visible) return null;
    return { a, b, xy: [(a.xy[0] + b.xy[0]) / 2, (a.xy[1] + b.xy[1]) / 2] };
  }

  return {
    // events: LiveFeed.bunchedNow(). Adds markers for new pairs and removes ended ones.
    set(events) {
      const next = new Map();
      for (const event of events) {
        if (!event.leaderBus || !event.followerBus) continue;
        const key = `${event.leader}|${event.follower}`;
        const pair = pairs.get(key) ?? { group: makeGroup() };
        pair.event = event;
        next.set(key, pair);
      }
      for (const [key, pair] of pairs) if (!next.has(key)) scene.remove(pair.group);
      pairs = next;
    },

    // Each 3D frame: puts each "!" between its buses, at the buses' scale, bobbing. Returns true if
    // any is showing (so the map keeps repainting for the bob).
    place(now, vehicles, scale, hidden = false) {
      let showing = false;
      const bob = reducedMotion ? 0 : Math.sin((now / BOB_MS) * Math.PI * 2) * BOB_M;
      for (const pair of pairs.values()) {
        const at = hidden ? null : ends(pair, vehicles);
        pair.group.visible = Boolean(at);
        if (!at) continue;
        showing = true;
        pair.group.scale.setScalar(scale);
        pair.group.position.set(at.xy[0], at.xy[1], (LIFT_M + bob) * scale);
      }
      return showing && !reducedMotion;
    },

    // GeoJSON points for the 2D badges.
    features(vehicles) {
      const features = [];
      for (const pair of pairs.values()) {
        const at = ends(pair, vehicles);
        if (at) features.push({ type: 'Feature', properties: { key: `${pair.event.leader}|${pair.event.follower}` }, geometry: { type: 'Point', coordinates: fromScene(at.xy) } });
      }
      return { type: 'FeatureCollection', features };
    },

    // The pair whose marker is within radiusPx of a clicked screen point, or null. In 3D the "!"
    // floats above the buses, so its middle is projected from its drawn height.
    pick(point, vehicles, radiusPx, use2D) {
      let best = null;
      let bestDistance = radiusPx;
      for (const pair of pairs.values()) {
        const at = ends(pair, vehicles);
        if (!at) continue;
        const ground = map.project(fromScene(at.xy));
        const raised = use2D ? ground : { x: ground.x, y: ground.y - raisedPx(pair) };
        const d = Math.min(Math.hypot(ground.x - point.x, ground.y - point.y), Math.hypot(raised.x - point.x, raised.y - point.y));
        if (d < bestDistance) {
          best = pair.event;
          bestDistance = d;
        }
      }
      return best;
    },
  };

  // Roughly how far above its ground point the "!" appears on screen: its height in metres over the
  // ground resolution, foreshortened by the camera's tilt.
  function raisedPx(pair) {
    const metersPerPx = (40_075_016.686 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
    const heightM = (LIFT_M + BAR_M / 2 + DOT_M * 2) * pair.group.scale.x;
    return (heightM / metersPerPx) * Math.sin((map.getPitch() * Math.PI) / 180);
  }
}
