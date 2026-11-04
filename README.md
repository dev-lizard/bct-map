# Broward Transit

A tool for Broward County Transit staff: what service was actually delivered, what went wrong, and what to change, measured independently from the buses' own GPS. It records BCT's live feeds around the clock, grades them (trips run or missed, on time, spacing, running times, connections, predictions, feed quality), lists what needs attention, and has a live map for looking into a bus, trip or stop. Built with MapLibre GL and OpenFreeMap, with a Cloudflare Worker on the free plan, so it needs no API keys or accounts. It began as a 3D map modelled on [aklcommute.nz](https://aklcommute.nz/).

The research, feed findings and build plan are in [docs/GROUNDWORK.md](docs/GROUNDWORK.md).

## Run it

Requires Node 22+.

```bash
npm install
```

```bash
npm run build:static
```

That downloads BCT's static GTFS (about 10 MB) and writes the timetable files to `public/data/`. Rerun it whenever BCT publishes a new schedule (the deployed site does this nightly).

```bash
npm run dev
```

Open http://localhost:8787. The server relays BCT's live feeds every 10 s; the page works out delays, departures and bunching itself (`web/live.js`). The first load takes a few seconds while map tiles and route data arrive.

- **The map:** a flat map, north up. Each bus is a dot in its route's colour at its latest reported GPS position, with an arrow for its heading and an orange halo when it's 2+ minutes late; a bus whose report is more than 2 minutes old is faded, and the header counts them. Nothing is animated between reports, so what you see is what the feed said.
- **Details:** click a bus for its trip timeline, or a stop for its next departures. Stops show from zoom 14.
- **Stops:** the stop panel shows the city, wheelchair access (from BCT's GTFS), what's there (shelter, bench, lighting, trash can, bike rack, from Broward County's "Fixed Bus Stop" GIS layer), and a Directions button.
- **Bunching in progress:** a red "!" badge between two buses bunched right now. Click it for the route, how close they are against the timetable, at which stop, and either bus's trip. Worked out in the browser from the feed the page already loads, by the same rule Analytics records.
- **Header:** Broward time, how many buses are live, late, or reporting stale GPS, and how old the data is. Settings → Rain radar adds the US NEXRAD radar layer, for context on a bad day.
- **Alerts (rail):** BCT's service alerts: what riders are being told.
- **Buses (rail):** every bus in the feed as a sortable, filterable table: route, bus number, destination, next stop, schedule adherence and report age. Click a row to show the bus; download it as CSV.
- **Analytics (rail):** a tool for BCT staff: what service was delivered, what went wrong, and what to change, measured from the buses' own GPS. One period (today, 7 or 30 days, or custom dates within the last 30) and one route (or all) apply to every tab; tables sort by any column, rows open the route, stop or trip they describe, and each section downloads as CSV. Seven tabs, grouped by who acts on them; the **?** button opens an illustrated guide (`web/guide.html`) at the open tab's chapter.
  - **Needs attention** (the first tab): what to act on, each with who runs it (route, block, bus) and what would fix it: measures short of their goals, blocks with trips not run, trips late or early again and again, running times to change (what 85% of runs take), connections to retime, where gaps open on frequent routes (where to hold buses), congestion ranked by rider-minutes, and GPS units to check. With 14+ days, this week against last, coloured only when a change is more than day-to-day variation. Goals are placeholders in `web/attention.js` until BCT's own are set; headline percentages carry a ± range.
  - **Service** (dispatch): the share of scheduled trips that ran in full, stop visits made, riders' extra wait for trips not run, trips run only partly, trips missed without notice (with their block), and canceled trips, split into not run and marked canceled but run.
  - **On time** (operations): GPS-timed departures from timepoints by BCT's rule (1 minute or more early is early, 5 or more late is late), by hour, by route with its worst hour, and by day with the worst days and what else happened (rain, cancellations, bunching).
  - **Spacing** (dispatch): excess wait on frequent routes from uneven gaps, with where gaps open; and bunching events, each with a replay of the two buses on the map.
  - **Running time** (scheduling, planning): running time against the timetable by route and trip, late starts, the running time to allow by direction and time of day, where along a route delay builds up, and bus speeds and congestion between stops with a map layer.
  - **Connections** (scheduling): timetabled transfers at hubs, made or missed, and how many minutes later a departure would have to leave to fix a bad one.
  - **Rider information** (customer information, the feed vendor): how right BCT's predicted arrivals were, buses that never came, and the live feed's quality (stale and missing GPS, buses vanishing mid-trip, timetable-only predictions, canceled trips that ran, GPS units to check).
- **Rail (left):** Routes (filter which routes are shown, or pick one to zoom to it), Search (stops by name or number, routes by number or name), Alerts, Buses, Analytics, and Settings (theme, rain radar, stops, stop names, 12/24-hour times). Settings and the route filter are saved in your browser.
- **Theme:** day or night is picked by the time in Broward, unless you choose one in Settings. `?theme=day` or `?theme=night` in the URL overrides both.
- **Links:** the URL always describes the current view, so you can bookmark or share it. The camera is in the hash (`#zoom/lat/lon`); the query string can add `?routes=01,22`, `?stop=0210`, or `?trip=<trip_id>&date=YYYYMMDD`. The detail panel's link button copies it.

## Scripts

| Command | What it does |
|---|---|
| `npm run build:static` | Builds the route, stop, shape and timetable JSON from BCT's GTFS zip. Pass a local zip path or URL to override the source. |
| `npm run dev` | Starts the local server: the API, the web app, feed polling, and a nightly timetable rebuild at 3:30 AM Broward time. Optional env vars: `PORT`, `REFRESH_MS`, `NIGHTLY_BUILD_AT` (`HH:MM` or `off`), `CONTRACT_FEED_BASE` (the contracted routes' feeds; see docs/DEPLOY.md). |
| `node scripts/build-ridership.mjs <folder>` | Turns a week of BCT fare-box exports (one CSV per service day) into `web/ridership.json`: totals by stop, and by route and hour, for weighting Analytics by riders. Only totals are written; the exports stay out of the repository. |
| `npm run dev:worker` | Runs the Cloudflare Worker locally on port 8788 (needs `npm run dev` running too). |
| `npm run build:site` | Assembles the GitHub Pages site in `_site/`; `API_URL` sets the Worker address. `build:site:local` points it at the local Worker. |
| `node scripts/make-icons.mjs` | Redraws the app icons in `web/icons/` |
| `npm run check:feeds` | Reports whether BCT's three GTFS-RT feeds are reachable and fresh, and which fields they fill. |
| `npm test` | Runs the unit tests: the GTFS-RT decoder, the compact timetable, route shapes, departure boards, trip timelines and alerts, every recorder and its rules, the Needs attention recommendations, health, search, settings and deep links. |

## API

Served by the Cloudflare Worker (`worker/`) when deployed, and by `server/index.mjs` locally. Both send CORS headers.

| Endpoint | Returns |
|---|---|
| `GET /api/rt` | BCT's vehicle positions, trip updates and alerts as raw protobuf in one bundle (format in `web/gtfs-rt.js`). `X-Server-Time` gives the server's clock. |
| `GET /api/segments` | Measured bus running times for every stretch between stops, per time of day (`?days=7`, up to 30) |
| (analytics endpoints) | `/api/reliability`, `/api/analytics`, `/api/segments` and `/api/service` take `?days=N` (1 to 30, default 7) or `?from=YYYYMMDD&to=YYYYMMDD` (within the last 30 days) |
| `GET /api/service` | Service delivered (trips run, missed without notice, canceled), prediction accuracy by lead time, headway sums for excess wait, running times and start delays by trip and running-time bands, delay by timepoint, transfers at hubs with how long riders had, on time by trip, feed quality by day, route and bus, and day-by-day series (`?days=7`, up to 30) |
| `GET /api/bunching-track` | Both buses' GPS tracks from 15 minutes before to 15 after a bunching event (`?key=<service date>|<leading trip>|<following trip>`) |
| `GET /api/analytics` | Bunching events and canceled trips, each with counts by date, and rain hours by date (`?days=7`, up to 30) |
| `GET /api/reliability` | On-time / early / late shares at timepoints, by route with each route's worst hour, or by hour for one route (`?route=BCT22&days=7`), from the service log |
| `GET /api/radar` | Time and tile URL of the latest NEXRAD radar composite |
| `GET /api/health` | `ok`, `degraded` or `down` (HTTP 503), with the checks behind it: feed freshness, timetable end date, timetable age |

The timetable is static JSON under `data/<build>/`, from `build:static`.

## Deploying

The free setup is GitHub Pages for the site plus a Cloudflare Worker for the API, deployed by GitHub Actions on every push to `main`. [docs/DEPLOY.md](docs/DEPLOY.md) walks through the one-time setup and the day-to-day loop, and also covers self-hosting with Docker or plain Node.

Data: Broward County Transit GTFS / GTFS-Realtime, with routes 4, 6, 15, 23 and 56 from the contractor's TrackTrolley GTFS-Realtime feeds when configured. Basemap: OpenFreeMap © OpenMapTiles, data © OpenStreetMap contributors.
