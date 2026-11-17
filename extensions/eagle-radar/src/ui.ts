// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
// Tiny DOM + canvas chart helpers (no framework).

export type Child = Node | string | undefined | null | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, unknown>> & { style?: Partial<CSSStyleDeclaration> | string } = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == undefined || v === false) continue;
    if (k === "style") {
      if (typeof v === "string") el.setAttribute("style", v);
      else Object.assign(el.style, v);
    } else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "class") {
      el.className = String(v);
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat()) {
    if (c == undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

const STYLE_ID = "eagle-radar-style";
const CSS = `
.er-root{font:12px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--er-fg);background:var(--er-bg);height:100%;width:100%;display:flex;flex-direction:column;box-sizing:border-box;overflow:hidden}
.er-root.dark{--er-fg:#e6e8ee;--er-bg:#14161b;--er-card:#1d2027;--er-border:#2c313b;--er-muted:#8d95a6;--er-accent:#4cc2ff;--er-good:#4ade80;--er-warn:#fbbf24;--er-bad:#f87171}
.er-root.light{--er-fg:#1b1f27;--er-bg:#f5f6f8;--er-card:#ffffff;--er-border:#d8dce3;--er-muted:#667085;--er-accent:#0b7bd0;--er-good:#16a34a;--er-warn:#d97706;--er-bad:#dc2626}
.er-bar{display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--er-border);flex-wrap:wrap}
.er-body{flex:1;overflow:auto;padding:8px;min-height:0}
.er-card{background:var(--er-card);border:1px solid var(--er-border);border-radius:6px;padding:8px 10px;min-width:96px}
.er-card .v{font-size:20px;font-weight:600}
.er-card .l{color:var(--er-muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.er-card .s{color:var(--er-muted);font-size:11px}
.er-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:10px}
.er-btn,.er-root select,.er-root input{background:var(--er-card);color:var(--er-fg);border:1px solid var(--er-border);border-radius:4px;padding:3px 8px;font:inherit}
.er-btn{cursor:pointer}.er-btn:hover{border-color:var(--er-accent)}
.er-muted{color:var(--er-muted)}
.er-good{color:var(--er-good)}.er-warn{color:var(--er-warn)}.er-bad{color:var(--er-bad)}
.er-table{width:100%;border-collapse:collapse}
.er-table th,.er-table td{text-align:left;padding:3px 6px;border-bottom:1px solid var(--er-border);white-space:nowrap}
.er-table th{color:var(--er-muted);font-weight:500;position:sticky;top:0;background:var(--er-bg);cursor:pointer}
.er-table tr.sel td{background:rgba(76,194,255,.12)}
.er-table tr:hover td{background:rgba(127,127,127,.12)}
.er-h{font-weight:600;margin:12px 0 6px}
.er-chart{background:var(--er-card);border:1px solid var(--er-border);border-radius:6px;margin-bottom:10px}
.er-chip{display:inline-block;padding:0 6px;border-radius:9px;border:1px solid var(--er-border);font-size:11px;margin-right:4px}
.er-legend{position:absolute;right:8px;bottom:8px;z-index:1000;background:rgba(20,22,27,.82);color:#e6e8ee;padding:6px 8px;border-radius:6px;font-size:11px}
.er-legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:middle}
.er-hud{position:absolute;left:52px;top:8px;max-width:calc(100% - 64px);overflow:hidden;z-index:1000;background:rgba(20,22,27,.82);color:#e6e8ee;padding:6px 8px;border-radius:6px;font-size:11px;pointer-events:none;white-space:pre}
`;

export function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.append(s);
}

export function rootEl(scheme: "dark" | "light" | undefined): HTMLDivElement {
  ensureStyle();
  return h("div", { class: `er-root ${scheme ?? "dark"}` });
}

export function fmt(v: number | null | undefined, digits = 1, unit = ""): string {
  if (v == undefined || !Number.isFinite(v)) return "–";
  return `${v.toFixed(digits)}${unit}`;
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (v == undefined || !Number.isFinite(v)) return "–";
  return `${(v * 100).toFixed(digits)} %`;
}

export function card(label: string, value: string, sub?: string, cls = ""): HTMLElement {
  return h("div", { class: "er-card" }, h("div", { class: "l" }, label), h("div", { class: `v ${cls}` }, value), sub ? h("div", { class: "s" }, sub) : undefined);
}

/* ---------------- charts ---------------- */

export interface Series {
  name: string;
  color: string;
  x: number[];
  y: (number | null)[];
  kind?: "line" | "scatter" | "bar";
}

export interface ChartOptions {
  title?: string;
  xLabel?: string;
  yLabel?: string;
  yMin?: number;
  yMax?: number;
  height?: number;
  /** vertical marker in x units */
  cursorX?: number;
}

export function drawChart(canvas: HTMLCanvasElement, series: Series[], opts: ChartOptions = {}): void {
  const dpr = globalThis.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 300;
  const cssH = opts.height ?? 160;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  const cs = getComputedStyle(canvas);
  const fg = cs.getPropertyValue("--er-fg") || "#ccc";
  const muted = cs.getPropertyValue("--er-muted") || "#888";
  const border = cs.getPropertyValue("--er-border") || "#444";
  ctx.clearRect(0, 0, cssW, cssH);
  const ml = 44, mr = 10, mt = opts.title ? 20 : 8, mb = 28;
  const pw = cssW - ml - mr, ph = cssH - mt - mb;

  let xMin = Infinity, xMax = -Infinity, yMin = opts.yMin ?? Infinity, yMax = opts.yMax ?? -Infinity;
  for (const s of series) {
    for (let i = 0; i < s.x.length; i++) {
      const y = s.y[i];
      if (y == undefined || !Number.isFinite(y)) continue;
      if (s.x[i]! < xMin) xMin = s.x[i]!;
      if (s.x[i]! > xMax) xMax = s.x[i]!;
      if (opts.yMin == undefined && y < yMin) yMin = y;
      if (opts.yMax == undefined && y > yMax) yMax = y;
    }
  }
  if (!Number.isFinite(xMin)) {
    ctx.fillStyle = muted;
    ctx.font = "11px system-ui";
    ctx.fillText("no data", ml + 8, mt + 20);
    return;
  }
  if (xMax === xMin) xMax = xMin + 1;
  if (yMax === yMin) yMax = yMin + 1;
  const px = (x: number) => ml + ((x - xMin) / (xMax - xMin)) * pw;
  const py = (y: number) => mt + ph - ((y - yMin) / (yMax - yMin)) * ph;

  ctx.strokeStyle = border;
  ctx.fillStyle = muted;
  ctx.font = "10px system-ui";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = yMin + ((yMax - yMin) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(ml, py(y));
    ctx.lineTo(ml + pw, py(y));
    ctx.stroke();
    ctx.fillText(Math.abs(y) >= 100 ? y.toFixed(0) : y.toFixed(2), 4, py(y) + 3);
  }
  for (let i = 0; i <= 4; i++) {
    const x = xMin + ((xMax - xMin) * i) / 4;
    ctx.fillText(Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1), px(x) - 10, mt + ph + 12);
  }
  if (opts.xLabel) ctx.fillText(opts.xLabel, ml + pw / 2 - 20, cssH - 3);
  if (opts.yLabel) {
    ctx.save();
    ctx.translate(10, mt + ph / 2 + 20);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(opts.yLabel, 0, 0);
    ctx.restore();
  }
  if (opts.title) {
    ctx.fillStyle = fg;
    ctx.font = "600 11px system-ui";
    ctx.fillText(opts.title, ml, 13);
  }

  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    if (s.kind === "scatter") {
      for (let i = 0; i < s.x.length; i++) {
        const y = s.y[i];
        if (y == undefined || !Number.isFinite(y)) continue;
        ctx.globalAlpha = 0.6;
        ctx.fillRect(px(s.x[i]!) - 1, py(y) - 1, 2.5, 2.5);
      }
      ctx.globalAlpha = 1;
    } else if (s.kind === "bar") {
      const bw = Math.max(1, (pw / Math.max(1, s.x.length)) * 0.7);
      for (let i = 0; i < s.x.length; i++) {
        const y = s.y[i];
        if (y == undefined || !Number.isFinite(y)) continue;
        ctx.fillRect(px(s.x[i]!) - bw / 2, py(y), bw, py(yMin) - py(y));
      }
    } else {
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < s.x.length; i++) {
        const y = s.y[i];
        if (y == undefined || !Number.isFinite(y)) {
          pen = false;
          continue;
        }
        if (!pen) ctx.moveTo(px(s.x[i]!), py(y));
        else ctx.lineTo(px(s.x[i]!), py(y));
        pen = true;
      }
      ctx.stroke();
    }
  }
  if (opts.cursorX != undefined && opts.cursorX >= xMin && opts.cursorX <= xMax) {
    ctx.strokeStyle = "#f59e0b";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(px(opts.cursorX), mt);
    ctx.lineTo(px(opts.cursorX), mt + ph);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // legend
  let lx = ml + 6;
  ctx.font = "10px system-ui";
  for (const s of series) {
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, mt + 3, 8, 8);
    ctx.fillStyle = muted;
    ctx.fillText(s.name, lx + 11, mt + 11);
    lx += 16 + ctx.measureText(s.name).width + 8;
  }
}

export function chartCanvas(): HTMLCanvasElement {
  const c = h("canvas", { class: "er-chart", style: { width: "100%", display: "block" } });
  return c;
}

/** viridis-like colour ramp, f in [0,1] -> css colour. */
export function ramp(f: number): string {
  const x = Math.max(0, Math.min(1, f));
  const stops = [
    [68, 1, 84], [59, 82, 139], [33, 144, 141], [93, 201, 99], [253, 231, 37],
  ] as const;
  const p = x * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(p));
  const t = p - i;
  const a = stops[i]!, b = stops[i + 1]!;
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
}
