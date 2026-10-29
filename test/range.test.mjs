import test from 'node:test';
import assert from 'node:assert/strict';
import { dateRange, rangeParams } from '../server/range.mjs';
import { serviceDayStart } from '../web/gtfs-util.js';

const TZ = 'America/New_York';
const nowS = serviceDayStart('20261029', TZ) + 12 * 3600; // noon, Oct 29

test('the last N days, or a picked range held inside the last 30 days', () => {
  assert.deepEqual(dateRange({ days: 3, timezone: TZ, nowS }), { from: '20261027', to: '20261029', days: 3, dates: ['20261027', '20261028', '20261029'] });
  assert.deepEqual(dateRange({ from: '20261028', to: '20261027', timezone: TZ, nowS }).dates, ['20261027', '20261028']); // put in order
  const wide = dateRange({ from: '20260901', to: '20261231', timezone: TZ, nowS });
  assert.deepEqual([wide.from, wide.to, wide.days], ['20260930', '20261029', 30]); // clamped to the days kept
  assert.equal(dateRange({ days: 99, timezone: TZ, nowS }).days, 30);
});

test('request parameters: days, or both dates', () => {
  const q = s => rangeParams(new URLSearchParams(s));
  assert.deepEqual(q('days=7'), { days: 7, from: null, to: null });
  assert.deepEqual(q('from=20261020&to=20261025'), { days: 7, from: '20261020', to: '20261025' });
  assert.deepEqual(q('from=20261020'), { days: 7, from: null, to: null }); // one date alone is ignored
  assert.deepEqual(q('days=0'), { days: 1, from: null, to: null });
});
