#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
# Integration smoke test of a running stack:  scripts/smoke.sh [base_url]
set -euo pipefail
BASE="${1:-http://localhost:8080}"
fail() { echo "FAIL: $*" >&2; exit 1; }

[[ "$(curl -fsS "$BASE/kpi/health")" == *'"status":"ok"'* ]] || fail "kpi health"
index=$(curl -fsS "$BASE/")
[[ "$index" == *"<title>Eagle Radar Analysis</title>"* ]] || fail "branding"
[[ "$index" == *"eagle-radar.RadarMap"* ]] || fail "default layout not injected"
[[ "$(curl -fsS "$BASE/radar-extension/manifest.json")" == *eagle-radar* ]] || fail "extension manifest"
curl -fsS "$BASE/radar-extension/extension.js" -o /dev/null || fail "extension bundle"

runs=$(curl -fsS "$BASE/kpi/runs")
n=$(python3 -c 'import json,sys; print(len(json.loads(sys.argv[1])))' "$runs")
echo "runs in catalogue: $n"
if [[ "$n" -gt 0 ]]; then
  read -r id url < <(python3 -c 'import json,sys; r=[x for x in json.loads(sys.argv[1]) if x["has_detections"]][0]; print(r["id"], r["data_url"])' "$runs")
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-99' "$BASE$url")
  [[ "$code" == "206" ]] || fail "data server range request returned $code"
  curl -fsS "$BASE/kpi/runs/$id/kpi" | python3 -c 'import json,sys; k=json.load(sys.stdin); assert k["detection"]["count"]>0; print("kpi mode:", k["mode"], "Pd:", k["detection"].get("pd"))'
  [[ "$(curl -fsS "$BASE/kpi/runs/$id/report.html")" == *"Radar KPI report"* ]] || fail "report"
fi
echo "smoke OK"
