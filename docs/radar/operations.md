# Operations and acceptance

```bash
docker compose up --build -d
curl localhost:8080/kpi/health            # {"status":"ok",...}
curl localhost:8080/kpi/runs | head
curl -I -H 'Range: bytes=0-99' localhost:8080/data/raw/<bag>/<file>.mcap   # 206 Partial Content
```

Service environment: `RADAR_ROOTS` (`name=path,…`, default raw + processed), `RADAR_CACHE_DIR` (volume `kpi-cache`;
catalogue and KPI JSON/CSV caches, invalidated by service version, bag size and parameters).

REST: `GET /runs`, `POST /rescan`, `GET /runs/by-url?url=`, `GET /runs/{id}`, `/context`, `/kpi?gate_m=&bin_s=&auto_offset=`,
`/kpi.csv`, `/report.html`.

Tests: `docker build --target test services/radar-kpi` and the extension tests (see `README.md`).
