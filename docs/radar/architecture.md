# Architecture

```
┌────────────── web container (Caddy :8080) ───────────────┐      ┌── radar-kpi (FastAPI :8090) ──┐
│ Lichtblick web build + default layout (placeholder swap) │ /kpi │ catalogue  ← bag folders (ro)  │
│ /radar-extension/{manifest.json,extension.js}            ├─────►│ KPI engine, JSON+CSV cache     │
│  └─ loaded by BuiltinExtensionLoader (suite-web patch)   │      │ HTML report                    │
│ reverse proxy /kpi/* and /data/* → single origin, no CORS│      └────────────────────────────────┘
└───────────────────────┬──────────────────────────────────┘      ┌── data-server (nginx :8081) ───┐
                        └──────────────────────────── /data ─────►│ MCAP files, Range + CORS (ro)  │
                                                                  └────────────────────────────────┘
```

* **Extension** (`extensions/eagle-radar`): vanilla DOM/canvas panels + Leaflet, bundled with esbuild into one CommonJS
  file. It is served from the web root and registered through an `IExtensionLoader` of type `server`, so it is
  available in every session without installation. Panel type ids: `eagle-radar.RadarMap`, `RadarKpi`, `RvMap`, `RadarRuns`.
* **Opening a bag**: the Run browser links to `/?ds=remote-file&ds.url=/data/<root>/<path>.mcap`. Panels recover the run
  with `GET /kpi/runs/by-url?url=…`.
* **Georeferencing**: radar-local data (`RadarDetection`) is in a NED frame with an unknown anchor. The anchor is
  estimated by comparing `RadarDetection.origin` with the carrier NavSatFix track (both NED and ENU hypotheses are tried,
  anchor refined by the median residual; exact ECEF tangent-plane maths, WGS84). The TypeScript and Python
  implementations are identical so the map and the service agree to centimetres.
* **Pairing**: processed bags (`detectionsAndGT.bag`) have no usable GT. They are paired with their raw sibling by the
  `rosbag2_YYYY_MM_DD-HH_MM_SS` token; the target NavSatFix of the raw bag is the ground truth (target chosen by minimum
  median distance to the detections).
* **Clock quirk**: some processed bags store seconds in `log_time` instead of nanoseconds. The catalogue flags them
  (`log_time_unit = "s"`) and panels map the playback cursor to payload time.
* **Data is never copied**: bags are bind-mounted read-only into `radar-kpi` and `data-server`.
