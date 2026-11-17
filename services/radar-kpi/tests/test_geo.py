# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
import numpy as np

from radar_kpi.geo import lla_to_ned, ned_to_lla
from radar_kpi.georef import Track, estimate_anchor

ANCHOR = (50.8717, 10.7378, 300.0)


def test_ned_roundtrip():
    rng = np.random.default_rng(0)
    ned = rng.uniform(-3000, 3000, size=(50, 3))
    lat, lon, alt = ned_to_lla(ANCHOR, ned)
    back = lla_to_ned(ANCHOR, lat, lon, alt)
    assert np.abs(back - ned).max() < 1e-6


def test_ned_axes_and_scale():
    lat, lon, alt = ned_to_lla(ANCHOR, np.array([[1000.0, 0, 0], [0, 1000.0, 0], [0, 0, -50.0]]))
    assert lat[0] > ANCHOR[0] and abs(lon[0] - ANCHOR[1]) < 1e-9  # north increases latitude
    assert lon[1] > ANCHOR[1]  # east increases longitude
    assert abs(alt[2] - (ANCHOR[2] + 50.0)) < 0.01  # down is negative altitude
    # 1 km north ~ 1/111.2 deg
    assert abs((lat[0] - ANCHOR[0]) * 111_200 - 1000) < 5


def test_track_interpolation_and_gaps():
    tr = Track([0, 1, 2, 100], [0, 10, 20, 30], [0, 0, 0, 0], [0, 0, 0, 0])
    lat, _, _, valid = tr.at([0.5, 1.5, 50.0, 200.0], max_gap=5.0)
    assert np.allclose(lat[:2], [5, 15])
    assert valid.tolist() == [True, True, False, False]


def test_estimate_anchor_recovers_known_frame():
    t = np.linspace(0, 100, 200)
    ned = np.stack([300 * np.sin(t / 20), 300 * np.cos(t / 20), -50 + 0 * t], axis=1)
    lat, lon, alt = ned_to_lla(ANCHOR, ned)
    carrier = Track(t, lat, lon, alt)
    est = estimate_anchor(t, ned, carrier)
    assert est is not None
    assert est.frame == "NED"
    assert est.residual_std_m is not None and est.residual_std_m < 0.5
    assert abs(est.lat - ANCHOR[0]) < 1e-6 and abs(est.lon - ANCHOR[1]) < 1e-6
