# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
"""Re-express a *real* processed run in the eagle_radar contract (CVDetection + NavSatFix).

Real bags contain no eagle_radar messages yet. This converter turns a real run (RadarDetection georeferenced with
the estimated anchor, plus carrier / target NavSatFix) into a bag that uses the new contract, so that

  * the contract path can be exercised with real data volumes, timing and geometry, and
  * the KPIs of both representations can be compared (they must agree: `python -m radar_kpi.export_cv --check`).

    python -m radar_kpi.export_cv <run_id> out_dir  [--roots raw=...,processed=...] [--check]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from mcap_ros2.writer import Writer

from .analysis import Analyzer
from .api import parse_roots
from .catalog import Catalog
from .geo import ned_to_lla
from .kpi import KpiParams
from .sim import CV_DETECTION, NAVSAT, _header, _stamp


def export(analyzer: Analyzer, run_id: str, out: Path) -> Path:
    run = analyzer.catalog.get(run_id)
    if run is None:
        raise SystemExit(f"unknown run {run_id}")
    ld = analyzer.load(run)
    if ld.det is None or ld.det_ned is None or ld.anchor is None or ld.target is None:
        raise SystemExit("run needs georeferenced detections and a ground-truth track")
    a = ld.anchor.as_tuple()
    lat, lon, alt = ned_to_lla(a, ld.det_ned)
    path = out / f"cv_{run_id}" / "cv.mcap"
    path.parent.mkdir(parents=True, exist_ok=True)
    events: list[tuple[float, str, dict, str]] = []  # (t, topic, msg, schema key)
    for i, t in enumerate(ld.det.t):
        conf = 0.0 if ld.det.confidence is None else float(ld.det.confidence[i])
        events.append((float(t), "/radar/detections", {
            "header": _header(float(t), "map"), "latitude": float(lat[i]), "longitude": float(lon[i]), "altitude": float(alt[i]),
            "position_covariance": [0.0] * 9, "position_covariance_type": 0, "object_id": "", "object_class": "",
            "sensor_id": "export", "confidence": conf, "datum": "WGS84", "coordinate_system": "ENU", "source_adapter": "export_cv",
            "state": "", "vx": 0.0, "vy": 0.0, "vz": 0.0, "external_id": ""}, "cv"))
    for topic, tr in (("/target/mavros/global_position/global", ld.target), ("/carrier/mavros/global_position/global", ld.carrier)):
        if tr is None:
            continue
        for t, la, lo, al in zip(tr.t, tr.lat, tr.lon, tr.alt):
            events.append((float(t), topic, {
                "header": _header(float(t), "gps"), "status": {"status": 0, "service": 1}, "latitude": float(la),
                "longitude": float(lo), "altitude": float(al), "position_covariance": [0.0] * 9, "position_covariance_type": 0}, "nav"))
    events.sort(key=lambda e: e[0])
    with open(path, "wb") as fh:
        w = Writer(fh)
        schemas = {"cv": w.register_msgdef("eagle_radar/msg/CVDetection", CV_DETECTION),
                   "nav": w.register_msgdef("sensor_msgs/msg/NavSatFix", NAVSAT)}
        for t, topic, msg, key in events:
            w.write_message(topic=topic, schema=schemas[key], message=msg, log_time=int(t * 1e9), publish_time=int(t * 1e9))
        w.finish()
    return path


def _summary(k: dict) -> dict:
    d = k["detection"]
    return {"count": d["count"], "true": d.get("true"), "pd": d.get("pd"), "cep50_m": d.get("cep50_m"), "cep95_m": d.get("cep95_m"),
            "false_alarms_per_min": d.get("false_alarms_per_min"), "rmse_horiz": (d.get("error") or {}).get("horiz", {}).get("rmse")}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("run_id")
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--roots", default="raw=/media/gio/SSD4TB/data_bag,processed=/home/gio/bags")
    ap.add_argument("--cache", type=Path, default=Path("/tmp/export_cv_cache"))
    ap.add_argument("--check", action="store_true", help="compare KPIs of the source run and the exported bag")
    ns = ap.parse_args()
    cat = Catalog(parse_roots(ns.roots), ns.cache)
    cat.scan()
    an = Analyzer(cat, ns.cache)
    path = export(an, ns.run_id, ns.out_dir)
    print(f"wrote {path}")
    if ns.check:
        params = KpiParams(gate_m=150.0)
        src = _summary(an.kpi(cat.get(ns.run_id), params, force=True))
        cat2 = Catalog({"cv": ns.out_dir}, ns.cache / "cv")
        cat2.scan(force=True)
        run2 = next(r for r in cat2.list() if r.name.startswith(f"cv_{ns.run_id}"))
        dst = _summary(Analyzer(cat2, ns.cache / "cv").kpi(run2, params, force=True))
        print(json.dumps({"source": src, "contract_bag": dst}, indent=1))
        bad = [k for k in src if src[k] is not None and dst[k] is not None and abs(src[k] - dst[k]) > 1e-6 * max(1.0, abs(src[k])) + (0.5 if k.startswith(("cep", "rmse")) else 0)]
        print("MISMATCH: " + ", ".join(bad) if bad else "KPIs agree between RadarDetection and eagle_radar CVDetection paths")


if __name__ == "__main__":
    main()
