// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
// Normalisation of the supported Eagle radar schemas into a common, georeferenced model.
//
// Supported inputs
//   eagle_radar/msg/CVDetection            lat/lon/alt (+ENU cov, object_id, confidence, state)
//   eagle_radar/msg/TrackArray             local x/y (+vx,vy)
//   eagle_radar/msg/GeoTrack               local position[3], track_id
//   eagle_radar/msg/DetectionArray         local x/y
//   eagle_radar/msg/GroundTruth            local NED position[3]
//   multi_sensor_msgs|eagle_radar /RadarDetection|RadarMeasurement   origin + range * ray_dir (local NED)
//   sensor_msgs/NavSatFix                  carrier (radar platform) and target (ground truth)
//   nav_msgs/Odometry named ground_truth   local position (ignored while it is all zeros)

import { Lla } from "./geo";
import { Anchor, LocalSample, TimedTrack, estimateAnchor, localToLla } from "./georef";
import { MessageEvent, Time } from "./lichtblick";

export type Role = "carrier" | "target" | "ignore";

export type SourceKind = "radarDetection" | "cvDetection" | "trackArray" | "geoTrack" | "detectionArray" | "groundTruth" | "navSat" | "odometryGt" | "unknown";

export function shortSchema(name: string): string {
  return name.replace("/msg/", "/");
}

export function classifySchema(schemaName: string, topic = ""): SourceKind {
  const s = shortSchema(schemaName);
  if (/(^|\/)(RadarDetection|RadarMeasurement)$/.test(s)) return "radarDetection";
  if (/(^|\/)CVDetection$/.test(s)) return "cvDetection";
  if (/(^|\/)TrackArray$/.test(s)) return "trackArray";
  if (/(^|\/)GeoTrack$/.test(s)) return "geoTrack";
  if (/(^|\/)DetectionArray$/.test(s)) return "detectionArray";
  if (/(^|\/)GroundTruth$/.test(s)) return "groundTruth";
  if (s === "sensor_msgs/NavSatFix" || s === "foxglove.LocationFix") return "navSat";
  if (s === "nav_msgs/Odometry" && /ground_?truth|(^|\/)gt($|\/)/i.test(topic)) return "odometryGt";
  return "unknown";
}

export function timeToSec(t: Time | undefined): number {
  return t ? t.sec + t.nsec * 1e-9 : 0;
}

export interface GeoDet {
  /** Payload timestamp, seconds (epoch). */
  t: number;
  /** Receive (log) time in seconds - same clock as the playback cursor. */
  recv: number;
  lat: number;
  lon: number;
  alt: number;
  range?: number;
  power?: number;
  confidence?: number;
  radialVel?: number;
  /** Radar platform position (if known) when the detection was made. */
  platform?: Lla;
  topic: string;
}

export interface TrackPoint {
  t: number;
  recv: number;
  lat: number;
  lon: number;
  alt: number;
  /** 3x3 ENU position covariance, row-major (CVDetection). */
  cov?: number[];
  state?: string;
}

export interface TrackSeries {
  key: string;
  id: string;
  topic: string;
  points: TrackPoint[];
}

interface PendingLocal {
  kind: "det" | "track" | "gt";
  x: number;
  y: number;
  z: number;
  t: number;
  recv: number;
  topic: string;
  id?: string;
  range?: number;
  power?: number;
  confidence?: number;
  radialVel?: number;
  platform?: [number, number, number];
}

export interface RoleMap {
  [topic: string]: Role;
}

export interface StoreStats {
  detections: number;
  tracks: number;
  carrierPoints: number;
  targetPoints: number;
  pendingLocal: number;
  anchor?: Anchor;
}

