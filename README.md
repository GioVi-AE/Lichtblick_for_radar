# Eagle Radar Analysis

A radar-focused fork of [Lichtblick](https://github.com/lichtblick-suite/lichtblick) (v1.31.0, MPL-2.0) for
ROS 2 radar bags. It shows detections, tracks and ground truth on a **georeferenced map**, computes **radar KPIs**
(Pd, false alarms, CEP, range/azimuth/elevation/velocity error, track continuity, RV-map health) and runs
entirely in **Docker**.

Created by **Giovanni Viglialoro** (giovanni.viglialoro@alpineeagle.com).

```
 browser ──► web (Caddy, Lichtblick + eagle-radar extension) ──► /kpi/*  ──► radar-kpi (FastAPI, Python)
                                                         └────► /data/* ──► data-server (nginx, Range+CORS)
                                  bags are mounted read-only into radar-kpi and data-server, never copied
```

## Quick start

```bash
cp .env.example .env        # set RAW_DATA_DIR and PROCESSED_DATA_DIR to your MCAP folders
docker compose up --build
# open http://localhost:8080  (default layout: Run browser | Radar map | KPIs + RV-map)
```

Pick a run in the **Run browser** and press *Open*: the bag is streamed to Lichtblick over HTTP Range; the map, KPI
dashboard and RV-map panels follow the playback cursor. No bag? Generate a synthetic one:

```bash
cd services/radar-kpi && python -m radar_kpi.sim ../../data/raw      # needs the requirements installed
```

## Using it

1. Open `http://localhost:8080` and close the welcome dialog (Escape). Do **not** use "Explore sample data": that is
   upstream Lichtblick's nuScenes demo (a Singapore map) and has nothing to do with the radar bags.
2. In **Radar Runs** pick a run and press **Open**. Runs whose `log_time` is stored in seconds show a `t[s]` chip and a
   **Fix time + open** button: it creates a time-corrected copy (about 13 s for 1.2 GB) so the playback clock shows the
   real date instead of 1970. The original bag is never modified.
3. Press **Space** (or ▶). The panels follow the playback cursor:
   * **Radar Map** - detections (colour = power), tracks, ground truth and the radar platform on OpenStreetMap; data
     is georeferenced by the panel itself and zooms to the bag's location. Settings: tile source, anchor, trail, track
     x/y axes (`auto` by default).
   * **Radar KPIs** - Pd, false alarms, CEP50/95, RMSE, range/azimuth/elevation/velocity error, tracks, RV-map health.
     Choose the association gate (default 150 m) and bin; *Report* and *CSV* export the numbers. If a time shift against
     the ground truth is detected, tick *auto time-sync* and press *Compute*.
   * **RV Map** - range-velocity heat map of `GeoRegRVMap`/`RVMap` frames plus the status strip.
   * **Runs** - catalogue of all bags (filter by GT / detections).
4. Direct link to a bag: `http://localhost:8080/?ds=remote-file&ds.url=http://localhost:8080/data/<root>/<path>.mcap`

### Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Singapore map | nuScenes sample data/layout is open. Switch layout (Layouts menu) or open a run from *Radar Runs* |
| Empty map | Press play; the map fills as the cursor moves. Make sure the panel is **Radar Map**, not the built-in *Map* |
| Clock shows 1970 | `log_time` in seconds. Use *Fix time + open* |
| "radar-kpi service unavailable" | `docker compose ps`; `docker compose logs radar-kpi` |
| Blank page | Hard reload (Ctrl+Shift+R); WebGL-capable Chrome/Firefox; check the browser console |
| Run list empty | Check `RAW_DATA_DIR` / `PROCESSED_DATA_DIR` in `.env`, then press *Rescan* |

## Verification status (what is and is not proven)

* **Verified on real bags:** `GeoRegRVMap` layout (velocity-major), georeferencing, ground-truth pairing, detection
  KPIs, RV health derived from the frames, time-fixed copies, the full UI flow in headless Chromium.
* **Verified only on synthetic bags:** track KPIs and everything about `eagle_radar` messages (`TrackArray`,
  `DetectionArray`, `TrackKpiStatus`, `RvMapHealth`) - no readable bag contains them. The x/y frame of `Track`/`Detection`
  is not assumed: it is selected against the ground truth (NED, ENU, platform-relative) and reported with a confidence.
* Details and evidence: `docs/radar/messages.md`, `docs/radar/kpis.md`.

## What is in here

| Path | Content |
| --- | --- |
| `extensions/eagle-radar/` | Built-in Lichtblick extension: panels *Radar Map*, *Radar KPIs*, *RV Map*, *Run Browser* and message converters |
| `services/radar-kpi/` | Python KPI engine, bag catalogue and REST API (pytest suite included) |
| `docker/`, `docker-compose.yml` | Web image (multi-stage), nginx data server, compose stack |
| `layouts/radar-analysis.json` | Default layout baked into the web image |
| `docs/radar/` | Architecture, KPI definitions, message contract, operations |
| `PATCHES.md` | Every change made to upstream Lichtblick files |

The rest of the tree is unmodified upstream Lichtblick; see `README.upstream.md`, `LICENSE` (MPL-2.0) and
`LICENSE-PROPRIETARY` for the licensing split.

## Tests

```bash
docker build --target test services/radar-kpi                       # pytest in a container
docker run --rm -v "$PWD/extensions/eagle-radar":/w -w /w node:22-slim sh -c "npm ci && npm test && npm run typecheck"
```
