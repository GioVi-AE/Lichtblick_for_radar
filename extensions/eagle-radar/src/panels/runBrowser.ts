// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
// Run browser: catalogue of the bags indexed by the radar-kpi service; opens a run in Lichtblick.

import { KpiClient, RunInfo, currentDataUrl, lichtblickOpenUrl } from "../kpiApi";
import { PanelExtensionContext } from "../lichtblick";
import { fmt, h, rootEl } from "../ui";

interface Config {
  search: string;
  root: string;
  onlyGt: boolean;
  onlyDet: boolean;
  sort: string;
  desc: boolean;
}

function human(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} kB`;
}

export function initRunBrowser(context: PanelExtensionContext): () => void {
  const cfg: Config = { search: "", root: "", onlyGt: false, onlyDet: false, sort: "name", desc: false, ...((context.initialState as Partial<Config>) ?? {}) };
  const client = new KpiClient();
  const root = rootEl("dark");
  const search = h("input", { placeholder: "filter…", value: cfg.search, style: { width: "140px" } });
  const rootSel = h("select", {}, h("option", { value: "" }, "all roots"));
  const gt = h("input", { type: "checkbox" }) as HTMLInputElement;
  gt.checked = cfg.onlyGt;
  const det = h("input", { type: "checkbox" }) as HTMLInputElement;
  det.checked = cfg.onlyDet;
  const status = h("span", { class: "er-muted" });
  const bar = h("div", { class: "er-bar" }, search, rootSel, h("label", {}, gt, " GT"), h("label", {}, det, " detections"),
    h("button", { class: "er-btn", onclick: () => void reload(true) }, "Rescan"), status);
  const body = h("div", { class: "er-body" });
  root.append(bar, body);
  context.panelElement.append(root);
  context.setDefaultPanelTitle("Radar Runs");

  let runs: RunInfo[] = [];
  const current = currentDataUrl();

  function flag(on: boolean, text: string, title: string): HTMLElement {
    return h("span", { class: "er-chip " + (on ? "er-good" : "er-muted"), title }, text);
  }

  function render(): void {
    cfg.search = search.value;
    cfg.root = rootSel.value;
    cfg.onlyGt = gt.checked;
    cfg.onlyDet = det.checked;
    context.saveState({ ...cfg });
    const q = cfg.search.toLowerCase();
    let list = runs.filter((r) => (!q || r.name.toLowerCase().includes(q) || r.mcap.toLowerCase().includes(q)) &&
      (!cfg.root || r.root === cfg.root) && (!cfg.onlyGt || r.has_ground_truth) && (!cfg.onlyDet || r.has_detections));
    const key = cfg.sort as keyof RunInfo;
    list = [...list].sort((a, b) => {
      const av = a[key] as unknown as number | string, bv = b[key] as unknown as number | string;
      const c = av < bv ? -1 : av > bv ? 1 : 0;
      return cfg.desc ? -c : c;
    });
    const cols: [string, string][] = [["name", "Run"], ["root", "Root"], ["duration_s", "Dur"], ["size_bytes", "Size"], ["", "Data"], ["", ""]];
    const head = h("tr", {}, ...cols.map(([k, t]) => h("th", { onclick: () => { if (!k) return; if (cfg.sort === k) cfg.desc = !cfg.desc; else { cfg.sort = k; cfg.desc = false; } render(); } }, t)));
    const rows = list.map((r) => {
      const isCurrent = current !== undefined && current === r.data_url;
      return h("tr", { class: isCurrent ? "sel" : "", title: r.mcap + (r.notes.length ? "\n" + r.notes.join("\n") : "") },
        h("td", {}, r.name, r.log_time_unit === "s" ? h("span", { class: "er-chip er-warn", title: "log_time is in seconds (not ns): playback clock is non-standard" }, "t[s]") : undefined),
        h("td", {}, r.root),
        h("td", {}, fmt(r.duration_s, 0, " s")),
        h("td", {}, human(r.size_bytes)),
        h("td", {}, flag(r.has_detections, "DET", "radar detections"), flag(r.has_tracks, "TRK", "tracks"),
          flag(r.has_ground_truth, "GT", r.gt_source ?? "ground truth"), flag(r.has_carrier, "NAV", "radar platform NavSat"), flag(r.has_rvmap, "RV", "RV map"),
          r.paired_with ? h("span", { class: "er-chip", title: "paired with raw bag " + r.paired_with }, "pair") : undefined),
        h("td", {}, h("button", { class: "er-btn", onclick: () => { globalThis.location.href = lichtblickOpenUrl(r); } }, "Open")));
    });
    body.replaceChildren(h("table", { class: "er-table" }, h("thead", {}, head), h("tbody", {}, ...rows)));
    status.textContent = `${list.length}/${runs.length} runs`;
  }

  async function reload(rescan = false): Promise<void> {
    status.textContent = rescan ? "scanning…" : "loading…";
    try {
      if (rescan) await client.rescan();
      runs = await client.runs();
      const roots = [...new Set(runs.map((r) => r.root))];
      rootSel.replaceChildren(h("option", { value: "" }, "all roots"), ...roots.map((r) => h("option", { value: r }, r)));
      rootSel.value = cfg.root;
      render();
    } catch (e) {
      body.replaceChildren(h("div", { class: "er-bad", style: { padding: "10px" } }, `radar-kpi service unavailable: ${(e as Error).message}`));
      status.textContent = "";
    }
  }

  search.addEventListener("input", render);
  rootSel.addEventListener("change", render);
  gt.addEventListener("change", render);
  det.addEventListener("change", render);
  void reload();
  return () => root.remove();
}
