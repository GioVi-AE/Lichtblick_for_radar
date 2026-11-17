# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
"""Thin helpers around the mcap / mcap-ros2 readers (no ROS installation required)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

import yaml
from mcap.reader import make_reader
from mcap_ros2.decoder import DecoderFactory

# ----------------------------------------------------------------------------- schema classification

KIND_RADAR_DET = "radarDetection"
KIND_CV_DET = "cvDetection"
KIND_TRACK_ARRAY = "trackArray"
KIND_GEO_TRACK = "geoTrack"
KIND_DET_ARRAY = "detectionArray"
KIND_GROUND_TRUTH = "groundTruth"
KIND_NAVSAT = "navSat"
KIND_ODOM_GT = "odometryGt"
KIND_RVMAP = "rvmap"
KIND_RV_HEALTH = "rvHealth"
KIND_TRACK_KPI = "trackKpi"
KIND_RADAR_STATUS = "radarStatus"
KIND_NODE_STATUS = "nodeStatus"
KIND_RAW_RADAR = "rawRadar"
KIND_UNKNOWN = "unknown"


def short_schema(name: str) -> str:
    return name.replace("/msg/", "/")


def classify_schema(schema: str, topic: str = "") -> str:
    s = short_schema(schema)
    base = s.rsplit("/", 1)[-1]
    if base in ("RadarDetection", "RadarMeasurement"):
        return KIND_RADAR_DET
    if base == "CVDetection":
        return KIND_CV_DET
    if base == "TrackArray":
        return KIND_TRACK_ARRAY
    if base == "GeoTrack":
        return KIND_GEO_TRACK
    if base == "DetectionArray":
        return KIND_DET_ARRAY
    if base == "GroundTruth":
        return KIND_GROUND_TRUTH
    if s in ("sensor_msgs/NavSatFix", "foxglove.LocationFix"):
        return KIND_NAVSAT
    if s == "nav_msgs/Odometry" and re.search(r"ground_?truth|(^|/)gt($|/)", topic, re.I):
        return KIND_ODOM_GT
    if base in ("GeoRegRVMap", "RVMap"):
        return KIND_RVMAP
    if base == "RvMapHealth":
        return KIND_RV_HEALTH
    if base == "TrackKpiStatus":
        return KIND_TRACK_KPI
    if base == "RadarStatus":
        return KIND_RADAR_STATUS
    if base == "NodeStatus":
        return KIND_NODE_STATUS
    if base == "RawRadarPacket" or (s == "sensor_msgs/Image" and "radar" in topic):
        return KIND_RAW_RADAR
    return KIND_UNKNOWN


# ----------------------------------------------------------------------------- bag summary


@dataclass
class TopicSummary:
    name: str
    type: str
    count: int
    kind: str = KIND_UNKNOWN


@dataclass
class BagSummary:
    path: Path  # primary mcap file
    topics: list[TopicSummary] = field(default_factory=list)
    start_ns: int | None = None
    end_ns: int | None = None
    message_count: int = 0
    indexed: bool = True
    size_bytes: int = 0
    files: list[Path] = field(default_factory=list)

    def by_kind(self, kind: str) -> list[TopicSummary]:
        return [t for t in self.topics if t.kind == kind]

    def topic_names(self) -> set[str]:
        return {t.name for t in self.topics}


def bag_mcap_files(bag_path: Path) -> list[Path]:
    """Resolve the mcap file(s) of a rosbag2 directory (metadata.yaml) or a single .mcap file."""
    if bag_path.is_file():
        return [bag_path]
    meta = bag_path / "metadata.yaml"
    files: list[Path] = []
    if meta.exists():
        try:
            info = yaml.safe_load(meta.read_text())["rosbag2_bagfile_information"]
            for rel in info.get("relative_file_paths", []):
                p = bag_path / rel
                if p.suffix == ".mcap" and p.exists():
                    files.append(p)
        except Exception:  # noqa: BLE001 - tolerate broken metadata, fall back to globbing
            files = []
    if not files:
        files = sorted(bag_path.glob("*.mcap"))
    return files


def summarize_mcap(path: Path) -> BagSummary:
    """Read the summary section of an mcap file (cheap: only touches the file footer)."""
    s = BagSummary(path=path, size_bytes=path.stat().st_size, files=[path])
    with open(path, "rb") as f:
        reader = make_reader(f)
        summary = reader.get_summary()
        if summary is None or summary.statistics is None:
            s.indexed = False
            return s
        s.indexed = len(summary.chunk_indexes) > 0 or summary.statistics.message_count == 0
        st = summary.statistics
        s.start_ns, s.end_ns, s.message_count = st.message_start_time, st.message_end_time, st.message_count
        for cid, ch in summary.channels.items():
            schema = summary.schemas.get(ch.schema_id)
            name = schema.name if schema else ""
            s.topics.append(
                TopicSummary(ch.topic, name, st.channel_message_counts.get(cid, 0), classify_schema(name, ch.topic))
            )
    return s


def summarize_bag(bag_path: Path) -> BagSummary | None:
    files = bag_mcap_files(bag_path)
    if not files:
        return None
    first = summarize_mcap(files[0])
    first.files = files
    if len(files) > 1:
        merged: dict[str, TopicSummary] = {t.name: t for t in first.topics}
        for extra in files[1:]:
            e = summarize_mcap(extra)
            first.size_bytes += e.size_bytes
            first.message_count += e.message_count
            first.indexed = first.indexed and e.indexed
            if e.start_ns is not None:
                first.start_ns = min(first.start_ns or e.start_ns, e.start_ns)
            if e.end_ns is not None:
                first.end_ns = max(first.end_ns or e.end_ns, e.end_ns)
            for t in e.topics:
                if t.name in merged:
                    merged[t.name].count += t.count
                else:
                    merged[t.name] = t
        first.topics = list(merged.values())
    return first


# ----------------------------------------------------------------------------- message iteration


def iter_messages(files: list[Path], topics: list[str]) -> Iterator[tuple[str, str, int, object]]:
    """Yield (topic, schema_name, log_time_ns, decoded_message) over all files in file order."""
    if not topics:
        return
    for p in files:
        with open(p, "rb") as f:
            reader = make_reader(f, decoder_factories=[DecoderFactory()])
            for schema, channel, message, decoded in reader.iter_decoded_messages(topics=topics):
                yield channel.topic, schema.name, message.log_time, decoded


def stamp_to_sec(stamp) -> float:
    return float(stamp.sec) + float(stamp.nanosec) * 1e-9
