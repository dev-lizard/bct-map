import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSearch, parseLink } from '../web/links.js';
import { createSearchIndex, normalize } from '../web/search.js';
import { DEFAULT_SETTINGS, loadSettings, sanitizeSettings, saveSettings } from '../web/settings.js';

// ---- Search ----------------------------------------------------------------------------------

const routes = [
  { routeId: 'BCT01', routeShortName: '01', routeLongName: 'Us 1 Local' },
  { routeId: 'BCT14', routeShortName: '14', routeLongName: 'Powerline Rd Local' },
  { routeId: 'BCT22', routeShortName: '22', routeLongName: 'Broward Blvd Local' },
  { routeId: 'BCT441', routeShortName: '441', routeLongName: 'Sr 7 Breeze' },
];
const stops = [
  { id: '0210', code: '0210', name: 'Northwest 4th Street/Northwest 6th Avenue (Family Health Center)' },
  { id: '2951', code: '2951', name: 'US 1/Dania Beach Boulevard' },
  { id: '0022', code: '0022', name: 'Broward Boulevard/Southwest 22nd Avenue' },
  { id: '1001', code: '1001', name: 'Powerline Road/Northwest 18th Street' },
];
const search = createSearchIndex({ routes, stops });
const ids = results => results.map(r => r.item.routeId ?? r.item.id);

test('normalize lowercases, splits and expands street abbreviations', () => {
  assert.deepEqual(normalize('NW 4th St & 6th Ave.'), ['northwest', '4th', 'street', 'and', '6th', 'avenue']);
  assert.deepEqual(normalize(''), []);
});

test('exact route numbers and stop codes come first, leading zeros optional', () => {
  assert.deepEqual(ids(search('22')), ['BCT22', '0022']); // route before the stop with the same number
  assert.deepEqual(ids(search('210')).slice(0, 1), ['0210']);
  assert.deepEqual(ids(search('1')).slice(0, 1), ['BCT01']);
});

test('abbreviated street names find the spelled-out stop', () => {
  assert.deepEqual(ids(search('nw 4th st 6th ave')), ['0210']);
  assert.deepEqual(ids(search('family health')), ['0210']);
});

test('name matches: routes before stops, prefix matches before word matches', () => {
  assert.deepEqual(ids(search('broward blvd')), ['BCT22', '0022']);
  assert.deepEqual(ids(search('powerline')), ['BCT14', '1001']);
  assert.deepEqual(ids(search('us 1')), ['BCT01', '2951']);
});

test('no query or no match gives nothing, and the limit holds', () => {
  assert.deepEqual(search('   '), []);
  assert.deepEqual(search('xyzzy'), []);
  assert.equal(search('local', 2).length, 2);
});

// ---- Settings --------------------------------------------------------------------------------

const memoryStorage = () => {
  const data = new Map();
  return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
};

test('settings fall back to defaults when storage is missing, empty or corrupt', () => {
  assert.deepEqual(loadSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings(memoryStorage()), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings({ getItem: () => '{not json' }), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings({ getItem: () => { throw new Error('blocked'); } }), DEFAULT_SETTINGS);
});

test('settings keep valid values and drop invalid ones', () => {
  const s = sanitizeSettings({ theme: 'night', buildings: 'yes', stops: 'everything', timeFormat: '24h', routes: ['BCT22', 7], extra: 1 });
  assert.deepEqual(s, { ...DEFAULT_SETTINGS, theme: 'night', timeFormat: '24h', routes: ['BCT22'] });
});

test('settings round-trip through storage, and a failing save does not throw', () => {
  const storage = memoryStorage();
  saveSettings({ ...DEFAULT_SETTINGS, stops: 'all', routes: ['BCT01'] }, storage);
  assert.deepEqual(loadSettings(storage), { ...DEFAULT_SETTINGS, stops: 'all', routes: ['BCT01'] });
  assert.doesNotThrow(() => saveSettings(DEFAULT_SETTINGS, { setItem: () => { throw new Error('quota'); } }));
});

// ---- Deep links ------------------------------------------------------------------------------

test('parseLink reads the route filter, stop, trip and date', () => {
  assert.deepEqual(parseLink('?routes=01,22&stop=0210&theme=night'), { routes: ['01', '22'], stop: '0210', trip: null, date: null });
  assert.deepEqual(parseLink('?trip=T1&date=2026-10-22'), { routes: null, stop: null, trip: 'T1', date: null }); // bad date dropped
  assert.deepEqual(parseLink(''), { routes: null, stop: null, trip: null, date: null });
});

test('linkSearch writes the current view and keeps parameters it does not own', () => {
  assert.equal(
    linkSearch('?theme=night&stop=9999', { routes: ['01', '22'], view: { kind: 'trip', tripId: '26SEPT_01-04_7_muwtf', date: '20261022' } }),
    '?theme=night&routes=01,22&trip=26SEPT_01-04_7_muwtf&date=20261022',
  );
  assert.equal(linkSearch('?stop=0210', { routes: null, view: null }), '');
  assert.equal(linkSearch('', { routes: null, view: { kind: 'stop', stopId: '0210' } }), '?stop=0210');
});
