# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
from pathlib import Path

import pytest

from radar_kpi.sim import Scenario, generate


@pytest.fixture(scope="session")
def sim(tmp_path_factory) -> tuple[Path, dict]:
    root = tmp_path_factory.mktemp("bags")
    stats = generate(root / "sim_a" / "sim.mcap", Scenario(seconds=100, seed=3))
    # same scenario but detections lag the truth by 2 s
    generate(root / "sim_lag" / "sim.mcap", Scenario(seconds=100, seed=4, time_offset_s=2.0))
    return root, stats


@pytest.fixture(scope="session")
def sim_root(sim) -> Path:
    return sim[0]


@pytest.fixture(scope="session")
def sim_stats(sim) -> dict:
    return sim[1]
