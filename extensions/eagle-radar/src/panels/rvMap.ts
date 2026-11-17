// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
// RV-map (range-Doppler) heatmap panel with a radar health / status strip.
// Inputs: GeoRegRVMap (uint32[] rvmap), RVMap (float32[] data), RvMapHealth, TrackKpiStatus, RadarStatus, NodeStatus.

import { MessageEvent, PanelExtensionContext, RenderState, SettingsTreeAction } from "../lichtblick";
import { shortSchema } from "../radarData";
import { h, ramp, rootEl } from "../ui";

interface Config {
  rangeAxis: "x" | "y";
  /**
   * false (default, verified on real GeoRegRVMap data, see docs/radar/messages.md):
   *   index = vel * nRange + range  (matrix of nVelocities rows x nRanges columns, row-major)
   * true: index = range * nVel + vel (kept only as a diagnostic override)
   */
  rangeMajor: boolean;
  scale: "log" | "linear";
  pLow: number;
  pHigh: number;
}

const DEFAULTS: Config = { rangeAxis: "x", rangeMajor: false, scale: "log", pLow: 5, pHigh: 99.8 };

const RV_SCHEMAS = ["GeoRegRVMap", "RVMap"];
const HEALTH_SCHEMAS = ["RvMapHealth", "TrackKpiStatus", "RadarStatus", "NodeStatus"];

function baseName(schema: string): string {
  return shortSchema(schema).split("/").pop() ?? schema;
}

