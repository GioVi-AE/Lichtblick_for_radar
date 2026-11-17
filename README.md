# Eagle Radar Analysis

A radar-focused fork of [Lichtblick](https://github.com/lichtblick-suite/lichtblick) (v1.31.0, MPL-2.0) for
ROS 2 radar bags. It shows detections, tracks and ground truth on a **georeferenced map**, computes **radar KPIs**
(Pd, false alarms, CEP, range/azimuth/elevation/velocity error, track continuity, RV-map health) and runs
entirely in **Docker**.

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
