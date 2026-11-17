// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
// Georeferencing of radar-local coordinates.
//
// Radar detections (RadarDetection.origin + range * ray_dir, Track.x/y, ...) are expressed in a local
// world frame. For the Eagle pipeline this frame was verified on real data to be NED
// (x = North, y = East, z = Down) with z measured relative to an altitude offset. The anchor
// (lat0, lon0, alt0) of that frame is not stored in the bags, so it is estimated from a platform
// NavSatFix track (carrier) by comparing it with the radar `origin` positions.

import { Lla, Ned, llaToNed, nedToLla } from "./geo";

export type LocalFrame = "NED" | "ENU";

export interface Anchor extends Lla {
  frame: LocalFrame;
  /** Std-dev (m) of the horizontal residual after anchoring; undefined for manual anchors. */
  residualStd?: number;
  source: "auto" | "manual" | "service";
}

export interface TimedLla extends Lla {
  t: number;
}

export interface LocalSample {
  t: number;
  x: number;
  y: number;
  z: number;
}

/** Converts a local sample (frame axes) into NED about the anchor. */
export function localToNed(frame: LocalFrame, x: number, y: number, z: number): Ned {
  return frame === "NED" ? { n: x, e: y, d: z } : { n: y, e: x, d: -z };
}

export function localToLla(anchor: Anchor, x: number, y: number, z: number): Lla {
  return nedToLla(anchor, localToNed(anchor.frame, x, y, z));
}

/** Time-ordered track with linear interpolation. */
export class TimedTrack {
  readonly t: number[] = [];
  readonly lat: number[] = [];
  readonly lon: number[] = [];
  readonly alt: number[] = [];

  push(p: TimedLla): void {
    // Keep sorted (inputs are almost always monotonic).
    const n = this.t.length;
    if (n === 0 || p.t >= this.t[n - 1]!) {
      this.t.push(p.t);
      this.lat.push(p.lat);
      this.lon.push(p.lon);
      this.alt.push(p.alt);
      return;
    }
    let i = n;
    while (i > 0 && this.t[i - 1]! > p.t) {
      i--;
    }
    this.t.splice(i, 0, p.t);
    this.lat.splice(i, 0, p.lat);
    this.lon.splice(i, 0, p.lon);
    this.alt.splice(i, 0, p.alt);
  }

  get length(): number {
    return this.t.length;
  }

  clear(): void {
    this.t.length = 0;
    this.lat.length = 0;
    this.lon.length = 0;
    this.alt.length = 0;
  }

  /** Interpolated position at time t; undefined outside [t0 - maxGap, t1 + maxGap] or across big gaps. */
  at(t: number, maxGap = 5): Lla | undefined {
    const n = this.t.length;
    if (n === 0) {
      return undefined;
    }
    if (t <= this.t[0]!) {
      return this.t[0]! - t <= maxGap ? this.pt(0) : undefined;
    }
    if (t >= this.t[n - 1]!) {
      return t - this.t[n - 1]! <= maxGap ? this.pt(n - 1) : undefined;
    }
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid]! <= t) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const t0 = this.t[lo]!;
    const t1 = this.t[hi]!;
    if (t1 - t0 > maxGap * 2) {
      return undefined;
    }
    const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
    return {
      lat: this.lat[lo]! + f * (this.lat[hi]! - this.lat[lo]!),
      lon: this.lon[lo]! + f * (this.lon[hi]! - this.lon[lo]!),
      alt: this.alt[lo]! + f * (this.alt[hi]! - this.alt[lo]!),
    };
  }

  private pt(i: number): Lla {
    return { lat: this.lat[i]!, lon: this.lon[i]!, alt: this.alt[i]! };
  }
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function std(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

/**
 * Estimates the anchor of the radar local frame from samples of the radar platform position in that
 * frame (RadarDetection.origin) and the platform NavSatFix track. Both axis conventions are tried;
 * the one with the smaller horizontal residual wins.
 */
export function estimateAnchor(
  platformLocal: readonly LocalSample[],
  carrier: TimedTrack,
  maxInterpGap = 2,
): Anchor | undefined {
  const paired: { s: LocalSample; c: Lla }[] = [];
  for (const s of platformLocal) {
    const c = carrier.at(s.t, maxInterpGap);
    if (c) {
      paired.push({ s, c });
    }
  }
  if (paired.length < 5) {
    return undefined;
  }
  const ref = paired[0]!.c;

  let best: Anchor | undefined;
  for (const frame of ["NED", "ENU"] as const) {
    // Start with the origin placed at the first carrier fix, then refine: move the anchor by the median
    // residual (carrier NED about the anchor minus radar-local platform position) until it converges.
    let anchor: Lla = { ...ref };
    let resid = Infinity;
    for (let iter = 0; iter < 6; iter++) {
      const dn: number[] = [];
      const de: number[] = [];
      const dd: number[] = [];
      for (const { s, c } of paired) {
        const cNed = llaToNed(anchor, c);
        const l = localToNed(frame, s.x, s.y, s.z);
        dn.push(cNed.n - l.n);
        de.push(cNed.e - l.e);
        dd.push(cNed.d - l.d);
      }
      resid = Math.hypot(std(dn), std(de));
      // moving the anchor by v (old NED) changes the carrier-relative NED by -v
      anchor = nedToLla(anchor, { n: median(dn), e: median(de), d: median(dd) });
    }
    const cand: Anchor = { ...anchor, frame, residualStd: resid, source: "auto" };
    if (!best || resid < (best.residualStd ?? Infinity)) {
      best = cand;
    }
  }
  return best;
}
