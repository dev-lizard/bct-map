// What's at each stop: shelter, bench, lighting, trash can and bike rack from Broward County's
// "Fixed Bus Stop" GIS layer, and wheelchair access from BCT's GTFS (stops.txt wheelchair_boarding;
// the GIS layer's ADA_ACCESS column is empty). The build packs each stop into one number
// (public/data/<folder>/amenities.json); the stop panel unpacks it.

export const AMENITIES = [
  { key: 'shelter', bit: 1, label: 'Shelter' },
  { key: 'bench', bit: 2, label: 'Bench' },
  { key: 'lights', bit: 4, label: 'Lighting' },
  { key: 'trash', bit: 8, label: 'Trash can' },
  { key: 'bikeRack', bit: 16, label: 'Bike rack' },
];
const SURVEYED = 32; // the GIS layer has amenity data for this stop
const WHEELCHAIR = 64; // GTFS wheelchair_boarding 1
const NO_WHEELCHAIR = 128; // GTFS wheelchair_boarding 2

const yes = v => String(v ?? '').trim().toLowerCase() === 'yes';
const known = v => v != null && String(v).trim() !== '';

// attrs: one feature's attributes from the GIS layer, or null. wheelchair: GTFS wheelchair_boarding
// ('0', '1', '2' or '').
export function encodeAmenities(attrs, wheelchair) {
  let mask = 0;
  if (attrs && ['SHELTER', 'BENCH', 'LIGHTS', 'TRASH', 'BIKE_RACK'].some(k => known(attrs[k]))) {
    mask |= SURVEYED;
    if (yes(attrs.SHELTER)) mask |= 1;
    // OTHER_BENCH / OTHER_TRASH: ones the county doesn't own (a city's, say). Riders can use them all the same.
    if (yes(attrs.BENCH) || yes(attrs.OTHER_BENCH)) mask |= 2;
    if (yes(attrs.LIGHTS)) mask |= 4;
    if (yes(attrs.TRASH) || yes(attrs.OTHER_TRASH)) mask |= 8;
    if (yes(attrs.BIKE_RACK)) mask |= 16;
  }
  if (String(wheelchair) === '1') mask |= WHEELCHAIR;
  else if (String(wheelchair) === '2') mask |= NO_WHEELCHAIR;
  return mask;
}

// -> { surveyed, have: [{ key, label }], lack: [{ key, label }], wheelchair: true, false or null (unknown) }
export function describeAmenities(mask = 0) {
  const surveyed = Boolean(mask & SURVEYED);
  return {
    surveyed,
    have: surveyed ? AMENITIES.filter(a => mask & a.bit) : [],
    lack: surveyed ? AMENITIES.filter(a => !(mask & a.bit)) : [],
    wheelchair: mask & WHEELCHAIR ? true : mask & NO_WHEELCHAIR ? false : null,
  };
}

// "POMPANO BEACH" -> "Pompano Beach"
export function cityName(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  return s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, sep, c) => sep + c.toUpperCase());
}
