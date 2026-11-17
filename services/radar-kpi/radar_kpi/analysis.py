# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
"""Per-run analysis: source resolution, georeferencing, KPI computation, context payloads, caching."""

from __future__ import annotations

import csv
import hashlib
import re
import io
import json
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import __version__
from .adapters import (
    Detections,
    LocalTruth,
    Status,
    TrackSet,
    read_detections,
    read_local_truth,
    read_navsat,
    read_status,
    read_tracks,
)
from .catalog import Catalog, Run
from .geo import lla_to_ned, local_to_ned, ned_to_lla
from .georef import Anchor, Track, estimate_anchor, estimate_time_offset
from .kpi import (
    KpiParams,
    detection_kpi,
    detection_range_table,
    detection_stream_timeline,
    downsample_samples,
    health_kpi,
    track_kpi,
)
from .mcap_io import (
    KIND_CV_DET,
    KIND_DET_ARRAY,
    KIND_GEO_TRACK,
    KIND_GROUND_TRUTH,
    KIND_NAVSAT,
    KIND_ODOM_GT,
    KIND_RADAR_DET,
    KIND_RV_HEALTH,
    KIND_TRACK_ARRAY,
    KIND_TRACK_KPI,
    summarize_bag,
)

log = logging.getLogger("radar_kpi.analysis")


class Loaded:
    """Everything needed to analyse one run (read once, kept in memory)."""

    def __init__(self) -> None:
        self.run: Run | None = None
        self.det: Detections | None = None
        self.tracks: TrackSet | None = None
        self.status: Status | None = None
        self.carrier: Track | None = None
        self.carrier_topic: str | None = None
        self.target: Track | None = None
        self.target_topic: str | None = None
        self.local_truth: LocalTruth | None = None
        self.anchor: Anchor | None = None
        self.frame: str = "NED"
        self.det_ned: np.ndarray | None = None
        self.plat_ned: np.ndarray | None = None
        self.warnings: list[str] = []
        self.sources: dict = {}


_CARRIER_NAME = re.compile(r"carrier|platform|ego|own_?ship|radar", re.I)


def _jsonable(o):
    if isinstance(o, dict):
        return {k: _jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_jsonable(v) for v in o]
    if isinstance(o, np.floating):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, float) and not np.isfinite(o):
        return None
    return o


