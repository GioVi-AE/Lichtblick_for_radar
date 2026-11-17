// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
import assert from "node:assert/strict";
import { test } from "node:test";

import { RadarStore } from "../src/radarData";
import { TimedTrack, XY_FRAMES, selectXyFrame, xyToNed } from "../src/georef";
import { llaToNed, nedToLla } from "../src/geo";

const A0 = { lat: 50.8717, lon: 10.7378, alt: 300 };

function scenario(frame: (typeof XY_FRAMES)[number]) {
  const carrier = new TimedTrack();
  const gt = new TimedTrack();
  const samples: { t: number; x: number; y: number; z: number }[] = [];
  for (let k = 0; k <= 600; k++) {
    const t = k * 0.1;
    const c = { n: 2 * t, e: 0.8 * t, d: -50 };
    const rel = { n: 600 + 150 * Math.sin(t / 8), e: 120 * (1 - Math.cos(t / 8)), d: -80 };
    const world = { n: c.n + rel.n, e: c.e + rel.e, d: c.d + rel.d };
    carrier.push({ t, ...nedToLla(A0, c) });
    gt.push({ t, ...nedToLla(A0, world) });
    const src = frame.startsWith("PLATFORM") ? rel : world;
    const isNed = frame.endsWith("NED");
    samples.push({ t, x: isNed ? src.n : src.e, y: isNed ? src.e : src.n, z: 0 });
  }
  return { carrier, gt, samples };
}

for (const frame of XY_FRAMES) {
  test(`selectXyFrame recovers ${frame} from ground truth`, () => {
    const { carrier, gt, samples } = scenario(frame);
    const sel = selectXyFrame(samples, A0, carrier, [gt]);
    assert.equal(sel?.selected, frame);
    assert.ok(sel?.confident);
    // and the conversion lands on the ground truth
    const g = llaToNed(A0, gt.at(30)!);
    const n = xyToNed(frame, A0, samples[300]!, carrier)!;
    assert.ok(Math.hypot(n.n - g.n, n.e - g.e) < 0.01);
  });
}

test("RadarStore holds bare x/y until the frame is decided, then georeferences them", () => {
  const { carrier, gt, samples } = scenario("PLATFORM_ENU");
  const store = new RadarStore();
  store.carrierNs = "/carrier";
  for (let i = 0; i < carrier.length; i++) {
    store.ingest({ topic: "/carrier/mavros/global_position/global", schemaName: "sensor_msgs/msg/NavSatFix", receiveTime: { sec: 0, nsec: 0 }, message: { header: { stamp: { sec: Math.floor(carrier.t[i]!), nsec: Math.round((carrier.t[i]! % 1) * 1e9) } }, latitude: carrier.lat[i], longitude: carrier.lon[i], altitude: carrier.alt[i] } } as never);
  }
  for (const s of samples) {
    store.ingest({ topic: "/rv/detections", schemaName: "eagle_radar/msg/DetectionArray", receiveTime: { sec: 0, nsec: 0 }, message: { header: { stamp: { sec: Math.floor(s.t), nsec: Math.round((s.t % 1) * 1e9) } }, detections: [{ x: s.x, y: s.y, amplitude: 1 }] } } as never);
  }
  store.resolve();
  assert.equal(store.detections.length, 0);
  assert.ok(store.pendingXy > 0);
  for (let i = 0; i < gt.length; i++) {
    store.targetSvc.push({ t: gt.t[i]!, lat: gt.lat[i]!, lon: gt.lon[i]!, alt: gt.alt[i]! });
  }
  store.resolve();
  assert.equal(store.xyInfo?.frame, "PLATFORM_ENU");
  assert.equal(store.detections.length, samples.length);
  assert.equal(store.pendingXy, 0);
});
