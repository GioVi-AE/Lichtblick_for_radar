# KPI definitions

Implemented identically in `services/radar-kpi/radar_kpi/kpi.py` (full, whole bag) and
`extensions/eagle-radar/src/quickKpi.ts` (live, browser-side, grows with playback).

| KPI | Definition |
| --- | --- |
| Association | A detection is **true** if its 3-D distance to the time-interpolated ground truth ≤ `gate_m` (default **150 m**), otherwise **false** (only evaluated where GT exists, GT gaps > 5 s are invalid) |
| Pd | Fraction of `bin_s` bins (default 1 s) inside the detection/GT overlap that contain ≥ 1 true detection |
| False alarms / min | false detections ÷ overlap minutes |
| CEP50 / CEP95 | median / 95th percentile of the horizontal error of true detections |
| Range / azimuth / elevation error | detection minus ground-truth line of sight seen from the radar platform (needs the carrier position) |
| Radial-velocity error | folded by the ambiguity interval; the sign convention is selected automatically |
| Time to first detection, longest miss | from the start of the GT/detection overlap |
| Time offset | lag `τ` minimising the median 3-D error of detections against GT(t+τ), search ±8 s. Reported always, applied only with `auto_offset=true`; a warning is raised if the lag is ≥ 0.3 s and improves the error by > 20 % |
| Tracks | count, mean length, confirmed ratio, continuity, fragmentations (gap > 3 s), ID switches, NEES consistency (χ²₃ 95 % = 7.8147) |
| RV-map health | frames, saturated frames, timeouts, max age from `RvMapHealth` |

**Choosing the gate.** The gate is an association radius, not a requirement. With real data from the UKI series the
detections have CEP95 ≈ 90–125 m, so a 100 m gate counts genuine target detections as false alarms. Always report the
gate with the numbers; the report and the dashboard do.

**Ground-truth caveats.** NavSatFix GT is GPS-grade (metres); time-stamps of detections and GPS can be offset by
seconds, hence the time-offset estimator. Pd is bin-based, so it is sensitive to `bin_s`.
