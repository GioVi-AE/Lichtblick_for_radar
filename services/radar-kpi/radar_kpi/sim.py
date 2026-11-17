# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
"""Synthetic eagle_radar_msgs bag generator.

Produces an MCAP (ROS 2 / CDR) with
  * /radar/detections   eagle_radar/msg/CVDetection  (object_id empty)
  * /radar/tracks       eagle_radar/msg/CVDetection  (object_id = track id)
  * /radar/track_kpi    eagle_radar/msg/TrackKpiStatus
  * /radar/rvmap_health eagle_radar/msg/RvMapHealth
  * /target/mavros/global_position/global  sensor_msgs/msg/NavSatFix  (ground truth)
  * /carrier/mavros/global_position/global sensor_msgs/msg/NavSatFix
so that the KPI engine, the API and the UI can be exercised without real data. The scenario
parameters are returned so tests can compare measured KPIs with the injected truth.

    python -m radar_kpi.sim out_dir [--seconds 120] [--seed 1]
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
from mcap_ros2.writer import Writer

from .geo import ned_to_lla

HEADER = """builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
"""

TIME = "int32 sec\nuint32 nanosec\n"

CV_DETECTION = """std_msgs/Header header
float64 latitude
float64 longitude
float64 altitude
float64[9] position_covariance
uint8 position_covariance_type
string object_id
string object_class
string sensor_id
float32 confidence
string datum
string coordinate_system
string source_adapter
string state
float64 vx
float64 vy
float64 vz
string external_id
================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
"""

TRACK_KPI = """builtin_interfaces/Time stamp
string utc_time
int32 track_id
bool confirmed
uint32 total_updates
uint32 missed_updates
float32 consistency
float32 avg_magnitude
float32 last_magnitude
float32 error_probability
float32 confidence
float32 cov_xx
float32 cov_xy
float32 cov_xz
float32 cov_yy
float32 cov_yz
float32 cov_zz
float32 rf_signal_power
float32 rf_noise_power
float32 rf_snr_db
bool rf_health_valid
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
"""

RV_HEALTH = """builtin_interfaces/Time stamp
string utc_time
bool rvmap_valid
uint32 seq
float32 age_ms
float32 expected_period_ms
float32 saturation_ratio
float32 max_value
float32 mean_value
uint32 saturated_bin_count
uint32 total_bin_count
bool timeout_active
bool saturated_active
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
"""

NAVSAT = """std_msgs/Header header
sensor_msgs/NavSatStatus status
float64 latitude
float64 longitude
float64 altitude
float64[9] position_covariance
uint8 position_covariance_type
================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
================================================================================
MSG: sensor_msgs/NavSatStatus
int8 status
uint16 service
"""


DETECTION_ARRAY = """std_msgs/Header header
eagle_radar/Detection[] detections
================================================================================
MSG: eagle_radar/Detection
float64 x
float64 y
float64 amplitude
================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
"""

TRACK_ARRAY = """std_msgs/Header header
eagle_radar/Track[] tracks
================================================================================
MSG: eagle_radar/Track
uint32 id
float64 x
float64 y
float64 vx
float64 vy
string status
================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
"""


TRACK_ARRAY_RICH = """std_msgs/Header header
eagle_radar/Track[] tracks
builtin_interfaces/Time timestamp
================================================================================
MSG: eagle_radar/Track
std_msgs/Header header
uint32 track_id
string track_type
float32[3] position
float32[3] velocity
float32[3] acceleration
float32 range
float32 azimuth
float32 elevation
float32 confidence
uint32 age_frames
uint32 hit_count
uint8 classification
float32 classification_confidence
builtin_interfaces/Time timestamp
================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
"""


@dataclass
class Scenario:
    seconds: float = 120.0
    seed: int = 1
    start_time: float = 1_790_000_000.0
    anchor: tuple[float, float, float] = (50.8717, 10.7378, 300.0)
    p_detect: float = 0.8
    sigma_h_m: float = 8.0
    sigma_v_m: float = 10.0
    clutter_per_scan: float = 0.15
    scan_hz: float = 5.0
    time_offset_s: float = 0.0  # detections describe the target `offset` s after their stamp (lag)
    target_speed_mps: float = 15.0
    target_range_m: float = 600.0
    carrier_gps_hz: float = 10.0


def _stamp(t: float) -> dict:
    sec = int(np.floor(t))
    return {"sec": sec, "nanosec": int(round((t - sec) * 1e9))}


def _header(t: float, frame: str) -> dict:
    return {"stamp": _stamp(t), "frame_id": frame}


def target_ned(t_rel: np.ndarray | float, sc: Scenario) -> np.ndarray:
    """Target path in NED relative to the carrier: a circle of radius range/2 centred at `range` N of carrier."""
    t = np.atleast_1d(np.asarray(t_rel, dtype=float))
    r = sc.target_range_m * 0.35
    w = sc.target_speed_mps / r
    n = sc.target_range_m + r * np.sin(w * t)
    e = r * (1 - np.cos(w * t))
    d = -80.0 + 10.0 * np.sin(0.2 * t)
    return np.stack([n, e, d], axis=1)


def generate(path: Path, sc: Scenario | None = None) -> dict:
    """Write the bag to `path` (a .mcap file) and return the injected ground-truth description."""
    sc = sc or Scenario()
    rng = np.random.default_rng(sc.seed)
    a = sc.anchor
    path.parent.mkdir(parents=True, exist_ok=True)

    def lla(ned: np.ndarray) -> np.ndarray:
        lat, lon, alt = ned_to_lla(a, np.atleast_2d(ned))
        return np.stack([lat, lon, alt], axis=1)

    stats = {"scenario": asdict(sc), "n_det": 0, "n_true": 0, "n_clutter": 0, "bins_detected": set(), "n_bins": int(sc.seconds)}
    with open(path, "wb") as fh:
        w = Writer(fh)
        s_cv = w.register_msgdef("eagle_radar/msg/CVDetection", CV_DETECTION)
        s_kpi = w.register_msgdef("eagle_radar/msg/TrackKpiStatus", TRACK_KPI)
        s_rv = w.register_msgdef("eagle_radar/msg/RvMapHealth", RV_HEALTH)
        s_nav = w.register_msgdef("sensor_msgs/msg/NavSatFix", NAVSAT)

        def navsat(topic: str, t: float, pos: np.ndarray) -> None:
            w.write_message(topic=topic, schema=s_nav, message={
                "header": _header(t, "gps"), "status": {"status": 0, "service": 1},
                "latitude": float(pos[0]), "longitude": float(pos[1]), "altitude": float(pos[2]),
                "position_covariance": [0.0] * 9, "position_covariance_type": 0,
            }, log_time=int(t * 1e9), publish_time=int(t * 1e9))

        def cv(topic: str, t: float, pos: np.ndarray, oid: str, conf: float, state: str, cov: float = 0.0) -> None:
            w.write_message(topic=topic, schema=s_cv, message={
                "header": _header(t, "map"), "latitude": float(pos[0]), "longitude": float(pos[1]), "altitude": float(pos[2]),
                "position_covariance": [cov, 0, 0, 0, cov, 0, 0, 0, cov], "position_covariance_type": 2 if cov else 0,
                "object_id": oid, "object_class": "uav" if oid else "", "sensor_id": "sim", "confidence": float(conf),
                "datum": "WGS84", "coordinate_system": "ENU", "source_adapter": "sim", "state": state,
                "vx": 0.0, "vy": 0.0, "vz": 0.0, "external_id": "",
            }, log_time=int(t * 1e9), publish_time=int(t * 1e9))

        # ground truth + carrier navsat
        for t_rel in np.arange(0.0, sc.seconds + 1e-9, 0.1):
            t = sc.start_time + t_rel
            navsat("/target/mavros/global_position/global", t, lla(target_ned(t_rel, sc))[0])
            navsat("/carrier/mavros/global_position/global", t, np.array(a))

        # detections / tracks
        smoothed = None
        n_scans = int(sc.seconds * sc.scan_hz)
        for k in range(n_scans):
            t_rel = k / sc.scan_hz
            t = sc.start_time + t_rel
            truth = target_ned(t_rel + sc.time_offset_s, sc)[0]
            if rng.random() < sc.p_detect:
                noise = np.array([rng.normal(0, sc.sigma_h_m), rng.normal(0, sc.sigma_h_m), rng.normal(0, sc.sigma_v_m)])
                det = truth + noise
                cv("/radar/detections", t, lla(det)[0], "", 0.9, "")
                stats["n_det"] += 1
                stats["n_true"] += 1
                stats["bins_detected"].add(int(t_rel))
                smoothed = det if smoothed is None else 0.6 * smoothed + 0.4 * det
                # id switch half-way through
                tid = "T1" if t_rel < sc.seconds / 2 else "T2"
                cv("/radar/tracks", t, lla(smoothed)[0], tid, 0.95, "CONFIRMED", cov=sc.sigma_h_m ** 2)
            for _ in range(rng.poisson(sc.clutter_per_scan)):
                far = np.array([rng.uniform(300, 3000), rng.uniform(-1500, 1500), rng.uniform(-300, 0)])
                cv("/radar/detections", t, lla(far)[0], "", 0.3, "")
                stats["n_det"] += 1
                stats["n_clutter"] += 1

        # track status + rv-map health
        for k in range(int(sc.seconds)):
            t = sc.start_time + k
            snr = 18.0 + 3.0 * np.sin(0.1 * k)
            w.write_message(topic="/radar/track_kpi", schema=s_kpi, message={
                "stamp": _stamp(t), "utc_time": "", "track_id": 1 if k < sc.seconds / 2 else 2, "confirmed": True,
                "total_updates": k * 4, "missed_updates": k, "consistency": 1.5, "avg_magnitude": 1.0, "last_magnitude": 1.0,
                "error_probability": 0.01, "confidence": 0.9, "cov_xx": 64.0, "cov_xy": 0.0, "cov_xz": 0.0, "cov_yy": 64.0,
                "cov_yz": 0.0, "cov_zz": 100.0, "rf_signal_power": 10.0, "rf_noise_power": 1.0, "rf_snr_db": float(snr),
                "rf_health_valid": True,
            }, log_time=int(t * 1e9), publish_time=int(t * 1e9))
            sat = 30 <= k < 35
            w.write_message(topic="/radar/rvmap_health", schema=s_rv, message={
                "stamp": _stamp(t), "utc_time": "", "rvmap_valid": True, "seq": k, "age_ms": 90.0 if k != 60 else 800.0,
                "expected_period_ms": 100.0, "saturation_ratio": 0.2 if sat else 0.0, "max_value": 1.0, "mean_value": 0.1,
                "saturated_bin_count": 2000 if sat else 0, "total_bin_count": 10000, "timeout_active": k == 60,
                "saturated_active": sat,
            }, log_time=int(t * 1e9), publish_time=int(t * 1e9))
        w.finish()

    stats["bins_detected"] = len(stats["bins_detected"])
    return stats


def generate_reveal(path: Path, sc: Scenario | None = None, frame: str = "PLATFORM_ENU", rich_tracks: bool = False) -> dict:
    """eagle_reveal-style bag: DetectionArray + TrackArray with x/y in an *unspecified* radar frame.

    `frame` (NED | ENU | PLATFORM_NED | PLATFORM_ENU) is the axis convention the x/y really use, so tests can check
    that the KPI service recovers it from the ground truth. The carrier flies a straight path away from its first fix.
    """
    sc = sc or Scenario()
    rng = np.random.default_rng(sc.seed)
    a = sc.anchor
    path.parent.mkdir(parents=True, exist_ok=True)

    def lla(ned: np.ndarray) -> np.ndarray:
        lat, lon, alt = ned_to_lla(a, np.atleast_2d(ned))
        return np.stack([lat, lon, alt], axis=1)

    def carrier_ned(t_rel: float) -> np.ndarray:
        return np.array([2.0 * t_rel, 0.8 * t_rel, -50.0])

    def to_frame(world: np.ndarray, t_rel: float) -> tuple[float, float]:
        rel = world - carrier_ned(t_rel) if frame.startswith("PLATFORM") else world
        return (float(rel[0]), float(rel[1])) if frame.endswith("NED") else (float(rel[1]), float(rel[0]))

    stats = {"scenario": asdict(sc), "frame": frame, "n_det": 0}
    with open(path, "wb") as fh:
        w = Writer(fh)
        s_nav = w.register_msgdef("sensor_msgs/msg/NavSatFix", NAVSAT)
        s_da = w.register_msgdef("eagle_radar/msg/DetectionArray", DETECTION_ARRAY)
        s_ta = w.register_msgdef("eagle_radar/msg/TrackArray", TRACK_ARRAY_RICH if rich_tracks else TRACK_ARRAY)

        def navsat(topic: str, t: float, pos: np.ndarray) -> None:
            w.write_message(topic=topic, schema=s_nav, message={
                "header": _header(t, "gps"), "status": {"status": 0, "service": 1},
                "latitude": float(pos[0]), "longitude": float(pos[1]), "altitude": float(pos[2]),
                "position_covariance": [0.0] * 9, "position_covariance_type": 0,
            }, log_time=int(t * 1e9), publish_time=int(t * 1e9))

        for t_rel in np.arange(0.0, sc.seconds + 1e-9, 0.1):
            t = sc.start_time + t_rel
            world = carrier_ned(t_rel) + target_ned(t_rel, sc)[0]
            navsat("/target/mavros/global_position/global", t, lla(world)[0])
            navsat("/carrier/mavros/global_position/global", t, lla(carrier_ned(t_rel))[0])
        for k in range(int(sc.seconds * sc.scan_hz)):
            t_rel = k / sc.scan_hz
            t = sc.start_time + t_rel
            world = carrier_ned(t_rel) + target_ned(t_rel, sc)[0]
            dets = []
            if rng.random() < sc.p_detect:
                noisy = world + np.array([rng.normal(0, sc.sigma_h_m), rng.normal(0, sc.sigma_h_m), 0.0])
                x, y = to_frame(noisy, t_rel)
                dets.append({"x": x, "y": y, "amplitude": 30.0})
                stats["n_det"] += 1
            for _ in range(rng.poisson(sc.clutter_per_scan)):
                far = world + np.array([rng.uniform(300, 2500), rng.uniform(-1500, 1500), 0.0])
                x, y = to_frame(far, t_rel)
                dets.append({"x": x, "y": y, "amplitude": 12.0})
            w.write_message(topic="/eagle_reveal/detections", schema=s_da,
                            message={"header": _header(t, "radar_frame"), "detections": dets},
                            log_time=int(t * 1e9), publish_time=int(t * 1e9))
            if dets and rich_tracks:
                x, y = dets[0]["x"], dets[0]["y"]
                stamp = _stamp(t)
                tr = {"header": _header(t, "radar_frame"), "track_id": 1, "track_type": "uav", "position": [x, y, 0.0],
                      "velocity": [0.0] * 3, "acceleration": [0.0] * 3, "range": 0.0, "azimuth": 0.0, "elevation": 0.0,
                      "confidence": 0.9, "age_frames": k, "hit_count": k, "classification": 0,
                      "classification_confidence": 0.0, "timestamp": stamp}
                w.write_message(topic="/eagle_reveal/tracks", schema=s_ta,
                                message={"header": _header(t, "radar_frame"), "tracks": [tr], "timestamp": stamp},
                                log_time=int(t * 1e9), publish_time=int(t * 1e9))
            elif dets:
                x, y = dets[0]["x"], dets[0]["y"]
                w.write_message(topic="/eagle_reveal/tracks", schema=s_ta, message={
                    "header": _header(t, "radar_frame"),
                    "tracks": [{"id": 1, "x": x, "y": y, "vx": 0.0, "vy": 0.0, "status": "CONFIRMED"}]},
                    log_time=int(t * 1e9), publish_time=int(t * 1e9))
        w.finish()
    return stats


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--seconds", type=float, default=120.0)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--time-offset", type=float, default=0.0)
    ns = ap.parse_args()
    bag = ns.out_dir / f"sim_{ns.seed}" / "sim.mcap"
    s = generate(bag, Scenario(seconds=ns.seconds, seed=ns.seed, time_offset_s=ns.time_offset))
    print(f"wrote {bag}: {s['n_det']} detections ({s['n_clutter']} clutter)")


if __name__ == "__main__":
    main()
