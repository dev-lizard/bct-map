import test from 'node:test';
import assert from 'node:assert/strict';
import { cached } from '../server/extras.mjs';

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
