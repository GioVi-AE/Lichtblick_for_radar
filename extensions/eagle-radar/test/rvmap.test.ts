// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
import assert from "node:assert/strict";
import { test } from "node:test";

import { binVelocity, percentileOf, rvIndex, toRvFrame } from "../src/panels/rvMap";

test("toRvFrame decodes GeoRegRVMap and rejects inconsistent sizes", () => {
  const ok = toRvFrame("multi_sensor_msgs/msg/GeoRegRVMap", {
    nranges: 4, nvelocities: 2, rvmap: new Uint32Array(8), dr: 3.25, dv: 0.43, zero_doppler_bin: 1, beam_az: 1, beam_el: 2, trig_ms: 5, status: 0, search_fps: 0,
  });
  assert.ok(ok);
  assert.equal(ok!.nR, 4);
  assert.equal(toRvFrame("multi_sensor_msgs/msg/GeoRegRVMap", { nranges: 4, nvelocities: 3, rvmap: new Uint32Array(8) }), undefined);
});

test("toRvFrame decodes eagle_radar RVMap", () => {
  const f = toRvFrame("eagle_radar/msg/RVMap", { n_ranges: 2, n_velocities: 3, data: new Float32Array(6), dr: 1, dv: 1, zero_doppler_bin: 1 });
  assert.equal(f?.nV, 3);
});

test("percentileOf", () => {
  assert.equal(percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 6);
});

test("default layout is velocity-major (rows = velocity bins), as verified on real GeoRegRVMap data", () => {
  // A target at range bin 5 / velocity bin 3 in a 10-range x 4-velocity map stored row-major by velocity.
  const nR = 10, nV = 4, values = new Uint32Array(nR * nV);
  values[3 * nR + 5] = 99;
  assert.equal(values[rvIndex(false, nR, nV, 5, 3)], 99);
  assert.notEqual(values[rvIndex(true, nR, nV, 5, 3)], 99);
  assert.equal(binVelocity({ dv: 0.5, zeroDoppler: 2 }, 3), 0.5);
});
