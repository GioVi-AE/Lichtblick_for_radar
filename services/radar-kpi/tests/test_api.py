# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
from fastapi.testclient import TestClient

from radar_kpi.api import create_app, parse_roots


def test_parse_roots():
    assert parse_roots("raw=/a,processed=/b")["processed"].as_posix() == "/b"


def test_api_end_to_end(sim_root, tmp_path):
    app = create_app({"raw": sim_root}, tmp_path / "cache", scan_on_start=False)
    app.state.catalog.scan(force=True)
    c = TestClient(app)
    assert c.get("/health").json()["runs"] == 2
    runs = c.get("/runs").json()
    run = next(r for r in runs if r["name"].startswith("sim_a"))
    assert c.get("/runs/by-url", params={"url": run["data_url"]}).json()["id"] == run["id"]
    assert c.get("/runs/by-url", params={"url": "/data/raw/none.mcap"}).status_code == 404
    assert c.get("/runs/doesnotexist").status_code == 404

    ctx = c.get(f"/runs/{run['id']}/context").json()
    assert len(ctx["target"]) > 100 and ctx["target_topic"] == "/target/mavros/global_position/global"

    k = c.get(f"/runs/{run['id']}/kpi", params={"gate_m": 100}).json()
    assert k["mode"] == "ground_truth" and k["detection"]["pd"] > 0.9
    assert c.get(f"/runs/{run['id']}/kpi", params={"gate_m": -1}).status_code == 422

    csv_r = c.get(f"/runs/{run['id']}/kpi.csv", params={"gate_m": 100})
    assert csv_r.headers["content-type"].startswith("text/csv")
    rep = c.get(f"/runs/{run['id']}/report.html", params={"gate_m": 100})
    assert ctx["carrier"], "carrier should be guessed by name"
    assert rep.status_code == 200 and "Radar KPI report" in rep.text and "<svg" in rep.text


def test_timefix_endpoints(sim_root, tmp_path):
    app = create_app({"raw": sim_root}, tmp_path / "cache", scan_on_start=False)
    app.state.catalog.scan(force=True)
    c = TestClient(app)
    run = c.get("/runs").json()[0]
    assert run["time_fix"] is None  # nanosecond bag: nothing to fix
    assert c.post(f"/runs/{run['id']}/timefix").status_code == 409
    assert c.get(f"/runs/{run['id']}/timefix").json()["state"] == "none"
    # a time-fixed copy URL resolves back to its run
    assert c.get("/runs/by-url", params={"url": f"/data/fixed/{run['id']}.mcap"}).json()["id"] == run["id"]
