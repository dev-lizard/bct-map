# Broward Transit 3D

A real-time 3D map of Broward County Transit buses, modelled on [aklcommute.nz](https://aklcommute.nz/) (ptauckland3d.com). Built with MapLibre GL, OpenFreeMap and three.js, so it needs no API keys or accounts.

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

Open http://localhost:8787. The server relays BCT's live feeds every 10 s; the page works out bus positions, delays and departures itself (`web/live.js`). Buses snap to their route shapes and are played back along them 30 s behind the feed (`PLAYBACK_DELAY_S` in `web/main.js`). They move smoothly between reports without running past the next one. When a report is late, they dead-reckon at their observed speed, capped at their next stop. The first load takes a few seconds while map tiles and route data arrive.

- **Details:** click a bus for its trip timeline, or a stop for its next departures. Stops show from zoom 14. On a trip, "Follow" keeps the camera on the bus until you drag the map.
- **Stops:** the stop panel shows the city, wheelchair access (from BCT's GTFS), what's there (shelter, bench, lighting, trash can, bike rack, from Broward County's "Fixed Bus Stop" GIS layer), and a Directions button that opens transit directions in Apple Maps or Google Maps.
- **Weather alerts:** National Weather Service alerts for Broward are listed in Alerts; severe and extreme ones (hurricane, tornado, flash flood warnings) also show as a banner in the header.
- **Hurricanes:** when there's an Atlantic storm, the National Hurricane Center's forecast cone, track and points are drawn on the map, and the header says whether Broward is inside the cone (Settings → Hurricane forecast cones). `?storms=all` in the URL includes storms in other basins, for testing outside the season.
- **Install:** on phones, "Add to Home Screen" installs it as an app. A service worker keeps the app and timetable cached so it reopens quickly.
- **Your location:** the locate button (bottom left) shows where you are, or tells you how far outside Broward you are.
- **Buses:** drawn in 3D, or as lighter 2D dots with heading arrows (Settings → Buses). "Automatic" switches to 2D if the map runs slowly.
- **Header:** Broward time and current weather (Open-Meteo). Settings → Rain radar adds the US NEXRAD radar layer.
- **Reliability (rail):** on-time performance by route and by hour, from each timepoint departure the API records. Locally that's `data/reliability/`; when deployed, a Cloudflare Durable Object.
- **Rail (left):** Routes (filter which routes are shown, or pick one to zoom to it), Search (stops by name or number, routes by number or name), Alerts, and Settings. Settings and the route filter are saved in your browser.
- **Theme:** day or night is picked by the time in Broward, unless you choose one in Settings. `?theme=day` or `?theme=night` in the URL overrides both.
- **Links:** the URL always describes the current view, so you can bookmark or share it. The camera is in the hash (`#zoom/lat/lon/bearing/pitch`); the query string can add `?routes=01,22`, `?stop=0210`, or `?trip=<trip_id>&date=YYYYMMDD`. The detail panel's link button copies it.

## Scripts

| Command | What it does |
|---|---|
| `npm run build:static` | Builds the route, stop, shape and timetable JSON from BCT's GTFS zip. Pass a local zip path or URL to override the source. |
| `npm run dev` | Starts the local server: the API, the web app, feed polling, and a nightly timetable rebuild at 3:30 AM Broward time. Optional env vars: `PORT`, `REFRESH_MS`, `NIGHTLY_BUILD_AT` (`HH:MM` or `off`). |
| `npm run dev:worker` | Runs the Cloudflare Worker locally on port 8788 (needs `npm run dev` running too). |
| `npm run build:site` | Assembles the GitHub Pages site in `_site/`; `API_URL` sets the Worker address. `build:site:local` points it at the local Worker. |
| `node scripts/make-icons.mjs` | Redraws the app icons in `web/icons/` |
| `npm run check:feeds` | Reports whether BCT's three GTFS-RT feeds are reachable and fresh, and which fields they fill. |
| `npm test` | Runs the unit tests: the GTFS-RT decoder, the compact timetable, route-shape snapping, playback and dead-reckoning, departure boards, trip timelines and alerts, reliability, health, search, settings, deep links, and the service-area and slow-device checks. |

## API

Served by the Cloudflare Worker (`worker/`) when deployed, and by `server/index.mjs` locally. Both send CORS headers.

| Endpoint | Returns |
|---|---|
| `GET /api/rt` | BCT's vehicle positions, trip updates and alerts as raw protobuf in one bundle, plus up to three older vehicle feeds (format in `web/gtfs-rt.js`). `X-Server-Time` gives the server's clock. |
| `GET /api/reliability` | On-time / early / late shares at timepoints, by route, or by hour for one route (`?route=BCT22&days=7`) |
| `GET /api/weather` | Current conditions in Fort Lauderdale (cached 10 minutes) |
| `GET /api/radar` | Time and tile URL of the latest NEXRAD radar composite |
| `GET /api/weather-alerts` | Active National Weather Service alerts for Broward, most severe first (cached 2 minutes) |
| `GET /api/storms` | Active Atlantic storms from the National Hurricane Center: forecast cones, tracks and points as GeoJSON, and whether Broward is in each cone (`?basin=all` for every basin; cached 10 minutes) |
| `GET /api/health` | `ok`, `degraded` or `down` (HTTP 503), with the checks behind it: feed freshness, timetable end date, timetable age |

The timetable is static JSON under `data/<build>/`, from `build:static`.

## Deploying

The free setup is GitHub Pages for the site plus a Cloudflare Worker for the API, deployed by GitHub Actions on every push to `main`. [docs/DEPLOY.md](docs/DEPLOY.md) walks through the one-time setup and the day-to-day loop, and also covers self-hosting with Docker or plain Node.

Data: Broward County Transit GTFS / GTFS-Realtime. Basemap: OpenFreeMap © OpenMapTiles, data © OpenStreetMap contributors.
