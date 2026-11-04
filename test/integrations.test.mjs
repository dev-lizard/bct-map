import test from 'node:test';
import assert from 'node:assert/strict';
import { cityName, describeAmenities, encodeAmenities } from '../web/amenities.js';
import { directionsUrl } from '../web/links.js';

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
