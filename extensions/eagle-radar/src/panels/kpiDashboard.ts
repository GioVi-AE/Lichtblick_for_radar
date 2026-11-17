// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
// KPI dashboard panel: radar KPIs computed by the radar-kpi service (or quick in-browser KPIs).

import { setSharedAnchor } from "../converters";
import { DataFeed } from "../dataFeed";
import { KpiClient, KpiResult, RunInfo, currentDataUrl } from "../kpiApi";
import { PanelExtensionContext, RenderState } from "../lichtblick";
import { DEFAULT_QUICK_PARAMS, computeQuickKpi } from "../quickKpi";
import { card, chartCanvas, drawChart, fmt, h, pct, rootEl } from "../ui";

interface Config {
  runId?: string;
  gateM: number;
  binS: number;
  autoOffset: boolean;
  source: "service" | "live";
}

export function initKpiDashboard(context: PanelExtensionContext): () => void {
  const cfg: Config = { gateM: DEFAULT_QUICK_PARAMS.gateM, binS: DEFAULT_QUICK_PARAMS.binS, autoOffset: false, source: "service", ...((context.initialState as Partial<Config>) ?? {}) };
  const client = new KpiClient();
  const feed = new DataFeed(context);

  const root = rootEl("dark");
  const runSel = h("select", { style: { maxWidth: "260px" } });
  const gateIn = h("input", { type: "number", value: String(cfg.gateM), min: "1", style: { width: "64px" }, title: "Association gate (m, 3D)" });
  const binIn = h("input", { type: "number", value: String(cfg.binS), min: "0.1", step: "0.5", style: { width: "56px" }, title: "Pd time bin (s)" });
  const offChk = h("input", { type: "checkbox", title: "Estimate and compensate the time lag between detections and ground truth" });
  offChk.checked = cfg.autoOffset;
  const srcSel = h("select", {}, h("option", { value: "service" }, "Service (full)"), h("option", { value: "live" }, "Live (browser)"));
  srcSel.value = cfg.source;
  const status = h("span", { class: "er-muted" });
  const csvLink = h("a", { class: "er-btn", target: "_blank", style: { textDecoration: "none", color: "inherit" } }, "CSV");
  const reportLink = h("a", { class: "er-btn", target: "_blank", style: { textDecoration: "none", color: "inherit" } }, "Report");
  const bar = h("div", { class: "er-bar" }, "Run", runSel, "Gate", gateIn, "m  Bin", binIn, "s", h("label", { class: "er-muted", style: { whiteSpace: "nowrap" } }, offChk, " auto time-sync"), srcSel,
    h("button", { class: "er-btn", onclick: () => void refresh() }, "Compute"), csvLink, reportLink, status);
  const body = h("div", { class: "er-body" });
  root.append(bar, body);
  context.panelElement.append(root);
  context.setDefaultPanelTitle("Radar KPIs");

  let runs: RunInfo[] = [];
  let result: KpiResult | undefined;
  let abort: AbortController | undefined;
  let lastRs: RenderState | undefined;
  let timelineCanvas: HTMLCanvasElement | undefined;
  let dark = true;

  function persist(): void {
    context.saveState({ ...cfg });
  }

  async function loadRuns(): Promise<boolean> {
    let fromUrlMatched = false;
    try {
      runs = await client.runs();
      runSel.innerHTML = "";
      for (const r of runs.filter((x) => x.has_detections || x.has_tracks)) {
        runSel.append(h("option", { value: r.id }, `${r.has_ground_truth ? "● " : "○ "}${r.name}  [${r.root}]`));
      }
      const fromUrl = currentDataUrl();
      if (fromUrl) {
        try {
          const r = await client.runByDataUrl(fromUrl);
          cfg.runId = r.id;
          fromUrlMatched = true;
        } catch {
          /* not in catalog */
        }
      }
      if (cfg.runId) runSel.value = cfg.runId;
      else if (runSel.options.length > 0) cfg.runId = runSel.value;
      status.textContent = `${runs.length} runs`;
    } catch (e) {
      status.textContent = `service unavailable: ${(e as Error).message}`;
      cfg.source = "live";
      srcSel.value = "live";
    }
    return fromUrlMatched;
  }

  async function refresh(): Promise<void> {
    cfg.gateM = Number(gateIn.value) || cfg.gateM;
    cfg.binS = Number(binIn.value) || cfg.binS;
    cfg.autoOffset = offChk.checked;
    cfg.source = srcSel.value as Config["source"];
    cfg.runId = runSel.value || cfg.runId;
    persist();
    if (cfg.source === "live") {
      renderLive();
      return;
    }
    if (!cfg.runId) {
      body.replaceChildren(h("div", { class: "er-muted" }, "No run selected."));
      return;
    }
    abort?.abort();
    abort = new AbortController();
    status.textContent = "computing…";
    body.replaceChildren(h("div", { class: "er-muted", style: { padding: "12px" } }, "Computing KPIs on the service (first run per bag reads the MCAP, later runs are cached)…"));
    try {
      result = await client.kpi(cfg.runId, cfg.gateM, cfg.binS, cfg.autoOffset, abort.signal);
      status.textContent = `computed ${result.computed_at}`;
      csvLink.href = client.csvUrl(cfg.runId, cfg.gateM, cfg.binS, cfg.autoOffset);
      reportLink.href = client.reportUrl(cfg.runId, cfg.gateM, cfg.binS, cfg.autoOffset);
      renderResult(result);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      status.textContent = "";
      body.replaceChildren(h("div", { class: "er-bad", style: { padding: "12px" } }, `KPI computation failed: ${(e as Error).message}`));
    }
  }

  function renderResult(r: KpiResult): void {
    const d = r.detection;
    const gt = r.mode === "ground_truth";
    const kids: (Node | string)[] = [];
    if (r.warnings.length) {
      kids.push(h("div", { class: "er-card er-warn", style: { marginBottom: "8px" } }, ...r.warnings.map((w) => h("div", {}, `⚠ ${w}`))));
    }
    const grid = h("div", { class: "er-grid" });
    grid.append(card("Mode", gt ? "Ground truth" : "Detection only", r.georef ? `georef ${r.georef.frame} (${r.georef.source})` : "no georef"));
    grid.append(card("Detections", String(d.count), `${fmt(d.per_minute, 1)} / min`));
    grid.append(card("Max gap", fmt(d.max_gap_s, 1, " s"), "between detections"));
    if (d.range_m) grid.append(card("Range", `${fmt(d.range_m.p50, 0)} m`, `${fmt(d.range_m.min, 0)} – ${fmt(d.range_m.max, 0)} m`));
    if (d.power_db) grid.append(card("Power", `${fmt(d.power_db.p50, 1)} dB`, `p95 ${fmt(d.power_db.p95, 1)} dB`));
    if (gt) {
      grid.append(card("Pd", pct(d.pd), `${d.pd_bins_detected}/${d.pd_bins} bins`, d.pd != undefined && d.pd >= 0.9 ? "er-good" : d.pd != undefined && d.pd < 0.5 ? "er-bad" : "er-warn"));
      grid.append(card("False alarms", fmt(d.false_alarms_per_min, 1, "/min"), `${d.false} false / ${d.with_gt} with GT`));
      grid.append(card("CEP50", fmt(d.cep50_m, 1, " m"), "horizontal"));
      grid.append(card("CEP95", fmt(d.cep95_m, 1, " m"), "horizontal"));
      if (d.error) {
        grid.append(card("RMSE horiz", fmt(d.error.horiz.rmse, 1, " m"), `bias N/E ${fmt(d.error.bias_ned[0], 1)}/${fmt(d.error.bias_ned[1], 1)} m`));
        grid.append(card("RMSE vert", fmt(d.error.vert.rmse, 1, " m"), `bias D ${fmt(d.error.bias_ned[2], 1)} m`));
        grid.append(card("Range err", fmt(d.error.range.rmse, 1, " m"), `mean ${fmt(d.error.range.mean, 1)} m`));
        grid.append(card("Az err", fmt(d.error.az_deg.rmse, 2, "°"), `mean ${fmt(d.error.az_deg.mean, 2)}°`));
        grid.append(card("El err", fmt(d.error.el_deg.rmse, 2, "°"), `mean ${fmt(d.error.el_deg.mean, 2)}°`));
        if (d.error.radial_vel) grid.append(card("Vr err", fmt(d.error.radial_vel.rmse, 2, " m/s"), "ambiguity folded"));
      }
      if (r.time_offset) {
        grid.append(card("Time offset", `${r.time_offset.lag_s >= 0 ? "+" : ""}${fmt(r.time_offset.lag_s, 2)} s`,
          `applied ${fmt(r.time_offset.applied_s, 2)} s · med. err ${fmt(r.time_offset.median_d3_at_zero_m, 0)}→${fmt(r.time_offset.median_d3_at_lag_m, 0)} m`,
          Math.abs(r.time_offset.lag_s) >= 0.3 ? "er-warn" : "er-good"));
      }
      grid.append(card("First detection", fmt(d.time_to_first_detection_s, 1, " s"), "after GT/radar overlap start"));
      grid.append(card("Longest miss", fmt(d.longest_miss_s, 1, " s"), "no true detection"));
    }
    if (r.tracks) {
      const t = r.tracks;
      grid.append(card("Tracks", String(t.count), `mean ${fmt(t.mean_length_s, 1)} s`));
      grid.append(card("Confirmed", pct(t.confirmed_ratio)));
      if (t.continuity != undefined) grid.append(card("Continuity", pct(t.continuity), `${t.fragmentations ?? 0} frags, ${t.id_switches ?? 0} ID sw.`));
      if (t.nees_consistency != undefined) grid.append(card("NEES ok", pct(t.nees_consistency), "χ² 95 %"));
      if (t.xy_frame) grid.append(card("Track x/y axes", t.xy_frame.selected.replace("_", " "), t.xy_frame.confident ? "chosen by ground truth" : "ambiguous", t.xy_frame.confident ? "er-good" : "er-warn"));
      if (t.mean_snr_db != undefined) grid.append(card("Track SNR", fmt(t.mean_snr_db, 1, " dB")));
    }
    if (r.health) {
      const hl = r.health;
      const derived = hl.source !== "RvMapHealth";
      if (derived) {
        grid.append(card("RV-map rate", hl.median_period_ms ? `${fmt(1000 / hl.median_period_ms, 1, " Hz")}` : "–", `${hl.frames} frames · p99 ${fmt(hl.p99_period_ms, 0, " ms")}`));
        grid.append(card("RV-map gaps", String(hl.timeout_frames), `max gap ${fmt(hl.max_age_ms, 0, " ms")} (> 5× period)`, hl.timeout_frames > 0 ? "er-warn" : "er-good"));
        grid.append(card("RV-map peak", fmt(hl.peak_median, 0), `max ${fmt(hl.peak_max, 0)} · measured, saturation n/a`));
      } else {
        grid.append(card("RV-map sat.", `${hl.saturated_frames}/${hl.frames}`, `max ${pct(hl.max_saturation_ratio)}`, (hl.saturated_frames ?? 0) > 0 ? "er-warn" : "er-good"));
        grid.append(card("RV-map timeouts", String(hl.timeout_frames), `max age ${fmt(hl.max_age_ms, 0, " ms")}`, hl.timeout_frames > 0 ? "er-bad" : "er-good"));
      }
    }
    kids.push(grid);

    // charts
    const s = r.samples;
    if (gt && s.length > 0) {
      const c1 = chartCanvas();
      const c2 = chartCanvas();
      kids.push(c1, c2);
      const ok = s.filter((x) => x.ok && x.range != undefined);
      requestAnimationFrame(() => {
        drawChart(c1, [
          { name: "horizontal", color: "#4cc2ff", x: ok.map((x) => x.range!), y: ok.map((x) => x.horiz), kind: "scatter" },
          { name: "vertical", color: "#fbbf24", x: ok.map((x) => x.range!), y: ok.map((x) => Math.abs(x.vert)), kind: "scatter" },
        ], { title: "Position error vs range (true detections)", xLabel: "range [m]", yLabel: "error [m]", yMin: 0 });
        const br = r.by_range.filter((b) => b.n > 0);
        drawChart(c2, [
          { name: "Pd", color: "#4ade80", x: br.map((b) => (b.r0 + b.r1) / 2), y: br.map((b) => b.pd), kind: "bar" },
        ], { title: "Probability of detection vs range", xLabel: "range [m]", yLabel: "Pd", yMin: 0, yMax: 1 });
      });
    }
    if (s.length > 0) {
      const c4 = chartCanvas();
      kids.push(c4);
      const withP = s.filter((x) => x.p != undefined && x.range != undefined);
      requestAnimationFrame(() => {
        drawChart(c4, [
          { name: "true", color: "#4ade80", x: withP.filter((x) => x.ok).map((x) => x.range!), y: withP.filter((x) => x.ok).map((x) => x.p!), kind: "scatter" },
          { name: "false/other", color: "#f87171", x: withP.filter((x) => !x.ok).map((x) => x.range!), y: withP.filter((x) => !x.ok).map((x) => x.p!), kind: "scatter" },
        ], { title: "Detection power vs range", xLabel: "range [m]", yLabel: "power [dB]" });
      });
    }
    if (r.timeline.length > 0) {
      const c5 = chartCanvas();
      timelineCanvas = c5;
      kids.push(c5);
      requestAnimationFrame(() => drawTimeline());
    }

    // by-range table
    if (r.by_range.length > 0) {
      const rows = r.by_range.filter((b) => b.n > 0).map((b) =>
        h("tr", {}, h("td", {}, `${b.r0.toFixed(0)}–${b.r1.toFixed(0)}`), h("td", {}, String(b.n)), h("td", {}, String(b.n_true)),
          h("td", {}, pct(b.pd)), h("td", {}, fmt(b.rmse_horiz, 1)), h("td", {}, fmt(b.rmse_range, 1)), h("td", {}, fmt(b.mean_power_db, 1))));
      kids.push(h("div", { class: "er-h" }, "By range"),
        h("table", { class: "er-table" },
          h("thead", {}, h("tr", {}, ...["Range [m]", "N", "True", "Pd", "RMSE horiz [m]", "RMSE range [m]", "Power [dB]"].map((t) => h("th", {}, t)))),
          h("tbody", {}, ...rows)));
    }
    body.replaceChildren(...kids);
  }

  function drawTimeline(): void {
    if (!result || !timelineCanvas) return;
    const tl = result.timeline;
    const t0 = tl[0]?.t ?? 0;
    let cursor: number | undefined;
    if (lastRs?.currentTime && lastRs.startTime && lastRs.endTime) {
      const toS = (t: { sec: number; nsec: number }) => t.sec + t.nsec * 1e-9;
      const span = toS(lastRs.endTime) - toS(lastRs.startTime);
      if (span > 0 && result.timing.t_start != undefined && result.timing.t_end != undefined) {
        const f = (toS(lastRs.currentTime) - toS(lastRs.startTime)) / span;
        cursor = result.timing.t_start + f * (result.timing.t_end - result.timing.t_start) - t0;
      }
    }
    drawChart(timelineCanvas, [
      { name: "detections/win", color: "#4cc2ff", x: tl.map((p) => p.t - t0), y: tl.map((p) => p.n_det) },
      { name: "true/win", color: "#4ade80", x: tl.map((p) => p.t - t0), y: tl.map((p) => p.n_true) },
    ], { title: `Detections over time (${result.params.bin_s}s bins aggregated)`, xLabel: "time [s]", yLabel: "count", cursorX: cursor, yMin: 0 });
  }

  function renderLive(): void {
    const st = feed.store;
    const gt = st.primaryGroundTruth();
    const q = computeQuickKpi(st.detections, gt, { gateM: cfg.gateM, binS: cfg.binS });
    const kids: Node[] = [];
    const grid = h("div", { class: "er-grid" });
    grid.append(card("Source", "Live (browser)", `${st.detections.length} detections, ${st.tracks.size} tracks`));
    if (!st.anchor && st.stats().pendingLocal > 0) {
      kids.push(h("div", { class: "er-card er-warn" }, "Radar-local detections cannot be georeferenced yet: no radar-platform NavSatFix in this bag. Use the service source or set a manual anchor in the Radar Map panel."));
    }
    if (q) {
      grid.append(card("Pd", pct(q.pd), `${q.pdBinsDetected}/${q.pdBins} bins`));
      grid.append(card("False alarms", fmt(q.falseAlarmsPerMin, 1, "/min"), `${q.nFalse} false`));
      grid.append(card("CEP50", fmt(q.cep50, 1, " m")));
      grid.append(card("CEP95", fmt(q.cep95, 1, " m")));
      grid.append(card("RMSE horiz", fmt(q.rmseHoriz, 1, " m")));
      grid.append(card("RMSE vert", fmt(q.rmseVert, 1, " m")));
    } else if (st.detections.length > 0) {
      grid.append(card("Ground truth", "none", "detection-only statistics"));
    }
    kids.unshift(grid);
    if (q) {
      const c = chartCanvas();
      kids.push(c);
      const ok = q.samples.filter((x) => x.isTrue && x.range != undefined);
      requestAnimationFrame(() => drawChart(c, [{ name: "horizontal", color: "#4cc2ff", x: ok.map((x) => x.range!), y: ok.map((x) => x.horiz), kind: "scatter" }], { title: "Horizontal error vs range", xLabel: "range [m]", yLabel: "error [m]", yMin: 0 }));
    }
    body.replaceChildren(...kids);
  }

  runSel.addEventListener("change", () => {
    cfg.runId = runSel.value;
    void refresh();
  });
  srcSel.addEventListener("change", () => void refresh());

  context.watch("allFrames");
  context.watch("currentTime");
  context.watch("topics");
  context.watch("colorScheme");
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  context.onRender = (rs, done) => {
    lastRs = rs;
    if (rs.colorScheme && (rs.colorScheme === "dark") !== dark) {
      dark = rs.colorScheme === "dark";
      root.className = `er-root ${rs.colorScheme}`;
    }
    const changed = feed.update(rs);
    setSharedAnchor(feed.store.anchor);
    if (cfg.source === "live" && changed) {
      globalThis.clearTimeout(liveTimer);
      liveTimer = globalThis.setTimeout(renderLive, 400);
    }
    if (cfg.source === "service" && result) drawTimeline();
    done();
  };

  void (async () => {
    const matched = await loadRuns();
    if (matched || cfg.source === "live") await refresh();
    else body.replaceChildren(h("div", { class: "er-muted", style: { padding: "12px" } }, "Open a run from the Run browser, or select one above and press Compute."));
  })();

  return () => {
    abort?.abort();
    globalThis.clearTimeout(liveTimer);
    root.remove();
  };
}
