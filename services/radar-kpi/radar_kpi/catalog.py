# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
"""Bag catalogue: scans data roots for rosbag2/MCAP recordings and derives analysis-relevant flags."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
from dataclasses import dataclass, field, asdict
from pathlib import Path
from urllib.parse import quote

from .mcap_io import (
    KIND_CV_DET,
    KIND_DET_ARRAY,
    KIND_GEO_TRACK,
    KIND_GROUND_TRUTH,
    KIND_NAVSAT,
    KIND_ODOM_GT,
    KIND_RADAR_DET,
    KIND_RAW_RADAR,
    KIND_RVMAP,
    KIND_TRACK_ARRAY,
    BagSummary,
    bag_mcap_files,
    iter_messages,
    summarize_bag,
)

log = logging.getLogger("radar_kpi.catalog")

CATALOG_VERSION = 4
_TOKEN = re.compile(r"rosbag2_\d{4}_\d{2}_\d{2}-\d{2}_\d{2}_\d{2}")


_CARRIER_NAME = re.compile(r"carrier|platform|ego|own_?ship|radar", re.I)


@dataclass
class Run:
    id: str
    name: str
    root: str
    mcap: str  # primary mcap, relative to the root
    data_url: str
    bag_dir: str  # bag directory (or file) relative to the root
    duration_s: float = 0.0
    start_time_s: float | None = None
    message_count: int = 0
    size_bytes: int = 0
    topics: list[dict] = field(default_factory=list)
    has_detections: bool = False
    has_tracks: bool = False
    has_ground_truth: bool = False
    has_carrier: bool = False
    has_rvmap: bool = False
    gt_source: str | None = None
    paired_with: str | None = None
    log_time_unit: str = "unknown"
    indexed: bool = True
    bbox: list[float] | None = None
    notes: list[str] = field(default_factory=list)
    carrier_ns: str | None = None
    token: str | None = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d.pop("carrier_ns", None)
        d.pop("token", None)
        return d


def run_id(root: str, rel: str) -> str:
    return hashlib.sha1(f"{root}:{rel}".encode()).hexdigest()[:12]


def _log_time_unit(start_ns: int | None) -> str:
    if start_ns is None:
        return "unknown"
    if start_ns >= 1e15:
        return "ns"
    if 1e9 <= start_ns < 4e9:
        return "s"  # epoch seconds written into a nanosecond field
    return "unknown"


def find_bags(root_dir: Path, max_depth: int = 10) -> list[Path]:
    """Directories with metadata.yaml + mcap, and stand-alone .mcap files (outside such directories)."""
    bags: list[Path] = []
    base_depth = len(root_dir.parts)
    for dirpath, dirnames, filenames in os.walk(root_dir):
        p = Path(dirpath)
        if len(p.parts) - base_depth > max_depth:
            dirnames[:] = []
            continue
        has_mcap = any(f.endswith(".mcap") for f in filenames)
        if "metadata.yaml" in filenames and has_mcap:
            bags.append(p)
            dirnames[:] = []
            continue
        for f in filenames:
            if f.endswith(".mcap"):
                bags.append(p / f)
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
    return sorted(bags)


def _ns_of(topic: str) -> str | None:
    m = re.match(r"^(/[^/]+)/", topic)
    return m.group(1) if m else None


def _odometry_gt_nonzero(files: list[Path], topic: str, limit: int = 400) -> bool:
    for i, (_, _, _, m) in enumerate(iter_messages(files, [topic])):
        p = m.pose.pose.position
        if abs(p.x) + abs(p.y) + abs(p.z) > 0:
            return True
        if i >= limit:
            break
    return False


def analyse_bag(root: str, root_dir: Path, bag: Path) -> Run | None:
    summary: BagSummary | None
    try:
        summary = summarize_bag(bag)
    except Exception as exc:  # noqa: BLE001 - corrupt bag must not break the scan
        log.warning("cannot read %s: %s", bag, exc)
        return None
    if summary is None:
        return None
    files = summary.files
    primary = files[0]
    rel_bag = bag.relative_to(root_dir).as_posix()
    rel_mcap = primary.relative_to(root_dir).as_posix()
    parts = rel_bag.split("/")
    name = "/".join(parts[-2:]) if len(parts) > 1 else parts[-1]
    run = Run(
        id=run_id(root, rel_bag),
        name=name,
        root=root,
        mcap=rel_mcap,
        data_url=f"/data/{root}/" + "/".join(quote(x) for x in rel_mcap.split("/")),
        bag_dir=rel_bag,
        message_count=summary.message_count,
        size_bytes=summary.size_bytes,
        indexed=summary.indexed,
        topics=[{"name": t.name, "type": t.type, "count": t.count} for t in summary.topics],
    )
    if summary.start_ns is not None and summary.end_ns is not None:
        unit = _log_time_unit(summary.start_ns)
        run.log_time_unit = unit
        scale = 1e-9 if unit != "s" else 1.0
        run.start_time_s = summary.start_ns * 1e-9 if unit == "ns" else None
        run.duration_s = (summary.end_ns - summary.start_ns) * scale
        if unit == "s":
            run.start_time_s = float(summary.start_ns)
            run.notes.append("log_time stores seconds instead of nanoseconds: Lichtblick playback clock is not real time; panels use payload timestamps")
    if not summary.indexed:
        run.notes.append("MCAP has no chunk index: remote streaming in the browser will be slow or fail")

    det_topics = [t for t in summary.topics if t.kind in (KIND_RADAR_DET, KIND_CV_DET, KIND_DET_ARRAY) and t.count > 0]
    trk_topics = [t for t in summary.topics if t.kind in (KIND_TRACK_ARRAY, KIND_GEO_TRACK) and t.count > 0]
    cv_topics = [t for t in summary.topics if t.kind == KIND_CV_DET and t.count > 0]
    cv_tracks = [t for t in cv_topics if "track" in t.name.lower()]
    run.has_detections = bool(det_topics)
    run.has_tracks = bool(trk_topics or cv_tracks)
    run.has_rvmap = any(t.kind == KIND_RVMAP and t.count > 0 for t in summary.topics)

    raw = [t for t in summary.topics if t.kind == KIND_RAW_RADAR]
    run.carrier_ns = _ns_of(raw[0].name) if raw else None
    nav = [t for t in summary.topics if t.kind == KIND_NAVSAT and t.count >= 10 and not t.name.endswith("/raw/fix")]
    if run.carrier_ns:
        is_carrier = lambda t: t.name.startswith(run.carrier_ns + "/")  # noqa: E731
    else:  # geo-native bags: guess the carrier by topic name
        is_carrier = lambda t: bool(_CARRIER_NAME.search(t.name))  # noqa: E731
    run.has_carrier = any(is_carrier(t) for t in nav)
    targets = [t for t in nav if not is_carrier(t)]

    # explicit ground truth messages
    gt_topics = [t for t in summary.topics if t.kind == KIND_GROUND_TRUTH and t.count > 0]
    odo = [t for t in summary.topics if t.kind == KIND_ODOM_GT and t.count > 0]
    try:
        if gt_topics:
            run.has_ground_truth, run.gt_source = True, f"GroundTruth:{gt_topics[0].name}"
        else:
            for t in odo:
                if _odometry_gt_nonzero(files, t.name):
                    run.has_ground_truth, run.gt_source = True, f"Odometry:{t.name}"
                    break
            else:
                if odo:
                    run.notes.append(f"{odo[0].name} contains only zero positions (no usable ground truth)")
    except Exception as exc:  # noqa: BLE001
        log.warning("gt probe failed for %s: %s", bag, exc)
    if not run.has_ground_truth and targets and (run.carrier_ns or cv_topics or run.has_detections or run.has_tracks):
        run.has_ground_truth, run.gt_source = True, f"NavSatFix:{targets[0].name}"

    m = _TOKEN.search(rel_bag)
    run.token = m.group(0) if m else None
    return run


class Catalog:
    def __init__(self, roots: dict[str, Path], cache_dir: Path):
        self.roots = roots
        self.cache_dir = cache_dir
        self.runs: dict[str, Run] = {}
        self._lock = threading.RLock()
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._cache_file = cache_dir / "catalog.json"
        self.scanning = False

    # -- persistence ---------------------------------------------------------------------------
    def _load_cache(self) -> dict:
        try:
            data = json.loads(self._cache_file.read_text())
            if data.get("version") == CATALOG_VERSION:
                return data.get("entries", {})
        except Exception:  # noqa: BLE001
            pass
        return {}

    def _save_cache(self, entries: dict) -> None:
        tmp = self._cache_file.with_suffix(".tmp")
        tmp.write_text(json.dumps({"version": CATALOG_VERSION, "entries": entries}))
        tmp.replace(self._cache_file)

    @staticmethod
    def _signature(bag: Path) -> str:
        sig = []
        for f in bag_mcap_files(bag):
            st = f.stat()
            sig.append(f"{f.name}:{st.st_size}:{int(st.st_mtime)}")
        return "|".join(sig)

    # -- scanning ------------------------------------------------------------------------------
    def scan(self, force: bool = False) -> int:
        with self._lock:
            self.scanning = True
        try:
            cache = {} if force else self._load_cache()
            entries: dict = {}
            runs: dict[str, Run] = {}
            for root, root_dir in self.roots.items():
                if not root_dir.exists():
                    log.warning("root %s (%s) does not exist", root, root_dir)
                    continue
                for bag in find_bags(root_dir):
                    key = f"{root}:{bag.relative_to(root_dir).as_posix()}"
                    try:
                        sig = self._signature(bag)
                    except OSError:
                        continue
                    ent = cache.get(key)
                    run: Run | None
                    if ent and ent.get("sig") == sig:
                        run = Run(**ent["run"])
                    else:
                        run = analyse_bag(root, root_dir, bag)
                    if run is None:
                        continue
                    entries[key] = {"sig": sig, "run": asdict(run)}
                    runs[run.id] = run
            self._pair(runs)
            self._save_cache(entries)
            with self._lock:
                self.runs = runs
            log.info("catalogue: %d runs", len(runs))
            return len(runs)
        finally:
            with self._lock:
                self.scanning = False

    @staticmethod
    def _pair(runs: dict[str, Run]) -> None:
        """Pair processed runs (detections, no own carrier/target) with the raw bag of the same recording."""
        by_token: dict[str, list[Run]] = {}
        for r in runs.values():
            if r.token and r.has_carrier and r.has_ground_truth:
                by_token.setdefault(r.token, []).append(r)
        for r in runs.values():
            r.paired_with = None
            if r.has_detections and not r.has_carrier and r.token:
                cands = [c for c in by_token.get(r.token, []) if c.id != r.id]
                if cands:
                    best = max(cands, key=lambda c: c.size_bytes)
                    r.paired_with = best.id
                    if not r.has_ground_truth:
                        r.has_ground_truth = True
                        r.gt_source = f"paired:{best.name} ({best.gt_source})"
                    r.has_carrier = True

    # -- lookup --------------------------------------------------------------------------------
    def list(self) -> list[Run]:
        with self._lock:
            return sorted(self.runs.values(), key=lambda r: (r.root, r.name))

    def get(self, rid: str) -> Run | None:
        with self._lock:
            return self.runs.get(rid)

    def by_data_url(self, url: str) -> Run | None:
        from urllib.parse import unquote

        path = unquote(url.split("?", 1)[0])
        with self._lock:
            for r in self.runs.values():
                if unquote(r.data_url) == path:
                    return r
        return None

    def bag_path(self, run: Run) -> Path:
        return self.roots[run.root] / run.bag_dir

    def files(self, run: Run) -> list[Path]:
        return bag_mcap_files(self.bag_path(run))
