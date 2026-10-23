import test from 'node:test';
import assert from 'node:assert/strict';
import { cached, describeWeather, weatherKind } from '../server/extras.mjs';

test('weatherKind picks an icon for WMO codes, day and night', () => {
  assert.equal(weatherKind(0, true), 'clear-day');
  assert.equal(weatherKind(1, false), 'clear-night');
  assert.equal(weatherKind(2, true), 'partly-day');
  assert.equal(weatherKind(3, true), 'cloudy');
  assert.equal(weatherKind(45, true), 'fog');
  assert.equal(weatherKind(63, true), 'rain');
  assert.equal(weatherKind(81, false), 'rain');
  assert.equal(weatherKind(95, true), 'storm');
});

test('describeWeather turns an Open-Meteo response into the header line', () => {
  // As returned for Fort Lauderdale on 2026-10-22 (EDT, UTC-4).
  const w = describeWeather({
    utc_offset_seconds: -14400,
    current: { time: '2026-10-22T15:45', temperature_2m: 73.4, apparent_temperature: 75.7, weather_code: 2, is_day: 1, wind_speed_10m: 8.5 },
  });
  assert.deepEqual(w, {
    temperatureF: 73,
    feelsLikeF: 76,
    condition: 'Partly cloudy',
    kind: 'partly-day',
    windMph: 9,
    observedAt: Date.UTC(2026, 9, 22, 19, 45) / 1000,
  });
});

test('cached shares one load, refreshes after the ttl, and serves stale data while upstream is down', async () => {
  let t = 0;
  let calls = 0;
  let fail = false;
  const get = cached(async () => {
    calls++;
    if (fail) throw new Error('down');
    return { n: calls };
  }, 1000, { retryMs: 500, now: () => t });

  const [a, b] = await Promise.all([get(), get()]);
  assert.deepEqual([a, b, calls], [{ n: 1 }, { n: 1 }, 1]); // concurrent callers share the request
  t = 999;
  assert.deepEqual(await get(), { n: 1 }); // still fresh
  t = 1000;
  assert.deepEqual(await get(), { n: 2 }); // refreshed

  fail = true;
  t = 2500;
  assert.deepEqual(await get(), { n: 2, stale: true }); // failed refresh: last good value, flagged
  t = 2600;
  assert.deepEqual(await get(), { n: 2, stale: true });
  assert.equal(calls, 3); // within retryMs: no new attempt
  fail = false;
  t = 3100;
  assert.deepEqual(await get(), { n: 4 }); // retried after retryMs

  const broken = cached(async () => { throw new Error('down'); }, 1000);
  await assert.rejects(broken(), /down/); // nothing to fall back on
});