/** Picks the radar carrier namespace from the topic list ("/uav1/radar/echoflight_raw" -> "/uav1"). */
export function detectCarrierNamespace(topics: readonly { name: string; schemaName: string }[]): string | undefined {
  const raw = topics.find((t) => /\/radar\//.test(t.name) || /echoflight/.test(t.name));
  if (!raw) return undefined;
  const m = /^(\/[^/]+)\//.exec(raw.name);
  return m ? m[1] : undefined;
}

/** Default role for a NavSatFix topic. */
export function defaultNavSatRole(topic: string, carrierNs: string | undefined): Role {
  // Prefer filtered global position; skip the raw GNSS duplicate topics.
  if (/\/raw\/fix$/.test(topic)) return "ignore";
  if (carrierNs && topic.startsWith(carrierNs + "/")) return "carrier";
  return "target";
}

export class RadarStore {
  readonly carrier = new TimedTrack();
  readonly targets = new Map<string, TimedTrack>();
  readonly detections: GeoDet[] = [];
  readonly tracks = new Map<string, TrackSeries>();
  readonly gtTracks = new Map<string, TrackSeries>();

  /** Tracks supplied by the radar-kpi service (paired raw bag) for runs whose own bag lacks them. */
  readonly carrierSvc = new TimedTrack();
  readonly targetSvc = new TimedTrack();
  /** recv-time -> payload-time map, used to align the playback cursor with payload timestamps. */
  readonly clockRecv: number[] = [];
  readonly clockT: number[] = [];

  manualAnchor: Anchor | undefined;
  serviceAnchor: Anchor | undefined;
  private autoAnchor: Anchor | undefined;
  private platformLocal: LocalSample[] = [];
  private pending: PendingLocal[] = [];
  private pendingAnchorKey = "";
  roles: RoleMap = {};
  carrierNs: string | undefined;

  noteClock(recv: number, t: number): void {
    const n = this.clockRecv.length;
    if (n === 0 || recv > this.clockRecv[n - 1]!) {
      this.clockRecv.push(recv);
      this.clockT.push(t);
    }
  }

  /** Payload timestamp corresponding to a playback (receive-time) cursor. */
  payloadTimeAt(recv: number): number {
    const n = this.clockRecv.length;
    if (n === 0) return recv;
    if (recv <= this.clockRecv[0]!) return this.clockT[0]!;
    if (recv >= this.clockRecv[n - 1]!) return this.clockT[n - 1]!;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.clockRecv[mid]! <= recv) lo = mid;
      else hi = mid;
    }
    const f = (recv - this.clockRecv[lo]!) / (this.clockRecv[hi]! - this.clockRecv[lo]!);
    return this.clockT[lo]! + f * (this.clockT[hi]! - this.clockT[lo]!);
  }

  /** Carrier track: own NavSat if present, else the one from the service. */
  effectiveCarrier(): TimedTrack {
    return this.carrier.length > 0 ? this.carrier : this.carrierSvc;
  }

  /** Primary ground-truth track (first non-empty). */
  primaryGroundTruth(): TimedTrack | undefined {
    const all = this.groundTruthTracks();
    return all.find((t) => t.length > 1);
  }

  reset(): void {
    this.carrier.clear();
    this.clockRecv.length = 0;
    this.clockT.length = 0;
    this.targets.clear();
    this.detections.length = 0;
    this.tracks.clear();
    this.gtTracks.clear();
    this.platformLocal = [];
    this.pending = [];
    this.autoAnchor = undefined;
    this.pendingAnchorKey = "";
  }

  get anchor(): Anchor | undefined {
    return this.manualAnchor ?? this.serviceAnchor ?? this.autoAnchor;
  }

  stats(): StoreStats {
    let targetPoints = 0;
    for (const t of this.targets.values()) targetPoints += t.length;
    return {
      detections: this.detections.length,
      tracks: this.tracks.size,
      carrierPoints: this.carrier.length,
      targetPoints,
      pendingLocal: this.pending.length,
      anchor: this.anchor,
    };
  }

  roleFor(topic: string): Role {
    return this.roles[topic] ?? defaultNavSatRole(topic, this.carrierNs);
  }

  ingest(ev: MessageEvent): void {
    const kind = classifySchema(ev.schemaName, ev.topic);
    const recv = timeToSec(ev.receiveTime);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = ev.message as any;
    switch (kind) {
      case "navSat": {
        if (m.status && typeof m.status.status === "number" && m.status.status < 0) return;
        if (!Number.isFinite(m.latitude) || !Number.isFinite(m.longitude)) return;
        const t = m.header?.stamp ? timeToSec(m.header.stamp) : (m.timestamp ? timeToSec(m.timestamp) : recv);
        const p = { t, lat: m.latitude as number, lon: m.longitude as number, alt: (m.altitude as number) ?? 0 };
        const role = this.roleFor(ev.topic);
        if (role === "carrier") {
          this.carrier.push(p);
          this.noteClock(recv, t);
        } else if (role === "target") {
          let tr = this.targets.get(ev.topic);
          if (!tr) this.targets.set(ev.topic, (tr = new TimedTrack()));
          tr.push(p);
        }
        this.invalidateAnchor();
        return;
      }
      case "cvDetection": {
        if (!Number.isFinite(m.latitude)) return;
        const t = timeToSec(m.header?.stamp) || recv;
        this.noteClock(recv, t);
        const cov = m.position_covariance ? Array.from(m.position_covariance as ArrayLike<number>) : undefined;
        const id = String(m.object_id ?? "");
        const pt: TrackPoint = { t, recv, lat: m.latitude, lon: m.longitude, alt: m.altitude ?? 0, cov, state: m.state };
        if (id) {
          const key = `${ev.topic}#${id}`;
          let s = this.tracks.get(key);
          if (!s) this.tracks.set(key, (s = { key, id, topic: ev.topic, points: [] }));
          s.points.push(pt);
        }
        this.detections.push({
          t, recv, lat: m.latitude, lon: m.longitude, alt: m.altitude ?? 0,
          confidence: m.confidence, topic: ev.topic,
        });
        return;
      }
      case "radarDetection": {
        const o = m.origin as ArrayLike<number> | undefined;
        const r = m.ray_dir as ArrayLike<number> | undefined;
        if (!o || !r || !Number.isFinite(m.range)) return;
        const t = m.timestamp ? Number(m.timestamp) : recv;
        const range = m.range as number;
        this.noteClock(recv, t);
        const x = o[0]! + range * r[0]!;
        const y = o[1]! + range * r[1]!;
        const z = o[2]! + range * r[2]!;
        this.platformLocal.push({ t, x: o[0]!, y: o[1]!, z: o[2]! });
        this.pending.push({
          kind: "det", x, y, z, t, recv, topic: ev.topic, range,
          power: m.power, confidence: m.confidence, radialVel: m.radial_vel,
          platform: [o[0]!, o[1]!, o[2]!],
        });
        this.invalidateAnchor();
        return;
      }
      case "detectionArray": {
        const t = timeToSec(m.header?.stamp) || recv;
        for (const d of (m.detections ?? []) as { x: number; y: number; amplitude?: number }[]) {
          this.pending.push({ kind: "det", x: d.x, y: d.y, z: 0, t, recv, topic: ev.topic, power: d.amplitude });
        }
        return;
      }
      case "trackArray": {
        const t = timeToSec(m.header?.stamp) || recv;
        for (const tr of (m.tracks ?? []) as { id: number; x: number; y: number }[]) {
          this.pending.push({ kind: "track", x: tr.x, y: tr.y, z: 0, t, recv, topic: ev.topic, id: String(tr.id) });
        }
        return;
      }
      case "geoTrack": {
        const p = m.position as ArrayLike<number> | undefined;
        if (!p) return;
        this.pending.push({
          kind: "track", x: p[0]!, y: p[1]!, z: p[2]!, t: Number(m.timestamp) || recv, recv,
          topic: ev.topic, id: String(m.track_id),
        });
        return;
      }
      case "groundTruth": {
        const p = m.position as ArrayLike<number> | undefined;
        if (!p) return;
        this.pending.push({
          kind: "gt", x: p[0]!, y: p[1]!, z: p[2]!, t: Number(m.timestamp) || timeToSec(m.stamp) || recv,
          recv, topic: ev.topic, id: String(m.id ?? 0),
        });
        return;
      }
      case "odometryGt": {
        const p = m.pose?.pose?.position as { x: number; y: number; z: number } | undefined;
        if (!p || Math.abs(p.x) + Math.abs(p.y) + Math.abs(p.z) === 0) return;
        this.pending.push({
          kind: "gt", x: p.x, y: p.y, z: p.z, t: timeToSec(m.header?.stamp) || recv, recv, topic: ev.topic, id: "0",
        });
        return;
      }
      default:
        return;
    }
  }

  private invalidateAnchor(): void {
    this.pendingAnchorKey = "";
  }

  /** Georeferences pending local-frame samples. Call after a batch of ingest() calls. */
  resolve(): void {
    if (this.pending.length === 0) return;
    if (!this.manualAnchor && !this.serviceAnchor) {
      const key = `${this.effectiveCarrier().length}:${this.platformLocal.length}`;
      if (key !== this.pendingAnchorKey) {
        this.pendingAnchorKey = key;
        const carrier = this.effectiveCarrier();
        if (carrier.length >= 5 && this.platformLocal.length >= 5) {
          const stride = Math.max(1, Math.floor(this.platformLocal.length / 500));
          const samples = this.platformLocal.filter((_, i) => i % stride === 0);
          this.autoAnchor = estimateAnchor(samples, carrier) ?? this.autoAnchor;
        }
      }
    }
    const anchor = this.anchor;
    if (!anchor) return;
    for (const p of this.pending) {
      const lla = localToLla(anchor, p.x, p.y, p.z);
      if (p.kind === "det") {
        this.detections.push({
          t: p.t, recv: p.recv, ...lla, range: p.range, power: p.power, confidence: p.confidence,
          radialVel: p.radialVel, topic: p.topic,
          platform: p.platform ? localToLla(anchor, p.platform[0], p.platform[1], p.platform[2]) : undefined,
        });
      } else {
        const bag = p.kind === "track" ? this.tracks : this.gtTracks;
        const key = `${p.topic}#${p.id ?? ""}`;
        let s = bag.get(key);
        if (!s) bag.set(key, (s = { key, id: p.id ?? "", topic: p.topic, points: [] }));
        s.points.push({ t: p.t, recv: p.recv, ...lla });
      }
    }
    this.pending = [];
  }

  /** All GT sources merged into time-interpolatable tracks (NavSat target topics + local GT messages). */
  groundTruthTracks(): TimedTrack[] {
    const out: TimedTrack[] = [...this.targets.values()];
    for (const s of this.gtTracks.values()) {
      const tr = new TimedTrack();
      for (const p of s.points) tr.push(p);
      out.push(tr);
    }
    if (out.every((t) => t.length === 0) && this.targetSvc.length > 0) out.push(this.targetSvc);
    return out;
  }
}
