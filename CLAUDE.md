# Broward Transit 3D

## Keep the Analytics guide in step with the app

`web/guide.html` is the illustrated guide to every Analytics tab. It ships with the site and opens
from the Help button at the top of the Analytics panel (at the open tab's chapter, e.g.
`guide.html?theme=night#transfers`). It's styled with the app's own fonts and colours and follows
its day/night theme.

Whenever a change affects what the Analytics panel shows or how a number is worked out, update the
guide in the same piece of work. That includes:

- a tab, section, table column, label, colour or legend in `web/analytics.js` or `web/style.css`
  (a new tab needs a new chapter, with an `id` matching its tab key, and a jump-menu link);
- a rule or threshold behind a number: `server/service.mjs`, `server/ontime.mjs`,
  `server/analytics.mjs` (bunching, weather), `server/segments.mjs` and `web/speeds.js` (speeds),
  `server/cancellations.mjs` and `web/canceled.js` (canceled trips);
- what the Worker records or keeps (`worker/recorder.js`) when a tab's data or limits change.

Update the matching chapter's picture and words together, keep example numbers marked as examples,
and change the "Matches the app as of" date near the top. In the app's tables late text is orange
(`.late`) and early text blue (`.early`); bars use the fixed status colours (yellow early, green on
time, red late). Mention the guide update in the reply.
