# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
import numpy as np

from radar_kpi.analysis import Analyzer
from radar_kpi.catalog import Catalog
from radar_kpi.kpi import KpiParams
from radar_kpi.sim import Scenario


def _analyzer(sim_root, tmp_path):
    cat = Catalog({"raw": sim_root}, tmp_path / "cache")
    cat.scan(force=True)
    return cat, Analyzer(cat, tmp_path / "cache")


def test_catalog_flags(sim_root, tmp_path):
    cat, _ = _analyzer(sim_root, tmp_path)
    runs = {r.name: r for r in cat.list()}
    r = runs["sim_a/sim.mcap"]
    assert r.has_detections and r.has_tracks and r.has_ground_truth
    assert r.data_url.startswith("/data/raw/sim_a/")
    assert cat.by_data_url(r.data_url).id == r.id


def test_kpi_matches_injected_truth(sim_root, sim_stats, tmp_path):
    cat, an = _analyzer(sim_root, tmp_path)
    run = next(r for r in cat.list() if r.name.startswith("sim_a"))
    k = an.kpi(run, KpiParams(gate_m=100.0))
    d = k["detection"]
    stats = sim_stats
    assert k["mode"] == "ground_truth"
    assert d["count"] == stats["n_det"]
    # every injected target detection is inside the 100 m gate (sigma 8/10 m); clutter is far away
    assert d["true"] >= stats["n_true"] - 1
    assert abs(d["false"] - stats["n_clutter"]) <= 3
    assert d["pd"] == stats["bins_detected"] / stats["n_bins"] or abs(d["pd"] - stats["bins_detected"] / stats["n_bins"]) < 0.02
    assert d["pd"] > 0.95
    # expected horizontal RMSE = sigma_h * sqrt(2)
    assert abs(d["error"]["horiz"]["rmse"] - 8.0 * np.sqrt(2)) < 2.0
    assert d["error"]["horiz"]["rmse"] > 0 and d["cep95_m"] > d["cep50_m"]
    # clutter per minute: 86 clutter / 100 s
    assert abs(d["false_alarms_per_min"] - stats["n_clutter"] * 60 / 100) < 3
    assert abs(k["time_offset"]["lag_s"]) < 0.3
    assert k["georef"] is None  # geo-native detections need no anchor
    assert k["tracks"]["id_switches"] == 1
    assert k["tracks"]["count"] == 2
    assert k["health"]["saturated_frames"] == 5 and k["health"]["timeout_frames"] == 1


def test_time_offset_detected_and_compensated(sim_root, tmp_path):
    cat, an = _analyzer(sim_root, tmp_path)
    run = next(r for r in cat.list() if r.name.startswith("sim_lag"))
    plain = an.kpi(run, KpiParams(gate_m=100.0))
    assert abs(plain["time_offset"]["lag_s"] - 2.0) < 0.5
    assert any("time-shifted" in w for w in plain["warnings"])
    fixed = an.kpi(run, KpiParams(gate_m=100.0, auto_offset=True))
    assert fixed["detection"]["error"]["horiz"]["rmse"] < plain["detection"]["error"]["horiz"]["rmse"] / 1.5
    assert abs(fixed["detection"]["error"]["horiz"]["rmse"] - 8.0 * np.sqrt(2)) < 3.0
    assert not any("time-shifted" in w for w in fixed["warnings"])


def test_csv_and_cache(sim_root, tmp_path):
    cat, an = _analyzer(sim_root, tmp_path)
    run = cat.list()[0]
    p = KpiParams(gate_m=100.0)
    k1 = an.kpi(run, p)
    k2 = an.kpi(run, p)
    assert k1["computed_at"] == k2["computed_at"]  # served from cache
    csv_text = an.kpi_csv(run, p)
    lines = csv_text.strip().splitlines()
    assert lines[0].startswith("t,") and len(lines) == k1["detection"]["count"] + 1
