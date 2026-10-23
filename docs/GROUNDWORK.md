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
| `web/gtfs-rt.js` | GTFS-RT decoder and the `/api/rt` bundle format | ✅ 0 mismatches against `gtfs-realtime-bindings` on live feeds; 5 tests |
| `web/schedule.js` | Compact timetable: pack, unpack, calls at a stop | ✅ 2 tests, plus every departure test |
| `web/api.js`, `web/runtime-config.js` | Where the API lives (same origin locally, the Worker on Pages) | ✅ |
| `worker/`, `wrangler.toml` | Cloudflare Worker and its Recorder Durable Object | ✅ `wrangler dev` with a cron tick; not deployed |
| `.github/workflows/` | Deploy the site to Pages and the Worker to Cloudflare | ⚠️ not run yet |
| `server/bct-feed.mjs` | Fetches BCT's raw feeds; keeps older vehicle feeds for the bundle | ✅ 1 test, live |
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
