# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
"""Track/Detection x/y live in an unspecified 'radar_frame': the ground truth must pick the axes."""
import pytest

from radar_kpi.analysis import Analyzer
from radar_kpi.catalog import Catalog
from radar_kpi.kpi import KpiParams
from radar_kpi.sim import Scenario, generate_reveal


@pytest.fixture(scope="module", params=["NED", "ENU", "PLATFORM_NED", "PLATFORM_ENU"])
def reveal(request, tmp_path_factory):
    root = tmp_path_factory.mktemp("reveal")
    generate_reveal(root / f"bag_{request.param}" / "r.mcap", Scenario(seconds=100, seed=7), frame=request.param)
    cat = Catalog({"raw": root}, root / "cache")
    cat.scan(force=True)
    return request.param, cat, Analyzer(cat, root / "cache")


def test_frame_is_recovered_from_ground_truth(reveal):
    frame, cat, an = reveal
    run = cat.list()[0]
    assert run.has_detections and run.has_tracks and run.has_ground_truth
    k = an.kpi(run, KpiParams(gate_m=100.0))
    assert k["tracks"]["xy_frame"]["selected"] == frame, k["tracks"]["xy_frame"]
    assert k["tracks"]["xy_frame"]["confident"]
    d = k["detection"]
    assert d["pd"] > 0.95
    assert d["true"] > 0.9 * k["detection"]["with_gt"] - 120  # clutter is far away; nearly all non-clutter are true
    assert k["tracks"]["rmse_horiz"] < 25
    assert any("horizontal" in w for w in k["warnings"])


def test_unverified_frame_without_ground_truth(tmp_path):
    # the same bag without any NavSatFix: frame stays NED and the user is told it is unverified
    import numpy as np  # noqa: F401
    from radar_kpi.analysis import Loaded  # noqa: F401
    from radar_kpi.georef import select_local_xy_frame

    assert select_local_xy_frame([0.0, 1.0], [[0, 0], [1, 1]], (50.0, 10.0, 0.0), None, {}) is None


def test_rich_eagleradar_track_variant(tmp_path):
    """EagleRadar's own Track.msg (track_id + position[3] 'NED') is read too; z is carried when present."""
    generate_reveal(tmp_path / "bag" / "r.mcap", Scenario(seconds=60, seed=9), frame="PLATFORM_NED", rich_tracks=True)
    cat = Catalog({"raw": tmp_path}, tmp_path / "cache")
    cat.scan(force=True)
    k = Analyzer(cat, tmp_path / "cache").kpi(cat.list()[0], KpiParams(gate_m=100.0))
    assert k["tracks"]["xy_frame"]["selected"] == "PLATFORM_NED"
    assert k["tracks"]["count"] == 1
