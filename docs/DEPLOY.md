# Deploying Broward Transit 3D

The app runs free on two services:

| Part | Where | What it does |
|---|---|---|
| The site | **GitHub Pages** | The web app plus the timetable files. A GitHub Actions workflow rebuilds the timetable from BCT's GTFS every night and on every push. |
| The API | **Cloudflare Worker** (free plan) | `/api/rt` relays BCT's live feeds (BCT sends no CORS headers, so browsers can't fetch them directly). It also serves weather and radar. |
| On-time history | **Durable Object** inside the Worker | A Cron Trigger runs it every minute. It records timepoint departures in its own SQLite database and serves `/api/reliability` and `/api/health`. |

Everything else (bus positions, delays, departure boards, trip timelines) is worked out in the browser by `web/live.js`.

```
GitHub repo ──push / nightly──► Actions ──► GitHub Pages  (https://<you>.github.io/<repo>/)
            └─push (worker/**)─► Actions ──► Cloudflare Worker (https://broward-transit-3d.<subdomain>.workers.dev)
Browser ── page, timetable ◄── Pages        Browser ── /api/* ◄── Worker ── BCT, Open-Meteo, IEM
                                            Worker cron (every minute) ──► Durable Object ── reads schedule.json from Pages
```

## One-time setup

You do these steps yourself: they need your GitHub and Cloudflare accounts. Allow about 20 minutes.

### 1. Create the GitHub repository

1. On github.com, create a **new, empty, public repository** (no README, licence or .gitignore). Pages is free for public repositories. These steps assume it's called `broward-transit-3d`.
2. Under **Settings → Pages → Build and deployment → Source**, choose **GitHub Actions**.

### 2. Create the Cloudflare account and an API token

