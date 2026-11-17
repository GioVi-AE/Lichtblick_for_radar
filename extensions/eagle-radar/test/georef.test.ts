// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
import assert from "node:assert/strict";
import { test } from "node:test";

import { llaToNed, nedToLla } from "../src/geo";
import { TimedTrack, estimateAnchor, localToLla } from "../src/georef";

const ANCHOR = { lat: 50.8718, lon: 10.7389, alt: 49.78 };

test("llaToNed / nedToLla round-trip", () => {
  const p = { lat: 50.83, lon: 10.8, alt: 1380 };
  const back = nedToLla(ANCHOR, llaToNed(ANCHOR, p));
  assert.ok(Math.abs(back.lat - p.lat) < 1e-9);
  assert.ok(Math.abs(back.lon - p.lon) < 1e-9);
  assert.ok(Math.abs(back.alt - p.alt) < 1e-6);
});

test("1 degree of latitude is ~111 km north", () => {
  const v = llaToNed({ lat: 50, lon: 10, alt: 0 }, { lat: 51, lon: 10, alt: 0 });
  assert.ok(Math.abs(v.n - 111_230) < 600);
  assert.ok(Math.abs(v.e) < 1e-6);
});

function syntheticCarrier(): { carrier: TimedTrack; local: { t: number; x: number; y: number; z: number }[] } {
  const carrier = new TimedTrack();
  const local = [];
  for (let i = 0; i < 200; i++) {
    const t = 1000 + i;
    // carrier flies a curve in NED about the anchor
    const n = -4600 + 6 * i + 40 * Math.sin(i / 15);
    const e = 4850 + 3 * i - 30 * Math.cos(i / 20);
    const d = -1333 + 0.1 * i;
    const lla = nedToLla(ANCHOR, { n, e, d });
    carrier.push({ t, ...lla });
    local.push({ t, x: n, y: e, z: d });
  }
  return { carrier, local };
}

test("estimateAnchor recovers NED anchor from carrier track", () => {
  const { carrier, local } = syntheticCarrier();
  const a = estimateAnchor(local, carrier)!;
  assert.equal(a.frame, "NED");
  assert.ok(Math.abs(a.lat - ANCHOR.lat) < 1e-6, `lat ${a.lat}`);
  assert.ok(Math.abs(a.lon - ANCHOR.lon) < 1e-6, `lon ${a.lon}`);
  assert.ok(Math.abs(a.alt - ANCHOR.alt) < 0.01, `alt ${a.alt}`);
  assert.ok((a.residualStd ?? 99) < 0.01);
});

test("estimateAnchor distinguishes ENU local frames", () => {
  const { carrier, local } = syntheticCarrier();
  const enu = local.map((s) => ({ t: s.t, x: s.y, y: s.x, z: -s.z }));
  const a = estimateAnchor(enu, carrier)!;
  assert.equal(a.frame, "ENU");
  assert.ok(Math.abs(a.lat - ANCHOR.lat) < 1e-6);
  const p = localToLla(a, enu[10]!.x, enu[10]!.y, enu[10]!.z);
  assert.ok(Math.abs(p.lat - carrier.lat[10]!) < 1e-7);
});

test("TimedTrack interpolates and refuses large gaps", () => {
  const tr = new TimedTrack();
  tr.push({ t: 0, lat: 0, lon: 0, alt: 0 });
  tr.push({ t: 10, lat: 1, lon: 2, alt: 4 });
  const mid = tr.at(5)!;
  assert.deepEqual([mid.lat, mid.lon, mid.alt], [0.5, 1, 2]);
  tr.push({ t: 100, lat: 3, lon: 3, alt: 3 });
  assert.equal(tr.at(50, 5), undefined);
});
