# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
"""Anchor estimation for radar-local frames.

Detections from the Eagle pipeline are expressed in a local world frame (verified on real data: NED,
x=North, y=East, z=Down with an altitude offset). The anchor (lat0, lon0, alt0) of that frame is not
stored in the bags. It is estimated by comparing the radar platform position reported in the
detections (``origin``) with the platform's NavSatFix track. Mirrors extensions/eagle-radar/src/georef.ts.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np

from .geo import lla_to_ned, local_to_ned, ned_to_lla


@dataclass
class Anchor:
    lat: float
    lon: float
    alt: float
    frame: str = "NED"
    residual_std_m: float | None = None
    source: str = "auto"

    def as_tuple(self) -> tuple[float, float, float]:
        return (self.lat, self.lon, self.alt)

    def to_dict(self) -> dict:
        return asdict(self)


class Track:
    """Time-ordered lat/lon/alt track with linear interpolation."""

    def __init__(self, t, lat, lon, alt):
        t = np.asarray(t, dtype=float)
        order = np.argsort(t, kind="stable")
        self.t = t[order]
        self.lat = np.asarray(lat, dtype=float)[order]
        self.lon = np.asarray(lon, dtype=float)[order]
        self.alt = np.asarray(alt, dtype=float)[order]

    def __len__(self) -> int:
        return len(self.t)

    def at(self, t, max_gap: float = 5.0):
        """Interpolated (lat, lon, alt, valid) at times t. Invalid outside coverage or over large gaps."""
        t = np.atleast_1d(np.asarray(t, dtype=float))
        if len(self.t) == 0:
            nan = np.full(t.shape, np.nan)
            return nan, nan.copy(), nan.copy(), np.zeros(t.shape, dtype=bool)
        lat = np.interp(t, self.t, self.lat)
        lon = np.interp(t, self.t, self.lon)
        alt = np.interp(t, self.t, self.alt)
        idx = np.clip(np.searchsorted(self.t, t), 1, max(1, len(self.t) - 1))
        if len(self.t) > 1:
            lo, hi = self.t[idx - 1], self.t[idx]
            gap_ok = (hi - lo) <= 2 * max_gap
        else:
            gap_ok = np.ones(t.shape, dtype=bool)
        before = t < self.t[0]
        after = t > self.t[-1]
        valid = gap_ok & ~(before & (self.t[0] - t > max_gap)) & ~(after & (t - self.t[-1] > max_gap))
        return lat, lon, alt, valid

    def ned(self, anchor: tuple[float, float, float]) -> np.ndarray:
        return lla_to_ned(anchor, self.lat, self.lon, self.alt)

    def shifted(self, offset: float) -> "Track":
        """Track whose value at time t equals this track's value at t + offset."""
        return Track(self.t - offset, self.lat, self.lon, self.alt)


def estimate_time_offset(
    det_t: np.ndarray,
    det_ned: np.ndarray,
    gt: "Track",
    anchor: tuple[float, float, float],
    max_gap_s: float = 5.0,
    search_s: float = 8.0,
) -> dict | None:
    """Lag (s) such that GT(t + lag) best matches the detections (min median 3-D error).

    Positive lag: the detections describe where the target *was* `lag` seconds
    after the detection timestamp, i.e. the detections lag behind the ground truth.
    """
    if len(det_t) < 5 or len(gt) < 2:
        return None

    def cost(lag: float) -> float:
        glat, glon, galt, valid = gt.at(det_t + lag, max_gap_s)
        if valid.sum() < 5:
            return float("inf")
        e = det_ned[valid] - lla_to_ned(anchor, glat[valid], glon[valid], galt[valid])
        return float(np.median(np.linalg.norm(e, axis=1)))

    coarse = np.arange(-search_s, search_s + 1e-9, 0.25)
    costs = np.array([cost(x) for x in coarse])
    if not np.isfinite(costs).any():
        return None
    c0 = float(coarse[int(np.argmin(costs))])
    fine = np.arange(c0 - 0.25, c0 + 0.25 + 1e-9, 0.05)
    fc = np.array([cost(x) for x in fine])
    best = float(fine[int(np.argmin(fc))])
    return {"lag_s": round(best, 3) + 0.0, "median_d3_at_lag_m": float(fc.min()), "median_d3_at_zero_m": cost(0.0)}


