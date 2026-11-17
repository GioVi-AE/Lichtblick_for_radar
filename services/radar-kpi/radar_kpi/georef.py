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
