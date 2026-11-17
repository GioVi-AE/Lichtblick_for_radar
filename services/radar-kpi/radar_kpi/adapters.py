# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
"""Readers that normalise the supported Eagle radar schemas into numpy structures.

Supported: RadarDetection/RadarMeasurement (multi_sensor_msgs | eagle_radar), CVDetection, DetectionArray,
TrackArray, GeoTrack, GroundTruth, nav_msgs/Odometry ground truth, sensor_msgs/NavSatFix, RvMapHealth,
TrackKpiStatus, GeoRegRVMap (status only).
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .georef import Track
from .mcap_io import (
    KIND_CV_DET,
    KIND_DET_ARRAY,
    KIND_GEO_TRACK,
    KIND_GROUND_TRUTH,
    KIND_NAVSAT,
    KIND_ODOM_GT,
    KIND_RADAR_DET,
    KIND_RV_HEALTH,
    KIND_RVMAP,
    KIND_TRACK_ARRAY,
    KIND_TRACK_KPI,
    classify_schema,
    iter_messages,
    stamp_to_sec,
)


@dataclass
class Detections:
    topic: str
    kind: str
    t: np.ndarray
    recv: np.ndarray
    # radar-local world positions of the detections and of the radar platform (NED/ENU axes, metres)
    local: np.ndarray | None = None
    platform_local: np.ndarray | None = None
    # geo-native detections (CVDetection)
    lla: np.ndarray | None = None
    range: np.ndarray | None = None
    power: np.ndarray | None = None
    confidence: np.ndarray | None = None
    radial_vel: np.ndarray | None = None
    ambiguity: np.ndarray | None = None
    platform_vel: np.ndarray | None = None
    ray_dir: np.ndarray | None = None

    def __len__(self) -> int:
        return len(self.t)


@dataclass
class TrackSet:
    topic: str
    kind: str
    t: np.ndarray
    ids: np.ndarray  # str array
    local: np.ndarray | None = None  # (N,3) radar-local (z may be 0 if unknown)
    lla: np.ndarray | None = None
    cov_enu: np.ndarray | None = None  # (N,9)
    state: np.ndarray | None = None  # str array
    has_z: bool = True

    def __len__(self) -> int:
        return len(self.t)


@dataclass
class LocalTruth:
    topic: str
    t: np.ndarray
    local: np.ndarray  # (N,3) radar-local frame


@dataclass
class Status:
    track_kpi: list[dict] = field(default_factory=list)
    rv_health: list[dict] = field(default_factory=list)
    rv_status: dict | None = None
    rv_derived: dict | None = None  # statistics measured from the RV maps themselves (no RvMapHealth topic)


def _arr(x, n=None):
    return np.asarray(x, dtype=float)


def read_detections(files: list[Path], topic: str, schema: str) -> Detections | None:
    kind = classify_schema(schema, topic)
    if kind == KIND_RADAR_DET:
        t, recv, local, plat, rng, pwr, conf, vr, amb, pvel, ray = ([] for _ in range(11))
        for _, _, log_time, m in iter_messages(files, [topic]):
            o = np.asarray(m.origin, dtype=float)
            r = np.asarray(m.ray_dir, dtype=float)
            rg = float(m.range)
            t.append(float(m.timestamp))
            recv.append(log_time * 1e-9)
            plat.append(o)
            local.append(o + rg * r)
            rng.append(rg)
            pwr.append(float(m.power))
            conf.append(float(m.confidence))
            vr.append(float(m.radial_vel))
            amb.append(float(m.ambiguity))
            pvel.append(np.asarray(m.velocity, dtype=float))
            ray.append(r)
        if not t:
            return None
        order = np.argsort(t, kind="stable")
        pick = lambda a: np.asarray(a)[order]  # noqa: E731
        return Detections(
            topic, kind, pick(t), pick(recv), local=pick(local), platform_local=pick(plat), range=pick(rng),
            power=pick(pwr), confidence=pick(conf), radial_vel=pick(vr), ambiguity=pick(amb),
            platform_vel=pick(pvel), ray_dir=pick(ray),
        )
    if kind == KIND_CV_DET:
        t, recv, lla, conf = [], [], [], []
        for _, _, log_time, m in iter_messages(files, [topic]):
            t.append(stamp_to_sec(m.header.stamp) or log_time * 1e-9)
            recv.append(log_time * 1e-9)
            lla.append((m.latitude, m.longitude, m.altitude))
            conf.append(float(m.confidence))
        if not t:
            return None
        order = np.argsort(t, kind="stable")
        return Detections(topic, kind, np.asarray(t)[order], np.asarray(recv)[order], lla=np.asarray(lla)[order],
                          confidence=np.asarray(conf)[order])
    if kind == KIND_DET_ARRAY:
        t, recv, local, pwr = [], [], [], []
        for _, _, log_time, m in iter_messages(files, [topic]):
            st = stamp_to_sec(m.header.stamp) or log_time * 1e-9
            for d in m.detections:
                t.append(st)
                recv.append(log_time * 1e-9)
                local.append((d.x, d.y, 0.0))
                pwr.append(float(d.amplitude))
        if not t:
            return None
        return Detections(topic, kind, np.asarray(t), np.asarray(recv), local=np.asarray(local), power=np.asarray(pwr))
    return None


def read_navsat(files: list[Path], topics: list[str]) -> dict[str, Track]:
    data: dict[str, list[tuple[float, float, float, float]]] = {tp: [] for tp in topics}
    for topic, _, log_time, m in iter_messages(files, topics):
        if not (np.isfinite(m.latitude) and np.isfinite(m.longitude)):
            continue
        if hasattr(m, "status") and getattr(m.status, "status", 0) < 0:
            continue
        stamp = stamp_to_sec(m.header.stamp) if hasattr(m, "header") else log_time * 1e-9
        data[topic].append((stamp or log_time * 1e-9, m.latitude, m.longitude, m.altitude))
    out = {}
    for topic, rows in data.items():
        if len(rows) >= 2:
            a = np.asarray(rows)
            out[topic] = Track(a[:, 0], a[:, 1], a[:, 2], a[:, 3])
    return out


def read_local_truth(files: list[Path], topics: list[tuple[str, str]]) -> LocalTruth | None:
    """GroundTruth / nav_msgs/Odometry ground truth in the radar-local frame. All-zero data is ignored."""
    t, xyz = [], []
    name = ""
    for topic, schema in topics:
        kind = classify_schema(schema, topic)
        for _, _, log_time, m in iter_messages(files, [topic]):
            if kind == KIND_GROUND_TRUTH:
                p = np.asarray(m.position, dtype=float)
                ts = float(m.timestamp) or log_time * 1e-9
            elif kind == KIND_ODOM_GT:
                pp = m.pose.pose.position
                p = np.array([pp.x, pp.y, pp.z], dtype=float)
                ts = stamp_to_sec(m.header.stamp) or log_time * 1e-9
            else:
                continue
            if np.abs(p).sum() == 0:
                continue
            t.append(ts)
            xyz.append(p)
            name = topic
    if len(t) < 2:
        return None
    order = np.argsort(t, kind="stable")
    return LocalTruth(name, np.asarray(t)[order], np.asarray(xyz)[order])


def read_tracks(files: list[Path], topic: str, schema: str) -> TrackSet | None:
    kind = classify_schema(schema, topic)
    t, ids, local, lla, cov, state = [], [], [], [], [], []
    if kind == KIND_TRACK_ARRAY:
        for _, _, log_time, m in iter_messages(files, [topic]):
            st = stamp_to_sec(m.header.stamp) or log_time * 1e-9
            has_z = False
            for tr in m.tracks:
                t.append(st)
                if hasattr(tr, "position"):  # EagleRadar variant: track_id + position[3] (NED), confidence, classification
                    ids.append(str(tr.track_id))
                    p = tr.position
                    local.append((p[0], p[1], p[2]))
                    state.append("CONFIRMED" if float(getattr(tr, "confidence", 1.0)) >= 0.5 else "TENTATIVE")
                    has_z = True
                else:  # eagle_radar_msgs variant: id + x/y + status
                    ids.append(str(tr.id))
                    local.append((tr.x, tr.y, 0.0))
                    state.append(str(tr.status))
        if not t:
            return None
        return TrackSet(topic, kind, np.asarray(t), np.asarray(ids), local=np.asarray(local), state=np.asarray(state), has_z=has_z)
    if kind == KIND_GEO_TRACK:
        for _, _, log_time, m in iter_messages(files, [topic]):
            t.append(float(m.timestamp) or log_time * 1e-9)
            ids.append(str(m.track_id))
            local.append(np.asarray(m.position, dtype=float))
            state.append(str(m.status))
        if not t:
            return None
        return TrackSet(topic, kind, np.asarray(t), np.asarray(ids), local=np.asarray(local), state=np.asarray(state))
    if kind == KIND_CV_DET:
        for _, _, log_time, m in iter_messages(files, [topic]):
            oid = str(m.object_id)
            if not oid:
                continue
            t.append(stamp_to_sec(m.header.stamp) or log_time * 1e-9)
            ids.append(oid)
            lla.append((m.latitude, m.longitude, m.altitude))
            cov.append(np.asarray(m.position_covariance, dtype=float))
            state.append(str(m.state))
        if not t:
            return None
        return TrackSet(topic, kind, np.asarray(t), np.asarray(ids), lla=np.asarray(lla), cov_enu=np.asarray(cov),
                        state=np.asarray(state))
    return None


def read_status(files: list[Path], topics: list[tuple[str, str]], rv_sample_cap: int = 300) -> Status:
    st = Status()
    for topic, schema in topics:
        kind = classify_schema(schema, topic)
        if kind == KIND_TRACK_KPI:
            for _, _, _, m in iter_messages(files, [topic]):
                st.track_kpi.append({
                    "t": float(m.stamp.sec) + float(m.stamp.nanosec) * 1e-9,
                    "track_id": int(m.track_id), "confirmed": bool(m.confirmed),
                    "total_updates": int(m.total_updates), "missed_updates": int(m.missed_updates),
                    "snr_db": float(m.rf_snr_db), "rf_ok": bool(m.rf_health_valid), "confidence": float(m.confidence),
                })
        elif kind == KIND_RV_HEALTH:
            for _, _, _, m in iter_messages(files, [topic]):
                st.rv_health.append({
                    "t": float(m.stamp.sec) + float(m.stamp.nanosec) * 1e-9, "valid": bool(m.rvmap_valid),
                    "age_ms": float(m.age_ms), "saturation_ratio": float(m.saturation_ratio),
                    "timeout": bool(m.timeout_active), "saturated": bool(m.saturated_active),
                })
    return st


def read_rvmap_stats(files: list[Path], topic: str, schema: str, value_stride: int = 25) -> dict | None:
    """Health statistics measured directly on GeoRegRVMap / RVMap frames.

    Used when a bag has no RvMapHealth topic. Frame times come from the payload (GeoRegRVMap starts with a float64
    timestamp, read without decoding the 250 kB array); peak/mean values are sampled every `value_stride` frames.
    Saturation cannot be derived (the ADC/normalisation limit is not in the data), so it is reported as unknown.
    """
    from mcap.reader import make_reader
    from mcap_ros2.decoder import DecoderFactory

    base = schema.rsplit("/", 1)[-1]
    times: list[float] = []
    peaks: list[float] = []
    means: list[float] = []
    dec = DecoderFactory()
    decoders: dict[int, object] = {}
    n = 0
    for p in files:
        with open(p, "rb") as fh:
            reader = make_reader(fh)
            for sch, ch, msg in reader.iter_messages(topics=[topic]):
                n += 1
                sample = (n - 1) % value_stride == 0
                if base == "GeoRegRVMap" and not sample:
                    times.append(struct.unpack_from("<d", msg.data, 4)[0])
                    continue
                d = decoders.get(sch.id) or decoders.setdefault(sch.id, dec.decoder_for("cdr", sch))
                m = d(msg.data)  # type: ignore[operator]
                if base == "GeoRegRVMap":
                    times.append(float(m.timestamp))
                    arr = np.asarray(m.rvmap, dtype=np.float64)
                else:
                    times.append(stamp_to_sec(m.header.stamp))
                    arr = np.asarray(m.data, dtype=np.float64)
                if arr.size:
                    peaks.append(float(arr.max()))
                    means.append(float(arr.mean()))
    if n == 0:
        return None
    t = np.sort(np.asarray(times))
    dt = np.diff(t) if len(t) > 1 else np.array([])
    med = float(np.median(dt)) if dt.size else None
    timeouts = int((dt > max(5 * med, 0.1)).sum()) if med else 0
    return {
        "frames": int(n),
        "median_period_ms": None if med is None else med * 1e3,
        "p99_period_ms": float(np.percentile(dt, 99) * 1e3) if dt.size else None,
        "max_gap_ms": float(dt.max() * 1e3) if dt.size else None,
        "timeout_gaps": timeouts,
        "peak_median": float(np.median(peaks)) if peaks else None,
        "peak_max": float(np.max(peaks)) if peaks else None,
        "mean_median": float(np.median(means)) if means else None,
        "sampled_frames": len(peaks),
    }
