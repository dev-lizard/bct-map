// Search over routes and stops, run in the browser against the static data. Pure so it can be
// unit-tested in Node.

// Street-name abbreviations people type, mapped to the words BCT's stop names spell out, so
// "nw 4th st" finds "Northwest 4th Street". Applied to names too, for the few BCT abbreviates.
const ABBREVIATIONS = {
  n: 'north', s: 'south', e: 'east', w: 'west',
  nw: 'northwest', ne: 'northeast', sw: 'southwest', se: 'southeast',
  st: 'street', ave: 'avenue', av: 'avenue', blvd: 'boulevard', blv: 'boulevard', rd: 'road', dr: 'drive',
  hwy: 'highway', pkwy: 'parkway', pky: 'parkway', ln: 'lane', ct: 'court', pl: 'place', ter: 'terrace',
  cir: 'circle', ctr: 'center', term: 'terminal', sta: 'station',
};

// "NW 4th St & 6th Ave" -> ['northwest', '4th', 'street', 'and', '6th', 'avenue']
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(t => ABBREVIATIONS[t] ?? t);
}

const stripZeros = s => s.replace(/^0+(?=.)/, '');

// routes: [{ routeId, routeShortName, routeLongName, ... }]; stops: [{ id, code, name, ... }].
// Returns search(query, limit) -> [{ kind: 'route' | 'stop', item }], best first:
//   1. exact route number or stop code ("22", "0210" or "210")
//   2. names starting with the query
//   3. names containing every query word as the start of some word, in any order
// Routes come before stops on ties, then shorter names.
export function createSearchIndex({ routes, stops }) {
  const entries = [
    ...routes.map(r => ({
      kind: 'route',
      item: r,
      exact: [stripZeros(String(r.routeShortName).toLowerCase())],
      words: normalize(`${r.routeShortName} ${r.routeLongName}`),
      text: normalize(r.routeLongName).join(' '),
    })),
    ...stops.map(s => ({
      kind: 'stop',
      item: s,
      exact: [stripZeros(String(s.code ?? s.id).toLowerCase())],
      words: normalize(s.name),
      text: normalize(s.name).join(' '),
    })),
  ];

  return function search(query, limit = 20) {
    const words = normalize(query);
    if (words.length === 0) return [];
    const raw = stripZeros(query.trim().toLowerCase());
    const phrase = words.join(' ');
    const hits = [];
    for (const e of entries) {
      let score;
      if (e.exact.includes(raw)) score = 0;
      else if (words.every(w => e.words.some(n => n.startsWith(w)))) score = e.text.startsWith(phrase) ? 1 : 2;
      else continue;
      hits.push({ score, e });
    }
    hits.sort((a, b) =>
      a.score - b.score ||
      (a.e.kind === b.e.kind ? 0 : a.e.kind === 'route' ? -1 : 1) ||
      a.e.text.length - b.e.text.length);
    return hits.slice(0, limit).map(({ e }) => ({ kind: e.kind, item: e.item }));
  };
}
