// The detail panel: a stop's departure board, a trip's timeline, or the story of a canceled trip,
// refreshed with every feed poll. load(view) returns what to show (LiveFeed.stopDepartures or
// tripStopTimes in web/live.js, or canceledTripDetails in web/canceled.js).
import { el, formatDate, formatTime, formatWhen, icon, routeBadge } from './dom.js';
import { directionsUrl } from './links.js';

// "On time", "4 min late", "3 min early", from seconds of delay.
function delayText(delay) {
  const minutes = Math.round(Math.abs(delay) / 60);
  if (minutes === 0) return { text: 'On time', className: '' };
  return delay > 0 ? { text: `${minutes} min late`, className: 'late' } : { text: `${minutes} min early`, className: 'early' };
}

// The expected time, with the timetabled one struck through when they differ by a minute or more.
function timeCell(scheduled, predicted) {
  const expected = predicted ?? scheduled;
  const cell = el('span', { className: 'clock' });
  if (predicted != null && Math.abs(predicted - scheduled) >= 60) {
    cell.append(el('s', { className: 'muted' }, formatTime(scheduled)), ' ');
  }
  cell.append(formatTime(expected));
  return cell;
}

const liveDot = () => el('span', { className: 'live-dot', title: 'Live prediction' });

// onView(view) is called whenever the panel opens something or closes (view = null), so the page
// can keep the URL in step. onFollow(vehicleId) toggles follow mode; isFollowing(vehicleId) says
// whether the camera is following that bus.
// onRoute(routeId) shows a route on the map.
export function createPanel(root, { load, onStop, onTrip, onBus, onRoute, onFollow, isFollowing, onView }) {
  const titleEl = el('div', { className: 'detail-title' });
  const copyButton = el('button', { className: 'icon-button', type: 'button', title: 'Copy link to this view', ariaLabel: 'Copy link' }, icon('link'));
  const closeButton = el('button', { className: 'icon-button close', type: 'button', title: 'Close', ariaLabel: 'Close panel' }, '×');
  const bodyEl = el('div', { className: 'detail-body' });
  root.append(el('div', { className: 'detail-header' }, titleEl, copyButton, closeButton), bodyEl);

  let view = null; // { kind: 'stop', stopId } or { kind: 'trip', tripId, date }
  let request = 0;

  function close() {
    if (!view) return;
    view = null;
    request++;
    root.hidden = true;
    onView(null);
  }
  closeButton.addEventListener('click', close);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && view) close();
  });
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      copyButton.title = 'Link copied';
    } catch {
      copyButton.title = "Couldn't copy: use the address bar";
    }
    copyButton.classList.add('flash');
    setTimeout(() => {
      copyButton.classList.remove('flash');
      copyButton.title = 'Copy link to this view';
    }, 1500);
  });

  async function refresh({ scrollToNext = false } = {}) {
    if (!view) return;
    const ticket = ++request;
    try {
      const data = await load(view);
      if (!data) throw new Error('Not in the current timetable.');
      if (ticket !== request) return; // the panel moved on while this was loading
      if (view.kind === 'stop') renderStop(data);
      else if (view.kind === 'canceled') renderCanceled(data);
      else renderTrip(data, scrollToNext);
    } catch (err) {
      if (ticket !== request) return;
      titleEl.replaceChildren(el('h2', {}, 'Not available'));
      bodyEl.replaceChildren(el('p', { className: 'empty' }, `Couldn't load this: ${err.message}`));
    }
  }

  function open(next) {
    view = next;
    root.hidden = false;
    titleEl.replaceChildren(el('h2', {}, 'Loading…'));
    bodyEl.replaceChildren();
    bodyEl.scrollTop = 0;
    onView(view);
    refresh({ scrollToNext: true });
  }

  // amenities: describeAmenities() from web/amenities.js, or null if unknown. city: the stop's municipality.
  function renderStop({ stop, routes, departures, amenities = null, city = null }) {
    titleEl.replaceChildren(
      el('h2', {}, stop.name),
      el('div', { className: 'detail-sub' }, el('span', {}, `Stop ${stop.code || stop.id}${city ? ` · ${city}` : ''}`), ...routes.map(routeBadge)),
      facilities(stop, amenities),
    );
    const nowS = Date.now() / 1000;
    const rows = departures.map(d => {
      const expected = d.predicted ?? d.scheduled;
      const minutes = Math.round((expected - nowS) / 60);
      const status = el('div', { className: 'status' });
      if (d.canceled) {
        status.append('Canceled');
        if (d.vehicleId) status.append(` · bus ${d.vehicleId} still assigned`);
      } else if (d.predicted != null) {
        const { text, className } = delayText(d.delay);
        status.append(liveDot(), el('span', { className }, text));
      } else {
        status.append('Scheduled');
      }
      const row = el('button', { type: 'button', className: `row${d.canceled ? ' canceled' : ''}` },
        routeBadge(d),
        el('div', { className: 'what' }, el('div', { className: 'headsign' }, d.headsign ?? ''), status),
        el('div', { className: 'when' },
          el('div', { className: 'countdown' }, minutes <= 0 ? 'Due' : `${minutes} min`),
          timeCell(d.scheduled, d.predicted)),
      );
      row.addEventListener('click', () => onTrip(d.tripId, d.date, d.vehicleId));
      return row;
    });
    bodyEl.replaceChildren(...(rows.length ? rows : [el('p', { className: 'empty' }, 'No departures in the next 90 minutes.')]),
      el('p', { className: 'footnote' }, liveDot(), 'Live prediction. Other times are from the timetable.'));
  }

  // What's at the stop (shelter, bench, …), wheelchair access, and a link for directions to it.
  function facilities(stop, amenities) {
    const chip = (name, text, className = '') => el('span', { className: `facility ${className}`.trim() }, icon(name), text);
    const row = el('div', { className: 'facilities' });
    if (amenities?.wheelchair === true) row.append(chip('wheelchair', 'Wheelchair accessible'));
    else if (amenities?.wheelchair === false) row.append(chip('wheelchair', 'Not wheelchair accessible', 'missing'));
    for (const a of amenities?.have ?? []) row.append(chip(a.key, a.label));
    const directions = el('a', {
      className: 'small-button directions',
      href: directionsUrl(stop, navigator.userAgent),
      target: '_blank',
      rel: 'noopener',
      title: 'Transit directions to this stop',
    }, icon('directions'), 'Directions');
    row.append(directions);
    const lacking = amenities?.lack ?? [];
    return el('div', {}, row,
      lacking.length > 0 && el('div', { className: 'status muted' }, `No ${lacking.map(a => a.label.toLowerCase()).join(', ')}`));
  }

  function renderTrip(trip, scrollToNext) {
    const status = el('div', { className: 'detail-sub' });
    if (trip.canceled) status.append('Marked canceled in the live feed');
    else if (trip.delay != null) {
      const { text, className } = delayText(trip.delay);
      status.append(liveDot(), el('span', { className }, text));
    } else status.append('No live data: timetable times');
    if (trip.vehicleId) {
      const showBus = el('button', { type: 'button', className: 'link' }, `Show bus ${trip.vehicleId}`);
      showBus.addEventListener('click', () => onBus(trip.vehicleId));
      const follow = el('button', { type: 'button', className: 'small-button follow' });
      follow.dataset.vehicleId = trip.vehicleId;
      follow.addEventListener('click', () => onFollow(trip.vehicleId));
      status.append(' · ', showBus, follow);
    }
    titleEl.replaceChildren(el('h2', {}, routeBadge(trip), ' ', trip.headsign ?? ''), status);
    updateFollow();

    let nextRow = null;
    const rows = trip.stops.map(s => {
      const isNext = s.seq === trip.nextStopSeq;
      const row = el('button', { type: 'button', className: `row stop-row${s.passed ? ' passed' : ''}${isNext ? ' next' : ''}` },
        el('span', { className: 'dot', ariaHidden: 'true' }),
        el('div', { className: 'what' }, el('div', { className: 'headsign' }, s.stopName ?? s.stopId), isNext && el('div', { className: 'status' }, 'Next stop')),
        el('div', { className: 'when' }, s.scheduled == null ? '' : timeCell(s.scheduled, s.predicted)),
      );
      row.addEventListener('click', () => onStop(s.stopId));
      if (isNext) nextRow = row;
      return row;
    });
    bodyEl.replaceChildren(...rows);
    if (scrollToNext && nextRow) nextRow.scrollIntoView({ block: 'center' });
  }

  // ---- Canceled trip -----------------------------------------------------------------------------

  // data: { details (canceledTripDetails), related: [records], route: route info }.
  function renderCanceled({ details, related, route }) {
    const { record, trip, verdict } = details;
    titleEl.replaceChildren(
      el('h2', {}, routeBadge(route), ' ', trip?.headsign ?? record.tripId),
      el('div', { className: 'detail-sub' }, `Canceled trip · ${serviceDateText(record.date)}`),
    );
    const fact = (label, ...value) => el('div', { className: 'fact' }, el('dt', {}, label), el('dd', {}, ...value));
    const stopLink = stop => {
      const b = el('button', { type: 'button', className: 'link' }, stop.name ?? stop.stopId);
      b.addEventListener('click', () => onStop(stop.stopId));
      return b;
    };
    const facts = el('dl', { className: 'facts' });
    if (trip) {
      facts.append(fact('Timetabled',
        `${formatTime(trip.firstStop.time)} from `, stopLink(trip.firstStop),
        ` to ${formatTime(trip.lastStop.time)} at `, stopLink(trip.lastStop),
        el('div', { className: 'status' }, `${trip.stops} stops, ${Math.round(trip.durationS / 60)} min`)));
    }
    facts.append(fact('Marked canceled',
      `${formatWhen(record.firstSeenAt)}${trip ? `, ${noticeText(details.noticeS)}` : ''}`,
      record.lastSeenAt - record.firstSeenAt >= 60 ? el('div', { className: 'status' }, `Still marked canceled at ${formatWhen(record.lastSeenAt)}`) : null,
      record.restoredAt != null ? el('div', { className: 'status' }, `Back on the schedule at ${formatWhen(record.restoredAt)}`) : null));
    if (record.predictedStartAt) facts.append(fact('BCT still predicted', `a departure at ${formatTime(record.predictedStartAt)}`));
    facts.append(fact('Bus', record.vehicles.length ? `${record.vehicles.join(', ')} assigned` : 'None assigned'));
    facts.append(fact('Seen by GPS', record.stopsPassed
      ? `Passed ${record.stopsPassed}${trip ? ` of ${trip.stops}` : ''} stops, ${formatTime(record.firstPassAt)}–${formatTime(record.lastPassAt)}`
      : 'No bus seen running it'));
    if (details.gap?.gapS) {
      facts.append(fact('Gap at the first stop',
        `Previous bus ${formatTime(details.gap.previous)}, next ${formatTime(details.gap.next)}`,
        el('div', { className: 'status' }, `If it didn't run: a ${Math.round(details.gap.gapS / 60)}-minute wait instead of about ${Math.round(details.gap.usualS / 60)}`)));
    } else if (details.gap && trip) {
      facts.append(fact('Gap at the first stop', details.gap.next == null ? 'It was the last trip of the day in this direction' : 'It was the first trip of the day in this direction'));
    }
    for (const a of record.alerts) {
      facts.append(fact('BCT alert', el('strong', {}, a.header ?? 'Alert'), a.description && a.description !== a.header ? ` — ${a.description}` : ''));
    }

    const timetable = el('button', { type: 'button', className: 'small-button' }, 'Timetable');
    timetable.addEventListener('click', () => onTrip(record.tripId, record.date));
    const showRoute = el('button', { type: 'button', className: 'small-button' }, 'Show route');
    showRoute.addEventListener('click', () => onRoute(record.routeId));

    const others = related.map(r => {
      const b = el('button', { type: 'button', className: 'row' },
        el('span', { className: 'status' }, formatWhen(r.firstSeenAt)),
        el('div', { className: 'what' }, el('div', { className: 'headsign' }, r.headsign ?? r.tripId), el('div', { className: 'status' }, verdictLabel(r))),
        el('span', {}));
      b.addEventListener('click', () => open({ kind: 'canceled', record: r, related }));
      return b;
    });
    // Optional parts are `false` when absent; replaceChildren would print them.
    bodyEl.replaceChildren(...[
      el('p', { className: `verdict verdict-${verdict.kind}` }, verdict.text),
      facts,
      el('div', { className: 'panel-tools' }, timetable, showRoute),
      others.length > 0 && el('h3', { className: 'section-title' }, `Other canceled trips on route ${route.routeShortName} that day`),
      ...others,
    ].filter(Boolean));
  }

  // Syncs the Follow button with whether the camera is following its bus.
  function updateFollow() {
    const button = titleEl.querySelector('.follow');
    if (!button) return;
    const following = isFollowing(button.dataset.vehicleId);
    button.textContent = following ? 'Following' : 'Follow';
    button.setAttribute('aria-pressed', String(following));
    button.title = following ? 'Stop following this bus (or drag the map)' : 'Keep the map centred on this bus';
  }

  return {
    showStop: stopId => open({ kind: 'stop', stopId }),
    updateFollow,
    showTrip: (tripId, date = null) => open({ kind: 'trip', tripId, date }),
    // record: a canceled trip from /api/analytics; related: other canceled trips to list below it.
    showCanceled: (record, related = []) => open({ kind: 'canceled', record, related }),
    refresh: () => refresh(),
    close,
    get isOpen() {
      return view != null;
    },
  };
}

// "Fri, Oct 23" for a YYYYMMDD service date.
function serviceDateText(ymd) {
  return formatDate(new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), 17)));
}

// How much notice BCT gave, from seconds between marking a trip canceled and its departure.
function noticeText(noticeS) {
  const minutes = Math.round(Math.abs(noticeS) / 60);
  if (minutes < 1) return 'as it was due to leave';
  const span = minutes >= 120 ? `${Math.round(minutes / 60)} h` : `${minutes} min`;
  return noticeS > 0 ? `${span} before it was due to leave` : `${span} after it was due to leave`;
}

// Short label for a canceled-trip record in lists.
export function verdictLabel(r) {
  if (r.stopsPassed > 0) return `ran anyway (${r.stopsPassed} stops seen)`;
  if (r.restoredAt != null) return 'back on the schedule';
  if (r.vehicles?.length) return `bus ${r.vehicles[0]} assigned`;
  return 'no bus seen';
}
