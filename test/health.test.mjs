import test from 'node:test';
import assert from 'node:assert/strict';
import { healthReport } from '../server/health.mjs';

const nowS = 1_800_000_000;
const healthy = {
  nowS,
  lastRefreshS: nowS - 5,
  vehicleFeedS: nowS - 8,
  feedErrors: [],
  timetableEnd: '20270116',
  today: '20261023',
  daysLeft: 85,
  lastBuild: { ok: true },
  builtAtS: nowS - 3600,
};
const level = (report, name) => report.checks.find(c => c.name === name)?.level;

test('everything fresh is ok', () => {
  const r = healthReport(healthy);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.checks.map(c => c.name), ['feed', 'bct-data', 'timetable', 'nightly-build']);
});

test('a stale or failing feed degrades, then takes the service down', () => {
  assert.equal(healthReport({ ...healthy, lastRefreshS: nowS - 200 }).status, 'degraded');
  assert.equal(healthReport({ ...healthy, lastRefreshS: nowS - 700 }).status, 'down');
  assert.equal(healthReport({ ...healthy, lastRefreshS: null }).status, 'down');
  // Refreshing fine, but BCT keeps republishing old positions.
  assert.equal(level(healthReport({ ...healthy, vehicleFeedS: nowS - 900 }), 'bct-data'), 'down');
  assert.equal(healthReport({ ...healthy, feedErrors: ['alerts -> HTTP 500'] }).status, 'degraded');
});

test('the timetable warns before it ends and is down after', () => {
  assert.equal(healthReport({ ...healthy, timetableEnd: '20261028', daysLeft: 5 }).status, 'degraded');
  assert.equal(healthReport({ ...healthy, timetableEnd: '20261022', daysLeft: -1 }).status, 'down');
});

test('a failed or overdue nightly rebuild degrades', () => {
  const failed = healthReport({ ...healthy, lastBuild: { ok: false, error: 'HTTP 503' } });
  assert.equal(failed.status, 'degraded');
  assert.match(failed.checks.find(c => c.name === 'nightly-build').detail, /HTTP 503/);
  assert.equal(healthReport({ ...healthy, lastBuild: null, builtAtS: nowS - 40 * 3600 }).status, 'degraded');
});

test('the Worker database: degraded past 60% of a daily free-plan limit, down past 95%', () => {
  const usage = (read, written) => ({ read, written, readLimit: 5_000_000, writtenLimit: 100_000 });
  const level = u => healthReport({ ...healthy, dbUsage: u }).checks.find(c => c.name === 'database').level;
  assert.equal(level(usage(200_000, 30_000)), 'ok');
  assert.equal(level(usage(3_500_000, 30_000)), 'degraded');
  assert.equal(level(usage(200_000, 97_000)), 'down');
  assert.equal(healthReport(healthy).checks.some(c => c.name === 'database'), false); // the Node server: no such limit
});
