# Message contract

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

Unverified assumptions (no bag with these messages exists yet): the index order of `GeoRegRVMap` data (the panel has a
range-major toggle), and that `TrackArray` x/y is NED.
