// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
// Local-tangent-plane geodesy. Must stay numerically identical to services/radar-kpi/radar_kpi/geo.py.

export const WGS84_A = 6378137.0;
export const WGS84_E2 = 0.00669437999014;
const DEG = Math.PI / 180;

export interface Lla {
  lat: number;
  lon: number;
  alt: number;
}

export interface Ned {
  n: number;
  e: number;
  d: number;
}

/** Meridian and prime-vertical radii of curvature at a latitude (degrees). */
export function curvatureRadii(latDeg: number): { m: number; nn: number } {
  const s = Math.sin(latDeg * DEG);
  const w = 1 - WGS84_E2 * s * s;
  return { m: (WGS84_A * (1 - WGS84_E2)) / Math.pow(w, 1.5), nn: WGS84_A / Math.sqrt(w) };
}

export function llaToEcef(p: Lla): [number, number, number] {
  const lat = p.lat * DEG;
  const lon = p.lon * DEG;
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2);
  return [
    (n + p.alt) * Math.cos(lat) * Math.cos(lon),
    (n + p.alt) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - WGS84_E2) + p.alt) * Math.sin(lat),
  ];
}

export function ecefToLla(x: number, y: number, z: number): Lla {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - WGS84_E2));
  let alt = 0;
  for (let i = 0; i < 6; i++) {
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2);
    alt = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (WGS84_E2 * n) / (n + alt)));
  }
  return { lat: lat / DEG, lon: lon / DEG, alt };
}

/** Position of `p` relative to anchor `a` in the local tangent-plane NED frame at `a` (exact, via ECEF). */
export function llaToNed(a: Lla, p: Lla): Ned {
  const [x0, y0, z0] = llaToEcef(a);
  const [x, y, z] = llaToEcef(p);
  const dx = x - x0, dy = y - y0, dz = z - z0;
  const sl = Math.sin(a.lat * DEG), cl = Math.cos(a.lat * DEG);
  const so = Math.sin(a.lon * DEG), co = Math.cos(a.lon * DEG);
  return {
    n: -sl * co * dx - sl * so * dy + cl * dz,
    e: -so * dx + co * dy,
    d: -cl * co * dx - cl * so * dy - sl * dz,
  };
}

/** Inverse of {@link llaToNed}. */
export function nedToLla(a: Lla, v: Ned): Lla {
  const [x0, y0, z0] = llaToEcef(a);
  const sl = Math.sin(a.lat * DEG), cl = Math.cos(a.lat * DEG);
  const so = Math.sin(a.lon * DEG), co = Math.cos(a.lon * DEG);
  const dx = -sl * co * v.n - so * v.e - cl * co * v.d;
  const dy = -sl * so * v.n + co * v.e - cl * so * v.d;
  const dz = cl * v.n - sl * v.d;
  return ecefToLla(x0 + dx, y0 + dy, z0 + dz);
}

/** Great-circle distance in meters (spherical). */
export function haversine(a: Lla, b: Lla): number {
  const R = 6371008.8;
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function norm3(a: readonly [number, number, number]): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return NaN;
  }
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}
