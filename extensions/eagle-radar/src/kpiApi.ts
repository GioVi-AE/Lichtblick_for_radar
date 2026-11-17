// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
// Client for the radar-kpi service (served same-origin under /kpi by the web container).

export interface TopicInfo {
  name: string;
  type: string;
  count: number;
}

export interface RunInfo {
  id: string;
  name: string;
  root: "raw" | "processed" | string;
  /** Path relative to the root, of the primary MCAP file. */
  mcap: string;
  /** Path (under /data) to open with Lichtblick remote-file. */
  data_url: string;
  duration_s: number;
  start_time_s: number | null;
  message_count: number;
  size_bytes: number;
  topics: TopicInfo[];
  has_detections: boolean;
  has_tracks: boolean;
  has_ground_truth: boolean;
  has_carrier: boolean;
  has_rvmap: boolean;
  gt_source: string | null;
  paired_with: string | null;
  log_time_unit: "ns" | "s" | "unknown";
  indexed: boolean;
  bbox: [number, number, number, number] | null; // minLat, minLon, maxLat, maxLon
  notes: string[];
  /** Only for log_time in seconds: state of the nanosecond-time copy (data_url of the copy when done). */
  time_fix?: TimeFixStatus | null;
}

export interface TimeFixStatus {
  state: "none" | "running" | "done" | "error";
  progress?: number;
  url?: string;
  size_bytes?: number;
  error?: string;
}

export type LatLonTrack = [number, number, number, number][]; // t, lat, lon, alt

export interface RunContext {
  run_id: string;
  anchor: { lat: number; lon: number; alt: number; frame: "NED" | "ENU"; residual_std_m: number | null; source: string } | null;
  carrier: LatLonTrack;
  target: LatLonTrack;
  xy_frame?: { selected: string; confident: boolean } | null;
  target_topic: string | null;
  carrier_topic: string | null;
  warnings: string[];
}

export interface ErrStats {
  n: number;
  mean: number;
  rmse: number;
  p50: number;
  p90: number;
  p95: number;
  max: number;
}

export interface KpiResult {
  run_id: string;
  computed_at: string;
  params: { gate_m: number; bin_s: number; max_gt_gap_s: number; time_offset_s?: number; auto_offset?: boolean };
  time_offset?: { lag_s: number; applied_s: number; median_d3_at_lag_m: number; median_d3_at_zero_m: number };
  mode: "ground_truth" | "detection_only";
  warnings: string[];
  sources: Record<string, unknown>;
  timing: { t_start: number | null; t_end: number | null; duration_s: number };
  georef: { frame: string; lat0: number; lon0: number; alt0: number; residual_std_m: number | null; source: string } | null;
  detection: {
    count: number;
    per_minute: number;
    max_gap_s: number;
    range_m: { min: number; max: number; mean: number; p50: number; p95: number } | null;
    power_db: { min: number; max: number; mean: number; p50: number; p95: number } | null;
    with_gt?: number;
    true?: number;
    false?: number;
    false_alarms_per_min?: number;
    pd?: number | null;
    pd_bins?: number;
    pd_bins_detected?: number;
    time_to_first_detection_s?: number | null;
    longest_miss_s?: number | null;
    cep50_m?: number | null;
    cep95_m?: number | null;
    error?: {
      horiz: ErrStats;
      vert: ErrStats;
      d3: ErrStats;
      range: ErrStats;
      az_deg: ErrStats;
      el_deg: ErrStats;
      radial_vel: ErrStats | null;
      bias_ned: [number, number, number];
    };
  };
  by_range: {
    r0: number;
    r1: number;
    n: number;
    n_true: number;
    pd: number | null;
    rmse_horiz: number | null;
    rmse_range: number | null;
    mean_power_db: number | null;
  }[];
  timeline: { t: number; n_det: number; n_true: number; pd: number | null; rmse_horiz: number | null }[];
  tracks: {
    count: number;
    topic: string;
    confirmed_ratio: number | null;
    mean_length_s: number;
    id_switches?: number;
    fragmentations?: number;
    continuity?: number | null;
    rmse_horiz?: number | null;
    nees_consistency?: number | null;
    mean_snr_db?: number | null;
    missed_update_ratio?: number | null;
    xy_frame?: { selected: string; confident: boolean; median_horiz_m: Record<string, number>; source: string; target: string };
  } | null;
  health: {
    /** "RvMapHealth" (reported by the radar) or "derived from RV maps" (measured on the frames, no saturation info) */
    source: string;
    frames: number;
    saturated_frames: number | null;
    timeout_frames: number;
    max_saturation_ratio: number | null;
    max_age_ms: number | null;
    median_period_ms?: number | null;
    p99_period_ms?: number | null;
    peak_median?: number | null;
    peak_max?: number | null;
  } | null;
  samples: { t: number; range: number | null; horiz: number; vert: number; d3: number; az: number | null; el: number | null; ok: boolean; p: number | null }[];
}

