// Small DOM helpers shared by the panels. Everything is built from nodes, never HTML strings,
// because stop names, headsigns and alert text come straight from the feed.

let clock = makeClock('12h');
let clockSeconds = makeClock('12h', true);
const dateFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });

function makeClock(format, seconds = false) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: seconds ? '2-digit' : undefined,
    hourCycle: format === '24h' ? 'h23' : 'h12',
  });
}

export function setTimeFormat(format) {
  clock = makeClock(format);
  clockSeconds = makeClock(format, true);
}

// Unix seconds -> "3:27 PM" (or "15:27"), in Broward's time zone.
export const formatTime = s => clock.format(new Date(s * 1000));
// The header clock: "Fri, Oct 23" and "3:27:05 PM", in Broward's time zone.
export const formatDate = date => dateFormat.format(date);
export const formatClock = date => clockSeconds.format(date);

// el('div', { className: 'x' }, child, 'text', ...). null and false children are skipped.
export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c != null && c !== false));
  return node;
}

export function routeBadge({ routeShortName, routeColor, routeTextColor }) {
  const badge = el('span', { className: 'route' }, routeShortName || '?');
  badge.style.background = routeColor;
  badge.style.color = routeTextColor ?? '#fff';
  return badge;
}

// Line icons drawn on a 24 x 24 grid with the current text colour.
export const ICONS = {
  routes: 'M5 6h14M5 12h14M5 18h9',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM20 20l-4.2-4.2',
  alerts: 'M12 4L2.5 20h19L12 4zM12 10v4M12 17.5v.5',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  locate: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z',
  reliability: 'M4 20h16M7 16v-5M12 16V6M17 16v-8',
  // Weather, by the `kind` the server reports.
  'clear-day': 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  'clear-night': 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  'partly-day': 'M8 18h9a3.5 3.5 0 0 0 0-7a5 5 0 0 0-9.6 1.4A2.9 2.9 0 0 0 8 18zM7 3v1.5M2.5 7.5H4M3.8 4.3l1 1',
  'partly-night': 'M8 18h9a3.5 3.5 0 0 0 0-7a5 5 0 0 0-9.6 1.4A2.9 2.9 0 0 0 8 18zM9 4.5A4 4 0 0 0 4 8',
  cloudy: 'M7 18h10a4 4 0 0 0 0-8a5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 18z',
  rain: 'M7 15h10a4 4 0 0 0 0-8a5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 15zM9 18l-1 3M13 18l-1 3M17 18l-1 3',
  storm: 'M7 15h10a4 4 0 0 0 0-8a5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 15zM13 16l-2 3h3l-2 3',
  fog: 'M4 9h16M6 13h12M4 17h16',
  snow: 'M7 15h10a4 4 0 0 0 0-8a5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 15zM9 19h.01M13 19h.01M17 19h.01',
};

export function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}
