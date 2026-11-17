# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
"""Bags that store epoch seconds in log_time are rewritten with payload-derived nanosecond log_time."""
import numpy as np
from mcap.reader import make_reader
from mcap_ros2.writer import Writer

from radar_kpi.fixtime import TimeFixer, rewrite_with_payload_time
from tests.test_rvmap_stats import GEO_REG_RV_MAP

STAMPED = """# a commented schema, like nav_msgs/Odometry
std_msgs/Header header
float64 x
================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
"""


def _seconds_bag(path, t0=1_790_000_000.0, n=20):
    with open(path, "wb") as fh:
        w = Writer(fh)
        rv = w.register_msgdef("multi_sensor_msgs/msg/GeoRegRVMap", GEO_REG_RV_MAP)
        st = w.register_msgdef("nav_msgs/msg/Odometry", STAMPED)
        for i in range(n):
            t = t0 + i * 0.125
            msg = {k: 0.0 for k in ("beam_az", "beam_el", "dr", "dv", "quat_x", "quat_y", "quat_z", "quat_w", "search_fps")}
            msg.update(timestamp=t, origin=[0.0] * 3, velocity=[0.0] * 3, ray_dir=[0.0] * 3, az_dir=[0.0] * 3, el_dir=[0.0] * 3,
                       trig_ms=0, nranges=2.0, nvelocities=2.0, zero_range_bin=0, zero_doppler_bin=1, status=0, rvmap=[1, 2, 3, 4])
            # log_time carries *seconds* (the quirk): many messages share the same value
            w.write_message(topic="rv", schema=rv, message=msg, log_time=int(t), publish_time=int(t))
            sec = int(np.floor(t))
            w.write_message(topic="odom", schema=st, message={"header": {"stamp": {"sec": sec, "nanosec": int(round((t - sec) * 1e9))},
                            "frame_id": "map"}, "x": 1.0}, log_time=int(t), publish_time=int(t))
        w.finish()


def test_rewrite_uses_payload_time(tmp_path):
    src, dst = tmp_path / "s.mcap", tmp_path / "out" / "d.mcap"
    _seconds_bag(src)
    stats = rewrite_with_payload_time([src], dst)
    assert stats["messages"] == 40 and stats["from_payload"] == 40 and stats["from_log_time"] == 0
    times = {"rv": [], "odom": []}
    with open(dst, "rb") as fh:
        for _, ch, msg in make_reader(fh).iter_messages():
            times[ch.topic].append(msg.log_time)
    for tp in times:
        arr = np.array(times[tp], dtype=float) * 1e-9
        assert abs(arr[0] - 1_790_000_000.0) < 1e-3 and abs(np.diff(arr).mean() - 0.125) < 1e-3
    assert dst.stat().st_size > 0 and not dst.with_suffix(".mcap.part").exists()


def test_timefixer_job_lifecycle(tmp_path):
    src = tmp_path / "s.mcap"
    _seconds_bag(src)
    fx = TimeFixer(tmp_path / "cache")
    assert fx.status("abc")["state"] == "none"
    fx.start("abc", [src])
    import time

    for _ in range(100):
        if fx.status("abc")["state"] == "done":
            break
        time.sleep(0.05)
    st = fx.status("abc")
    assert st["state"] == "done" and st["url"] == "/data/fixed/abc.mcap"
