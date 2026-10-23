import test from 'node:test';
import assert from 'node:assert/strict';
import { ShapeLine } from '../web/shapes.js';

const deg = r => Math.round((r * 180) / Math.PI);

// East 100 m, then north 100 m (an L-shaped street).
const L = new ShapeLine([[0, 0], [100, 0], [100, 100]]);

test('length and cumulative distance', () => {
  assert.equal(L.length, 200);
});

test('project snaps a nearby point to the closest segment', () => {
  const hit = L.project(50, 7);
  assert.equal(Math.round(hit.along), 50);
  assert.equal(Math.round(hit.offset), 7);
  const hit2 = L.project(108, 60);
  assert.equal(Math.round(hit2.along), 160);
  assert.equal(Math.round(hit2.offset), 8);
});

test('project clamps beyond the ends', () => {
  assert.equal(L.project(-20, 0).along, 0);
  assert.equal(L.project(100, 150).along, 200);
});

test('pointAt interpolates and clamps', () => {
  assert.deepEqual(L.pointAt(50), [50, 0]);
  assert.deepEqual(L.pointAt(150), [100, 50]);
  assert.deepEqual(L.pointAt(-5), [0, 0]);
  assert.deepEqual(L.pointAt(999), [100, 100]);
});

test('headingAt follows the street and turns at the corner', () => {
  assert.equal(deg(L.headingAt(50)), 0);    // heading east
  assert.equal(deg(L.headingAt(150)), 90);  // heading north
  assert.equal(deg(L.headingAt(100)), 45);  // halfway round the corner
});

// Out and back on the same street: east 500 m, then back west 500 m about 2 m to the side.
const outAndBack = new ShapeLine([[0, 0], [500, 0], [500, 2], [0, 2]]);

test('near prefers the leg ahead of the last known position', () => {
  // A report at x=300, y=1 sits equally between the two legs.
  assert.equal(Math.round(outAndBack.project(300, 1, { near: 250 }).along), 300); // still outbound
  assert.equal(Math.round(outAndBack.project(300, 1, { near: 650 }).along), 702); // already returning
});

test('heading picks the leg running the same way on a first sighting', () => {
  assert.equal(Math.round(outAndBack.project(300, 1, { heading: 0 }).along), 300);
  assert.equal(Math.round(outAndBack.project(300, 1, { heading: Math.PI }).along), 702);
});

// A loop that passes the same corner at the start and near the end.
const loop = new ShapeLine([[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 5], [5, 5]]);

test('near keeps a loop route from jumping to the far side of the loop', () => {
  // A bus near the start corner, last seen just after setting off.
  assert.ok(loop.project(3, 1, { near: 2 }).along < 10);
  // The same spot when the bus was last seen coming down the final leg.
  assert.ok(loop.project(1, 4, { near: 3950 }).along > 3990);
});

test('degenerate shapes do not throw', () => {
  const one = new ShapeLine([[5, 5]]);
  assert.equal(one.project(0, 0).offset, Infinity);
  assert.deepEqual(one.pointAt(10), [5, 5]);
  const dup = new ShapeLine([[0, 0], [0, 0], [10, 0]]);
  assert.equal(Math.round(dup.project(5, 1).along), 5);
});