interface RvFrame {
  nR: number;
  nV: number;
  values: ArrayLike<number>;
  dr: number;
  dv: number;
  zeroDoppler: number;
  meta: Record<string, string>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function toRvFrame(schema: string, m: any): RvFrame | undefined {
  const name = baseName(schema);
  if (name === "GeoRegRVMap") {
    const nR = Math.round(m.nranges), nV = Math.round(m.nvelocities);
    if (!m.rvmap || nR * nV !== m.rvmap.length) return undefined;
    return {
      nR, nV, values: m.rvmap, dr: m.dr, dv: m.dv, zeroDoppler: m.zero_doppler_bin,
      meta: { "beam az/el": `${m.beam_az?.toFixed?.(1)}° / ${m.beam_el?.toFixed?.(1)}°`, trig_ms: String(m.trig_ms), status: String(m.status), fps: String(m.search_fps) },
    };
  }
  if (name === "RVMap") {
    const nR = m.n_ranges, nV = m.n_velocities;
    if (!m.data || nR * nV !== m.data.length) return undefined;
    return {
      nR, nV, values: m.data, dr: m.dr, dv: m.dv, zeroDoppler: m.zero_doppler_bin,
      meta: { "beam az/el": `${m.beam_az?.toFixed?.(1)}° / ${m.beam_el?.toFixed?.(1)}°` },
    };
  }
  return undefined;
}

/** Linear index of the (range bin, velocity bin) cell in the flat RV-map array. */
export function rvIndex(rangeMajor: boolean, nR: number, nV: number, r: number, v: number): number {
  return rangeMajor ? r * nV + v : v * nR + r;
}

/** Velocity [m/s] of velocity bin v (positive = away, zero at the zero-Doppler bin). */
export function binVelocity(frame: { dv: number; zeroDoppler: number }, v: number): number {
  return (v - frame.zeroDoppler) * frame.dv;
}

export function percentileOf(values: ArrayLike<number>, p: number, stride = 1): number {
  const sample: number[] = [];
  for (let i = 0; i < values.length; i += stride) sample.push(values[i]!);
  sample.sort((a, b) => a - b);
  if (sample.length === 0) return 0;
  return sample[Math.min(sample.length - 1, Math.floor((p / 100) * sample.length))]!;
}

export function initRvMap(context: PanelExtensionContext): () => void {
  const cfg: Config = { ...DEFAULTS, ...((context.initialState as Partial<Config>) ?? {}) };
  const root = rootEl("dark");
  const strip = h("div", { class: "er-bar" });
  const info = h("div", { class: "er-muted", style: { padding: "2px 8px" } });
  const canvas = h("canvas", { style: { flex: "1", minHeight: "0", width: "100%", imageRendering: "pixelated" } });
  const wrap = h("div", { style: { flex: "1", minHeight: "0", display: "flex" } }, canvas);
  root.append(strip, info, wrap);
  context.panelElement.append(root);
  context.setDefaultPanelTitle("RV Map");

  let frame: RvFrame | undefined;
  let health = new Map<string, Record<string, unknown>>();
  let dark = true;

  function chip(label: string, value: string, cls = ""): HTMLElement {
    return h("span", { class: `er-chip ${cls}` }, `${label}: ${value}`);
  }

  function renderStrip(): void {
    const chips: HTMLElement[] = [];
    const rh = health.get("RvMapHealth");
    if (rh) {
      chips.push(chip("RVMap", rh.rvmap_valid ? "valid" : "INVALID", rh.rvmap_valid ? "er-good" : "er-bad"));
      chips.push(chip("age", `${Number(rh.age_ms).toFixed(0)} / ${Number(rh.expected_period_ms).toFixed(0)} ms`, Number(rh.age_ms) > 2 * Number(rh.expected_period_ms) ? "er-warn" : ""));
      chips.push(chip("sat", `${(Number(rh.saturation_ratio) * 100).toFixed(2)} %`, rh.saturated_active ? "er-bad" : "er-good"));
      if (rh.timeout_active) chips.push(chip("TIMEOUT", "active", "er-bad"));
    }
    const tk = health.get("TrackKpiStatus");
    if (tk) {
      chips.push(chip("track", `#${tk.track_id} ${tk.confirmed ? "confirmed" : "tentative"}`, tk.confirmed ? "er-good" : "er-warn"));
      chips.push(chip("SNR", `${Number(tk.rf_snr_db).toFixed(1)} dB`, tk.rf_health_valid ? "" : "er-warn"));
      chips.push(chip("conf", `${(Number(tk.confidence) * 100).toFixed(0)} %`));
      chips.push(chip("missed", `${tk.missed_updates}/${tk.total_updates}`));
    }
    const rs = health.get("RadarStatus");
    if (rs) chips.push(chip("radar", `${rs.status} (err ${rs.error_code})`, Number(rs.error_code) === 0 ? "er-good" : "er-bad"));
    const ns = health.get("NodeStatus");
    if (ns) {
      const errs = (ns.errors as string[] | undefined) ?? [];
      chips.push(chip(String(ns.node_name), `${ns.state}${errs.length ? " ⚠ " + errs.length : ""}`, errs.length ? "er-bad" : "er-good"));
    }
    if (chips.length === 0) chips.push(h("span", { class: "er-muted" }, "no RvMapHealth / TrackKpiStatus / RadarStatus topics"));
    strip.replaceChildren(...chips);
  }

  function draw(): void {
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.max(50, canvas.clientWidth), hgt = Math.max(50, canvas.clientHeight);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(hgt * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!frame) {
      ctx.fillStyle = "#888";
      ctx.font = `${12 * dpr}px system-ui`;
      ctx.fillText("Waiting for GeoRegRVMap / RVMap messages…", 12 * dpr, 24 * dpr);
      return;
    }
    const { nR, nV, values } = frame;
    const idx = (r: number, v: number) => rvIndex(cfg.rangeMajor, nR, nV, r, v);
    const tf = (x: number) => (cfg.scale === "log" ? Math.log10(1 + Math.max(0, x)) : x);
    const stride = Math.max(1, Math.floor(values.length / 5000));
    const lo = tf(percentileOf(values, cfg.pLow, stride));
    const hi = Math.max(lo + 1e-9, tf(percentileOf(values, cfg.pHigh, stride)));
    const img = new ImageData(cfg.rangeAxis === "x" ? nR : nV, cfg.rangeAxis === "x" ? nV : nR);
    const lut: [number, number, number][] = [];
    for (let i = 0; i < 256; i++) {
      const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(ramp(i / 255))!;
      lut.push([Number(m[1]), Number(m[2]), Number(m[3])]);
    }
    for (let r = 0; r < nR; r++) {
      for (let v = 0; v < nV; v++) {
        const f = Math.max(0, Math.min(1, (tf(values[idx(r, v)]!) - lo) / (hi - lo)));
        const c = lut[Math.round(f * 255)]!;
        // velocity axis: positive velocity up (y) / right (x)
        const x = cfg.rangeAxis === "x" ? r : nV - 1 - v;
        const y = cfg.rangeAxis === "x" ? nV - 1 - v : r;
        const o = (y * img.width + x) * 4;
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
      }
    }
    const off = document.createElement("canvas");
    off.width = img.width;
    off.height = img.height;
    off.getContext("2d")!.putImageData(img, 0, 0);
    const ml = 46 * dpr, mb = 24 * dpr;
    const pw = canvas.width - ml - 6 * dpr, ph = canvas.height - mb - 6 * dpr;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, ml, 6 * dpr, pw, ph);
    ctx.fillStyle = "#aaa";
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.font = `${10 * dpr}px system-ui`;
    // axes labels
    const rMax = nR * frame.dr;
    const vMin = (0 - frame.zeroDoppler) * frame.dv, vMax = (nV - 1 - frame.zeroDoppler) * frame.dv;
    for (let i = 0; i <= 4; i++) {
      const rr = (rMax * i) / 4;
      const vv = vMin + ((vMax - vMin) * i) / 4;
      if (cfg.rangeAxis === "x") {
        ctx.fillText(`${rr.toFixed(0)} m`, ml + (pw * i) / 4 - 10 * dpr, canvas.height - 8 * dpr);
        ctx.fillText(`${(vMax - (vMax - vMin) * (i / 4)).toFixed(1)}`, 4 * dpr, 6 * dpr + (ph * i) / 4 + 8 * dpr);
      } else {
        ctx.fillText(`${rr.toFixed(0)} m`, 4 * dpr, 6 * dpr + (ph * i) / 4 + 8 * dpr);
        ctx.fillText(`${(vMax - (vMax - vMin) * (i / 4)).toFixed(1)}`, ml + (pw * i) / 4 - 10 * dpr, canvas.height - 8 * dpr);
      }
    }
    // zero-Doppler line
    const zf = (vMax - 0) / (vMax - vMin);
    ctx.beginPath();
    if (cfg.rangeAxis === "x") {
      ctx.moveTo(ml, 6 * dpr + ph * zf);
      ctx.lineTo(ml + pw, 6 * dpr + ph * zf);
    } else {
      ctx.moveTo(ml + pw * (1 - zf), 6 * dpr);
      ctx.lineTo(ml + pw * (1 - zf), 6 * dpr + ph);
    }
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.stroke();
    ctx.setLineDash([]);
    info.textContent = `${nR} range × ${nV} velocity bins   dr=${frame.dr.toFixed(2)} m  dv=${frame.dv.toFixed(2)} m/s   ` +
      Object.entries(frame.meta).map(([k, v]) => `${k}=${v}`).join("  ");
  }