def estimate_anchor(
    platform_t: np.ndarray,
    platform_local: np.ndarray,
    carrier: Track,
    max_interp_gap: float = 2.0,
) -> Anchor | None:
    """Estimate the local-frame anchor from radar platform positions and the carrier NavSat track."""
    platform_t = np.asarray(platform_t, dtype=float)
    platform_local = np.asarray(platform_local, dtype=float)
    lat, lon, alt, valid = carrier.at(platform_t, max_interp_gap)
    if valid.sum() < 5:
        return None
    lat, lon, alt = lat[valid], lon[valid], alt[valid]
    local = platform_local[valid]
    ref = (float(lat[0]), float(lon[0]), float(alt[0]))
    best: Anchor | None = None
    for frame in ("NED", "ENU"):
        loc_ned = local_to_ned(frame, local)
        anchor = ref
        resid = np.inf
        for _ in range(6):
            c_ned = lla_to_ned(anchor, lat, lon, alt)
            diff = c_ned - loc_ned
            resid = float(np.hypot(diff[:, 0].std(), diff[:, 1].std()))
            shift = np.median(diff, axis=0)
            la, lo, al = ned_to_lla(anchor, shift)
            anchor = (float(la), float(lo), float(al))
        cand = Anchor(anchor[0], anchor[1], anchor[2], frame=frame, residual_std_m=resid, source="auto")
        if best is None or resid < (best.residual_std_m or np.inf):
            best = cand
    return best


# ----------------------------------------------------------------------------- bare local x/y frames
# eagle_radar_msgs Track/Detection carry only x/y in a frame called "radar_frame" whose axes are not
# specified. We therefore treat the frame as a hypothesis and let the ground truth decide.

LOCAL_XY_FRAMES = ("NED", "ENU", "PLATFORM_NED", "PLATFORM_ENU")


def local_xy_to_ned(frame: str, t, xy, anchor: tuple[float, float, float], carrier: "Track | None", z=None) -> np.ndarray:
    """x/y (m) of the given frame hypothesis -> NED about `anchor` (z = platform down, or 0 for world frames).

    NED: (x=N, y=E); ENU: (x=E, y=N); PLATFORM_*: same axes but relative to the radar carrier position at time t.
    Samples without carrier coverage become NaN for PLATFORM_*.
    """
    xy = np.asarray(xy, dtype=float)[:, :2]
    n, e = (xy[:, 0], xy[:, 1]) if frame.endswith("NED") else (xy[:, 1], xy[:, 0])
    zz = np.zeros_like(n) if z is None else np.asarray(z, dtype=float)
    if not frame.endswith("NED"):
        zz = -zz  # ENU z is up
    out = np.stack([n, e, zz], axis=1)
    if frame.startswith("PLATFORM"):
        if carrier is None:
            out[:] = np.nan
            return out
        clat, clon, calt, ok = carrier.at(np.asarray(t, dtype=float), 5.0)
        base = lla_to_ned(anchor, clat, clon, calt)
        out = out + base
        out[~ok] = np.nan
    return out


def select_local_xy_frame(
    t,
    xy,
    anchor: tuple[float, float, float],
    carrier: "Track | None",
    gts: "dict[str, Track]",
    max_gap_s: float = 5.0,
    max_samples: int = 3000,
) -> dict | None:
    """Pick the frame hypothesis (and ground-truth track) with the smallest median horizontal error.

    Returns {selected, target, median_horiz_m: {frame: best median over gts}, confident} or None.
    `confident` = best median < 70 % of the best median of any *other* frame.
    """
    t = np.asarray(t, dtype=float)
    if len(t) == 0 or not gts:
        return None
    stride = max(1, len(t) // max_samples)
    ts, xys = t[::stride], np.asarray(xy, dtype=float)[::stride]
    scores: dict[str, float] = {}
    best_target: dict[str, str] = {}
    for fr in LOCAL_XY_FRAMES:
        ned = local_xy_to_ned(fr, ts, xys, anchor, carrier)
        for name, gt in gts.items():
            glat, glon, galt, valid = gt.at(ts, max_gap_s)
            valid &= np.isfinite(ned[:, 0])
            if valid.sum() < 3:
                continue
            g = lla_to_ned(anchor, glat[valid], glon[valid], galt[valid])
            d = float(np.median(np.hypot(ned[valid, 0] - g[:, 0], ned[valid, 1] - g[:, 1])))
            if d < scores.get(fr, np.inf):
                scores[fr], best_target[fr] = d, name
    if not scores:
        return None
    sel = min(scores, key=scores.get)  # type: ignore[arg-type]
    others = [v for k, v in scores.items() if k != sel]
    return {
        "selected": sel,
        "target": best_target[sel],
        "median_horiz_m": scores,
        "confident": bool(not others or scores[sel] < 0.7 * min(others)),
    }
