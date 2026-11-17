# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
"""Self-contained HTML run report (inline SVG charts, no external assets)."""

from __future__ import annotations

import html


def _fmt(v, digits=1, unit=""):
    if v is None:
        return "–"
    return f"{v:.{digits}f}{unit}"


def _pct(v):
    return "–" if v is None else f"{v * 100:.1f} %"


def _scatter(points, x_label, y_label, title, color="#0b7bd0", w=520, h=240):
    pts = [(x, y) for x, y in points if x is not None and y is not None]
    if not pts:
        return f"<p><em>{html.escape(title)}: no data</em></p>"
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    x0, x1, y0, y1 = min(xs), max(xs), min(0, min(ys)), max(ys)
    if x1 == x0:
        x1 = x0 + 1
    if y1 == y0:
        y1 = y0 + 1
    ml, mb, mt, mr = 46, 30, 22, 8
    pw, ph = w - ml - mr, h - mt - mb
    sx = lambda x: ml + (x - x0) / (x1 - x0) * pw  # noqa: E731
    sy = lambda y: mt + ph - (y - y0) / (y1 - y0) * ph  # noqa: E731
    dots = "".join(f'<circle cx="{sx(x):.1f}" cy="{sy(y):.1f}" r="1.6" fill="{color}" fill-opacity="0.55"/>' for x, y in pts[:3000])
    ticks = ""
    for i in range(5):
        yv = y0 + (y1 - y0) * i / 4
        xv = x0 + (x1 - x0) * i / 4
        ticks += f'<line x1="{ml}" x2="{ml + pw}" y1="{sy(yv):.1f}" y2="{sy(yv):.1f}" stroke="#ddd"/>'
        ticks += f'<text x="4" y="{sy(yv) + 3:.1f}" font-size="9" fill="#666">{yv:.1f}</text>'
        ticks += f'<text x="{sx(xv) - 10:.1f}" y="{h - 14}" font-size="9" fill="#666">{xv:.0f}</text>'
    return (f'<svg width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg" style="background:#fff;border:1px solid #ddd">'
            f'<text x="{ml}" y="14" font-size="11" font-weight="600">{html.escape(title)}</text>{ticks}{dots}'
            f'<text x="{ml + pw / 2 - 20}" y="{h - 3}" font-size="10" fill="#444">{html.escape(x_label)}</text>'
            f'<text x="2" y="{mt - 4}" font-size="10" fill="#444">{html.escape(y_label)}</text></svg>')


