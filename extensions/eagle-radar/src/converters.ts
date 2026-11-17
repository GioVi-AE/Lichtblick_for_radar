// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
// Message converters: Eagle radar schemas -> Foxglove schemas understood by the stock Map and 3D panels.

import { Anchor, localToLla } from "./georef";
import { ExtensionContext, MessageEvent } from "./lichtblick";

/** Anchor shared between panels and the (stateless-API) converters. */
let sharedAnchor: Anchor | undefined;
export function setSharedAnchor(a: Anchor | undefined): void {
  sharedAnchor = a;
}
export function getSharedAnchor(): Anchor | undefined {
  return sharedAnchor;
}

interface Stamp {
  sec: number;
  nsec: number;
}

function toStamp(seconds: number): Stamp {
  const sec = Math.floor(seconds);
  return { sec, nsec: Math.round((seconds - sec) * 1e9) };
}

function powerColor(power: number | undefined): { r: number; g: number; b: number; a: number } {
  // log-scaled power -> blue..red
  const db = power && power > 0 ? 10 * Math.log10(power) : 0;
  const f = Math.max(0, Math.min(1, (db - 20) / 30));
  return { r: f, g: 0.3 * (1 - Math.abs(f - 0.5) * 2) + 0.2, b: 1 - f, a: 0.95 };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export function cvDetectionToLocationFix(msg: any, event: MessageEvent<any>): unknown {
  const ts = msg.header?.stamp ?? event.receiveTime;
  return {
    timestamp: { sec: ts.sec, nsec: ts.nsec },
    frame_id: msg.header?.frame_id ?? "",
    latitude: msg.latitude,
    longitude: msg.longitude,
    altitude: msg.altitude,
    position_covariance: Array.from(msg.position_covariance ?? new Array(9).fill(0)),
    position_covariance_type: msg.position_covariance_type ?? 0,
  };
}

export function radarDetectionToLocationFix(msg: any, event: MessageEvent<any>): unknown {
  if (!sharedAnchor || !msg.origin || !msg.ray_dir) return undefined;
  const lla = localToLla(
    sharedAnchor,
    msg.origin[0] + msg.range * msg.ray_dir[0],
    msg.origin[1] + msg.range * msg.ray_dir[1],
    msg.origin[2] + msg.range * msg.ray_dir[2],
  );
  const ts = msg.timestamp ? toStamp(Number(msg.timestamp)) : event.receiveTime;
  const sigmaR = Math.sqrt(Math.max(0, msg.cov?.[0] ?? 0));
  return {
    timestamp: ts,
    frame_id: "radar_world",
    latitude: lla.lat,
    longitude: lla.lon,
    altitude: lla.alt,
    position_covariance: [sigmaR ** 2, 0, 0, 0, sigmaR ** 2, 0, 0, 0, sigmaR ** 2],
    position_covariance_type: sigmaR > 0 ? 2 : 0,
  };
}

const IDENTITY_Q = { x: 0, y: 0, z: 0, w: 1 };

/** NED (x=N, y=E, z=Down) -> ENU (x=E, y=N, z=Up) for the 3D panel. */
function nedToEnu(x: number, y: number, z: number): { x: number; y: number; z: number } {
  return { x: y, y: x, z: -z };
}

export function radarDetectionToScene(msg: any, event: MessageEvent<any>): unknown {
  if (!msg.origin || !msg.ray_dir) return undefined;
  const p = nedToEnu(
    msg.origin[0] + msg.range * msg.ray_dir[0],
    msg.origin[1] + msg.range * msg.ray_dir[1],
    msg.origin[2] + msg.range * msg.ray_dir[2],
  );
  const o = nedToEnu(msg.origin[0], msg.origin[1], msg.origin[2]);
  const ts = msg.timestamp ? toStamp(Number(msg.timestamp)) : event.receiveTime;
  return {
    deletions: [],
    entities: [
      {
        timestamp: ts,
        frame_id: "radar_world",
        id: `det-${event.topic}`,
        lifetime: { sec: 0, nsec: 500_000_000 },
        frame_locked: false,
        metadata: [],
        arrows: [],
        cubes: [],
        cylinders: [],
        models: [],
        triangles: [],
        texts: [],
        lines: [
          {
            type: 0,
            pose: { position: { x: 0, y: 0, z: 0 }, orientation: IDENTITY_Q },
            thickness: 1,
            scale_invariant: true,
            points: [o, p],
            color: { r: 0.6, g: 0.6, b: 0.6, a: 0.4 },
            colors: [],
            indices: [],
          },
        ],
        spheres: [
          {
            pose: { position: p, orientation: IDENTITY_Q },
            size: { x: 12, y: 12, z: 12 },
            color: powerColor(msg.power),
          },
        ],
      },
    ],
  };
}

export function trackArrayToScene(msg: any, event: MessageEvent<any>): unknown {
  const ts = msg.header?.stamp ?? event.receiveTime;
  const tracks: any[] = msg.tracks ?? [];
  return {
    deletions: [],
    entities: [
      {
        timestamp: { sec: ts.sec, nsec: ts.nsec },
        frame_id: "radar_world",
        id: `tracks-${event.topic}`,
        lifetime: { sec: 1, nsec: 0 },
        frame_locked: false,
        metadata: [],
        arrows: [],
        cubes: [],
        cylinders: [],
        models: [],
        triangles: [],
        lines: [],
        spheres: tracks.map((t) => ({
          pose: { position: nedToEnu(t.x, t.y, 0), orientation: IDENTITY_Q },
          size: { x: 20, y: 20, z: 20 },
          color: { r: 0.1, g: 0.9, b: 0.3, a: 0.9 },
        })),
        texts: tracks.map((t) => ({
          pose: { position: nedToEnu(t.x, t.y, 0), orientation: IDENTITY_Q },
          billboard: true,
          font_size: 14,
          scale_invariant: true,
          color: { r: 1, g: 1, b: 1, a: 1 },
          text: `#${t.id} ${t.status ?? ""}`,
        })),
      },
    ],
  };
}

export function registerConverters(ctx: ExtensionContext): void {
  const radarDetSchemas = [
    "multi_sensor_msgs/msg/RadarDetection",
    "eagle_radar/msg/RadarDetection",
    "eagle_radar/msg/RadarMeasurement",
  ];
  ctx.registerMessageConverter({
    fromSchemaName: "eagle_radar/msg/CVDetection",
    toSchemaName: "foxglove.LocationFix",
    converter: cvDetectionToLocationFix,
  });
  for (const s of radarDetSchemas) {
    ctx.registerMessageConverter({ fromSchemaName: s, toSchemaName: "foxglove.LocationFix", converter: radarDetectionToLocationFix });
    ctx.registerMessageConverter({ fromSchemaName: s, toSchemaName: "foxglove.SceneUpdate", converter: radarDetectionToScene });
  }
  ctx.registerMessageConverter({
    fromSchemaName: "eagle_radar/msg/TrackArray",
    toSchemaName: "foxglove.SceneUpdate",
    converter: trackArrayToScene,
  });
}

