// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
// In-browser "quick" KPIs. Definitions mirror services/radar-kpi/radar_kpi/kpi.py (detection level):
//  - a detection is TRUE if its 3D distance to the time-interpolated ground truth is <= gateM
//  - Pd = bins (binS seconds) with >=1 true detection / bins where ground truth exists in the overlap window
//  - false alarms = detections farther than the gate from ground truth (while ground truth exists)
//  - CEP50 / CEP95 = median / 95th percentile of the horizontal error of true detections

import { llaToNed, percentile } from "./geo";
import { TimedTrack } from "./georef";
import { GeoDet } from "./radarData";

export interface QuickKpiParams {
  gateM: number;
  binS: number;
}

export const DEFAULT_QUICK_PARAMS: QuickKpiParams = { gateM: 150, binS: 1 };

export interface ErrorSample {
  t: number;
  range: number | undefined;
  horiz: number;
  vert: number;
  dist3: number;
  isTrue: boolean;
}

export interface QuickKpi {
  nDetections: number;
  nWithGt: number;
  nTrue: number;
  nFalse: number;
  falseAlarmsPerMin: number;
  pd: number;
  pdBins: number;
  pdBinsDetected: number;
  durationS: number;
  rmseHoriz: number;
  rmseVert: number;
  rmse3d: number;
  cep50: number;
  cep95: number;
  meanBias: { n: number; e: number; d: number };
  samples: ErrorSample[];
}

export function computeQuickKpi(
  dets: readonly GeoDet[],
  gt: TimedTrack | undefined,
  params: QuickKpiParams = DEFAULT_QUICK_PARAMS,
): QuickKpi | undefined {
  if (!gt || gt.length < 2 || dets.length === 0) return undefined;
  const samples: ErrorSample[] = [];
  const trueHoriz: number[] = [];
  let sumN = 0, sumE = 0, sumD = 0, sumH2 = 0, sumV2 = 0;
  const detectedBins = new Set<number>();
  let nTrue = 0;
  let nFalse = 0;
  for (const d of dets) {
    const g = gt.at(d.t, 2);
    if (!g) continue;
    const e = llaToNed(g, d);
    const horiz = Math.hypot(e.n, e.e);
    const dist3 = Math.hypot(horiz, e.d);
    const isTrue = dist3 <= params.gateM;
    samples.push({ t: d.t, range: d.range, horiz, vert: e.d, dist3, isTrue });
    if (isTrue) {
      nTrue++;
      trueHoriz.push(horiz);
      sumN += e.n; sumE += e.e; sumD += e.d;
      sumH2 += horiz * horiz; sumV2 += e.d * e.d;
      detectedBins.add(Math.floor(d.t / params.binS));
    } else {
      nFalse++;
    }
  }
  if (samples.length === 0) return undefined;
  let dMin = Infinity;
  let dMax = -Infinity;
  for (const d of dets) {
    if (d.t < dMin) dMin = d.t;
    if (d.t > dMax) dMax = d.t;
  }
  const tMin = Math.max(dMin, gt.t[0]!);
  const tMax = Math.min(dMax, gt.t[gt.length - 1]!);
  let bins = 0;
  for (let b = Math.floor(tMin / params.binS); b <= Math.floor(tMax / params.binS); b++) {
    if (gt.at((b + 0.5) * params.binS, 2)) bins++;
  }
  const durationS = Math.max(0, tMax - tMin);
  trueHoriz.sort((a, b) => a - b);
  const n = Math.max(1, nTrue);
  return {
    nDetections: dets.length,
    nWithGt: samples.length,
    nTrue,
    nFalse,
    falseAlarmsPerMin: durationS > 0 ? nFalse / (durationS / 60) : 0,
    pd: bins > 0 ? Math.min(1, detectedBins.size / bins) : NaN,
    pdBins: bins,
    pdBinsDetected: detectedBins.size,
    durationS,
    rmseHoriz: Math.sqrt(sumH2 / n),
    rmseVert: Math.sqrt(sumV2 / n),
    rmse3d: Math.sqrt((sumH2 + sumV2) / n),
    cep50: percentile(trueHoriz, 0.5),
    cep95: percentile(trueHoriz, 0.95),
    meanBias: { n: sumN / n, e: sumE / n, d: sumD / n },
    samples,
  };
}
