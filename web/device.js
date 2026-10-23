// Small pure helpers about where the viewer is and what their device can manage, unit-tested in Node.

const KM_PER_DEG_LAT = 111.32;
const toRad = d => (d * Math.PI) / 180;

// Broward County Transit's service area: the box around its stops ([{ lon, lat }]), widened by
// `marginKm` so someone a short walk outside still counts as in.
export function serviceArea(stops, marginKm = 2) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const { lon, lat } of stops) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  const dLat = marginKm / KM_PER_DEG_LAT;
  const dLon = marginKm / (KM_PER_DEG_LAT * Math.cos(toRad((south + north) / 2)));
  return { west: west - dLon, south: south - dLat, east: east + dLon, north: north + dLat };
}

// Straight-line km from [lon, lat] to the nearest point of `area`; 0 inside it.
export function kmOutside([lon, lat], area) {
  const nearLon = Math.min(area.east, Math.max(area.west, lon));
  const nearLat = Math.min(area.north, Math.max(area.south, lat));
  const a = Math.sin(toRad(nearLat - lat) / 2) ** 2 +
    Math.cos(toRad(lat)) * Math.cos(toRad(nearLat)) * Math.sin(toRad(nearLon - lon) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}

// Decides once whether the device is struggling to draw the 3D buses, from the gaps between frames
// while the map animates. Gaps longer than `maxGapMs` are the browser throttling a background tab
// (or the map sitting idle), not a slow device, so they're ignored. frame() returns null until it
// has `samples` gaps, then 'slow' (median gap over `slowMs`) or 'ok' for good.
export function createFrameMonitor({ samples = 90, slowMs = 50, maxGapMs = 250 } = {}) {
  const gaps = [];
  let last = null;
  let verdict = null;
  return {
    frame(nowMs) {
      if (verdict) return verdict;
      if (last != null) {
        const gap = nowMs - last;
        if (gap > 0 && gap <= maxGapMs) gaps.push(gap);
      }
      last = nowMs;
      if (gaps.length >= samples) {
        gaps.sort((a, b) => a - b);
        verdict = gaps[gaps.length >> 1] > slowMs ? 'slow' : 'ok';
      }
      return verdict;
    },
  };
}