  function updateSettings(): void {
    context.updatePanelSettingsEditor({
      actionHandler: (action: SettingsTreeAction) => {
        if (action.action !== "update") return;
        const key = action.payload.path[1]!;
        if (key === "rangeMajor") cfg.rangeMajor = action.payload.value === "range";
        else (cfg as unknown as Record<string, unknown>)[key] = action.payload.value;
        context.saveState({ ...cfg });
        updateSettings();
        draw();
      },
      nodes: {
        display: {
          label: "RV map",
          defaultExpansionState: "expanded",
          fields: {
            rangeAxis: { label: "Range axis", input: "select", value: cfg.rangeAxis, options: [{ label: "Horizontal", value: "x" }, { label: "Vertical", value: "y" }] },
            rangeMajor: { label: "Index order", input: "select", value: cfg.rangeMajor ? "range" : "vel", options: [{ label: "range-major (r*nVel+v)", value: "range" }, { label: "velocity-major (v*nRange+r) – verified", value: "vel" }] },
            scale: { label: "Scale", input: "select", value: cfg.scale, options: [{ label: "log10(1+x)", value: "log" }, { label: "linear", value: "linear" }] },
            pLow: { label: "Low percentile", input: "number", value: cfg.pLow, min: 0, max: 99, step: 1 },
            pHigh: { label: "High percentile", input: "number", value: cfg.pHigh, min: 50, max: 100, step: 0.1 },
          },
        },
      },
    } as never);
  }
  let topicKey = "";
  function subscribe(rs: RenderState): void {
    const subs: { topic: string }[] = [];
    for (const t of rs.topics ?? []) {
      const b = baseName(t.schemaName);
      if (RV_SCHEMAS.includes(b) || HEALTH_SCHEMAS.includes(b)) subs.push({ topic: t.name });
    }
    const key = subs.map((s) => s.topic).sort().join("|");
    if (key !== topicKey) {
      topicKey = key;
      context.subscribe(subs);
    }
  }

  let pending = false;
  function schedule(): void {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      renderStrip();
      draw();
    });
  }

  context.watch("currentFrame");
  context.watch("topics");
  context.watch("colorScheme");
  updateSettings();
  context.onRender = (rs, done) => {
    if (rs.colorScheme && (rs.colorScheme === "dark") !== dark) {
      dark = rs.colorScheme === "dark";
      root.className = `er-root ${rs.colorScheme}`;
    }
    subscribe(rs);
    let changed = false;
    for (const ev of rs.currentFrame ?? []) {
      const e = ev as MessageEvent;
      const b = baseName(e.schemaName);
      if (RV_SCHEMAS.includes(b)) {
        const f = toRvFrame(e.schemaName, e.message);
        if (f) {
          frame = f;
          changed = true;
        }
      } else if (HEALTH_SCHEMAS.includes(b)) {
        health = new Map(health).set(b, e.message as Record<string, unknown>);
        changed = true;
      }
    }
    if (changed) schedule();
    done();
  };

  const ro = new ResizeObserver(() => schedule());
  ro.observe(wrap);
  return () => {
    ro.disconnect();
    root.remove();
  };
}
