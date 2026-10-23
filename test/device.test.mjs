import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameMonitor, kmOutside, serviceArea } from '../web/device.js';

// Roughly BCT's extremes: Aventura in the south-east, Boca Raton in the north, Sawgrass in the west.
const stops = [
  { lon: -80.14, lat: 25.96 },
  { lon: -80.09, lat: 26.32 },
  { lon: -80.41, lat: 26.15 },
];

test('serviceArea is the box around the stops plus a margin', () => {
  const area = serviceArea(stops, 2);
  assert.ok(area.south < 25.96 && area.south > 25.94);
  assert.ok(area.north > 26.32 && area.north < 26.34);
  assert.ok(area.west < -80.41 && area.east > -80.09);
});

test('kmOutside is 0 inside the area and grows with distance outside it', () => {
  const area = serviceArea(stops, 2);
  assert.equal(kmOutside([-80.14, 26.12], area), 0); // downtown Fort Lauderdale
  const westPalm = kmOutside([-80.05, 26.71], area);
  assert.ok(westPalm > 38 && westPalm < 44, `West Palm Beach ${westPalm}`);
  const auckland = kmOutside([174.76, -36.85], area);
  assert.ok(auckland > 12_000, `Auckland ${auckland}`);
});

test('frame monitor: smooth frames are ok, slow frames are slow', () => {
  const smooth = createFrameMonitor({ samples: 30 });
  let verdict = null;
  for (let t = 0; t <= 31 * 16; t += 16) verdict = smooth.frame(t);
  assert.equal(verdict, 'ok');

  const slow = createFrameMonitor({ samples: 30 });
  for (let t = 0; t <= 31 * 80; t += 80) verdict = slow.frame(t);
  assert.equal(verdict, 'slow');
});

test('frame monitor ignores throttled background-tab gaps and keeps its verdict', () => {
  const monitor = createFrameMonitor({ samples: 30 });
  for (let t = 0; t <= 100 * 500; t += 500) assert.equal(monitor.frame(t), null); // 2 fps when hidden
  let verdict = null;
  for (let t = 60_000; t <= 60_000 + 31 * 16; t += 16) verdict = monitor.frame(t);
  assert.equal(verdict, 'ok');
  assert.equal(monitor.frame(200_000), 'ok'); // decided once
});
