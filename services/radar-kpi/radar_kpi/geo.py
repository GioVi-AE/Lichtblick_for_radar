# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
"""Local-tangent-plane geodesy (WGS84, via ECEF). Mirrors extensions/eagle-radar/src/geo.ts."""

from __future__ import annotations

import numpy as np

WGS84_A = 6378137.0
WGS84_E2 = 0.00669437999014
DEG = np.pi / 180.0


def lla_to_ecef(lat, lon, alt):
    lat = np.asarray(lat, dtype=float) * DEG
    lon = np.asarray(lon, dtype=float) * DEG
    alt = np.asarray(alt, dtype=float)
    n = WGS84_A / np.sqrt(1 - WGS84_E2 * np.sin(lat) ** 2)
    return (
        (n + alt) * np.cos(lat) * np.cos(lon),
        (n + alt) * np.cos(lat) * np.sin(lon),
        (n * (1 - WGS84_E2) + alt) * np.sin(lat),
    )


def ecef_to_lla(x, y, z):
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    z = np.asarray(z, dtype=float)
    lon = np.arctan2(y, x)
    p = np.hypot(x, y)
    lat = np.arctan2(z, p * (1 - WGS84_E2))
    alt = np.zeros_like(lat)
    for _ in range(6):
        n = WGS84_A / np.sqrt(1 - WGS84_E2 * np.sin(lat) ** 2)
        alt = p / np.cos(lat) - n
        lat = np.arctan2(z, p * (1 - WGS84_E2 * n / (n + alt)))
    return lat / DEG, lon / DEG, alt


def _basis(lat0: float, lon0: float):
    sl, cl = np.sin(lat0 * DEG), np.cos(lat0 * DEG)
    so, co = np.sin(lon0 * DEG), np.cos(lon0 * DEG)
    return sl, cl, so, co


def lla_to_ned(anchor: tuple[float, float, float], lat, lon, alt) -> np.ndarray:
    """(…,3) array of NED offsets of the given points relative to anchor (lat, lon, alt)."""
    x0, y0, z0 = lla_to_ecef(*anchor)
    x, y, z = lla_to_ecef(lat, lon, alt)
    dx, dy, dz = x - x0, y - y0, z - z0
    sl, cl, so, co = _basis(anchor[0], anchor[1])
    n = -sl * co * dx - sl * so * dy + cl * dz
    e = -so * dx + co * dy
    d = -cl * co * dx - cl * so * dy - sl * dz
    return np.stack([n, e, d], axis=-1)


def ned_to_lla(anchor: tuple[float, float, float], ned) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    ned = np.asarray(ned, dtype=float)
    n, e, d = ned[..., 0], ned[..., 1], ned[..., 2]
    x0, y0, z0 = lla_to_ecef(*anchor)
    sl, cl, so, co = _basis(anchor[0], anchor[1])
    dx = -sl * co * n - so * e - cl * co * d
    dy = -sl * so * n + co * e - cl * so * d
    dz = cl * n - sl * d
    return ecef_to_lla(x0 + dx, y0 + dy, z0 + dz)


def local_to_ned(frame: str, xyz) -> np.ndarray:
    """Radar-local world axes -> NED. NED: (x=N,y=E,z=D). ENU: (x=E,y=N,z=U)."""
    xyz = np.asarray(xyz, dtype=float)
    if frame == "NED":
        return xyz
    if frame == "ENU":
        return np.stack([xyz[..., 1], xyz[..., 0], -xyz[..., 2]], axis=-1)
    raise ValueError(f"unknown frame {frame}")


def ned_to_enu(ned) -> np.ndarray:
    ned = np.asarray(ned, dtype=float)
    return np.stack([ned[..., 1], ned[..., 0], -ned[..., 2]], axis=-1)
