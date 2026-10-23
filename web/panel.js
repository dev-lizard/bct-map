// The detail panel: a stop's departure board or a trip's timeline, refreshed with every feed poll.
// load(view) returns what to show (LiveFeed.stopDepartures or tripStopTimes in web/live.js).
import { el, formatTime, icon, routeBadge } from './dom.js';

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
export function createPanel(root, { load, onStop, onTrip, onBus, onFollow, isFollowing, onView }) {
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

  function renderStop({ stop, routes, departures }) {
    titleEl.replaceChildren(
      el('h2', {}, stop.name),
      el('div', { className: 'detail-sub' }, el('span', {}, `Stop ${stop.code || stop.id}`), ...routes.map(routeBadge)),
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
    refresh: () => refresh(),
    close,
    get isOpen() {
      return view != null;
    },
  };
}
