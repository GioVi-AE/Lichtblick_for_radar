# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
"""KPI definitions for radar detections and tracks.

Definitions (also mirrored by extensions/eagle-radar/src/quickKpi.ts for the in-browser view)
---------------------------------------------------------------------------------------------
* A detection is TRUE if its 3D distance to the time-interpolated ground truth is <= ``gate_m``;
  otherwise it is FALSE (clutter / false alarm) as long as ground truth exists at that time.
* Pd = number of ``bin_s`` time bins with >= 1 true detection / number of bins in the radar/GT overlap
  window in which ground truth exists.
* False alarms per minute = false detections / overlap duration [min].
* CEP50 / CEP95 = median / 95th percentile of the horizontal error of true detections.
* Range / azimuth / elevation errors compare the detection with the GT line of sight from the radar
  platform. Radial velocity is compared modulo the unambiguous velocity interval.
* Tracks: continuity = share of overlap seconds covered by a track point within the gate;
  fragmentations = gaps > ``track_gap_s`` in that coverage; id switches = track-id changes along the
  true-track sequence; NEES consistency = share of true track points with NEES <= chi2(3, 0.95).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .adapters import Detections, Status, TrackSet
from .geo import lla_to_ned, local_to_ned, ned_to_enu
from .georef import Track

CHI2_3DOF_95 = 7.814727903251179


@dataclass(frozen=True)
class KpiParams:
    gate_m: float = 150.0
    bin_s: float = 1.0
    max_gt_gap_s: float = 5.0
    time_offset_s: float = 0.0  # applied GT time shift (GT sampled at t + offset)
    auto_offset: bool = False  # estimate and apply the best offset
    track_gap_s: float = 3.0
    timeline_windows: int = 60
    max_samples: int = 4000

    def to_dict(self) -> dict:
        return {"gate_m": self.gate_m, "bin_s": self.bin_s, "max_gt_gap_s": self.max_gt_gap_s,
                "time_offset_s": self.time_offset_s, "auto_offset": self.auto_offset}


# ----------------------------------------------------------------------------- helpers


def _f(x):
    """JSON-safe float (NaN/inf -> None)."""
    if x is None:
        return None
    x = float(x)
    return x if math.isfinite(x) else None


def err_stats(values: np.ndarray) -> dict | None:
    v = np.asarray(values, dtype=float)
    v = v[np.isfinite(v)]
    if v.size == 0:
        return None
    a = np.abs(v)
    return {
        "n": int(v.size),
        "mean": _f(v.mean()),
        "rmse": _f(np.sqrt(np.mean(v**2))),
        "p50": _f(np.percentile(a, 50)),
        "p90": _f(np.percentile(a, 90)),
        "p95": _f(np.percentile(a, 95)),
        "max": _f(a.max()),
    }


def dist_stats(values: np.ndarray) -> dict | None:
    v = np.asarray(values, dtype=float)
    v = v[np.isfinite(v)]
    if v.size == 0:
        return None
    return {
        "min": _f(v.min()), "max": _f(v.max()), "mean": _f(v.mean()),
        "p50": _f(np.percentile(v, 50)), "p95": _f(np.percentile(v, 95)),
    }


def _nice_range_bin(max_range: float) -> float:
    for w in (50.0, 100.0, 200.0, 250.0, 500.0, 1000.0, 2000.0):
        if max_range / w <= 14:
            return w
    return 5000.0


def _wrap_deg(a: np.ndarray) -> np.ndarray:
    return (a + 180.0) % 360.0 - 180.0


def _longest_gap(times: np.ndarray, t0: float, t1: float) -> float:
    edges = np.concatenate([[t0], np.sort(times), [t1]])
    return float(np.max(np.diff(edges))) if len(edges) > 1 else float(t1 - t0)


# ----------------------------------------------------------------------------- detections


def detection_kpi(
    det: Detections,
    det_ned: np.ndarray | None,
    plat_ned: np.ndarray | None,
    gt: Track | None,
    anchor: tuple[float, float, float] | None,
    params: KpiParams,
) -> tuple[dict, dict[str, np.ndarray], list[str]]:
    """Returns (kpi dict, per-detection arrays for CSV export, warnings)."""
    warnings: list[str] = []
    n = len(det)
    t = det.t
    out: dict = {"count": int(n)}
    duration = float(t.max() - t.min()) if n > 1 else 0.0
    out["per_minute"] = _f(n / (duration / 60.0)) if duration > 0 else None
    out["max_gap_s"] = _f(np.max(np.diff(np.sort(t)))) if n > 1 else 0.0
    out["range_m"] = dist_stats(det.range) if det.range is not None else None
    pwr_db = None
    if det.power is not None:
        p = det.power[det.power > 0]
        if p.size:
            pwr_db = 10 * np.log10(p)
    out["power_db"] = dist_stats(pwr_db) if pwr_db is not None else None

    arrays: dict[str, np.ndarray] = {"t": t}
    if gt is None or det_ned is None or anchor is None:
        return out, arrays, warnings

    glat, glon, galt, valid = gt.at(t, params.max_gt_gap_s)
    if not valid.any():
        warnings.append("Ground truth does not overlap the detection time span.")
        return out, arrays, warnings
    gt_ned = lla_to_ned(anchor, glat, glon, galt)
    e = det_ned - gt_ned
    horiz = np.hypot(e[:, 0], e[:, 1])
    vert = e[:, 2]
    d3 = np.linalg.norm(e, axis=1)
    is_true = valid & (d3 <= params.gate_m)
    is_false = valid & ~is_true

    # --- line-of-sight errors (needs platform position)
    rng_err = az_err = el_err = None
    vr_stats = None
    rng_gt = None
    if plat_ned is not None:
        rel_gt = gt_ned - plat_ned
        rng_gt = np.linalg.norm(rel_gt, axis=1)
        rel_det = det_ned - plat_ned
        rng_det = det.range if det.range is not None else np.linalg.norm(rel_det, axis=1)
        rng_err = rng_det - rng_gt
        az_gt = np.degrees(np.arctan2(rel_gt[:, 1], rel_gt[:, 0]))
        az_det = np.degrees(np.arctan2(rel_det[:, 1], rel_det[:, 0]))
        az_err = _wrap_deg(az_det - az_gt)
        el_gt = np.degrees(np.arcsin(np.clip(-rel_gt[:, 2] / np.maximum(rng_gt, 1e-6), -1, 1)))
        el_det = np.degrees(np.arcsin(np.clip(-rel_det[:, 2] / np.maximum(np.linalg.norm(rel_det, axis=1), 1e-6), -1, 1)))
        el_err = el_det - el_gt
        # radial velocity (folded by the ambiguity interval)
        if det.radial_vel is not None and det.ambiguity is not None and det.platform_vel is not None:
            tg = gt.t
            if len(tg) > 2:
                gned = lla_to_ned(anchor, gt.lat, gt.lon, gt.alt)
                gvel = np.gradient(gned, tg, axis=0)
                v_gt = np.stack([np.interp(t, tg, gvel[:, k]) for k in range(3)], axis=1)
                los = rel_gt / np.maximum(rng_gt, 1e-6)[:, None]
                v_r = np.sum((v_gt - det.platform_vel) * los, axis=1)
                amb = np.where(det.ambiguity > 0, det.ambiguity, np.nan)
                best_sign, best_med = 1.0, np.inf
                folded_best = None
                for sign in (1.0, -1.0):
                    diff = det.radial_vel - sign * v_r
                    folded = diff - amb * np.round(diff / amb)
                    sel = is_true & np.isfinite(folded)
                    med = np.median(np.abs(folded[sel])) if sel.any() else np.inf
                    if med < best_med:
                        best_med, best_sign, folded_best = med, sign, folded
                if folded_best is not None and np.isfinite(best_med):
                    vr_stats = err_stats(folded_best[is_true])
                    arrays["vr_err"] = folded_best
                    out["radial_vel_sign"] = best_sign

    out["with_gt"] = int(valid.sum())
    out["true"] = int(is_true.sum())
    out["false"] = int(is_false.sum())

    # --- Pd over time bins
    t0 = max(float(t.min()), float(gt.t[0]))
    t1 = min(float(t.max()), float(gt.t[-1]))
    bin_s = params.bin_s
    pd_bins = pd_detected = 0
    pd = None
    ttfd = None
    longest_miss = None
    bin_range = np.array([])
    bin_hit = np.array([], dtype=bool)
    bin_centers = np.array([])
    if t1 > t0:
        edges = np.arange(math.floor(t0 / bin_s), math.floor(t1 / bin_s) + 2) * bin_s
        centers = edges[:-1] + bin_s / 2
        blat, blon, balt, bvalid = gt.at(centers, params.max_gt_gap_s)
        hit_idx = np.floor(t[is_true] / bin_s).astype(int) - int(edges[0] / bin_s)
        hit = np.zeros(len(centers), dtype=bool)
        hit_idx = hit_idx[(hit_idx >= 0) & (hit_idx < len(centers))]
        hit[hit_idx] = True
        # only bins inside the overlap window
        inside = (centers >= t0 - bin_s / 2) & (centers <= t1 + bin_s / 2) & bvalid
        pd_bins = int(inside.sum())
        pd_detected = int((hit & inside).sum())
        pd = pd_detected / pd_bins if pd_bins else None
        bin_centers = centers[inside]
        bin_hit = hit[inside]
        if plat_ned is not None and len(t) > 1:
            pn = np.stack([np.interp(bin_centers, t, plat_ned[:, k]) for k in range(3)], axis=1)
            gn = lla_to_ned(anchor, blat[inside], blon[inside], balt[inside])
            bin_range = np.linalg.norm(gn - pn, axis=1)
        tt = np.sort(t[is_true])
        ttfd = float(tt[0] - t0) if tt.size else None
        longest_miss = _longest_gap(tt[(tt >= t0) & (tt <= t1)], t0, t1)
    out["pd"] = _f(pd)
    out["pd_bins"] = pd_bins
    out["pd_bins_detected"] = pd_detected
    out["time_to_first_detection_s"] = _f(ttfd)
    out["longest_miss_s"] = _f(longest_miss)
    ov = max(0.0, t1 - t0)
    out["false_alarms_per_min"] = _f(is_false.sum() / (ov / 60.0)) if ov > 0 else None

    if is_true.any():
        h = horiz[is_true]
        out["cep50_m"] = _f(np.percentile(h, 50))
        out["cep95_m"] = _f(np.percentile(h, 95))
        out["error"] = {
            "horiz": err_stats(h), "vert": err_stats(vert[is_true]), "d3": err_stats(d3[is_true]),
            "range": err_stats(rng_err[is_true]) if rng_err is not None else None,
            "az_deg": err_stats(az_err[is_true]) if az_err is not None else None,
            "el_deg": err_stats(el_err[is_true]) if el_err is not None else None,
            "radial_vel": vr_stats,
            "bias_ned": [_f(e[is_true, k].mean()) for k in range(3)],
        }
    else:
        out["cep50_m"] = out["cep95_m"] = None
        out["error"] = None
        warnings.append("No detection fell within the association gate; check gate, time sync and georeference.")

    arrays.update({
        "gt_valid": valid, "true": is_true, "horiz": horiz, "vert": vert, "d3": d3,
    })
    if rng_err is not None:
        arrays["range_err"], arrays["az_err_deg"], arrays["el_err_deg"] = rng_err, az_err, el_err
        arrays["gt_range"] = rng_gt

    # --- by range
    by_range: list[dict] = []
    rmax = 0.0
    if det.range is not None and n:
        rmax = float(np.nanmax(det.range))
    if bin_range.size:
        rmax = max(rmax, float(bin_range.max()))
    if rmax > 0:
        w = _nice_range_bin(rmax)
        nb = int(math.ceil(rmax / w)) or 1
        rr = det.range if det.range is not None else (np.linalg.norm(det_ned - plat_ned, axis=1) if plat_ned is not None else None)
        for i in range(nb):
            r0, r1 = i * w, (i + 1) * w
            row = {"r0": r0, "r1": r1, "n": 0, "n_true": 0, "pd": None, "rmse_horiz": None, "rmse_range": None, "mean_power_db": None}
            if rr is not None:
                sel = (rr >= r0) & (rr < r1) & valid
                row["n"] = int(sel.sum())
                st = sel & is_true
                row["n_true"] = int(st.sum())
                if st.any():
                    row["rmse_horiz"] = _f(np.sqrt(np.mean(horiz[st] ** 2)))
                    if rng_err is not None:
                        row["rmse_range"] = _f(np.sqrt(np.mean(rng_err[st] ** 2)))
                if pwr_db is not None and det.power is not None:
                    pm = sel & (det.power > 0)
                    if pm.any():
                        row["mean_power_db"] = _f(np.mean(10 * np.log10(det.power[pm])))
            if bin_range.size:
                bsel = (bin_range >= r0) & (bin_range < r1)
                if bsel.any():
                    row["pd"] = _f(bin_hit[bsel].mean())
            by_range.append(row)

    # --- timeline windows
    timeline: list[dict] = []
    if ov > 0:
        win = max(bin_s * 5, ov / params.timeline_windows)
        nwin = int(math.ceil(ov / win))
        for k in range(nwin):
            a, b = t0 + k * win, t0 + (k + 1) * win
            sel = (t >= a) & (t < b) & valid
            st = sel & is_true
            pdw = None
            if bin_centers.size:
                bm = (bin_centers >= a) & (bin_centers < b)
                if bm.any():
                    pdw = _f(bin_hit[bm].mean())
            timeline.append({
                "t": _f(a), "n_det": int(sel.sum()), "n_true": int(st.sum()), "pd": pdw,
                "rmse_horiz": _f(np.sqrt(np.mean(horiz[st] ** 2))) if st.any() else None,
            })
    out["by_range"] = by_range
    out["timeline"] = timeline
    return out, arrays, warnings


def detection_stream_timeline(det: Detections, params: KpiParams) -> list[dict]:
    """Detection-count timeline for runs without ground truth."""
    t = det.t
    if len(t) < 2:
        return []
    dur = float(t.max() - t.min())
    win = max(params.bin_s * 5, dur / params.timeline_windows)
    nwin = max(1, int(math.ceil(dur / win)))
    out = []
    for k in range(nwin):
        a, b = t.min() + k * win, t.min() + (k + 1) * win
        out.append({"t": _f(a), "n_det": int(((t >= a) & (t < b)).sum()), "n_true": 0, "pd": None, "rmse_horiz": None})
    return out


def detection_range_table(det: Detections) -> list[dict]:
    """By-range table (counts / power) without ground truth."""
    if det.range is None or len(det) == 0:
        return []
    rmax = float(np.nanmax(det.range))
    w = _nice_range_bin(rmax)
    rows = []
    for i in range(int(math.ceil(rmax / w)) or 1):
        r0, r1 = i * w, (i + 1) * w
        sel = (det.range >= r0) & (det.range < r1)
        mp = None
        if det.power is not None:
            pm = sel & (det.power > 0)
            if pm.any():
                mp = _f(np.mean(10 * np.log10(det.power[pm])))
        rows.append({"r0": r0, "r1": r1, "n": int(sel.sum()), "n_true": 0, "pd": None, "rmse_horiz": None, "rmse_range": None, "mean_power_db": mp})
    return rows


def downsample_samples(det: Detections, arrays: dict, max_samples: int) -> list[dict]:
    n = len(det)
    if n == 0 or "horiz" not in arrays:
        return []
    idx = np.arange(n)
    idx = idx[arrays["gt_valid"][idx]]
    if len(idx) > max_samples:
        idx = idx[np.linspace(0, len(idx) - 1, max_samples).astype(int)]
    pdb = None
    if det.power is not None:
        pdb = np.where(det.power > 0, 10 * np.log10(np.maximum(det.power, 1e-12)), np.nan)
    rows = []
    for i in idx:
        rows.append({
            "t": _f(det.t[i]),
            "range": _f(det.range[i]) if det.range is not None else None,
            "horiz": _f(arrays["horiz"][i]), "vert": _f(arrays["vert"][i]), "d3": _f(arrays["d3"][i]),
            "az": _f(arrays["az_err_deg"][i]) if "az_err_deg" in arrays else None,
            "el": _f(arrays["el_err_deg"][i]) if "el_err_deg" in arrays else None,
            "ok": bool(arrays["true"][i]),
            "p": _f(pdb[i]) if pdb is not None else None,
        })
    return rows


# ----------------------------------------------------------------------------- tracks


def track_kpi(
    tracks: TrackSet,
    anchor: tuple[float, float, float] | None,
    frame: str,
    gt: Track | None,
    status: Status | None,
    params: KpiParams,
) -> dict:
    ids = tracks.ids
    uniq = np.unique(ids)
    lengths = []
    for u in uniq:
        tt = tracks.t[ids == u]
        lengths.append(float(tt.max() - tt.min()))
    out: dict = {
        "count": int(len(uniq)), "topic": tracks.topic,
        "mean_length_s": _f(np.mean(lengths)) if lengths else 0.0,
        "confirmed_ratio": None,
    }
    # confirmed ratio
    if status is not None and status.track_kpi:
        last: dict[int, bool] = {}
        for s in sorted(status.track_kpi, key=lambda s: s["t"]):
            last[s["track_id"]] = s["confirmed"]
        out["confirmed_ratio"] = _f(np.mean(list(last.values()))) if last else None
        snr = [s["snr_db"] for s in status.track_kpi if s["rf_ok"] and math.isfinite(s["snr_db"])]
        out["mean_snr_db"] = _f(np.mean(snr)) if snr else None
        lastu: dict[int, tuple[int, int]] = {}
        for s in sorted(status.track_kpi, key=lambda s: s["t"]):
            lastu[s["track_id"]] = (s["missed_updates"], s["total_updates"])
        tot = sum(v[1] for v in lastu.values())
        out["missed_update_ratio"] = _f(sum(v[0] for v in lastu.values()) / tot) if tot else None
    elif tracks.state is not None:
        conf = []
        for u in uniq:
            st = tracks.state[ids == u][-1].lower()
            conf.append(st in ("confirmed", "tracking", "active", "1"))
        out["confirmed_ratio"] = _f(np.mean(conf)) if conf else None

    if gt is None or anchor is None:
        return out

    # positions in NED about anchor
    if tracks.lla is not None:
        ned = lla_to_ned(anchor, tracks.lla[:, 0], tracks.lla[:, 1], tracks.lla[:, 2])
    elif tracks.local is not None:
        ned = local_to_ned(frame, tracks.local)
    else:
        return out
    glat, glon, galt, valid = gt.at(tracks.t, params.max_gt_gap_s)
    if not valid.any():
        return out
    gned = lla_to_ned(anchor, glat, glon, galt)
    e = ned - gned
    if not tracks.has_z:
        e[:, 2] = 0.0
    d = np.linalg.norm(e, axis=1)
    ok = valid & (d <= params.gate_m)
    horiz = np.hypot(e[:, 0], e[:, 1])
    out["rmse_horiz"] = _f(np.sqrt(np.mean(horiz[ok] ** 2))) if ok.any() else None
    if ok.any():
        tt = tracks.t[ok]
        order = np.argsort(tt, kind="stable")
        tt_sorted = tt[order]
        ids_ok = ids[ok][order]
        # id switches along the true sequence (collapse same-time duplicates)
        seq = []
        last_t = None
        for ts, i_ in zip(tt_sorted, ids_ok):
            if last_t is not None and ts == last_t:
                continue
            seq.append(i_)
            last_t = ts
        out["id_switches"] = int(sum(1 for a, b in zip(seq[:-1], seq[1:]) if a != b))
        # fragmentation + continuity on the overlap window
        t0, t1 = max(float(tracks.t.min()), float(gt.t[0])), min(float(tracks.t.max()), float(gt.t[-1]))
        uniq_t = np.unique(tt_sorted)
        gaps = np.diff(uniq_t)
        out["fragmentations"] = int((gaps > params.track_gap_s).sum())
        if t1 > t0:
            nb = int(math.ceil((t1 - t0) / params.bin_s))
            hit = np.zeros(nb, dtype=bool)
            bi = np.floor((uniq_t - t0) / params.bin_s).astype(int)
            bi = bi[(bi >= 0) & (bi < nb)]
            hit[bi] = True
            out["continuity"] = _f(hit.mean())
        # NEES
        if tracks.cov_enu is not None and tracks.has_z:
            enu = ned_to_enu(e[ok])
            covs = tracks.cov_enu[ok].reshape(-1, 3, 3)
            good = []
            for ev, c in zip(enu, covs):
                if np.linalg.det(c) > 1e-12:
                    try:
                        good.append(float(ev @ np.linalg.solve(c, ev)))
                    except np.linalg.LinAlgError:
                        pass
            if good:
                out["nees_consistency"] = _f(np.mean(np.asarray(good) <= CHI2_3DOF_95))
    return out


def health_kpi(status: Status | None) -> dict | None:
    if status is None or not status.rv_health:
        return None
    h = status.rv_health
    return {
        "frames": len(h),
        "saturated_frames": int(sum(1 for x in h if x["saturated"])),
        "timeout_frames": int(sum(1 for x in h if x["timeout"])),
        "max_saturation_ratio": _f(max(x["saturation_ratio"] for x in h)),
        "max_age_ms": _f(max(x["age_ms"] for x in h)),
    }
