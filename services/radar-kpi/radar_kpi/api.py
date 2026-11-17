# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
"""REST API of the radar-kpi service."""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, PlainTextResponse

from . import __version__
from .analysis import Analyzer
from .catalog import Catalog
from .kpi import KpiParams
from .report import render_report

log = logging.getLogger("radar_kpi.api")


def parse_roots(spec: str) -> dict[str, Path]:
    """'raw=/data/raw,processed=/data/processed' -> {name: Path}."""
    roots: dict[str, Path] = {}
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        name, _, path = part.partition("=")
        roots[name.strip()] = Path(path.strip())
    return roots


def create_app(roots: dict[str, Path] | None = None, cache_dir: Path | None = None, scan_on_start: bool = True) -> FastAPI:
    roots = roots if roots is not None else parse_roots(os.environ.get("RADAR_ROOTS", "raw=/data/raw,processed=/data/processed"))
    cache_dir = cache_dir or Path(os.environ.get("RADAR_CACHE_DIR", "/cache"))
    catalog = Catalog(roots, cache_dir)
    analyzer = Analyzer(catalog, cache_dir)

    app = FastAPI(title="radar-kpi", version=__version__)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    app.state.catalog = catalog
    app.state.analyzer = analyzer

    def _scan(force: bool = False) -> None:
        try:
            catalog.scan(force=force)
        except Exception:  # noqa: BLE001
            log.exception("catalogue scan failed")

    if scan_on_start:
        threading.Thread(target=_scan, daemon=True, name="catalog-scan").start()

    def _run(rid: str):
        run = catalog.get(rid)
        if run is None:
            raise HTTPException(404, f"unknown run {rid}")
        return run

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "version": __version__, "runs": len(catalog.runs), "scanning": catalog.scanning}

    @app.get("/runs")
    def runs() -> list[dict]:
        return [r.to_dict() for r in catalog.list()]

    @app.post("/rescan")
    def rescan(force: bool = False) -> dict:
        if not catalog.scanning:
            threading.Thread(target=_scan, args=(force,), daemon=True).start()
        return {"status": "scanning"}

    @app.get("/runs/by-url")
    def run_by_url(url: str) -> dict:
        run = catalog.by_data_url(url)
        if run is None:
            raise HTTPException(404, f"no run for {url}")
        return run.to_dict()

    @app.get("/runs/{rid}")
    def run_detail(rid: str) -> dict:
        return _run(rid).to_dict()

    @app.get("/runs/{rid}/context")
    def run_context(rid: str) -> dict:
        try:
            return analyzer.context(_run(rid))
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("context failed")
            raise HTTPException(500, f"context failed: {exc}") from exc

    def _params(gate_m: float, bin_s: float, auto_offset: bool = False, time_offset_s: float = 0.0) -> KpiParams:
        if gate_m <= 0 or bin_s <= 0:
            raise HTTPException(422, "gate_m and bin_s must be positive")
        return KpiParams(gate_m=gate_m, bin_s=bin_s, auto_offset=auto_offset, time_offset_s=time_offset_s)

    @app.get("/runs/{rid}/kpi")
    def run_kpi(rid: str, gate_m: float = Query(150.0), bin_s: float = Query(1.0),
                auto_offset: bool = False, time_offset_s: float = 0.0, force: bool = False) -> dict:
        try:
            return analyzer.kpi(_run(rid), _params(gate_m, bin_s, auto_offset, time_offset_s), force=force)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("kpi failed")
            raise HTTPException(500, f"kpi computation failed: {exc}") from exc

    @app.get("/runs/{rid}/kpi.csv", response_class=PlainTextResponse)
    def run_kpi_csv(rid: str, gate_m: float = Query(150.0), bin_s: float = Query(1.0),
                    auto_offset: bool = False, time_offset_s: float = 0.0) -> PlainTextResponse:
        text = analyzer.kpi_csv(_run(rid), _params(gate_m, bin_s, auto_offset, time_offset_s))
        return PlainTextResponse(text, media_type="text/csv",
                                 headers={"Content-Disposition": f'attachment; filename="{rid}_detections.csv"'})

    @app.get("/runs/{rid}/report.html", response_class=HTMLResponse)
    def run_report(rid: str, gate_m: float = Query(150.0), bin_s: float = Query(1.0),
                   auto_offset: bool = False, time_offset_s: float = 0.0) -> HTMLResponse:
        run = _run(rid)
        kpi = analyzer.kpi(run, _params(gate_m, bin_s, auto_offset, time_offset_s))
        return HTMLResponse(render_report(run.to_dict(), kpi))

    return app


app = None  # created lazily by `uvicorn radar_kpi.api:create_app --factory`
