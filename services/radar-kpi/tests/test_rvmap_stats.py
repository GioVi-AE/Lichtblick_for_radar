# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
"""RV-map health measured on the frames themselves (bags without RvMapHealth)."""
import struct

import numpy as np
from mcap_ros2.writer import Writer

from radar_kpi.adapters import read_rvmap_stats

GEO_REG_RV_MAP = """float64 timestamp
float32[3] origin
float32[3] velocity
float32[3] ray_dir
float32[3] az_dir
float32[3] el_dir
float32 beam_az
float32 beam_el
uint32 trig_ms
float32 dr
float32 nranges
float32 dv
float32 nvelocities
float32 quat_x
float32 quat_y
float32 quat_z
float32 quat_w
float32 search_fps
uint32 zero_range_bin
uint32 zero_doppler_bin
uint8 status
uint32[] rvmap
"""


def _write(path, times, nR=8, nV=4):
    with open(path, "wb") as fh:
        w = Writer(fh)
        sch = w.register_msgdef("multi_sensor_msgs/msg/GeoRegRVMap", GEO_REG_RV_MAP)
        for i, t in enumerate(times):
            msg = {k: 0.0 for k in ("beam_az", "beam_el", "dr", "dv", "quat_x", "quat_y", "quat_z", "quat_w", "search_fps")}
            msg.update(timestamp=float(t), origin=[0.0] * 3, velocity=[0.0] * 3, ray_dir=[0.0] * 3, az_dir=[0.0] * 3, el_dir=[0.0] * 3,
                       trig_ms=0, nranges=float(nR), nvelocities=float(nV), zero_range_bin=0, zero_doppler_bin=2, status=0,
                       rvmap=[int(100 + i)] * (nR * nV - 1) + [int(1000 + i)])
            w.write_message(topic="rv", schema=sch, message=msg, log_time=int(t * 1e9), publish_time=int(t * 1e9))
        w.finish()


def test_payload_timestamp_is_at_cdr_offset_4(tmp_path):
    # the fast path reads the float64 timestamp without decoding the array; make sure it matches the decoder
    p = tmp_path / "a.mcap"
    _write(p, [1_790_000_000.25, 1_790_000_000.35])
    from mcap.reader import make_reader
    with open(p, "rb") as fh:
        for _, _, msg in make_reader(fh).iter_messages(topics=["rv"]):
            assert abs(struct.unpack_from("<d", msg.data, 4)[0] - 1_790_000_000.25) < 0.2


def test_period_gap_and_peak_statistics(tmp_path):
    t = list(np.arange(0, 2.0, 0.015))
    t = [x for x in t if not (0.9 < x < 1.2)]  # a 300 ms hole = timeout
    p = tmp_path / "b.mcap"
    _write(p, t)
    s = read_rvmap_stats([p], "rv", "multi_sensor_msgs/msg/GeoRegRVMap", value_stride=5)
    assert s["frames"] == len(t)
    assert abs(s["median_period_ms"] - 15.0) < 0.5
    assert 290 < s["max_gap_ms"] < 330
    assert s["timeout_gaps"] == 1
    assert s["peak_max"] >= 1000 and s["sampled_frames"] < len(t)
