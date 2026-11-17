# Message contract

_Author: Giovanni Viglialoro._

Primary contract: `eagle_radar_msgs` (`/home/gio/bags/eagle_radar_msgs`)

| Message | Use |
| --- | --- |
| `CVDetection` | NavSatFix-style lat/lon/alt + ENU covariance + `object_id`/`state`/velocity. Empty `object_id` = detection, set = track. Converted to `foxglove.LocationFix` for the Map panel |
| `TrackArray` / `Track`, `DetectionArray` / `Detection` | local x/y (assumed NED) tracks/detections |
| `TrackKpiStatus` | per-track SNR, consistency, confidence, covariance |
| `RvMapHealth` | RV-map validity, age, saturation, timeouts |
| `RadarStatus`, `NodeStatus` | status strip in the RV-map panel |
| `GeoRegRVMap`, `RVMap` | range-velocity heatmap |

Adapters for the existing bag schemas:

| Schema | Notes |
| --- | --- |
| `multi_sensor_msgs/RadarDetection` | `origin + range·ray_dir` in the radar-local NED frame; georeferenced via the carrier NavSatFix |
| `ground_truth` `nav_msgs/Odometry` | used only when non-zero; all-zero data is ignored (as in `detectionsAndGT.bag`) |
| `sensor_msgs/NavSatFix` | carrier = topics under the namespace of the raw radar topics (or named `carrier/platform/ego/radar` in geo-native bags); remaining NavSatFix topics are ground-truth candidates |

## Verification status

| Item | Status |
| --- | --- |
| `GeoRegRVMap.rvmap` layout | **Verified on real data** (uint32, `nVelocities` rows × `nRanges` columns, index `v*nRanges + r`; range bin = `range/dr`, velocity bin = `zero_doppler_bin + v/dv`). Evidence: neighbour correlation along both axes and stacking of the matrix around detections in real bags; the producer code agrees. The panel defaults to velocity-major; the toggle remains for other producers. Not verified: the float `RVMap` of `eagle_radar` (assumed to use the same layout) |
| ROS package name | `eagle_radar` (schema names `eagle_radar/msg/...`), not `eagle_radar_msgs` |
| `Track` / `Detection` x/y frame | **Not knowable from the message** and no real bag contains them. Two incompatible definitions share these names: the `id,x,y,vx,vy,status` variant (frame `radar_frame`, unspecified) and the EagleRadar-repo variant (`track_id`, `position[3]` NED, polar `Detection` that cannot be georeferenced). Instead of assuming NED, the x/y frame is **resolved against the ground truth**: hypotheses NED, ENU, PLATFORM_NED, PLATFORM_ENU (platform = relative to the radar carrier at time t); the one with the smallest median horizontal error wins, and it is reported as confident only when it beats the runner-up by 30 %. Without ground truth, x/y data stays unplaced (map panel) / unscored (KPIs) unless the axes are set manually in the Radar Map settings. If no anchor exists the carrier's first fix is used (`anchor source: carrier_first_fix`) |
| `eagle_radar` messages on real data | **No readable bag contains them.** They are tested only on synthetic bags (`python -m radar_kpi.sim`) and on a contract bag derived from real data (`python -m radar_kpi.export_cv --check` rebuilds `CVDetection` from a real bag and confirms that the KPIs equal those of the native path) |
| Track and RV-health numbers | Track KPIs are verified only on synthetic bags. RV health is, for real bags without `RvMapHealth`, **derived from the frames** (period, gaps/timeouts = gap > max(5 × median, 100 ms), peak and mean level). The dashboard labels the source. Saturation is not derivable and is shown as "n/a" |
| `log_time` in seconds | Handled, see below |

### Playback clock of processed bags

Processed bags store seconds (integers) in `log_time`, so Lichtblick shows 1970. The panels already use payload
timestamps, but the transport clock is Lichtblick's. The Run browser therefore offers **Fix time + open** for such runs:
`radar-kpi` writes a copy of the bag with `log_time` re-derived from payload stamps (`Header.stamp`, or the leading
`float64` time of `GeoRegRVMap`/`RadarDetection`/...; fallback `log_time × 1e9`) into the cache volume. `data-server`
serves it at `/data/fixed/<run-id>.mcap`. The original is never modified. API: `GET/POST /kpi/runs/{id}/timefix`.