1. Sign up at dash.cloudflare.com (the free plan is enough).
2. Open **Workers & Pages** once. Cloudflare asks you to pick your `*.workers.dev` subdomain, which becomes part of the Worker's address.
3. Note your **Account ID**. It's in the right-hand column of **Workers & Pages**, or in the dashboard URL after `dash.cloudflare.com/`.
4. Go to **My Profile → API Tokens → Create Token** and use the **Edit Cloudflare Workers** template. Under *Account Resources*, pick your account; under *Zone Resources*, pick **All zones** (it doesn't matter for workers.dev). Create the token and copy it; it's shown only once.

### 3. Give the repository the Cloudflare credentials

In the repository, open **Settings → Secrets and variables → Actions**. Under **Secrets**, add:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 2.4 |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID from step 2.3 |

The Worker workflow works out your Pages address (`https://<owner>.github.io/<repo>`) on its own. Only if you later move the site to a custom domain, also add a **variable** `PAGES_URL` with the new address.

### 4. Push the code

From the project folder:

```bash
git init -b main
```

```bash
git add -A
```

```bash
git commit -m "Broward Transit 3D"
```

```bash
git remote add origin https://github.com/<you>/broward-transit-3d.git
```

```bash
git push -u origin main
```

The push starts two workflows (repository **Actions** tab):

- **Deploy Worker** runs the tests and publishes the Worker. Open the run and expand the *Deploy* step. It prints the Worker's address, like `https://broward-transit-3d.<subdomain>.workers.dev`.
- **Deploy site** builds the timetable and publishes the site. On this first run the page doesn't know the Worker's address yet, so it shows "Live feed unavailable" until step 5.

### 5. Point the site at the Worker

1. In **Settings → Secrets and variables → Actions → Variables**, add `WORKER_URL` with the address from step 4, with no trailing slash.
2. In **Actions → Deploy site**, click **Run workflow**.

### 5b. Add the contracted routes' feeds (optional)

Routes 4, 6, 15, 23 and 56 are run by a contractor, and their buses aren't in BCT's feeds; they come from the contractor's TrackTrolley system. Its address includes a private key, so it isn't in the repository. Give it to the Worker as a secret, once, from the project folder:

```bash
npx wrangler secret put CONTRACT_FEED_BASE
```

Paste the address up to and including `/command/gtfs-rt/` (`https://tcbct.tracktrolley.com/api/v1/key/<key>/agency/BCT/command/gtfs-rt/`) when it asks. Deploys from GitHub keep the secret. Without it, the app works as before, without those five routes.

### 6. Check it

- **The site:** open `https://<you>.github.io/broward-transit-3d/`. Buses should appear within about 10 seconds.
- **The API:** open `https://broward-transit-3d.<subdomain>.workers.dev/api/health`. Within two minutes of the Worker's first cron run it should say `"status":"ok"`.
  - If the `feed-errors` check mentions TLS or "internal error", Cloudflare couldn't connect to BCT's server, which only offers older TLS cipher suites. Cloudflare's network supports them, so this isn't expected; if it happens, tell me and we'll route the feeds another way.
- **Reliability:** the Reliability panel starts empty. It fills as the Durable Object records departures, a few hundred an hour in the daytime.

## Iterating

The everyday loop:

1. **Run it locally** with `npm run dev` and open http://localhost:8787. The Node server serves the same `/api/*` endpoints as the Worker, so the page behaves the same.
2. **Test** with `npm test`.
3. **Push to `main`.** Changes to the web app redeploy the site (about 2 minutes). Changes under `worker/`, `server/` or the shared `web/` modules the Worker uses also redeploy the Worker.

For anything bigger, work on a branch and merge when it's ready. Only `main` deploys.

### Running the Worker locally

Run this when you change `worker/`:

```bash
npm run dev
```

Then, in a second terminal:

```bash
npm run dev:worker
```

The Worker runs on http://127.0.0.1:8788. `.dev.vars` points it at the Node server for the timetable and for BCT's feeds; workerd can't connect to BCT directly on your machine, though the deployed Worker can.

- **Trigger the minute cron by hand:** open http://127.0.0.1:8788/__scheduled?cron=*+*+*+*+*
- **See the result:** open http://127.0.0.1:8788/api/health and http://127.0.0.1:8788/api/reliability
- **Use it from the page:** build a copy of the site with `npm run build:site:local`, then serve `_site/` with any static server.

On Windows, keep the project in a short path such as `C:coderoward-transit-3d`. wrangler keeps the Durable Object's local database deep inside `.wrangler/`, and past Windows' 260-character path limit SQLite fails with `SQLITE_CANTOPEN`. Otherwise add `-- --persist-to C:	empt3d` to the command.

### Things to know when changing things

- **The timetable format** (`web/schedule.js`): the site, the Node server and the Durable Object all read it. Bump its `v` number if you change its shape, and keep reading the old one until a nightly build has replaced it.
- **The API contract:** the site and the Worker deploy separately and may be a few minutes apart. Make Worker changes backwards-compatible, or deploy the Worker first.
- **The Durable Object's database:** add tables or columns with `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` in its constructor. Renaming or deleting the `Recorder` class needs a new `[[migrations]]` entry in `wrangler.toml`.
- **Logs:** run `npx wrangler tail` (after `npx wrangler login`), or open the Cloudflare dashboard → Workers & Pages → broward-transit-3d → Logs.
- **Rolling back:** for the Worker, `npx wrangler rollback`, or redeploy an older commit with **Run workflow**. For the site, re-run an older **Deploy site** run, or revert the commit.
- **The nightly build:** GitHub pauses scheduled workflows in repositories with no activity for 60 days. If the timetable goes stale, `/api/health` reports it within 7 days of it running out, and any push or a manual run restarts the schedule.

## Free plan limits

At this app's size, everything sits inside the free plans:

| Limit | Free allowance | This app |
|---|---|---|
| Worker requests | 100,000 a day | One per open page every 10 s, plus weather and radar every few minutes: about 30 pages open all day. Beyond that, requests fail until the next UTC day. |
| Worker CPU | 10 ms per request | `/api/rt` repackages bytes and never decodes them: about 1 ms |
| Durable Object rows written | 100,000 a day | About 60,000 (one per departure, plus counts and deletes of old rows) |
| Durable Object rows read | 5 million a day | About 75,000 each time the object wakes from eviction; nothing per request |
| Pages bandwidth | 100 GB a month (soft) | About 1 MB per first visit |
| Actions minutes | Unlimited on public repositories | About 2 minutes a day |

If the site gets popular, the first limit you'll hit is Worker requests. The cheapest fix is a custom domain on Cloudflare: `/api/rt` can then be cached at the edge, so most requests never run the Worker. The other fix is the $5/month Workers plan.

## Monitoring

`GET /api/health` on the Worker returns `{ status, checks, … }`:

| status | HTTP | Meaning |
|---|---|---|
| `ok` | 200 | All checks pass |
| `degraded` | 200 | Still working, but needs attention. Possible causes: BCT data over 2 minutes stale, a feed returning errors, the timetable ending within 7 days, the timetable over 36 hours old, or the Worker unable to load it from Pages. |
| `down` | 503 | The map is wrong or stale. Possible causes: no successful BCT fetch in 10 minutes (including the cron having stopped), BCT's own data over 10 minutes old, or the timetable having ended. |

Point a free uptime monitor (UptimeRobot, Better Stack, Healthchecks.io…) at it, alerting on non-200. For warnings on `degraded` as well, use a keyword check for `"status":"ok"`.

## Before going public

- **BCT data:** BCT publishes no licence or terms for its GTFS-RT feeds. Email BCTGTFSFeed@broward.org before launching. The Worker keeps load low: at most one fetch per 10 s from each Worker instance, plus one a minute from the Durable Object. Browsers never hit BCT directly.
- **Attribution:** keep the map credits MapLibre shows (OpenFreeMap, OpenMapTiles, OpenStreetMap contributors, and NEXRAD/IEM when radar is on), and credit Broward County Transit for the data.
- **Free services:** OpenFreeMap, Open-Meteo and IEM are free community or academic services with no uptime guarantee. The URLs to change are in `web/main.js` and `server/extras.mjs`.

## Self-hosting instead

`server/index.mjs` runs the whole thing as one Node process: API, web app, feed polling, nightly rebuild and a file-based reliability log in `data/reliability/`. Use it on any machine or VM:

- **Docker:** `docker build -t broward-transit-3d .`, then run with volumes for `/app/data` and `/app/public/data`. The health check is built in.
- **Plain Node 22+:** run `npm ci --omit=dev`, then `node server/index.mjs` under systemd with `Restart=always`.

Run exactly one instance. Environment variables: `PORT` (8787), `REFRESH_MS` (10000), `NIGHTLY_BUILD_AT` (`03:30` Broward time, or `off`), `BCT_STATIC_URL`, and `CONTRACT_FEED_BASE` for the contracted routes' feeds (see step 5b).
