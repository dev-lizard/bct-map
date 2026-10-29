# Broward Transit 3D — groundwork

Goal: recreate [ptauckland3d.com](https://ptauckland3d.com/) (a live 3D map of Auckland's buses, trains and ferries) using Broward County Transit (BCT) GTFS and GTFS-Realtime data.

Everything below was checked against the live site and the live BCT feeds on **2026-10-22**.

---

## 1. Summary

- **The original is simpler than it looks.** It is a React single-page app with a Mapbox GL v3 basemap (the "Standard" style, which provides the 3D buildings and lighting). Each vehicle is a **plain colored box** drawn with Threebox. A small API merges Auckland Transport's three GTFS-RT feeds into one JSON response, and the client polls it every 20 s. Static GTFS is preprocessed into small per-route JSON files on a CDN.
- **BCT's data is usable for this.** All three GTFS-RT feeds are live, need no API key, refresh about every 10 s, and their trip and stop IDs join to the static GTFS 100%.
- **BCT's feeds are thinner than Auckland's**, so the server has to fill four gaps: no vehicle bearing or speed, no delay values, trip updates not linked to vehicles, and no CORS headers. This repo's server already fills all four.
- **Done in this repo:** the static GTFS pipeline, the live-feed proxy, and a minimal 3D map, all running against live data. The map uses **MapLibre GL + OpenFreeMap + three.js** instead of the original's Mapbox + Threebox, so it needs no API key or account. Section 7 covers what that trades away.

---

## 2. How the original works (reverse-engineered)

`ptauckland3d.com` redirects to **aklcommute.nz** ("AKLCommute"), a hobby project by Viet-Hung Nguyen. I read its production bundle (`/assets/index-*.js`, about 3.3 MB minified) and called its public endpoints.

### 2.1 Stack

| Layer | What it uses |
|---|---|
| App shell | React SPA built with Vite (`<div id="root">`, hashed `/assets/index-*.js`). State lives in Zustand-style stores, settings in `localStorage` (`at3dlive-*` keys), icons from lucide. |
| Basemap | **Mapbox GL JS v3**, style `mapbox://styles/mapbox/standard`, configured through `config.basemap`: `lightPreset` follows the time of day (dawn/day/dusk/night), `theme` is `faded`, road/place/transit labels are off, POI labels can be toggled, and `show3dObjects` toggles 3D buildings. |
| 3D vehicles | **threebox-plugin@2.2.7** from unpkg, in a Mapbox custom layer: `id: "vehicles-3d"`, `type: "custom"`, `renderingMode: "3d"`, `slot: "top"`. |
| 2D fallback | A separate vehicle layer swapped in when "3D vehicles" is turned off. |
| API | `https://api.aklcommute.nz`. Its error strings ("Worker /feed responded…") point to a **Cloudflare Worker**. |
| Static data | `https://assets.aklcommute.nz`: preprocessed GTFS JSON behind a versioned manifest. |
| Extras | Open-Meteo (temperature and conditions), RainViewer (radar tiles), NZTA traffic cameras and road events, YouTube live cams, Cloudflare RUM analytics. |

### 2.2 Data flow

```
Auckland Transport GTFS-RT (vehicle positions, trip updates, alerts)
        │  protobuf, polled by the Worker
        ▼
api.aklcommute.nz  ── GET /feed?routes=…  → one JSON: vehiclePositions, tripUpdates, alerts,
        │                                   totalVehicleCounts, previousVehiclePositions
        │           ── GET /stops/:id/stoptrips?date&hour,  /trips/:id/stoptimes,
        │              /reliability?route=,  /nzta/events
        ▼
Browser polls /feed every 20 s (pauses while the tab is hidden; refetches at once when it returns)
        +
assets.aklcommute.nz  manifest.json → {folder}; then routes.json, stops.json, stop_routes.json,
                      {folder}/route_data/{route_id}.json (shapes + trips), cameras, fare zones
```

The `/feed` response for Auckland was about **1.5 MB**, with about 1,670 vehicles. `previousVehiclePositions` holds each vehicle's last position, so a freshly loaded page can animate immediately instead of waiting for a second poll.

### 2.3 Static asset formats

| File | Shape |
|---|---|
| `manifest.json` | `{"folder": "20261019_081635"}`, so new GTFS builds are atomic and cache-safe |
| `routes.json` | `[{route_id, route_short_name, route_long_name, route_type, route_color, route_text_color}]` |
| `stops.json` | tuples: `[stop_id, stop_code, lat, lon, name, location_type, platform_code, parent_station]` |
| `stop_routes.json` | `{stop_id: [route_id, …]}` |
| `route_data/{route_id}.json` | `{s: {shape_id: coords}, t: [[trip_id, headsignIndex]], h: [headsigns]}`, loaded lazily per route |

### 2.4 How the vehicles are drawn

- Each vehicle is `THREE.BoxGeometry(30, 15, 15)` (not a GLB model). Materials are cached by route color.
- Boxes are rescaled with zoom (scale clamped 0.3–10 between zoom 12 and 20) so they stay visible when zoomed out. Trains are drawn 1.3× larger, and trains sharing a track are offset sideways.
- A **lateness globe** (a semi-transparent sphere with a custom glow shader) appears when a vehicle is **2 minutes or more late**.
- Movement: on each poll, a vehicle animates from its previous position to its new one **along the route shape**, using waypoints taken from the route geometry, not a straight line. A stationary vehicle has its heading snapped to the route direction.
- Clicking uses Three.js raycasting against the meshes. There is also a hover popup, and a selected vehicle can be "tracked" (the camera follows it).

---

## 3. Broward County Transit data (verified 2026-10-22)

### 3.1 Endpoints

| Feed | URL | Status |
|---|---|---|
| Static GTFS | `https://www.browardcdn.org/api/public/content/5813c48c805a4851a24a52a26f6f487c` | ✅ 200, about 9.9 MB zip. This became the producer URL on 2026-10-15 ([transitland/transitland-atlas#2246](https://github.com/transitland/transitland-atlas/pull/2246)). |
| Old static URL | `https://www.broward.org/bct/documents/google_transit.zip` | ❌ 403 |
| Vehicle positions | `https://myride2.broward.org/gtfsrealtime/api/vehiclepositions` | ✅ about 150 buses at 1:50 pm on a weekday |
| Trip updates | `https://myride2.broward.org/gtfsrealtime/api/trips` | ✅ about 156 trips |
| Alerts | `https://myride2.broward.org/gtfsrealtime/api/alerts` | ✅ (3 alerts at the time) |
| Old trip updates | `https://bctmyride-buspas.com:8080/GTFS/TripUpdates` | ⚠️ Responds, but with an **empty** feed. Don't use it. |

None of these require an API key ([MobilityData/mobility-database-catalogs#1583](https://github.com/MobilityData/mobility-database-catalogs/issues/1583) lists "Authentication: None"). Mobility Database IDs: `mdb-3475`, `mdb-3476`, `mdb-3524`. Static feed contact (from `feed_info.txt`): BCTGTFSFeed@broward.org.

### 3.2 What's in the feeds

- **Freshness:** the feed header is 0–3 s old, it republishes about every **10 s**, and 60–80% of buses send a new position each cycle. The median position is about 10 s old.
- **Vehicle positions:** `trip.trip_id` and `trip.route_id` are always present. The label looks like `"BCT01 CENTRAL TERMINAL via INTL. AIRPORT"`. There is **no bearing, speed, stop_id or occupancy**.
- **Trip updates:** absolute arrival and departure times only. There is **no `delay` field anywhere** and **no vehicle block**. Updates include stops the bus has already passed, and about 10% of trips are marked `CANCELED`, some of which still have a bus on the map.
- **Alerts:** auto-generated "Delayed / Trip is Delayed" alerts, with informed entities by trip and stop and cause/effect set to `OTHER_CAUSE`/`UNKNOWN_EFFECT`. Useful as a signal, but not much text to show.
- **Static GTFS:** 1 agency, 44 bus routes (all `route_type` 3, all with colors), and 5,136 stops in the full zip (4,793 used by current service). Shapes and `shape_dist_traveled` are included. The zip holds **two service periods** (`26MAY_*`/`CB2025_*` through Sep 2026 and `26SEPT_*`/`CB2026_*` through Jan 2027), so the build script filters by calendar.
- **Joins:** 151/151 live vehicle trip IDs and 156/156 trip-update trip IDs exist in `trips.txt`. 5,877 of 5,880 trip-update stop IDs exist in `stops.txt`.

### 3.3 Gotchas, and how the server handles them

| Problem | Effect | Handled by |
|---|---|---|
| No CORS headers, and the response type is `application/force-download` protobuf | A browser can't read the feeds directly | Proxy server ✅ |
| Firewall returns 403 to curl's and Wget's default User-Agents | Scripts get mysterious 403s, while Node's `fetch` and custom UAs work | The server sends `broward-transit-3d/0.1` ✅ |
| No bearing | Buses can't be pointed in a direction | The client takes headings from the bus's route shape ✅ (every snapped bus, parked ones included). The server also computes a bearing from consecutive positions once a bus moves 15 m or more (about 110/152 buses after 30 s); it is used for off-route buses and to choose the right leg on a first sighting. |
| No speed | Nothing to extrapolate between reports with | Computed in m/s from consecutive reports ✅ |
| No delay | No lateness glow and no "5 min late" text | Next stop's predicted time minus the scheduled time from `stop_times.txt` ✅ (99% of buses have a value; median about 1 min late; some buses run more than 3 min early.) |
| Trip updates not linked to vehicles | — | Joined by `trip_id` ✅ |
| Static and live feed URLs move | The map goes blank after a URL change | URLs are kept in one place (`server/bct-feed.mjs`, `scripts/build-static.mjs`). `npm run check:feeds` diagnoses problems. |
| Trip IDs change every service period (`26SEPT_…`) | Headsigns and delays turn `null` after a service change | Rebuild the static data nightly (Phase 6) |

---

## 4. Target architecture

Since Phase 7 the app is a static site on GitHub Pages plus a small Cloudflare Worker, both on free plans. The browser does the work the Node server used to.

```
                    nightly (GitHub Actions)                       BCT GTFS-RT ×3 (myride2.broward.org)
BCT static GTFS ─────► scripts/build-static.mjs                              │ raw protobuf
 (browardcdn.org)        ├─► data/manifest.json                              ▼
                         └─► data/<folder>/ routes, stops, shapes,     Cloudflare Worker (worker/)
                             schedule.json (compact, ~150 KB gzip)       GET /api/rt  bundle, cached 10 s per isolate
                                   │  GitHub Pages                        GET /api/weather, /api/radar
                                   │                                      GET /api/reliability, /api/health ◄─┐
                                   │                                                                           │
                                   │                  every minute (Cron) ─► Recorder Durable Object (SQLite) ─┘
                                   │                                         on-time counts; reads schedule.json from Pages
                                   ▼
Browser: web/live.js decodes the bundle (web/gtfs-rt.js) and joins it with the timetable (web/schedule.js):
         bearing / speed, delay vs schedule, departure boards, trip timelines, alerts
MapLibre GL + OpenFreeMap vector basemap (+ 3D buildings) + three.js "vehicles-3d" custom layer
```

The snapshot the map draws keeps the original's shape (`vehiclePositions`, `previousVehiclePositions`, `tripUpdates`, `alerts`, `totalVehicleCounts`), now built in the browser. Vehicles are pre-flattened (`lat`, `lon`, `bearing`, `delay`, `routeColor`, `headsign`, `shapeId`, `nextStop`) rather than raw GTFS-RT objects. Each poll moves about 45 KB (gzipped protobuf) against Auckland's 1.5 MB of JSON. `server/index.mjs` serves the same API for local development and self-hosting.

---

## 5. Feature map: original → Broward

| aklcommute.nz feature | Broward approach | Status |
|---|---|---|
| Mapbox Standard 3D basemap, light preset by time of day, faded theme | OpenFreeMap `positron` by day and `dark` by night (by Broward time; `?theme=` overrides), plus our own `fill-extrusion` 3D buildings | **Working** (two looks instead of four smooth presets; no 3D landmarks) |
| Vehicles as route-colored 3D boxes, scaled with zoom | three.js custom layer; 12 × 2.6 × 3.2 m box, real size up close and never under 18 px long zoomed out | **Working** |
| Lateness globe at ≥ 2 min late | Server-computed delay; translucent orange sphere | **Working** (no glow shader yet) |
| Camera persistence | MapLibre `hash` keeps `#zoom/lat/lon/bearing/pitch` in the URL | **Working** |
| Heading | Route-shape direction at the bus's position; movement bearing when off-route | **Working** |
| Smooth movement along the route | Snap to the trip's shape (`shapeId`), play back 30 s behind the feed, dead-reckon (capped at the next expected report and the next stop) when a report is late; `previousVehiclePositions` seeds playback on load | **Working** |
| Click a vehicle → trip details | `/api/trips/:id/stoptimes` → trip timeline panel; selected bus outlined | **Working** |
| Stops layer + departures per stop | Stops on routes with a live bus; `/api/stops/:id/departures` → departure board panel | **Working** |
| Route filter (`/feed?routes=`) | Filtered in the browser: buses, route lines and stops; saved, and in the URL as `?routes=01,22` | **Working** |
| Search | Stops and routes, in the browser, with street-abbreviation matching | **Working** |
| Alerts panel | `alerts` in `/api/feed`, named from the timetable; rail count badge | **Working** |
| Settings | Theme, 3D buildings, stops mode, stop names, 12/24 h, saved in `localStorage` | **Working** |
| Deep links (`?route=&trip=`) | `?routes=`, `?stop=`, `?trip=&date=` plus the camera hash; "Copy link" button | **Working** |
| Geolocate + "outside Auckland" notice | MapLibre's locate button; a notice with the distance when you're outside BCT's service area or the map's limits | **Working** |
| Track a vehicle (camera follows) | "Follow" on the trip panel; dragging, closing the panel or opening something else stops it | **Working** |
| 2D vehicles (when 3D is turned off) | MapLibre dots with heading arrows; Settings → Buses, with "Automatic" switching to 2D on slow devices | **Working** |
| Vehicle counts by mode | `totalVehicleCounts` ✅ (bus only) | **Done** (API) |
| Clock + weather header | Ticking clock; Open-Meteo for Fort Lauderdale, cached on the server | **Working** |
| Rain radar | US NEXRAD tiles from Iowa Environmental Mesonet; Settings → Rain radar | **Working** |
| Traffic cameras, road events | FL511 has no public API; access goes through FDOT (DIVAS third-party feed) | **Blocked**: needs FDOT access |
| Reliability stats | Server logs each timepoint departure to `data/reliability/`; Reliability panel by route and hour | **Working** |
| Fare zones, trains, ferries, train lateral offset | BCT is bus-only with a flat fare | Not applicable |

---

## 6. Build plan

Each phase ends in something you can see working.

**Phase 0 — groundwork (this repo) ✅**
Feeds discovered and verified, static pipeline, live proxy with the gap-filling above, and a minimal 3D map.

**Phase 1 — first light ✅ (mostly)**
`npm run build:static && npm run dev`, then open http://localhost:8787. Checked in a browser on 2026-10-22:
- About 147 live buses render as route-colored boxes in the right places (e.g. lined up in the Broward Central Terminal bays).
- Late buses glow orange, and clicking a bus opens its popup.
- Day and night themes both work, and zoomed-out buses stay visible.

The 2D fallback for low-end phones was added in Phase 4.

**Phase 2 — motion quality (the "feel" of the original) ✅**

Built in `web/shapes.js` (polyline math), `web/reckon.js` (playback and dead-reckoning), both unit-tested in `test/`, and `onReport()`/`stepMoves()` in `web/main.js`:
- **Snapping:** each report snaps to its trip's shape (`shapeId`). On shapes that pass the same street twice (loops, out-and-back ends), the projection prefers points at or just ahead of the bus's last position. On a first sighting it prefers segments running the bus's way.
- **Playback:** each bus is drawn where the feed says it was `PLAYBACK_DELAY_S` (30 s) ago. By the time the drawn bus reaches a report, the next one has usually arrived, so between two reports it moves at exactly the speed observed between them and cannot pass the next one.
- **Dead-reckoning (when a report is late):** past its newest report, a bus keeps going at its observed speed along the shape (smoothed over recent reports), with three caps:
  - No further than it would get by its next expected report, using its own smoothed report interval.
  - Never past the stop it's heading to (`/api/feed` now includes the next stop's coordinates), and no extrapolation at all while dwelling at a stop.
  - If a report still lands behind the drawn bus, it holds still rather than reversing. More than 150 m ahead, it glides back instead.
- **Smoothing:** a bus drawn behind its target catches up over about 3 s (at most 20 m/s above the target's speed). Frame steps are capped at 0.5 s, so buses catch up rather than teleport after a background tab.

**Why playback instead of pure dead-reckoning.** BCT reports arrive 5–40 s apart (most often 10–15 s). About 12% of new timestamps carry an unchanged position, and buses stop at lights between reports (one moved 1 m, then 0 m, then 134 m in consecutive reports). Dead-reckoning forward from the newest report therefore keeps overshooting at red lights and stalling when buses speed up.

I replayed 3 minutes of live feed (1,199 scored reports, 2026-10-22) through the exact snapping and motion code at 30 fps. "Past next report" means the bus was already drawn beyond a new report's position when that report arrived:

| Strategy | Past next report by >5 m | by >50 m | Moving buses drawn still | Drawn behind the feed |
|---|---|---|---|---|
| Dead-reckoning from the newest report (no delay) | 38% | 20% | 38% | 0 s (plus about 9 s delivery) |
| Playback, 20 s delay | 19% | 5.5% | 21% | 20 s |
| Playback, 30 s delay (**default**) | 10% | 1.2% | 8% | 30 s |
| Playback, 40 s delay | 2.6% | 0.4% | 3% | 40 s |

The remaining small overshoots are mostly GPS jitter: a report a few metres behind the previous one, which playback holds flat rather than reversing. `PLAYBACK_DELAY_S` in `web/main.js` is the single knob between fresher and smoother.
- **Headings:** taken from the shape's direction over ±6 m of road, so buses turn smoothly at corners and parked buses face the right way.
- **Fallbacks:**
  - Small backward jitter (< 30 m) is held in place rather than reversed.
  - Jumps of 2.5 km or more, real reversals, and trip changes glide straight onto the route.
  - Reports more than 40 m from the shape (deadheading, detours, canceled trips) glide in a straight line, facing the way the bus moves.

Measured on live data (2026-10-22):
- 148 of 150 buses were within 40 m of their own shape (median 5 m, 95th percentile 15 m). The other 2 were on canceled trips, correctly treated as off-route.
- Shape headings matched observed movement within 45° for 135 of 139 buses, and none pointed backwards.
- Snapped buses are drawn exactly on their shape, and moved 20–190 m forward along it in a few seconds of animation.

Still to do:
- **Lazy route loading:** all 44 route files still load up front (they also draw the route lines). The original loads them only for routes with live buses.
- **Shared streets:** where routes share a street, their lines overlap and only the top one shows (e.g. route 81's grey-green covers route 22 on Broward Blvd). Light colours like route 81's are also hard to see on the light basemap. Offsetting parallel lines or adding a dark casing would help.

**Phase 3 — stops and departures ✅**
- **Stops layer** (`web/main.js`): circles from zoom 14, names from 16.5. Like the original's default, only stops on routes that have a live bus right now are shown.
- **Departures** (`/api/stops/:stopId/departures?minutes=90&limit=20`): the equivalent of the original's `/stops/:id/stoptrips`. It's built from a per-stop timetable index, using the build's service calendar so only services running that day count (holiday swaps included, e.g. Sunday service on Thanksgiving). It also includes yesterday's trips still running after midnight.
  - **Live times:** the feed's own prediction for the stop when it has one; otherwise the trip's current delay carried forward to stops the bus hasn't reached.
  - **Board contents:** late buses stay on the board past their timetabled time. Trips that end at the stop are left off, since nobody can board them.
- **Trip timeline** (`/api/trips/:tripId/stoptimes?date=`): every stop with timetabled and live times, which stops are passed, and the next stop.
- **Panels** (`web/panel.js`): a stop's board shows countdowns, live/late/early status, and the timetabled time struck through when the prediction differs. A trip's timeline shows passed and next stops plus "Show bus".
  - **Navigation:** clicking a departure opens its trip. Clicking a stop in a timeline opens that stop. Clicking a bus or stop on the map opens it.
  - **Behavior:** panels refresh with every poll, follow the map's day/night theme, and become a bottom sheet on narrow screens.
- **Tests:** 8 server tests in `test/departures.test.mjs` cover the calendar, live vs. carried-forward predictions, cancellations, late buses, after-midnight trips, and wrong-day live data.
- **Live-data notes:**
  - BCT often predicts buses 5–11 minutes ahead of the timetable. The board shows those predictions as given.
  - Some trips are marked canceled while a bus is still assigned and predicted. The board says both ("Canceled · bus 20094 still assigned") rather than hiding either.

**Phase 4 — app shell ✅**

Still plain ES modules with no build step. React + Vite, as the original uses, would have added a toolchain for a UI that is still a few hundred lines; it's worth revisiting if the UI grows a lot more.

- **Rail and sidebar** (`web/sidebar.js`): an icon rail on the left opens four panels.
  - **Routes:** all 44 routes with live bus counts and a text filter. A checkbox per route shows or hides it, the route name shows only that route and zooms to it, and "Show all" clears the filter.
  - **Search:** stops and routes as you type; Enter opens the top result.
  - **Alerts:** each alert lists its trip and stops, which open on click. A count badge sits on the rail button.
  - **Settings:** theme, 3D buildings, stops mode, stop names and 12/24-hour time.
- **Route filter:** hides other routes' buses, lines and stops, and narrows the alerts. The status card shows "13 of 167 buses" and the filtered routes with "Show all routes". It's filtered in the browser rather than with `/feed?routes=` as the original does: our feed is about 130 KB, not 1.5 MB, and toggling a route is instant.
- **Search** (`web/search.js`): expands street abbreviations both ways ("NW 4th St" finds "Northwest 4th Street"). It ranks exact route numbers and stop codes first (leading zeros optional), then name prefixes, then names containing every word.
- **Alerts:** BCT's alerts are trip-level "Delayed" notices naming only IDs, so the server now names each trip (route and headsign), adds its route, and names the stops.
- **Settings** (`web/settings.js`): saved in `localStorage`. Bad or blocked storage falls back to the defaults. Changing the theme reloads the map, since swapping the basemap style would mean rebuilding every layer.
- **Deep links** (`web/links.js`): `?routes=01,22`, `?stop=0210` and `?trip=<id>&date=YYYYMMDD` sit alongside the camera hash, and the URL updates as you browse. The detail panel has a "Copy link" button. A linked trip selects its bus as soon as the feed has it.
- **Layout:** the detail panel stays on the right. Below 800 px wide the sidebar and detail panel can't both fit, so opening one closes the other; below 641 px both become bottom sheets.
- **Tests:** 10 new tests in `test/shell.test.mjs` (search, settings, links) and 1 for alert naming.
- **Your location** (MapLibre's `GeolocateControl`, bottom left):
  - **Outside the service area but inside the map's limits** (e.g. the Everglades): the map shows you there, with "You're about 35 km outside Broward County Transit's service area" and a "Back to Broward" button. The service area is the box around BCT's stops plus 2 km (`web/device.js`).
  - **Beyond the map's limits:** the camera stays put, and the notice explains why: "You're about 12,976 km from Broward, so the map stays on Broward County".
  - **Location blocked at the prompt:** the notice says how to allow it.
  - **Location already denied in the browser:** MapLibre doesn't show the button at all.
- **Follow a bus:** the trip panel's "Follow" keeps the bus centred in the visible part of the map every frame, including while you zoom.
  - **Stops when:** you drag the map, close the panel, open something else, press locate, or the bus leaves the feed or is filtered out.
  - **Checked live:** the camera tracked a route 07 bus along Pines Boulevard at about 21 m/s, and a drag ended it.
- **2D buses** (Settings → Buses: Automatic / 3D / 2D): route-coloured dots with a white heading arrow, an orange halo when 2+ minutes late, and a ring when selected.
  - **Lighter:** in 2D a timer updates the buses five times a second, instead of the map redrawing every frame.
  - **Automatic:** switches to 2D (once per visit, with a "Keep 3D" option) if the median gap between frames goes over 50 ms while buses animate. It ignores the long gaps a throttled background tab produces.
- **Tests:** 4 more in `test/device.test.mjs`, for the service area, distances and the frame-rate check.
- **Not checked live:** the automatic switch to 2D, since this machine draws smoothly; it shares the code path of picking 2D by hand, which was checked. Also the theme and 12/24-hour options, whose saving logic is unit-tested. Location was checked with a temporary page that faked a position, because the browser pane has location blocked.

**Phase 5 — extras ✅ (except traffic)**
- **Header:** a ticking Broward-time clock (following the 12/24-hour setting), plus current weather with an icon, e.g. "73°F Partly cloudy", with feels-like and wind in its tooltip. The server fetches Open-Meteo (`/api/weather`) at most every 10 minutes for all visitors, and keeps serving the last reading, marked stale, if it goes down.
- **Rain radar** (Settings → Rain radar, off by default): the US NEXRAD composite from Iowa Environmental Mesonet, drawn under the route lines at 55% opacity. The header shows the radar time ("Rain radar from 9:35 AM"), and it refreshes as IEM rebuilds the composite every 5 minutes.
  - **Why IEM, not RainViewer:** RainViewer's free tiles stop at zoom 7, which is too coarse at street level; IEM works at every zoom. `/api/radar` gives the latest radar time, which goes into the tile URL so browsers fetch new tiles.
- **Reliability** (`server/reliability.mjs`, `/api/reliability?route=&days=`, and the rail's Reliability panel): measured at *timepoints*, the stops the timetable is built around (the static build now marks them).
  - **What's recorded:** when a bus passes a timepoint, the server records BCT's reported time for it against the timetable, once per trip and stop. "On time" means no more than 1 minute early or 5 minutes late, the usual US transit definition.
  - **Storage:** records are saved to `data/reliability/<date>.jsonl` and reloaded at startup, keeping 30 days.
  - **Panel:** shows the last 7 days as early / on-time / late bars per route, best to worst by on-time share, with a legend, tooltips and full text labels. A route opens its breakdown by hour, and figures from under 20 departures are marked with an asterisk.
  - **Early finding:** a large share of departures are *early* (58% in the first few minutes; 41% on time overall after a day). That matches the early predictions seen earlier, so it's worth checking against BCT's own reported on-time figures before quoting it.
- **Traffic cameras and incidents: not done.** FL511 has no public API: its developer page returns 404, and FDOT shares its feed only with authorized partners through DIVAS. The ArcGIS "FL511" entry is just a link to the website, and FHP's incident page is an interactive viewer, not a feed. Scraping fl511.com's internal endpoints would be fragile and unauthorized, so this waits on FDOT access.
- **Tests:** 7 more, in `test/extras.test.mjs` (weather conversion, the shared cache) and `test/reliability.test.mjs` (what counts as a departure, the on-time maths, by-hour, persistence across restarts).

**Phase 6 — production ✅ (ready to deploy; not deployed)**

The whole service stays one self-contained Node process, deployable to any host without a separate CI job, bucket or database. How to deploy and monitor it is in [DEPLOY.md](DEPLOY.md).

- **Nightly rebuild** (`NIGHTLY_BUILD_AT`, default 03:30 Broward time, or `off`):
  - **How it runs:** the server runs `scripts/build-static.mjs` in a child process, so the API stays responsive during the half-minute of CSV parsing, then swaps the new timetable in without a restart (`BctLiveFeed.setStatic`).
  - **Folders:** it keeps the new and previous dated data folders, so pages loaded just before the switch keep working.
  - **On failure:** the old data stays in use and health reports it.
  - **First start:** with no static data, the server builds it before serving.
  - **Checked live:** a test copy rebuilt on schedule, swapped data while serving departures, pruned to two folders and rescheduled for the next day.
- **Health** (`server/health.mjs`, `GET /api/health`): reports `ok`, `degraded` or `down` (HTTP 503), with a `checks` list covering:
  - **Feed:** how long since the server's last successful refresh, and BCT's own data age (BCT can keep republishing old data while our refreshes succeed).
  - **Errors:** any feed returning errors.
  - **Timetable:** when the static timetable ends (degraded within 7 days, down after).
  - **Rebuild:** the last nightly rebuild (degraded if it failed or the data is over 36 h old).
  
  These rules have 4 tests in `test/health.test.mjs`.
- **Serving:**
  - **Caching:** dated `/data/<build>/` files are `immutable` for a year; the manifest and web app are `no-cache` with `Last-Modified` and a 304 when unchanged.
  - **Compression:** gzip for text, with `/api/feed` compressed once per refresh (146 KB → about 22 KB).
  - **Headers:** basic security headers on every response.
- **Shutdown:** on SIGTERM or SIGINT the server stops polling and finishes writing the reliability log before exiting.
- **Container:** a `Dockerfile` (Node 22 Alpine, non-root, volumes for `data/` and `public/data/`, a health check against `/api/health`) and a `.dockerignore`. **Not built here:** Docker isn't installed on this machine.
- **Single instance:** run exactly one instance. The poller, rebuild and reliability log live in the process; scale with a CDN in front instead (see DEPLOY.md).
- **Superseded by Phase 7** for hosting. The Node server remains for local development and self-hosting.

**Phase 7 — GitHub Pages + Cloudflare Worker ✅ (built and tested locally; not deployed)**

Free hosting that keeps every feature. The walkthrough is in [DEPLOY.md](DEPLOY.md).

- **Browser does the live work:** `web/live.js` is the old `BctLiveFeed` moved client-side (`LiveFeed`): tracks, bearings, delays, departure boards, trip timelines and alerts. The departure and trip tests run against it unchanged.
- **Own GTFS-RT decoder** (`web/gtfs-rt.js`, about 300 lines): its output matches `gtfs-realtime-bindings`' `toObject` and has 0 mismatches against the live feeds. It decodes trip updates in about 9 ms.
  - It skips unknown fields, including BCT's extension field 9000 on every vehicle (a bug here, `this.pos += this.uint()`, broke that at first; there is a regression test now).
- **Compact timetable** (`web/schedule.js`): trips with the same stops share a pattern and times are stored as deltas. That is 148 KB gzipped against 2 MB for one row per stop call. It ships with the static data as `data/<folder>/schedule.json`; `data/schedule.json` is gone.
- **`/api/rt` bundle:** BCT's three feeds as raw protobuf in one response, plus up to three older vehicle feeds so a page that has just opened can animate buses at once. `X-Server-Time` corrects the page's clock.
- **Worker** (`worker/index.js`): relays the feeds, weather and radar, cached per isolate (the Cache API does nothing on workers.dev).
- **Durable Object** (`worker/recorder.js`): every minute it records timepoint departures into SQLite as counts per (service date, route, hour). It reports health and serves `/api/reliability`. The rules are shared with the Node log (`server/ontime.mjs`).
  - The reliability panel now shows the mean delay, not the median, because counts can't give a median.
- **Workflows:** `.github/workflows/pages.yml` (test, build the timetable, assemble with `scripts/build-site.mjs`, deploy; on push, nightly and on demand) and `worker.yml` (test, `wrangler deploy`).
- **Checked locally:**
  - Node server and site in a browser.
  - `wrangler dev` with a manual cron tick: the Durable Object recorded 27 departures and health was `ok`.
  - The assembled site served under a `/repo/` subpath against the Worker on another origin, with no console errors.
- **Not checked:**
  - **BCT's TLS:** BCT's server offers only older TLS cipher suites, and `workerd` can't connect to it locally (`.dev.vars` routes local fetches through the Node server instead). Cloudflare's network lists those suites for origin connections, so the deployed Worker should connect; `/api/health` will say on the first deploy.
  - **The deploy itself:** neither workflow has run yet.
  - **History:** the Worker's reliability history starts empty; the local `data/reliability/` log isn't migrated.

**Phase 8 — stops, weather and an installable app ✅ (built and tested locally)**

- **Stop amenities:** the build reads Broward County's "Fixed Bus Stop" GIS layer (`bcgishub.broward.org/…/OpenData2/Fixed_Bus_Stop/FeatureServer/0`, 4,658 stops, 2,000 per query).
  - **Matching:** every GTFS stop matched, 4,315 by `STOP_ID` and the rest by `STOP_CODE`.
  - **What's kept:** shelter, bench, lighting, trash can and bike rack ("other" benches and trash cans count too), and the municipality. These are packed into one number per stop in `amenities.json` (17 KB gzipped).
  - **Server quirk:** like BCT's feed server, the county server refuses curl's default User-Agent.
  - **If it's down:** the build carries on without amenities.
- **Wheelchair access:** the layer's `ADA_ACCESS` column is empty for every stop, so access comes from GTFS `wheelchair_boarding` (4,262 accessible, 738 not, 136 unknown in stops.txt).
  - The two sources sometimes disagree in spirit: stop 0111 has every amenity but is marked not accessible. The panel shows what each source says.
- **Directions:** the stop panel links to transit directions to the stop, in Apple Maps on Apple devices and Google Maps elsewhere.
- **NWS alerts** (`/api/weather-alerts`): api.weather.gov alerts for county `FLC011` and zones `FLZ071`, `FLZ072` and `FLZ172` (inland, metro and coastal Broward), most severe first.
  - **Where they show:** in the Alerts panel with a severity edge and expandable text. Severe and extreme ones also show as a header banner.
  - **Fixed alongside:** the Alerts panel used to rebuild on every 10-second feed update, closing whatever a reader had expanded. It now rebuilds only when the alerts change. BCT restamps each alert's active period on every publish (start = now, end = now + 16.7 h), so periods are ignored in that comparison, and BCT's "Until …" times are not meaningful.
- **Hurricane cones** (`/api/storms`): NHC's `CurrentStorms.json` lists active storms, and NOAA's `NHC_tropical_weather` map service gives each storm's cone, track and points as GeoJSON (via the Worker; it sends no CORS headers).
  - **Visibility:** the map's camera is limited to the Broward area, so the header states whether Broward is inside each cone (point-in-polygon on the county's corners and middle).
  - **Checked:** with Hurricane Vance (eastern Pacific, `?storms=all`), and with a made-up cone over Broward to check the drawing.
- **Installable app:**
  - `manifest.webmanifest` plus icons drawn by `scripts/make-icons.mjs`.
  - `sw.js`: the app is network-first (revalidated, so deploys show at once), dated timetable builds and pinned libraries are cache-first (the two newest builds are kept), and the API and map tiles are never cached.
  - The site build adds a version to `runtime-config.js`'s address, so a changed `WORKER_URL` isn't held back by Pages' 10-minute cache.
  - **Checked:** the service worker's rules with a Node harness. The in-app browser can't register service workers from a local server, so registration itself is unchecked until the site is deployed.
- **Tests:** 7 more in `test/integrations.test.mjs`: amenity packing, directions links, NWS parsing, storm features and point-in-polygon.
- **Not checked:** the header banner with a real severe alert (none was active; the alerts that were active are Moderate and Minor).

**Phase 9 — analytics, a bus table and Overpass ✅ (built and tested locally)**

- **Bunching** (`server/analytics.mjs`): two buses on the same route and direction at the same stop within 3 minutes, and within a quarter of their timetabled gap, when that gap is 10 minutes or more.
  - **How it's measured:** from BCT's trip-update times (predicted ahead, actual just behind), so it needs no map geometry.
  - **Which trips count:** only trips with a bus on them in the vehicle feed. BCT also predicts trips no bus has started, which would otherwise pair a bus with its own next trip.
  - **Recording:** one event per pair per service day. The Durable Object stores events in SQLite (`bunching` table) and the Node server in `data/analytics/`.
  - **First live check:** two route 72 buses (20080 and 20095) due at the same stop at the same second, 30 minutes apart on the timetable.
- **Cancellations:** trips the feed marks CANCELED, once per trip per day (`canceled` table). 11–18 a day in testing.
  - Trips that silently never ran aren't counted. That would need tracking which scheduled trips never appear, and keeping enough uptime records to tell a missed trip from a gap in recording.
- **Weather and adherence:** Open-Meteo's hourly rain history for Fort Lauderdale, which goes back 31 days, is joined at query time with the hourly on-time counts already recorded. Nothing new is stored.
  - **Weather classes:** dry, rain (≥ 0.1 mm or a rain code), and heavy rain or storms (≥ 2.5 mm or thunderstorm codes).
  - **"vs dry":** compares each class with dry weather at the same hours of the day, weighted by that class's departures, so rush hours are compared with rush hours (tested).
  - **Caveat:** one point stands in for the county.
- **Buses panel** (`web/buses.js`): a sortable, filterable table with CSV download. The sidebar column widens to 600 px on screens at least 1,100 px wide.
- **Analytics panel** (`web/analytics.js`): bunching (count, by route, a 24-hour column chart, latest events), weather classes as early, on-time and late bars with "vs dry", and cancellations by route. Every list downloads as CSV.
- **Fixes:**
  - **Next-stop names:** about 10% of BCT's stop-time updates name a stop by its code ("3533") where the timetable's id is "3533_Merged_2". Those buses lost their next-stop name and position, and bunching at those stops was missed. The stop id now comes from the timetable row with the same stop_sequence (regression test added).
  - **Truncated names:** stop names and headsigns in the detail panel wrap instead of being cut off with an ellipsis.
- **Font:** Overpass (Google Fonts) for the whole interface. OpenFreeMap only serves Noto Sans glyphs, so the map's own street and place labels stay Noto Sans.
- **Worth knowing from the data:** these numbers, from trip-update times, said BCT buses ran early (more than 1 minute) about as often as on time: 47% early, 41% on time, 11% late over 2,500 departures. Phase 10 found that the trip-update times for passed stops are the timetable shifted by BCT's delay estimate, and Phase 11 switched to GPS timing.
- **Tests:** 9 more (`test/analytics.test.mjs`, plus the stop-code fix).

**Phase 10 — bus speeds and congestion from GPS ✅ (built and tested locally)**

- **Why GPS, not trip updates:** BCT's trip updates drop most stops a bus has passed. Of the few they keep, 305 of 307 stop-to-stop gaps were exactly the timetable's, so they are the timetable shifted by the current delay, not measurements.
  - This also matters for the on-time stats, which read those same passed-stop times. They probably reflect BCT's delay estimate rather than an observed departure (see "Worth knowing" in Phase 9). Measuring timepoint departures from GPS instead, with the machinery below, is the natural next step.
- **How it measures** (`server/segments.mjs`):
  - **Placing reports:** each vehicle report is placed along its trip's stops (joined by straight lines).
  - **Stop times:** the moment the bus passes each stop is interpolated between consecutive reports.
  - **Running times:** the time between two stops is that stretch's running time.
  - **Rejected:** reports over 250 m off the line, gaps over 5 minutes, runs over 30 minutes or 70 mph, and a bus seen past its last stop (the terminal).
  - **First live sample:** 139 runs in 2 minutes with a median of 19 mph (10th–90th percentile 9–36 mph).
- **What's kept:** per calendar day, for each stop pair, per time of day (night, morning peak 6–9, midday, afternoon peak 3–7, evening): runs, measured seconds and timetabled seconds; plus network totals per hour for weather.
  - Each day is one JSON value, about 7 KB per 2 minutes of data at first and growing to an estimated few hundred KB.
  - **Worker:** one row in `segment_days`, saved every 10 minutes, so a few hundred row writes a day.
  - **Node:** `data/segments/<date>.json`.
  - Kept 31 days.
- **Congestion** (`web/speeds.js`): each stretch is compared with itself at its fastest time of day (with at least 3 runs). Time over that, times runs, per day, is bus time lost.
  - **Why not the timetable:** buses beat it on most stretches (measured time is about 75% of timetabled), because BCT's stop times have 1-minute resolution and padding sits at timepoints.
- **Panel and map:** an Analytics section with a time-of-day selector, average speed, the 10 stretches losing the most time, the 10 slowest, running time in wet weather (same-hours comparison), and CSV.
  - "Show on map" draws stretches with 2 or more runs in five speed bands; slower is darker and wider. The route lines fade meanwhile.
- **Checked:**
  - Live recording through the Node server.
  - The panel and map in a browser. The page's request was intercepted to triple the real runs, because after a few minutes only 9 stretches had 2 runs; buses come every 20–60 minutes, so a full day is needed.
  - 9 tests (`test/segments.test.mjs`, `test/speeds.test.mjs`).
- **Not checked:** the Worker's recording under `wrangler dev` (it bundles; the logic is shared with the tested Node path).

**Phase 11 — on-time stats timed from GPS ✅ (built and tested locally)**

- **What changed:** timepoint departures are now timed from GPS, with the same stop-passing calculation as the speed measurements (`SegmentLog.observe`'s `onPass`).
  - A trip's first stop counts as departed once the bus is 25 m past it, so time waiting at the terminal isn't counted.
  - When the feed gives no start date, the service day is whichever puts the timetabled time nearest.
- **Effect:** in the first 8 minutes (93 departures around 3:20 PM), 56% were on time, 15% early and 29% late, with a mean of +3 minutes. The trip-update method had said 47% early, 41% on time and 11% late over the day. That suggests BCT's passed-stop times reflect its delay estimate, not observed departures.
- **Clean start:** the old and new numbers aren't comparable, so the two are kept apart.
  - **Node:** logs to `data/ontime/`; `data/reliability/` is left on disk unread.
  - **Durable Object:** clears its counts once, the first time the new code runs (state `ontimeSource = gps`).
  - The weather comparison, which reads the same counts, starts over with it.
- **Tests:** the reliability tests now feed GPS passages, plus a passage test (87 in all).
- **Weather source fixed:** Open-Meteo's "past" hours are model output, not measurements, and missed almost all of South Florida's showers. Eight points across Broward showed only 0.4 mm on a day the radar and stations showed rain; over a month it had 32 wet hours.
  - **Now:** observed hourly rain at Broward's four airport weather stations (FLL, FXE, HWO, PMP), from Iowa Environmental Mesonet's ASOS archive (`hourlyprecip.py`). The same month has 108 wet hours.
  - **Classes:** an hour is as wet as its wettest station. Rain is 0.01 in or more and heavy is 0.10 in or more; a trace counts as dry.
  - **Hours:** a report valid at 14:00 covers 13:00–14:00. Hours no station reported (including the last hour or two, before IEM has them) are left out rather than counted as dry.

**Phase 12 — investigating canceled trips ✅ (built and tested locally)**

- **Why:** BCT's CANCELED flag doesn't simply mean "didn't run".
  - Canceled trips often still have a bus on them in the vehicle feed, and BCT keeps publishing predictions for them.
  - The one active alert, "Delayed: Trip is Delayed", listed 10 of 14 canceled trips.
  - Of 22 trips canceled on Oct 23, GPS saw buses run 6 at least partly, and BCT put 4 back on the schedule.
- **Recording** (`server/cancellations.mjs`): each canceled trip is followed through its day.
  - **From the feeds:** when it was first and last marked canceled, whether it went back on the schedule, which buses were on it, BCT's alert text, and the start time BCT still predicted.
  - **From GPS:** stops passed, and when, including before it was marked canceled (every trip's progress is held in memory for a day).
  - **Storage:** one value per service day. That's `data/cancellations/` locally, or a `cancel_days` row in the Durable Object (saved every 10 minutes); the old `canceled` table is dropped.
  - **Other changes:** the Durable Object now also fetches the alerts feed, and bunching stays in `analytics.mjs`.
- **Investigating** (`web/canceled.js`, `renderCanceled` in `web/panel.js`): clicking a canceled trip opens it in the side panel.
  - **The trip:** its timetabled run (first and last stops, number of stops, duration), and when it was marked canceled, as notice before or after its departure.
  - **What happened:** the bus, what GPS saw, and BCT's alerts.
  - **The rider gap:** the previous and next bus on the same route and direction at its first stop that day (for example, "a 60-minute wait instead of about 30").
  - **Links:** the trip's timetable, its route on the map, and the route's other canceled trips that day.
  - **Verdicts:** ran anyway (GPS saw at least half its stops), partly run, back on the schedule, still under way (being watched), bus assigned but not seen, or no bus seen.
- **List:** the Analytics list shows every canceled trip with its verdict, filters to a route by clicking its bar, and its CSV includes every field.
- **Tests:** 7 more (`test/cancellations.test.mjs`, `test/canceled.test.mjs`).
- **Fixed alongside: the deployed Worker had measured nothing for four days** (no stretches, no GPS-timed departures), while the Node server measured 7,649 runs in a day.
  - **Cause:** Cloudflare stops an idle Durable Object between its once-a-minute ticks, and its memory goes with it. So no bus ever had a "previous report" to measure from, and the 10-minute save timer restarted with the object and never fired.
  - **Fix:** the per-bus tracking (`SegmentLog.exportTracking`) and every trip's GPS progress (`CancellationLog.exportProgress`) are saved in `state` at the end of every tick and restored on wake-up, and the day totals are saved every tick. That's about 4,300 row writes a day.
  - **Checked:** restarting `wrangler dev` between ticks; the first tick after the restart measured 89 runs from the saved positions. There's also a restart test in `test/segments.test.mjs`.
**Phase 13 — bunching replays ✅ (built and tested locally)**

- **Capture** (`server/tracks.mjs`): every bus's positions from the last 20 minutes are kept. When bunching is found, both buses' tracks from 15 minutes before the event to 15 minutes after are saved.
  - **Size:** about 1–2 KB per event, so a month is well under 1 MB.
  - **Storage:** the rolling buffer is saved every tick (the Durable Object may stop between ticks), and finished tracks go into `track_days` (Worker) or `data/tracks/` (Node).
  - **Older events:** events from before this have no track and show "no replay".
- **Replay** (`web/replay.js`, `renderBunching` in `web/panel.js`): clicking an event marked "▶ Replay" in Analytics opens the side panel and fits the map to both tracks.
  - **On the map:** two ghost buses (blue ahead, amber behind) with labels and trails, moving along their trip's route shape between GPS reports.
  - **Controls:** play or pause, a timeline, speeds of 10–120×, the time relative to the event, and the straight-line gap between the buses.
  - **Cleanup:** closing the panel removes the ghosts.
- **Checked:** with a made-up track along route 72's real shape (no real event had been captured yet). The ghosts follow Oakland Park Blvd and the gap closes from 1.2 to 0.8 mi as it plays.
- **Also:** OpenFreeMap's dark style asks for a "wood-pattern" image it doesn't have, and MapLibre warned for every tile (thousands of console messages). A transparent stand-in is now added on `styleimagemissing`.

**Phase 14 — service, prediction, headway and schedule analytics; one Analytics panel ✅ (built and tested locally)**

- **Recording** (`server/service.mjs`): one value per day (`service_days` in the Worker, `data/service/` in Node), plus a small state saved every tick (pending predictions, the last bus at each timepoint, trips in progress).
  - **Service delivered:** trips a bus was seen on (vehicle feed or GPS), and the minutes the recorder ran. Once a trip is half an hour over, it counts as ran, canceled (BCT said so), missed without notice (no bus, no notice, and the recorder watched at least 90% of its run), or not judged.
  - **Prediction accuracy:** BCT's prediction for each timepoint, taken the first time the bus is 0–2, 2–5, 5–10, 10–20 and 20–30 minutes away, and scored when GPS sees it pass. Accurate means 1 minute early to 3 minutes late; a bus that came early counts separately, since riders following the prediction miss it.
  - **Headways:** at timepoints, on service timetabled 20 minutes apart or less, the actual and timetabled gap between consecutive buses. They're summed so the excess wait can be worked out: Σh²/2Σh, actual minus timetabled.
  - **Schedule fit:** a trip's running time from its first to its last timepoint GPS saw (at least 80% of its timetabled time), recorded 10 minutes after it stops moving.
  - **Tests:** 5 in `test/service.test.mjs`.
- **Panel** (`web/analytics.js`): rewritten as one panel with shared controls.
  - **Shared controls:** a period and a route picker apply to all eight tabs (Service, On time, Predictions, Headways, Schedule, Speeds, Bunching, Weather).
  - **Tables:** sort by any column, with "show all" on long lists.
  - **Clicking:** route badges and route rows narrow every tab to that route, stops open their departures, trips open their timetable, canceled trips their story, and bunching events their replay.
  - **CSV:** each tab exports its data.
  - **The rail:** the Reliability button became the On time tab, so the rail is down to six buttons.
- **Checked:** every tab in a browser, the route picker following a click, and `/api/service` from the Node server and `wrangler dev`.
  - Predictions were scored within minutes (97 on 29 routes).
  - Headways, run times and service delivered need recording to have covered whole trips, so they fill in over the first hours. BCT's frequent service is routes 1, 18 and 19 (gaps of 20 minutes or less), plus some trips on 22, 72 and 114.

**Phase 15 — transfers, late starts, delay build-up, trends, shelters and feed quality ✅ (built and tested locally)**

- **Recording** (more fields in each `server/service.mjs` day, and in its saved state):
  - **Transfers:** hubs are parent stations whose stops serve 3+ routes (41 in this timetable, from Broward Central Terminal down). Each bus GPS sees at a hub is paired with other routes' buses there in the last hour. A pair counts when the departing bus is the arriving one's timetabled connection (the next on its route and direction, 2 to 30 minutes later). Made means it left at least 2 minutes after the first really arrived; missed adds the timetabled wait for the bus after. Both buses must be seen, and arrivals at a route's last stop are only caught when GPS places the bus at the stop, so missed connections from buses that vanish aren't counted.
  - **Late starts:** a trip's delay leaving its first timepoint is kept with its running time, so a route's lateness splits into starting late and losing time on the way.
  - **Delay by timepoint:** average delay at each timepoint, with its timetabled position in the trip, for the "where delay builds up" profile; and on-time counts by route and day for trends.
  - **Feed quality:** GPS reports more than 2 minutes old when published, a bus on a trip silent for 5+ minutes, a bus GPS loses with 15+ timetabled minutes left (not counted after a gap in recording, so a restart doesn't look like dropouts), and next-stop predictions exactly equal to the timetable.
  - **Daily counts** for bunching, cancellations and rain hours were added to `/api/analytics`.
  - `web/schedule.js` gained `routesByStop()` (for hubs) and `departuresByStop(services)` (for shelters), both one pass over the stop patterns.
  - **Tests:** 4 more in `test/service.test.mjs` (9 in all).
- **Panel:** four new tabs (Transfers, Trends, Shelters, Feed), and Schedule gained late starts, time lost en route and, for one route, a delay profile whose rows open the stop.
  - **Transfers:** hubs worst first; a hub opens its route pairs, which narrow every tab to a route.
  - **Trends:** a sortable table of every measure by day, the last 7 days against the 7 before (30-day view), day of the week, and the three worst on-time days with that day's rain, cancellations and bunching.
  - **Shelters:** computed in the browser from the timetable and the stop survey already loaded for the stop panel. Rain and heat aren't used to weight it: the airport stations show much the same weather county-wide.
  - **Feed:** totals, by day and by route, and the canceled-but-ran count; its CSV is meant as a report for BCT.
- **Checked:** every tab in a browser, and the new fields recording in the Node server and `wrangler dev` (41 hubs, feed counts, delay by timepoint, first transfers judged).

**Phase 16 — the contracted routes' feeds ✅ (built and tested locally; needs the Worker secret)**

- **Why:** routes 4, 6, 15, 23 and 56 are run by a contractor, and BCT's feeds have none of their buses. The contractor's TrackTrolley system publishes standard GTFS-RT vehicle positions and trip updates, and every trip id in them is in BCT's timetable.
- **Merging** (`server/bct-feed.mjs`): when `CONTRACT_FEED_BASE` is set, both feeds are fetched alongside BCT's and joined byte for byte, contractor first. Two serialized protobuf messages one after the other read as one message with the entities of both and the last header, so BCT's timestamp still rules (`feedTimestamp` now returns the last header's too) and nothing is re-encoded. A contractor feed is only added to a BCT feed that arrived, so a BCT outage still shows as one. Everything downstream (the map, departures, every recorder) sees the merged feeds.
- **Quirks handled:**
  - The trip updates number stops one lower than the timetable. `summarizeTripUpdates` now places a stop by its id when that doesn't match the row at its sequence.
  - The vehicle feed keeps parked buses' last positions for days. Reports more than 30 minutes older than the feed are left off the map.
  - TrackTrolley answers HTTP 406 to `Accept: application/x-protobuf`, so it's asked for `application/octet-stream`.
- **The key:** it's private (the public tracker page uses another), so the address lives in the environment: a Worker secret, or an environment variable for the Node server. Errors leave the address out, since `/api/health` shows them.
- **Checked:** 3 more tests (108); live, the bundle carried 10 contracted buses and 18 trip updates, and the Buses table showed each with its next stop and delay.

**Phase 17 — partial trips in service delivered ✅ (built and tested locally)**

- **What:** "ran" is split into ran in full and ran only partly. Each day now keeps, per trip, the earliest and latest timetabled time of the stops GPS saw it pass. A trip is partial when that starts 15+ minutes into its timetable or ends 15+ minutes before its end, and the recorder was running for the whole trip. Trips seen only in the vehicle feed (no stops passed), and days recorded before this, count as in full.
- **Caveat:** a bus whose GPS fails mid-trip, or a detour that takes it off its stops at the end, looks the same as a trip cut short; the Feed tab's "vanished" count is the GPS side of it.
- **Panel:** the Service tab's headline is now "ran in full", with a hatched "only partly" segment in the day bars, a Partly column by route, and a list of partial trips saying which end wasn't run (each opens the trip). Trends' column is "In full".
- **Canceled trips:** each in the list now says what share of the trip's stops GPS saw its bus pass ("partly run: 21% of the trip (15 of 73 stops)", or "ran anyway" from half the stops up, as the trip details already judged it), with "so far" while the trip is still timetabled to be running. The CSV gains `trip_stops` and `pct_of_stops_run`. Stops count once each, in order, from when the recorder first saw the trip, so a trip already under way when the recorder started reads low.
- **Tests:** 1 more (109 in all).
- **Note:** before the contracted routes' feeds were merged (Phase 16), their trips counted as missed without notice; those days' numbers for routes 4, 6, 15, 23 and 56 are wrong and age out after 30 days.

**Phase 18 — staying inside the Durable Object's free plan ✅ (built and measured locally)**

- **What happened:** at 5 AM on Oct 28 the Worker hit the free plan's 5 million rows read a day, and stopped recording and answering until midnight UTC. Cloudflare evicts the object between most ticks, and each wake-up read every row of `seen` (one per departure for 3 days), `counts` (one per date, route and hour for 30 days) and `bunching`: tens of thousands of rows, most minutes.
- **Fix:**
  - On-time counts are now one row per service date (`ontime_days`), like the other logs; the old `counts` rows were moved over once on the first wake-up.
  - `seen` and `bunching` are no longer read into memory. A departure or event is new when its `INSERT OR IGNORE` writes a row; summaries query only their window.
  - A wake-up now reads the per-day rows and saved state: about 125 rows.
  - Then three more, the same day:
    - **The timetable is kept in the database** (`timetable`, gzipped: 144 KB and 97 KB). A wake-up used to download schedule.json and stops.json from GitHub Pages, about 2.4 MB most minutes (an estimated 2 to 3 GB a day). Now it reads two rows, and downloads only when the 10-minute manifest check finds a new build. Checked by restarting `wrangler dev` with PAGES_URL unreachable: it still recorded departures.
    - **Older days load when asked.** A wake-up reads only the last two days of the per-day logs (ticks only touch today and yesterday); the Analytics endpoints read further back for their window. A wake-up is now about 15 rows.
    - **One row of saved state.** Bus progress, the replay buffer, service state, the last tick, the timetable check time and the usage figures used to be five rows written a minute; they're one (`tickState`), about 5,800 fewer writes a day. The old rows are still read if `tickState` is missing.
  - The Worker reuses the Durable Object's answers for a minute (30 s for health), so visitors clicking through Analytics don't each wake it.
  - Every query goes through one helper that adds up the cursor's rows read and written; the day's totals are saved each tick and shown in `/api/health` (degraded from 60% of either limit, down from 95%).
- **Measured locally (after all of the above):** a wake-up reads about 14 rows, a tick 2 to 16 and writes 3 to 18, and twelve Analytics requests (four endpoints, three periods) read 35 rows in all.
- **Tests:** 1 more (110).

**Phase 19 — the Analytics guide and Help button ✅ (built and checked locally)**

- **The guide** (`web/guide.html`): every Analytics tab explained in plain words, with a drawn copy of each part of the tab and numbered markers tying the picture to the explanation. It ships with the site and uses the app's font (Overpass), panel colours and status colours, and its day/night theme (from `?theme=`, else the saved setting, else the hour in Broward). It started as a private Claude artifact; the site copy replaced it so everyone can open it.
- **Help button:** at the top of the Analytics panel, beside the period buttons. It opens the guide in a new tab at the open tab's chapter (`guide.html?theme=night#transfers`).
- **Upkeep:** `CLAUDE.md` asks every change to a tab, or to a rule behind its numbers, to update the guide in the same piece of work.
- **Also fixed:** Service's "By day" bars now show in the Today view and for one route (the server keeps per-route day counts, `delivered.byRouteDate`), start at the first day with judged trips, and give dates a wider label column so they no longer run into the bars.

**Phase 20 — custom date ranges in Analytics ✅ (built and checked locally)**

- **Panel:** a fourth period button, Custom, shows a first-day and last-day picker (limited to the last 30 days, which is what the recorders keep). Every tab reloads for that range; labels read "from Tue, Oct 27 to Wed, Oct 28", CSV file names carry the dates, and Trends compares the range's last 7 days with the 7 before when it covers 14 days or more. To fit the narrow panel, Help became a "?" icon and the two dates sit side by side.
- **Server:** `server/range.mjs` turns `?days=N` or `?from=&to=` into the list of dates; every summary (on time, bunching, cancellations, running times, service) takes it, in both the Node server and the Worker.
- **Free plan:** a range costs the same database reads as the 30-day view at most (about 100 to 200 rows). Custom ranges get less from the Worker's one-minute answer cache, since each is different, which doesn't matter at those sizes.

**Phase 21 — BCT's on-time rule, and measures of what riders experience ✅ (built and checked locally)**

The aim: numbers that reflect what riders go through, not just what the schedule says.

- **BCT's rule:** 1 minute or more early is early, 5 minutes or more late is late (was: more than 1 early, more than 5 late). On 6,602 recorded departures this moved on-time from 61.88% to 61.62%. Worker days recorded before this keep the old edges, a difference of about 0.3 points that rolls out of the 30-day window.
- **Departures timed as the bus pulls away:** every stop's time is now when GPS shows the bus 25 m past it (or halfway to the next stop, if closer), so a bus that arrives early and waits isn't counted early. The last stop of a trip is timed on arrival and no longer counts as a departure. Arrival times at each stop are recorded too: predictions (which are of arrival) are graded against them, and transfers use the first bus's arrival.
- **On time tab:** the share more than 10 minutes late and the average lateness of late buses (counted from Oct 29); hours first, for all routes or one; and each route's worst hour (with 20+ departures).
- **Riders at any stop and at the end:** buses leaving any stop, not just timepoints, 1 minute or more early (every stop in BCT's timetable has a time; between timepoints they're BCT's estimates, as riders see them); and trips reaching their last stop less than 5 minutes late.
- **Service tab:** stop visits promised and made (a trip cut short counts the stops it reached); for each trip missed or canceled, how long riders waited for the next bus that ran (not counted across trips the recorder couldn't judge); and trips shown to riders as canceled that then ran are described as something riders faced, not only a data problem.
- **Tests:** 116.
- **Ridership:** a week of stop-level boardings would let these be weighted by riders instead of trips; not built yet (needs the data).

**Phase 22 — weighting by riders, from a week of fare-box data ✅ (built and checked locally)**

- **The data:** BCT's fare-box exports for Oct 18–24, 2026, one CSV per service day (4 AM to about 2 AM; rides after midnight are already filed under the day before), one row per boarding: about 391,000 rows. Stop numbers match BCT's stop ids or codes once their leading zeros are restored (89%); another 1.3% match by location (the nearest stop on that route within 60 m); 9.4% have no stop and count only toward route and hour totals. The two garages (Copans, Ravenswood: about 9,000 boardings) are left out.
- **Privacy:** the exports hold card data, ticket, device and driver fields. `scripts/build-ridership.mjs` reads them from outside the repo and writes only totals to `web/ridership.json` (98 KB): average boardings a day by stop (weekday, Saturday, Sunday), by route and clock hour, and per trip starting each hour. CLAUDE.md keeps the rule.
- **Used for:**
  - **Shelters:** ranked by riders boarding a weekday (buses stay as a column).
  - **Service:** riders on trips not run (missed, and canceled ones never run), from the route's average boardings per trip at that hour and kind of day; rider-hours of extra waiting; each missed trip shows its estimate.
  - **On time:** "On time for riders": each route and hour weighted by its boardings (from per-route, per-hour counts the on-time summary now includes). 62.0% against 61.7% by departures on the local data.
- **Refreshing it:** run the script on a newer week's exports and commit the new `web/ridership.json`.
- **Terminals left out of Shelters:** their bays ranked high among "no shelter" stops because the county's stop survey doesn't record a terminal's canopy as a shelter. Stops named "Terminal" or "Transit Center" (32 bays) are now left out, with a note under the table.

- **Side note:** the local server's rebuild failed once on Oct 27 (the log kept only "Node.js v24.21.0"; a rerun succeeded). The production nightly builds on GitHub ran every day.

---

## 7. Risks and open questions

- **Terms of use.** BCT publishes no developer page or license for the GTFS-RT feeds. Before launching publicly, email BCTGTFSFeed@broward.org. Keep load polite: one server poll every 10 s, cached for all users.
- **Feed churn.** Both the static and live URLs have changed in the last few months, and the firewall's UA filtering could tighten. `npm run check:feeds` is the first thing to run when the map goes blank.
- **MapLibre vs. the original's Mapbox.** The free stack costs less visual polish: no Mapbox Standard lighting presets (dawn/dusk), no 3D landmark models, and plain extruded buildings. If you want that look later, the switch is contained: the basemap setup and the custom layer's `render()` matrix in `web/main.js`. Mapbox v3 takes the same three.js approach, and needs a token and paid usage beyond its free tier.
- **OpenFreeMap is a free community service** with no SLA. For production traffic, consider self-hosting its tiles (it publishes the planet extracts) or a paid vector-tile provider. The style URL is the only thing to change.
- **First paint is slow** (about 10 s in testing) because the map's tiles and all 44 route files load before buses appear (polling deliberately waits for the route shapes). Lazy route loading and a loading indicator would both help. In a background tab the browser throttles rendering, so the first load can take much longer there.
- **Library versions.** Pinned to MapLibre GL 5.24.0 and three.js r184. MapLibre 6.x exists; its custom-layer `render()` arguments may differ, so retest before upgrading.
- **Bus count.** About 150 buses (vs. Auckland's about 580 buses and ferries) is comfortably light for per-vehicle meshes. Instancing isn't needed yet.
- **Don't copy the original.** Reimplement its ideas; don't lift aklcommute.nz's code or assets. Crediting it as inspiration is good form.

---

## 8. What's in this repo

| Path | Purpose | Verified |
|---|---|---|
| `scripts/build-static.mjs` | BCT GTFS zip → `public/data/<folder>/…`, including the compact `schedule.json` | ✅ 44 routes, 5,981 trips, 4,793 stops, 166 shapes; schedule 1.9 MB (148 KB gzipped) |
| `scripts/build-site.mjs` | Assembles `_site/` for GitHub Pages and writes `runtime-config.js` | ✅ served under a subpath against a local Worker |
| `web/live.js` | Live snapshot (bearing, speed, delay, joins), stop departure boards, trip timelines, alerts, in the browser | ✅ against live feeds, plus 9 tests in `test/departures.test.mjs` and `test/schedule.test.mjs` |
| `server/service.mjs` | Service delivered, prediction accuracy, headways, schedule fit and late starts, delay by timepoint, transfers at hubs, feed quality | ✅ 9 tests; recording live; `/api/service` checked in Node and `wrangler dev` |
| `server/segments.mjs`, `web/speeds.js` | Running times between stops from GPS; speeds, congestion and the map layer | ✅ 9 tests; recorded live and checked in a browser |
| `server/analytics.mjs`, `server/analytics-log.mjs` | Bunching, cancellations, adherence by weather; the Node server's event log | ✅ 8 tests; checked on live data and in the panel |
| `web/buses.js`, `web/analytics.js`, `web/csv.js` | Buses table and Analytics panel, with CSV downloads | ✅ checked in a browser at 800 and 1,280 px |
| `web/amenities.js` | Stop amenities and wheelchair access, packed into one number per stop | ✅ 2 tests; all 4,657 stops matched; stop panel checked in a browser |
| `server/extras.mjs` (weather alerts, storms) | NWS alerts for Broward; NHC storm cones and whether Broward is inside | ✅ 4 tests; live alerts and Hurricane Vance checked through the Node server and `wrangler dev` |
| `web/sw.js`, `web/manifest.webmanifest`, `scripts/make-icons.mjs` | Installable app: service worker, manifest, icons | ⚠️ caching rules checked in a Node harness; registration only checkable once deployed |
| `web/gtfs-rt.js` | GTFS-RT decoder and the `/api/rt` bundle format | ✅ 0 mismatches against `gtfs-realtime-bindings` on live feeds; 5 tests |
| `web/schedule.js` | Compact timetable: pack, unpack, calls at a stop | ✅ 2 tests, plus every departure test |
| `web/api.js`, `web/runtime-config.js` | Where the API lives (same origin locally, the Worker on Pages) | ✅ |
| `worker/`, `wrangler.toml` | Cloudflare Worker and its Recorder Durable Object | ✅ `wrangler dev` with a cron tick; not deployed |
| `.github/workflows/` | Deploy the site to Pages and the Worker to Cloudflare | ⚠️ not run yet |
| `server/bct-feed.mjs` | Fetches BCT's raw feeds, merges in the contracted routes' (TrackTrolley) feeds, keeps older vehicle feeds for the bundle | ✅ 2 tests, live |
| `server/index.mjs` | Dev and self-hosting server: `/api/rt`, `/api/reliability`, `/api/weather`, `/api/radar`, `/api/health`, static files | ✅ in a browser |
| `web/panel.js` | Stop departure board and trip timeline panel, with "Copy link" | ✅ Clicked through in a browser against live data |
| `web/sidebar.js` | Rail plus routes, search, alerts and settings panels | ✅ Each panel opened in a browser against live data |
| `web/search.js`, `web/settings.js`, `web/links.js` | Stop and route search, saved settings, deep links | ✅ 10 tests in `test/shell.test.mjs`; deep link and search checked in a browser |
| `web/dom.js` | Shared DOM helpers: elements, route badges, time formatting, icons | ✅ via the above |
| `web/device.js` | Service area, distance outside it, and the slow-device check | ✅ 4 tests in `test/device.test.mjs`; location notices checked in a browser with a faked position |
| `server/extras.mjs` | Weather and radar time, behind a shared cache | ✅ 2 tests; live endpoints checked |
| `server/reliability.mjs`, `server/ontime.mjs` | Timepoint departure log (Node) and the on-time rules shared with the Worker | ✅ 4 tests; recording live since 2026-10-22, panel checked in a browser |
| `web/gtfs-util.js` | CSV parser, GTFS time and service-day math, geo helpers | ✅ via the above |
| `scripts/check-feeds.mjs` | Feed health and field-coverage report | ✅ |
| `server/health.mjs` | ok / degraded / down rules for `/api/health` | ✅ 4 tests; checked live |
| `Dockerfile`, `docs/DEPLOY.md` | Container image and deployment / monitoring guide | ⚠️ Dockerfile not built (no Docker here) |
| `web/` | MapLibre + OpenFreeMap map, 3D buildings, route lines, three.js 3D buses that follow their route shapes, popups, day/night themes | ✅ Run in a browser against live data |
| `web/shapes.js` | Polyline projection, interpolation and headings for snapping buses to route shapes | ✅ 9 unit tests (`npm test`) plus live-data checks |
| `web/reckon.js` | Playback and dead-reckoning along a shape: report history, interpolation, speed smoothing, caps (next report, next stop), frame stepping | ✅ 10 unit tests, including simulated steady, dwelling and bursty buses, plus a 3-minute live-data replay |
| `.claude/launch.json` | Lets Claude Code's browser preview start the dev server | ✅ |