export interface KpiClientOptions {
  baseUrl?: string;
}

export function defaultBaseUrl(): string {
  return `${globalThis.location.origin}/kpi`;
}

export class KpiClient {
  readonly baseUrl: string;
  constructor(opts: KpiClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? defaultBaseUrl()).replace(/\/$/, "");
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { signal });
    if (!res.ok) {
      let detail = "";
      try {
        detail = ((await res.json()) as { detail?: string }).detail ?? "";
      } catch {
        /* ignore */
      }
      throw new Error(`KPI service ${res.status}${detail ? ": " + detail : ""}`);
    }
    return (await res.json()) as T;
  }

  health(): Promise<{ status: string; runs: number }> {
    return this.get("/health");
  }
  runs(): Promise<RunInfo[]> {
    return this.get("/runs");
  }
  timeFixStatus(id: string): Promise<TimeFixStatus> {
    return this.get(`/runs/${id}/timefix`);
  }
  async startTimeFix(id: string): Promise<TimeFixStatus> {
    const res = await fetch(`${this.baseUrl}/runs/${id}/timefix`, { method: "POST" });
    if (!res.ok) throw new Error(`KPI service ${res.status}`);
    return (await res.json()) as TimeFixStatus;
  }
  async rescan(): Promise<void> {
    await fetch(`${this.baseUrl}/rescan`, { method: "POST" });
  }
  runByDataUrl(dataUrl: string): Promise<RunInfo> {
    return this.get(`/runs/by-url?url=${encodeURIComponent(dataUrl)}`);
  }
  context(id: string): Promise<RunContext> {
    return this.get(`/runs/${id}/context`);
  }
  kpi(id: string, gateM: number, binS: number, autoOffset: boolean, signal?: AbortSignal): Promise<KpiResult> {
    return this.get(`/runs/${id}/kpi?gate_m=${gateM}&bin_s=${binS}&auto_offset=${autoOffset}`, signal);
  }
  csvUrl(id: string, gateM: number, binS: number, autoOffset: boolean): string {
    return `${this.baseUrl}/runs/${id}/kpi.csv?gate_m=${gateM}&bin_s=${binS}&auto_offset=${autoOffset}`;
  }
  reportUrl(id: string, gateM: number, binS: number, autoOffset: boolean): string {
    return `${this.baseUrl}/runs/${id}/report.html?gate_m=${gateM}&bin_s=${binS}&auto_offset=${autoOffset}`;
  }
}

/** Lichtblick remote-file URL to open a run. */
export function lichtblickOpenUrl(run: RunInfo, dataUrl: string = run.data_url): string {
  const abs = `${globalThis.location.origin}${dataUrl}`;
  return `${globalThis.location.origin}/?ds=remote-file&ds.url=${encodeURIComponent(abs)}`;
}

/** The ds.url of the currently open remote-file source, mapped back to a /data path. */
export function currentDataUrl(): string | undefined {
  try {
    const u = new URL(globalThis.location.href).searchParams.get("ds.url");
    if (!u) return undefined;
    const parsed = new URL(u, globalThis.location.origin);
    return parsed.pathname;
  } catch {
    return undefined;
  }
}
