// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
import assert from "node:assert/strict";
import { test } from "node:test";

import { cvDetectionToLocationFix, radarDetectionToLocationFix, radarDetectionToScene, setSharedAnchor } from "../src/converters";
import { llaToNed, nedToLla } from "../src/geo";
import { MessageEvent } from "../src/lichtblick";
import { DEFAULT_QUICK_PARAMS, computeQuickKpi } from "../src/quickKpi";
import { RadarStore, classifySchema, defaultNavSatRole, detectCarrierNamespace } from "../src/radarData";

const ANCHOR = { lat: 50.8718, lon: 10.7389, alt: 49.78 };

function ev(topic: string, schemaName: string, message: unknown, recv: number): MessageEvent {
  return { topic, schemaName, message, receiveTime: { sec: Math.floor(recv), nsec: Math.round((recv % 1) * 1e9) }, sizeInBytes: 0 };
}

test("classifySchema", () => {
  assert.equal(classifySchema("multi_sensor_msgs/msg/RadarDetection"), "radarDetection");
  assert.equal(classifySchema("eagle_radar/msg/CVDetection"), "cvDetection");
  assert.equal(classifySchema("sensor_msgs/msg/NavSatFix"), "navSat");
  assert.equal(classifySchema("nav_msgs/msg/Odometry", "ground_truth"), "odometryGt");
  assert.equal(classifySchema("nav_msgs/msg/Odometry", "/uav1/mavros/global_position/local"), "unknown");
});

test("carrier namespace and navsat roles", () => {
  const topics = [{ name: "/uav1/radar/echoflight_raw", schemaName: "sensor_msgs/msg/Image" }];
  const ns = detectCarrierNamespace(topics);
  assert.equal(ns, "/uav1");
  assert.equal(defaultNavSatRole("/uav1/mavros/global_position/global", ns), "carrier");
  assert.equal(defaultNavSatRole("/uav248/mavros/global_position/global", ns), "target");
  assert.equal(defaultNavSatRole("/uav248/mavros/global_position/raw/fix", ns), "ignore");
});

/** Builds a carrier flying north-east, a target 700 m away, and radar detections of the target. */
function scenario(): { store: RadarStore; targetAt: (t: number) => { n: number; e: number; d: number } } {
  const store = new RadarStore();
  store.carrierNs = "/uav1";
  const targetAt = (t: number) => ({ n: -4000 + 4 * (t - 1000), e: 5100 + 2 * (t - 1000), d: -1250 });
  let recv = 1.0;
  for (let i = 0; i < 100; i++) {
    const t = 1000 + i;
    const c = { n: -4600 + 6 * i, e: 4850 + 3 * i, d: -1333 };
    const cLla = nedToLla(ANCHOR, c);
    store.ingest(ev("/uav1/mavros/global_position/global", "sensor_msgs/msg/NavSatFix", { header: { stamp: { sec: t, nsec: 0 } }, latitude: cLla.lat, longitude: cLla.lon, altitude: cLla.alt }, recv));
    const g = nedToLla(ANCHOR, targetAt(t));
    store.ingest(ev("/uav248/mavros/global_position/global", "sensor_msgs/msg/NavSatFix", { header: { stamp: { sec: t, nsec: 0 } }, latitude: g.lat, longitude: g.lon, altitude: g.alt }, recv));
    // detection of the target (with 5 m offset error)
    const tg = targetAt(t);
    const rel = [tg.n + 3 - c.n, tg.e + 4 - c.e, tg.d - c.d];
    const range = Math.hypot(rel[0]!, rel[1]!, rel[2]!);
    store.ingest(ev("radarDetection", "multi_sensor_msgs/msg/RadarDetection", {
      timestamp: t + 0.3, origin: [c.n, c.e, c.d], ray_dir: rel.map((x) => x / range), range, power: 4000, confidence: 1, cov: [9, 1e9, 4, 36], radial_vel: 3,
    }, recv));
    recv += 1e-9 * 1000; // log_time in "seconds" quirk: tiny steps
  }
  store.resolve();
  return { store, targetAt };
}

test("RadarStore auto-anchors RadarDetection to the carrier NavSatFix and georeferences detections", () => {
  const { store, targetAt } = scenario();
  const a = store.anchor!;
  assert.equal(a.frame, "NED");
  // detections are stamped 0.3 s after the carrier fix (~1.8 m of motion) -> small bias is expected
  assert.ok(Math.abs(a.lat - ANCHOR.lat) < 3e-5);
  assert.equal(store.detections.length, 100);
  const d = store.detections[50]!;
  const truth = nedToLla(ANCHOR, targetAt(d.t));
  const err = llaToNed(truth, d);
  assert.ok(Math.hypot(err.n, err.e) < 8, `horizontal error ${Math.hypot(err.n, err.e)}`);
});

test("computeQuickKpi: all detections within gate -> Pd 1, CEP ~ 5 m", () => {
  const { store } = scenario();
  const gt = store.primaryGroundTruth()!;
  const k = computeQuickKpi(store.detections, gt, DEFAULT_QUICK_PARAMS)!;
  assert.equal(k.nFalse, 0);
  assert.ok(k.pd > 0.98, `pd ${k.pd}`);
  assert.ok(Math.abs(k.cep50 - 5) < 1.5, `cep50 ${k.cep50}`);
  assert.ok(k.rmse3d < 8);
});

test("computeQuickKpi flags clutter as false alarms", () => {
  const { store } = scenario();
  const gt = store.primaryGroundTruth()!;
  const dets = [...store.detections, { ...store.detections[10]!, lat: store.detections[10]!.lat + 0.01, t: store.detections[10]!.t }];
  const k = computeQuickKpi(dets, gt)!;
  assert.equal(k.nFalse, 1);
});

test("payloadTimeAt maps the seconds-quirk playback clock to payload time", () => {
  const { store } = scenario();
  const recvMid = store.clockRecv[Math.floor(store.clockRecv.length / 2)]!;
  const t = store.payloadTimeAt(recvMid);
  assert.ok(t > 1040 && t < 1060);
});

test("converters", () => {
  const cv = cvDetectionToLocationFix(
    { header: { stamp: { sec: 5, nsec: 6 }, frame_id: "x" }, latitude: 1, longitude: 2, altitude: 3, position_covariance: [1, 0, 0, 0, 1, 0, 0, 0, 1], position_covariance_type: 2 },
    ev("t", "eagle_radar/msg/CVDetection", {}, 1) as MessageEvent<unknown>,
  ) as { latitude: number; timestamp: { sec: number } };
  assert.equal(cv.latitude, 1);
  assert.equal(cv.timestamp.sec, 5);

  const det = { timestamp: 10.5, origin: [100, 200, -50], ray_dir: [1, 0, 0], range: 10, power: 100, cov: [4, 0, 0, 0] };
  setSharedAnchor(undefined);
  assert.equal(radarDetectionToLocationFix(det, ev("d", "x", det, 1)), undefined);
  setSharedAnchor({ ...ANCHOR, frame: "NED", source: "manual" });
  const fix = radarDetectionToLocationFix(det, ev("d", "x", det, 1)) as { latitude: number };
  assert.ok(Math.abs(fix.latitude - nedToLla(ANCHOR, { n: 110, e: 200, d: -50 }).lat) < 1e-9);
  const scene = radarDetectionToScene(det, ev("d", "x", det, 1)) as { entities: { spheres: { pose: { position: { x: number; y: number; z: number } } }[] }[] };
  const p = scene.entities[0]!.spheres[0]!.pose.position;
  assert.deepEqual([p.x, p.y, p.z], [200, 110, 50]); // NED -> ENU
});