def render_report(run: dict, kpi: dict) -> str:
    d = kpi["detection"]
    err = d.get("error") or {}
    rows = [
        ("Mode", kpi["mode"]),
        ("Detections", d["count"]),
        ("Detections / min", _fmt(d.get("per_minute"))),
        ("Max gap between detections", _fmt(d.get("max_gap_s"), 1, " s")),
    ]
    if kpi["mode"] == "ground_truth":
        rows += [
            ("Pd", f'{_pct(d.get("pd"))} ({d.get("pd_bins_detected")}/{d.get("pd_bins")} bins of {kpi["params"]["bin_s"]} s)'),
            ("False alarms / min", _fmt(d.get("false_alarms_per_min"))),
            ("True / false / with GT", f'{d.get("true")} / {d.get("false")} / {d.get("with_gt")}'),
            ("Time to first detection", _fmt(d.get("time_to_first_detection_s"), 1, " s")),
            ("Longest miss", _fmt(d.get("longest_miss_s"), 1, " s")),
            ("CEP50 / CEP95 (horizontal)", f'{_fmt(d.get("cep50_m"))} / {_fmt(d.get("cep95_m"))} m'),
        ]
        for key, label, unit in (("horiz", "Horizontal error", " m"), ("vert", "Vertical error", " m"), ("range", "Range error", " m"),
                                 ("az_deg", "Azimuth error", "°"), ("el_deg", "Elevation error", "°"), ("radial_vel", "Radial velocity error", " m/s")):
            s = err.get(key)
            if s:
                rows.append((label, f'RMSE {_fmt(s["rmse"], 2, unit)}, mean {_fmt(s["mean"], 2, unit)}, p95 {_fmt(s["p95"], 2, unit)}'))
    to = kpi.get("time_offset")
    if to:
        rows.append(("Estimated time offset (GT vs detections)",
                     f'{to["lag_s"]:+.2f} s (median 3-D error {_fmt(to["median_d3_at_zero_m"], 0)} m -> {_fmt(to["median_d3_at_lag_m"], 0)} m); applied {to["applied_s"]:+.2f} s'))
    if kpi.get("tracks"):
        t = kpi["tracks"]
        rows += [("Tracks", f'{t["count"]} (mean length {_fmt(t["mean_length_s"])} s)'),
                 ("Confirmed ratio", _pct(t.get("confirmed_ratio")))]
        if t.get("continuity") is not None:
            rows.append(("Track continuity", f'{_pct(t["continuity"])}; {t.get("fragmentations")} fragmentations, {t.get("id_switches")} ID switches'))
        if t.get("nees_consistency") is not None:
            rows.append(("NEES consistency (95 %)", _pct(t["nees_consistency"])))
    if kpi.get("health"):
        hl = kpi["health"]
        rows.append(("RV-map health", f'{hl["saturated_frames"]}/{hl["frames"]} saturated, {hl["timeout_frames"]} timeouts, max age {_fmt(hl["max_age_ms"], 0, " ms")}'))
    table = "".join(f"<tr><th>{html.escape(str(k))}</th><td>{html.escape(str(v))}</td></tr>" for k, v in rows)
    s = kpi.get("samples", [])
    ok = [x for x in s if x["ok"]]
    charts = _scatter([(x["range"], x["horiz"]) for x in ok], "range [m]", "horizontal error [m]", "Horizontal error vs range") + " " + \
        _scatter([(x["range"], x["p"]) for x in s], "range [m]", "power [dB]", "Power vs range", color="#16a34a")
    br = "".join(
        f"<tr><td>{b['r0']:.0f}–{b['r1']:.0f}</td><td>{b['n']}</td><td>{b['n_true']}</td><td>{_pct(b['pd'])}</td>"
        f"<td>{_fmt(b['rmse_horiz'])}</td><td>{_fmt(b['rmse_range'])}</td><td>{_fmt(b['mean_power_db'])}</td></tr>"
        for b in kpi.get("by_range", []) if b["n"] > 0)
    warns = "".join(f"<li>{html.escape(w)}</li>" for w in kpi.get("warnings", []))
    g = kpi.get("georef")
    geo = f'{g["frame"]} anchor {g["lat0"]:.6f}, {g["lon0"]:.6f}, alt {g["alt0"]:.1f} ({g["source"]}, σ {_fmt(g["residual_std_m"])} m)' if g else "none"
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>Radar KPI report – {html.escape(run['name'])}</title>
<style>body{{font:14px system-ui;margin:24px;color:#1b1f27}}th{{text-align:left;padding:3px 14px 3px 0;color:#555;font-weight:500}}
td{{padding:3px 8px}}table.b td,table.b th{{border-bottom:1px solid #ddd;padding:3px 10px}}h1{{font-size:20px}}h2{{font-size:15px;margin-top:22px}}</style></head>
<body><h1>Radar KPI report</h1>
<p><b>{html.escape(run['name'])}</b> [{html.escape(run['root'])}] &middot; duration {run['duration_s']:.0f} s &middot; generated {html.escape(kpi['computed_at'])}<br>
Gate {kpi['params']['gate_m']} m, bin {kpi['params']['bin_s']} s &middot; georeference: {html.escape(geo)}<br>
Ground truth: {html.escape(str(kpi['sources'].get('ground_truth')))} &middot; carrier: {html.escape(str(kpi['sources'].get('carrier')))}</p>
{('<h2>Warnings</h2><ul>' + warns + '</ul>') if warns else ''}
<h2>Summary</h2><table>{table}</table>
<h2>Charts</h2>{charts}
<h2>By range</h2><table class="b"><tr><th>Range [m]</th><th>N</th><th>True</th><th>Pd</th><th>RMSE horiz [m]</th><th>RMSE range [m]</th><th>Power [dB]</th></tr>{br}</table>
</body></html>"""