class Analyzer:
    def __init__(self, catalog: Catalog, cache_dir: Path):
        self.catalog = catalog
        self.cache_dir = cache_dir
        (cache_dir / "kpi").mkdir(parents=True, exist_ok=True)
        self._loaded: dict[str, Loaded] = {}
        self._lock = threading.Lock()
        self._run_locks: dict[str, threading.Lock] = {}

    def _run_lock(self, rid: str) -> threading.Lock:
        with self._lock:
            return self._run_locks.setdefault(rid, threading.Lock())

    # ------------------------------------------------------------------------------- loading
    def load(self, run: Run) -> Loaded:
        with self._run_lock(run.id):
            cached = self._loaded.get(run.id)
            if cached is not None:
                return cached
            ld = self._load_uncached(run)
            with self._lock:
                if len(self._loaded) >= 4:  # tiny LRU: keep memory bounded
                    self._loaded.pop(next(iter(self._loaded)))
                self._loaded[run.id] = ld
            return ld

    def _load_uncached(self, run: Run) -> Loaded:
        ld = Loaded()
        ld.run = run
        files = self.catalog.files(run)
        summary = summarize_bag(self.catalog.bag_path(run))
        assert summary is not None
        topics = summary.topics

        # --- detections: the topic with most messages among detection kinds
        det_cands = sorted((t for t in topics if t.kind in (KIND_RADAR_DET, KIND_CV_DET, KIND_DET_ARRAY) and t.count > 0),
                           key=lambda t: (t.kind != KIND_RADAR_DET, t.kind == KIND_CV_DET and "track" in t.name.lower(), -t.count))
        if det_cands:
            t = det_cands[0]
            ld.det = read_detections(files, t.name, t.type)
            ld.sources["detections"] = {"topic": t.name, "schema": t.type, "count": 0 if ld.det is None else len(ld.det)}
        # --- tracks
        trk_cands = [t for t in topics if t.kind in (KIND_TRACK_ARRAY, KIND_GEO_TRACK) and t.count > 0]
        if not trk_cands:
            trk_cands = [t for t in topics if t.kind == KIND_CV_DET and t.count > 0]
        if trk_cands:
            tc = max(trk_cands, key=lambda t: ("track" in t.name.lower(), t.count))
            ld.tracks = read_tracks(files, tc.name, tc.type)
            if ld.tracks is not None:
                ld.sources["tracks"] = {"topic": tc.name, "schema": tc.type, "count": len(ld.tracks)}
        # --- status topics
        stat_topics = [(t.name, t.type) for t in topics if t.kind in (KIND_TRACK_KPI, KIND_RV_HEALTH)]
        if stat_topics:
            ld.status = read_status(files, stat_topics)
        # --- local ground truth (messages)
        gt_topics = [(t.name, t.type) for t in topics if t.kind in (KIND_GROUND_TRUTH, KIND_ODOM_GT) and t.count > 0]
        if gt_topics:
            ld.local_truth = read_local_truth(files, gt_topics)

        # --- carrier + target NavSat (own bag, else paired raw bag)
        sources = [(run, files, topics)]
        if run.paired_with:
            pr = self.catalog.get(run.paired_with)
            if pr is not None:
                psum = summarize_bag(self.catalog.bag_path(pr))
                if psum is not None:
                    sources.append((pr, self.catalog.files(pr), psum.topics))
                    ld.sources["pair_run_id"] = pr.id
        self._load_navsat(ld, sources)

        self._georeference(ld)
        return ld

    def _load_navsat(self, ld: Loaded, sources) -> None:
        for r, files, topics in sources:
            nav = [t for t in topics if t.kind == KIND_NAVSAT and t.count >= 2 and not t.name.endswith("/raw/fix")]
            if not nav:
                continue
            ns = r.carrier_ns
            tracks = read_navsat(files, [t.name for t in nav])
            carrier_topics = [t for t in tracks if ns and t.startswith(ns + "/")]
            if not ns:  # geo-native bags without raw radar topics: guess by name
                carrier_topics = [t for t in tracks if _CARRIER_NAME.search(t)]
            if carrier_topics and ld.carrier is None:
                # prefer global_position/global
                carrier_topics.sort(key=lambda x: (not x.endswith("global_position/global"), x))
                ld.carrier_topic = carrier_topics[0]
                ld.carrier = tracks[ld.carrier_topic]
            cands = {k: v for k, v in tracks.items()
                     if not (ns and k.startswith(ns + "/")) and not (not ns and k in carrier_topics)}
            if cands and ld.target is None:
                ld.sources.setdefault("_target_candidates", {}).update(cands)

    # ------------------------------------------------------------------------------- georeference
    def _georeference(self, ld: Loaded) -> None:
        det = ld.det
        cands: dict[str, Track] = ld.sources.pop("_target_candidates", {})
        if det is None:
            ld.warnings.append("No radar detection topic found in this run.")
            if cands:
                ld.target_topic, ld.target = next(iter(cands.items()))
            return
        # geo-native detections (CVDetection): anchor = first detection
        if det.lla is not None:
            a = (float(det.lla[0, 0]), float(det.lla[0, 1]), float(det.lla[0, 2]))
            ld.anchor = Anchor(*a, frame="NED", residual_std_m=0.0, source="cv_detection")
            ld.det_ned = lla_to_ned(a, det.lla[:, 0], det.lla[:, 1], det.lla[:, 2])
            if ld.carrier is not None:
                clat, clon, calt, cvalid = ld.carrier.at(det.t, 5.0)
                plat = lla_to_ned(a, clat, clon, calt)
                plat[~cvalid] = np.nan
                ld.plat_ned = plat
                if det.range is None:
                    det.range = np.linalg.norm(ld.det_ned - plat, axis=1)
        elif det.platform_local is not None and det.local is not None and ld.carrier is not None:
            stride = max(1, len(det) // 2000)
            anchor = estimate_anchor(det.t[::stride], det.platform_local[::stride], ld.carrier)
            if anchor is None:
                ld.warnings.append("Could not georeference detections: carrier NavSatFix does not overlap detection times.")
            else:
                ld.anchor, ld.frame = anchor, anchor.frame
                if (anchor.residual_std_m or 0) > 25:
                    ld.warnings.append(
                        f"Georeference residual is large ({anchor.residual_std_m:.1f} m); the local-frame assumption may not hold.")
                a = anchor.as_tuple()
                ld.det_ned = local_to_ned(anchor.frame, det.local)
                ld.plat_ned = local_to_ned(anchor.frame, det.platform_local)
        elif det.local is not None:
            ld.warnings.append("Radar-local detections but no radar-platform NavSatFix (not in this bag nor in a paired raw bag): "
                               "cannot georeference; only detection statistics are available.")
        if det.local is not None and det.platform_local is not None and ld.plat_ned is None and ld.anchor is not None:
            ld.plat_ned = local_to_ned(ld.anchor.frame, det.platform_local)

        # --- ground truth selection
        if ld.anchor is None:
            return
        a = ld.anchor.as_tuple()
        if ld.local_truth is not None:
            ned = local_to_ned(ld.anchor.frame, ld.local_truth.local)
            lat, lon, alt = ned_to_lla(a, ned)
            ld.target = Track(ld.local_truth.t, lat, lon, alt)
            ld.target_topic = ld.local_truth.topic
        elif cands:
            best, best_d = None, np.inf
            for name, tr in cands.items():
                glat, glon, galt, valid = tr.at(det.t, 5.0)
                if valid.sum() < 3:
                    continue
                g = lla_to_ned(a, glat[valid], glon[valid], galt[valid])
                d = float(np.median(np.linalg.norm(det_ned_v(ld, valid) - g, axis=1)))
                if d < best_d:
                    best, best_d = name, d
            if best is not None:
                ld.target_topic, ld.target = best, cands[best]
                ld.sources["target_selection_median_dist_m"] = best_d
            else:
                ld.warnings.append("Target NavSatFix candidates do not overlap the detection time span.")
        else:
            ld.warnings.append("No ground truth available: detection-only statistics.")

    # ------------------------------------------------------------------------------- context
    def context(self, run: Run, max_points: int = 3000) -> dict:
        ld = self.load(run)

        def pack(tr: Track | None):
            if tr is None or len(tr) == 0:
                return []
            idx = np.arange(len(tr))
            if len(idx) > max_points:
                idx = np.linspace(0, len(tr) - 1, max_points).astype(int)
            return [[float(tr.t[i]), float(tr.lat[i]), float(tr.lon[i]), float(tr.alt[i])] for i in idx]

        return _jsonable({
            "run_id": run.id,
            "anchor": None if ld.anchor is None or ld.anchor.source == "cv_detection" else {
                "lat": ld.anchor.lat, "lon": ld.anchor.lon, "alt": ld.anchor.alt, "frame": ld.anchor.frame,
                "residual_std_m": ld.anchor.residual_std_m, "source": "service",
            },
            "carrier": pack(ld.carrier),
            "target": pack(ld.target),
            "carrier_topic": ld.carrier_topic,
            "target_topic": ld.target_topic,
            "warnings": ld.warnings,
        })

    # ------------------------------------------------------------------------------- KPI
    def _cache_path(self, run: Run, params: KpiParams) -> Path:
        sig = hashlib.sha1(
            f"{__version__}|{run.id}|{run.size_bytes}|{run.paired_with}|{params.gate_m}|{params.bin_s}|{params.max_gt_gap_s}|{params.time_offset_s}|{params.auto_offset}".encode()
        ).hexdigest()[:16]
        return self.cache_dir / "kpi" / f"{run.id}-{sig}.json"

    def kpi(self, run: Run, params: KpiParams, force: bool = False) -> dict:
        path = self._cache_path(run, params)
        if path.exists() and not force:
            return json.loads(path.read_text())
        result, arrays = self._compute(run, params)
        result = _jsonable(result)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(result))
        tmp.replace(path)
        if arrays is not None:
            self._write_csv(path.with_suffix(".csv"), arrays)
        return result

    def kpi_csv(self, run: Run, params: KpiParams) -> str:
        self.kpi(run, params)
        p = self._cache_path(run, params).with_suffix(".csv")
        return p.read_text() if p.exists() else "t\n"

    def _compute(self, run: Run, params: KpiParams) -> tuple[dict, dict | None]:
        ld = self.load(run)
        warnings = list(ld.warnings)
        det = ld.det
        result: dict = {
            "run_id": run.id,
            "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "params": params.to_dict(),
            "mode": "detection_only",
            "warnings": warnings,
            "sources": {**ld.sources, "carrier": ld.carrier_topic, "ground_truth": ld.target_topic},
            "timing": {"t_start": None, "t_end": None, "duration_s": 0.0},
            "georef": None,
            "detection": {"count": 0, "per_minute": None, "max_gap_s": 0.0, "range_m": None, "power_db": None},
            "by_range": [],
            "timeline": [],
            "tracks": None,
            "health": None,
            "samples": [],
        }
        if ld.anchor is not None and ld.anchor.source != "cv_detection":
            result["georef"] = {
                "frame": ld.anchor.frame, "lat0": ld.anchor.lat, "lon0": ld.anchor.lon, "alt0": ld.anchor.alt,
                "residual_std_m": ld.anchor.residual_std_m, "source": ld.anchor.source,
            }
        arrays: dict | None = None
        if det is not None and len(det) > 0:
            result["timing"] = {"t_start": float(det.t.min()), "t_end": float(det.t.max()),
                                "duration_s": float(det.t.max() - det.t.min())}
            anchor_t = ld.anchor.as_tuple() if ld.anchor else None
            gt = ld.target
            tracks_gt = gt
            if gt is not None and anchor_t is not None and ld.det_ned is not None:
                est = estimate_time_offset(det.t, ld.det_ned, gt, anchor_t, params.max_gt_gap_s)
                applied = params.time_offset_s
                if params.auto_offset and est is not None:
                    applied = est["lag_s"]
                if est is not None:
                    est["applied_s"] = float(applied)
                    result["time_offset"] = est
                    if abs(est["lag_s"]) >= 0.3 and est["median_d3_at_lag_m"] < 0.8 * est["median_d3_at_zero_m"] and not applied:
                        warnings.append(
                            f"Detections appear time-shifted by {est['lag_s']:+.2f} s relative to the ground truth "
                            f"(median 3-D error {est['median_d3_at_zero_m']:.0f} m -> {est['median_d3_at_lag_m']:.0f} m). "
                            "Pd and errors are pessimistic; re-run with auto_offset to compensate.")
                if applied:
                    gt = gt.shifted(applied)
            d, arrays, w = detection_kpi(det, ld.det_ned, ld.plat_ned, gt, anchor_t, params)
            warnings.extend(w)
            by_range = d.pop("by_range", None)
            timeline = d.pop("timeline", None)
            result["detection"] = d
            if gt is not None and "true" in d:
                result["mode"] = "ground_truth"
                result["by_range"] = by_range or []
                result["timeline"] = timeline or []
                result["samples"] = downsample_samples(det, arrays, params.max_samples)
            else:
                result["by_range"] = detection_range_table(det)
                result["timeline"] = detection_stream_timeline(det, params)
        elif det is not None:
            warnings.append("Detection topic is empty.")

        if ld.tracks is not None:
            anchor_t = ld.anchor.as_tuple() if ld.anchor else None
            if anchor_t is None and ld.tracks.lla is not None:
                anchor_t = tuple(float(x) for x in ld.tracks.lla[0])
            result["tracks"] = track_kpi(ld.tracks, anchor_t, ld.frame, ld.target, ld.status, params)
        result["health"] = health_kpi(ld.status)
        return result, arrays

    @staticmethod
    def _write_csv(path: Path, arrays: dict) -> None:
        keys = [k for k, v in arrays.items() if isinstance(v, np.ndarray) and v.ndim == 1]
        n = len(arrays["t"])
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(keys)
        for i in range(n):
            w.writerow([_fmt(arrays[k][i]) for k in keys])
        path.write_text(buf.getvalue())


def _fmt(v) -> str:
    if isinstance(v, (np.bool_, bool)):
        return "1" if v else "0"
    if isinstance(v, (np.floating, float)):
        return "" if not np.isfinite(v) else f"{float(v):.6f}"
    return str(v)


def det_ned_v(ld: Loaded, valid: np.ndarray) -> np.ndarray:
    assert ld.det_ned is not None
    return ld.det_ned[valid]
