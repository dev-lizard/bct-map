import test from 'node:test';
import assert from 'node:assert/strict';
import { cityName, describeAmenities, encodeAmenities } from '../web/amenities.js';
import { directionsUrl } from '../web/links.js';
import { describeWeatherAlerts, inPolygon, stormFeatures } from '../server/extras.mjs';

test('amenities: GIS yes/no fields and GTFS wheelchair access round-trip through one number', () => {
  const gis = { SHELTER: 'yes', BENCH: 'no', OTHER_BENCH: 'yes', LIGHTS: 'no', TRASH: 'no', OTHER_TRASH: 'no', BIKE_RACK: 'yes' };
  const d = describeAmenities(encodeAmenities(gis, '1'));
  assert.equal(d.surveyed, true);
  assert.deepEqual(d.have.map(a => a.key), ['shelter', 'bench', 'bikeRack']); // a city's bench counts
  assert.deepEqual(d.lack.map(a => a.key), ['lights', 'trash']);
  assert.equal(d.wheelchair, true);
  assert.equal(describeAmenities(encodeAmenities(gis, '2')).wheelchair, false);
  assert.equal(describeAmenities(encodeAmenities(gis, '0')).wheelchair, null);
});

test('amenities: a stop missing from the GIS layer, or with blank fields, is unknown rather than bare', () => {
  for (const gis of [null, { SHELTER: null, BENCH: null, LIGHTS: null, TRASH: null, BIKE_RACK: null }]) {
    const d = describeAmenities(encodeAmenities(gis, '1'));
    assert.equal(d.surveyed, false);
    assert.deepEqual([d.have, d.lack], [[], []]);
    assert.equal(d.wheelchair, true);
  }
  assert.equal(cityName('POMPANO BEACH'), 'Pompano Beach');
  assert.equal(cityName('LAUDERDALE-BY-THE-SEA'), 'Lauderdale-By-The-Sea');
  assert.equal(cityName(null), null);
});

test('directions open Apple Maps on Apple devices and Google Maps elsewhere', () => {
  const stop = { lat: 26.056208, lon: -80.143688 };
  assert.equal(directionsUrl(stop, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'https://maps.apple.com/?daddr=26.056208,-80.143688&dirflg=r');
  assert.equal(directionsUrl(stop, 'Mozilla/5.0 (Linux; Android 14)'), 'https://www.google.com/maps/dir/?api=1&destination=26.056208,-80.143688&travelmode=transit');
});

const nwsAlert = (props) => ({ properties: { status: 'Actual', messageType: 'Alert', event: 'Test', severity: 'Minor', headline: 'h', areaDesc: 'Coastal Broward', senderName: 'NWS Miami FL', onset: '2026-10-23T10:00:00-04:00', ends: '2026-10-24T20:00:00-04:00', ...props } });

test('weather alerts: most severe first; cancelled, test and expired ones dropped', () => {
  const nowS = Date.parse('2026-10-23T12:00:00-04:00') / 1000;
  const { alerts } = describeWeatherAlerts({ features: [
    nwsAlert({ id: 'a', event: 'Rip Current Statement', severity: 'Moderate' }),
    nwsAlert({ id: 'b', event: 'Hurricane Warning', severity: 'Extreme', description: '  Line one\nwrapped.\n\nSecond.\n' }),
    nwsAlert({ id: 'c', status: 'Test' }),
    nwsAlert({ id: 'd', messageType: 'Cancel' }),
    nwsAlert({ id: 'e', ends: '2026-10-23T11:00:00-04:00', expires: null }),
  ] }, nowS);
  assert.deepEqual(alerts.map(a => a.id), ['b', 'a']);
  assert.equal(alerts[0].ends, Date.parse('2026-10-24T20:00:00-04:00') / 1000);
  assert.equal(alerts[0].description, 'Line one\nwrapped.\n\nSecond.'); // trimmed; the page joins wrapped lines
});

test('storm features keep only what the map draws', () => {
  const layer = { features: [
    { geometry: { type: 'Point', coordinates: [-80, 25] }, properties: { dvlbl: 'H', datelbl: '8:00 AM Sat', maxwind: 80 } },
    { geometry: null, properties: {} },
  ] };
  assert.deepEqual(stormFeatures(layer, 'point', { name: 'Vance' }), [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-80, 25] }, properties: { kind: 'point', storm: 'Vance', label: 'H', time: '8:00 AM Sat' } },
  ]);
});

test('inPolygon: inside, outside, in a hole, and across a MultiPolygon', () => {
  const ring = [[-81, 25], [-79, 25], [-79, 27], [-81, 27], [-81, 25]];
  const hole = [[-80.5, 26], [-80.3, 26], [-80.3, 26.2], [-80.5, 26.2], [-80.5, 26]];
  const polygon = { type: 'Polygon', coordinates: [ring, hole] };
  assert.equal(inPolygon([-80.1, 26.1], polygon), true);
  assert.equal(inPolygon([-80.4, 26.1], polygon), false);
  assert.equal(inPolygon([-70, 26], polygon), false);
  assert.equal(inPolygon([-80.4, 26.1], { type: 'MultiPolygon', coordinates: [[hole], [[[-60, 10], [-59, 10], [-59, 11], [-60, 10]]]] }), true);
});
