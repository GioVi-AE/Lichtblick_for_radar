// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
// Radar Map panel: georeferenced detections, tracks, ground truth and radar platform on a map.

import L from "leaflet";
// eslint-disable-next-line import/no-unresolved
import leafletCss from "leaflet/dist/leaflet.css";

import { setSharedAnchor } from "../converters";
import { llaToNed } from "../geo";
import { Anchor, TimedTrack } from "../georef";
import { KpiClient, RunContext, currentDataUrl } from "../kpiApi";
import { MessageEvent, PanelExtensionContext, RenderState, SettingsTreeAction, Subscription } from "../lichtblick";
import { DEFAULT_QUICK_PARAMS } from "../quickKpi";
import { GeoDet, RadarStore, Role, classifySchema, detectCarrierNamespace, timeToSec } from "../radarData";
import { fmt, h, ramp, rootEl } from "../ui";

type ColorBy = "power" | "error" | "age";
type TileMode = "osm" | "satellite" | "none" | "custom";

interface Config {
  tileMode: TileMode;
  customTileUrl: string;
  colorBy: ColorBy;
  trailSec: number;
  maxPoints: number;
  gateM: number;
  showDetections: boolean;
  showTracks: boolean;
  showGt: boolean;
  showCarrier: boolean;
  showErrorLines: boolean;
  showCovariance: boolean;
  showLos: boolean;
  anchorMode: "auto" | "manual";
  manualLat: number;
  manualLon: number;
  manualAlt: number;
  manualFrame: "NED" | "ENU";
  overlayUrl: string;
  followCarrier: boolean;
  roles: Record<string, Role>;
}

const DEFAULTS: Config = {
  tileMode: "osm",
  customTileUrl: "",
  colorBy: "power",
  trailSec: 30,
  maxPoints: 4000,
  gateM: DEFAULT_QUICK_PARAMS.gateM,
  showDetections: true,
  showTracks: true,
  showGt: true,
  showCarrier: true,
  showErrorLines: false,
  showCovariance: true,
  showLos: true,
  anchorMode: "auto",
  manualLat: 0,
  manualLon: 0,
  manualAlt: 0,
  manualFrame: "NED",
  overlayUrl: "",
  followCarrier: false,
  roles: {},
};

const TILES: Record<Exclude<TileMode, "none" | "custom">, { url: string; attribution: string }> = {
  osm: { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "© OpenStreetMap contributors" },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles © Esri",
  },
};

const RADAR_TOPIC_KINDS = new Set(["radarDetection", "cvDetection", "trackArray", "geoTrack", "detectionArray", "groundTruth", "navSat", "odometryGt"]);

function interestingTopics(topics: readonly { name: string; schemaName: string }[]): { name: string; schemaName: string }[] {
  return topics.filter((t) => RADAR_TOPIC_KINDS.has(classifySchema(t.schemaName, t.name)));
}

export function initRadarMap(context: PanelExtensionContext): () => void {
  const cfg: Config = { ...DEFAULTS, ...((context.initialState as Partial<Config> | undefined) ?? {}) };
  cfg.roles = { ...(cfg.roles ?? {}) };

  if (!document.getElementById("eagle-radar-leaflet-css")) {
    const st = document.createElement("style");
    st.id = "eagle-radar-leaflet-css";
    st.textContent = leafletCss as unknown as string;
    document.head.append(st);
  }

  const root = rootEl("dark");
  const mapDiv = h("div", { style: { flex: "1", position: "relative", minHeight: "0" } });
  const hud = h("div", { class: "er-hud" });
  const legend = h("div", { class: "er-legend" });
  mapDiv.append(hud, legend);
  root.append(mapDiv);
  context.panelElement.append(root);

  const map = L.map(mapDiv, { zoomControl: true, preferCanvas: true, worldCopyJump: false }).setView([50.83, 10.8], 13);
  const canvasRenderer = L.canvas({ padding: 0.3 });
  let tileLayer: L.TileLayer | undefined;
  let overlayLayer: L.ImageOverlay | undefined;
  const staticGroup = L.layerGroup().addTo(map);
  const dynGroup = L.layerGroup().addTo(map);

  const store = new RadarStore();
  const kpi = new KpiClient();
  let processed = 0;
  let lastFirst: unknown;
  let subscribedKey = "";
  let carrierNs: string | undefined;
  let lastRender: RenderState | undefined;
  let ctxLoaded = false;
  let ctxInfo: RunContext | undefined;
  let rafPending = false;
  let staticSig = "";
  let fitted = false;
  let dark = true;

  /* ---------------- tiles ---------------- */
  function applyTiles(): void {
    tileLayer?.remove();
    tileLayer = undefined;
    const url = cfg.tileMode === "custom" ? cfg.customTileUrl : cfg.tileMode === "none" ? "" : TILES[cfg.tileMode].url;
    if (url) {
      tileLayer = L.tileLayer(url, {
        maxZoom: 22,
        maxNativeZoom: 19,
        attribution: cfg.tileMode === "custom" ? "" : TILES[cfg.tileMode as "osm"]?.attribution ?? "",
      }).addTo(map);
    }
    mapDiv.style.background = cfg.tileMode === "none" ? "#0f1115" : "";
  }

  async function applyOverlay(): Promise<void> {
    overlayLayer?.remove();
    overlayLayer = undefined;
    if (!cfg.overlayUrl) return;
    try {
      const jgwUrl = cfg.overlayUrl.replace(/\.[a-zA-Z0-9]+$/, ".jgw");
      const jgw = (await (await fetch(jgwUrl)).text()).trim().split(/\s+/).map(Number);
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("overlay image load failed"));
        img.src = cfg.overlayUrl;
      });
      const [a, , , e, c, f] = jgw as [number, number, number, number, number, number];
      // World file (degrees): x = a*col + c, y = e*row + f  (centre of upper-left pixel)
      const west = c - a / 2;
      const north = f - e / 2;
      const east = west + a * img.naturalWidth;
      const south = north + e * img.naturalHeight;
      overlayLayer = L.imageOverlay(cfg.overlayUrl, [[south, west], [north, east]], { opacity: 0.8 }).addTo(map);
    } catch (err) {
      hud.textContent = `Overlay error: ${(err as Error).message}`;
    }
  }

  /* ---------------- anchor ---------------- */
  function applyAnchorConfig(): void {
    if (cfg.anchorMode === "manual") {
      store.manualAnchor = { lat: cfg.manualLat, lon: cfg.manualLon, alt: cfg.manualAlt, frame: cfg.manualFrame, source: "manual" };
    } else {
      store.manualAnchor = undefined;
    }
    setSharedAnchor(store.anchor);
    // Re-ingest everything with the new anchor.
    processed = 0;
    store.reset();
    reapplyContext();
    if (lastRender) ingestFrames(lastRender);
    schedule();
  }

  function reapplyContext(): void {
    if (!ctxInfo) return;
    storeContext(ctxInfo);
  }

  function storeContext(c: RunContext): void {
    store.carrierSvc.clear();
    store.targetSvc.clear();
    for (const [t, lat, lon, alt] of c.carrier) store.carrierSvc.push({ t, lat, lon, alt });
    for (const [t, lat, lon, alt] of c.target) store.targetSvc.push({ t, lat, lon, alt });
    if (c.anchor) {
      const a: Anchor = {
        lat: c.anchor.lat, lon: c.anchor.lon, alt: c.anchor.alt, frame: c.anchor.frame,
        residualStd: c.anchor.residual_std_m ?? undefined, source: "service",
      };
      store.serviceAnchor = a;
    }
  }

  async function loadContext(): Promise<void> {
    if (ctxLoaded) return;
    const url = currentDataUrl();
    if (!url) return;
    ctxLoaded = true;
    try {
      const run = await kpi.runByDataUrl(url);
      ctxInfo = await kpi.context(run.id);
      storeContext(ctxInfo);
      setSharedAnchor(store.anchor);
      staticSig = "";
      processed = 0;
      const keepRoles = store.roles;
      store.reset();
      store.roles = keepRoles;
      storeContext(ctxInfo);
      if (lastRender) ingestFrames(lastRender);
      schedule();
    } catch (err) {
      hud.textContent = `KPI service context unavailable (${(err as Error).message})`;
    }
  }

  /* ---------------- data intake ---------------- */
  function subscribeTopics(rs: RenderState): void {
    const topics = interestingTopics(rs.topics ?? []);
    carrierNs = detectCarrierNamespace(rs.topics ?? []);
    store.carrierNs = carrierNs;
    store.roles = cfg.roles;
    const subs: Subscription[] = [];
    for (const t of topics) {
      const kind = classifySchema(t.schemaName, t.name);
      if (kind === "navSat" && store.roleFor(t.name) === "ignore") continue;
      subs.push({ topic: t.name, preload: true });
    }
    const key = subs.map((s) => s.topic).sort().join("|");
    if (key !== subscribedKey) {
      subscribedKey = key;
      context.subscribe(subs);
      processed = 0;
      const keepRoles = store.roles;
      store.reset();
      store.roles = keepRoles;
      reapplyContext();
      updateSettings(rs.topics ?? []);
    }
  }

  function ingestFrames(rs: RenderState): void {
    const all = rs.allFrames;
    if (all) {
      if (all.length < processed || (all.length > 0 && lastFirst !== undefined && all[0] !== lastFirst)) {
        processed = 0;
        const keepRoles = store.roles;
        store.reset();
        store.roles = keepRoles;
        reapplyContext();
      }
      lastFirst = all[0];
      for (let i = processed; i < all.length; i++) store.ingest(all[i] as MessageEvent);
      processed = all.length;
    }
    store.resolve();
    setSharedAnchor(store.anchor);
  }

  /* ---------------- rendering ---------------- */
  function sig(): string {
    const s = store.stats();
    return `${s.carrierPoints}|${s.targetPoints}|${store.carrierSvc.length}|${store.targetSvc.length}|${cfg.showCarrier}|${cfg.showGt}`;
  }

  function polyline(track: TimedTrack, color: string, weight: number, dash?: string, upToT?: number): L.Polyline | undefined {
    const pts: L.LatLngTuple[] = [];
    const n = track.length;
    const stride = Math.max(1, Math.floor(n / 2000));
    for (let i = 0; i < n; i += stride) {
      if (upToT !== undefined && track.t[i]! > upToT) break;
      pts.push([track.lat[i]!, track.lon[i]!]);
    }
    if (pts.length < 2) return undefined;
    return L.polyline(pts, { color, weight, opacity: 0.85, dashArray: dash, renderer: canvasRenderer, interactive: false });
  }

  function drawStatic(): void {
    staticGroup.clearLayers();
    const carrier = store.effectiveCarrier();
    if (cfg.showCarrier) polyline(carrier, "#38bdf8", 2, "6 4")?.addTo(staticGroup);
    if (cfg.showGt) {
      for (const g of store.groundTruthTracks()) polyline(g, "#f97316", 2, "6 4")?.addTo(staticGroup);
    }
    if (!fitted) {
      const pts: L.LatLngTuple[] = [];
      for (const tr of [carrier, ...store.groundTruthTracks()]) {
        for (let i = 0; i < tr.length; i += Math.max(1, Math.floor(tr.length / 200))) pts.push([tr.lat[i]!, tr.lon[i]!]);
      }
      if (pts.length === 0) for (const d of store.detections.slice(0, 500)) pts.push([d.lat, d.lon]);
      if (pts.length > 0) {
        map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 17 });
        fitted = true;
      }
    }
  }

  function ellipse(lat: number, lon: number, cov: number[]): L.Polygon | undefined {
    // ENU covariance (E,N): [0]=ee [1]=en [4]=nn
    const ee = cov[0]!, en = cov[1]!, nn = cov[4]!;
    if (!(ee > 0 || nn > 0)) return undefined;
    const tr = ee + nn;
    const det = ee * nn - en * en;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l1 = tr / 2 + disc;
    const l2 = Math.max(0, tr / 2 - disc);
    const ang = 0.5 * Math.atan2(2 * en, ee - nn);
    const k = 2.4477; // 95 % for 2 dof
    const a = k * Math.sqrt(l1), b = k * Math.sqrt(l2);
    const pts: L.LatLngTuple[] = [];
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
    for (let i = 0; i <= 36; i++) {
      const th = (i / 36) * 2 * Math.PI;
      const x = a * Math.cos(th), y = b * Math.sin(th);
      const e = x * Math.cos(ang) - y * Math.sin(ang);
      const n = x * Math.sin(ang) + y * Math.cos(ang);
      pts.push([lat + n / mPerDegLat, lon + e / mPerDegLon]);
    }
    return L.polygon(pts, { color: "#22c55e", weight: 1, fillOpacity: 0.1, renderer: canvasRenderer, interactive: false });
  }

  function drawDynamic(): void {
    dynGroup.clearLayers();
    const rs = lastRender;
    const curRecv = rs?.currentTime ? timeToSec(rs.currentTime) : Infinity;
    const tCur = Number.isFinite(curRecv) ? store.payloadTimeAt(curRecv) : (store.detections.at(-1)?.t ?? 0);
    const tMin = tCur - cfg.trailSec;
    const gt = store.primaryGroundTruth();
    const carrier = store.effectiveCarrier();

    // markers for carrier + target
    const carrierPos = carrier.at(tCur, 10);
    if (cfg.showCarrier && carrierPos) {
      L.circleMarker([carrierPos.lat, carrierPos.lon], { radius: 7, color: "#0ea5e9", fillColor: "#38bdf8", fillOpacity: 1, weight: 2, renderer: canvasRenderer })
        .bindTooltip("Radar platform").addTo(dynGroup);
      if (cfg.followCarrier) map.panTo([carrierPos.lat, carrierPos.lon], { animate: false });
    }
    const gtPos = gt?.at(tCur, 10);
    if (cfg.showGt && gtPos) {
      L.circleMarker([gtPos.lat, gtPos.lon], { radius: 7, color: "#ea580c", fillColor: "#f97316", fillOpacity: 1, weight: 2, renderer: canvasRenderer })
        .bindTooltip("Ground truth").addTo(dynGroup);
    }

    // detections within trail
    const dets = store.detections;
    let hi = dets.length;
    // detections are in receive order -> binary search for last recv <= cursor
    if (Number.isFinite(curRecv)) {
      let lo = 0;
      hi = dets.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (dets[mid]!.recv <= curRecv) lo = mid + 1;
        else hi = mid;
      }
      hi = lo;
    }
    const visible: GeoDet[] = [];
    for (let i = hi - 1; i >= 0 && visible.length < cfg.maxPoints; i--) {
      const d = dets[i]!;
      if (d.t < tMin) break;
      visible.push(d);
    }
    let nTrue = 0;
    let lastDet: GeoDet | undefined;
    if (cfg.showDetections) {
      for (const d of visible) {
        if (!lastDet || d.t > lastDet.t) lastDet = d;
        let color: string;
        let g: ReturnType<TimedTrack["at"]>;
        if (gt && (cfg.colorBy === "error" || cfg.showErrorLines)) g = gt.at(d.t, 2);
        if (cfg.colorBy === "power") {
          const db = d.power && d.power > 0 ? 10 * Math.log10(d.power) : 0;
          color = ramp((db - 20) / 30);
        } else if (cfg.colorBy === "age") {
          color = ramp(1 - Math.max(0, Math.min(1, (tCur - d.t) / cfg.trailSec)));
        } else if (g) {
          const e = llaToNed(g, d);
          const ok = Math.hypot(e.n, e.e, e.d) <= cfg.gateM;
          if (ok) nTrue++;
          color = ok ? "#22c55e" : "#ef4444";
        } else {
          color = "#9ca3af";
        }
        const age = Math.max(0, Math.min(1, (tCur - d.t) / cfg.trailSec));
        L.circleMarker([d.lat, d.lon], { radius: 3.5, color, fillColor: color, fillOpacity: 0.85 - 0.5 * age, opacity: 0.9 - 0.5 * age, weight: 1, renderer: canvasRenderer })
          .bindTooltip(`t=${d.t.toFixed(2)}  range=${fmt(d.range, 0, " m")}  P=${fmt(d.power && d.power > 0 ? 10 * Math.log10(d.power) : undefined, 1, " dB")}`)
          .addTo(dynGroup);
        if (cfg.showErrorLines && g) {
          L.polyline([[d.lat, d.lon], [g.lat, g.lon]], { color: "#facc15", weight: 1, opacity: 0.5, renderer: canvasRenderer, interactive: false }).addTo(dynGroup);
        }
      }
    }
    if (cfg.showLos && lastDet?.platform) {
      L.polyline([[lastDet.platform.lat, lastDet.platform.lon], [lastDet.lat, lastDet.lon]], { color: "#e5e7eb", weight: 1, opacity: 0.7, dashArray: "2 4", renderer: canvasRenderer, interactive: false }).addTo(dynGroup);
    }

    // tracks
    let trackCount = 0;
    if (cfg.showTracks) {
      const palette = ["#22c55e", "#a855f7", "#eab308", "#06b6d4", "#ec4899", "#84cc16", "#f43f5e", "#14b8a6"];
      let idx = 0;
      for (const s of store.tracks.values()) {
        const color = palette[idx++ % palette.length]!;
        const pts: L.LatLngTuple[] = [];
        let last = undefined as (typeof s.points)[number] | undefined;
        for (const p of s.points) {
          if (Number.isFinite(curRecv) && p.recv > curRecv) break;
          if (p.t < tMin) continue;
          pts.push([p.lat, p.lon]);
          last = p;
        }
        if (!last) continue;
        trackCount++;
        if (pts.length > 1) L.polyline(pts, { color, weight: 2, opacity: 0.9, renderer: canvasRenderer, interactive: false }).addTo(dynGroup);
        L.circleMarker([last.lat, last.lon], { radius: 5, color, fillColor: color, fillOpacity: 1, renderer: canvasRenderer })
          .bindTooltip(`Track ${s.id}${last.state ? " (" + last.state + ")" : ""}`).addTo(dynGroup);
        if (cfg.showCovariance && last.cov) ellipse(last.lat, last.lon, last.cov)?.addTo(dynGroup);
      }
    }

    // HUD
    const st = store.stats();
    const lines: string[] = [];
    lines.push(`t = ${tCur.toFixed(2)} s   (trail ${cfg.trailSec}s)`);
    lines.push(`detections: ${visible.length} shown / ${st.detections} total   tracks: ${trackCount}/${st.tracks}`);
    if (st.pendingLocal > 0 && !st.anchor) lines.push(`⚠ ${st.pendingLocal} local-frame samples waiting for georeference (no platform NavSat / anchor)`);
    if (st.anchor) lines.push(`georef: ${st.anchor.frame} anchor ${st.anchor.lat.toFixed(5)}, ${st.anchor.lon.toFixed(5)} [${st.anchor.source}${st.anchor.residualStd != undefined ? ", σ=" + st.anchor.residualStd.toFixed(1) + " m" : ""}]`);
    if (gtPos && carrierPos) {
      const r = llaToNed(carrierPos, gtPos);
      lines.push(`target range ${Math.hypot(r.n, r.e, r.d).toFixed(0)} m  alt Δ ${(-r.d).toFixed(0)} m`);
    }
    if (cfg.colorBy === "error" && gt) lines.push(`true ${nTrue}/${visible.length} (gate ${cfg.gateM} m)`);
    hud.textContent = lines.join("\n");

    legend.innerHTML = "";
    const item = (c: string, t: string) => legend.append(h("div", {}, h("i", { style: { background: c } }), t));
    if (cfg.showCarrier) item("#38bdf8", "radar platform");
    if (cfg.showGt) item("#f97316", "ground truth");
    if (cfg.showDetections) {
      if (cfg.colorBy === "error") { item("#22c55e", `detection ≤ ${cfg.gateM} m`); item("#ef4444", "false / clutter"); }
      else item(cfg.colorBy === "power" ? ramp(0.8) : ramp(0.9), cfg.colorBy === "power" ? "detection (colour = power)" : "detection (colour = age)");
    }
    if (cfg.showTracks && trackCount > 0) item("#22c55e", "tracks");
  }

  function redraw(): void {
    rafPending = false;
    const s = sig();
    if (s !== staticSig) {
      staticSig = s;
      drawStatic();
    }
    drawDynamic();
  }

  function schedule(): void {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(redraw);
  }

  /* ---------------- settings ---------------- */
  function updateSettings(topics: readonly { name: string; schemaName: string }[]): void {
    const navTopics = topics.filter((t) => classifySchema(t.schemaName, t.name) === "navSat");
    const roleChildren: Record<string, { label: string; fields: Record<string, unknown> }> = {};
    for (const t of navTopics) {
      roleChildren[t.name] = {
        label: t.name,
        fields: {
          role: {
            label: "Role",
            input: "select",
            value: store.roleFor(t.name),
            options: [
              { label: "Radar platform (carrier)", value: "carrier" },
              { label: "Target / ground truth", value: "target" },
              { label: "Ignore", value: "ignore" },
            ],
          },
        },
      };
    }
    context.updatePanelSettingsEditor({
      actionHandler: (action: SettingsTreeAction) => {
        if (action.action !== "update") return;
        const { path, value } = action.payload;
        if (path[0] === "roles" && path[2] === "role") {
          cfg.roles[path[1]!] = value as Role;
          subscribedKey = "";
          persist();
          if (lastRender) subscribeTopics(lastRender);
          return;
        }
        const key = path[1] as keyof Config;
        (cfg as unknown as Record<string, unknown>)[key] = value;
        persist();
        if (["tileMode", "customTileUrl"].includes(key)) applyTiles();
        if (key === "overlayUrl") void applyOverlay();
        if (["anchorMode", "manualLat", "manualLon", "manualAlt", "manualFrame"].includes(key)) applyAnchorConfig();
        staticSig = "";
        schedule();
        updateSettings(topics);
      },
      nodes: {
        display: {
          label: "Display",
          defaultExpansionState: "expanded",
          fields: {
            colorBy: { label: "Detection colour", input: "select", value: cfg.colorBy, options: [{ label: "Power", value: "power" }, { label: "Error vs ground truth", value: "error" }, { label: "Age", value: "age" }] },
            trailSec: { label: "Trail (s)", input: "number", value: cfg.trailSec, min: 1, max: 3600, step: 1 },
            maxPoints: { label: "Max points", input: "number", value: cfg.maxPoints, min: 100, max: 50000, step: 100 },
            gateM: { label: "Gate (m)", input: "number", value: cfg.gateM, min: 1, max: 5000, step: 5 },
            showDetections: { label: "Detections", input: "boolean", value: cfg.showDetections },
            showTracks: { label: "Tracks", input: "boolean", value: cfg.showTracks },
            showGt: { label: "Ground truth", input: "boolean", value: cfg.showGt },
            showCarrier: { label: "Radar platform", input: "boolean", value: cfg.showCarrier },
            showErrorLines: { label: "Error lines", input: "boolean", value: cfg.showErrorLines },
            showCovariance: { label: "Covariance ellipse", input: "boolean", value: cfg.showCovariance },
            showLos: { label: "Line of sight", input: "boolean", value: cfg.showLos },
            followCarrier: { label: "Follow platform", input: "boolean", value: cfg.followCarrier },
          },
        },
        basemap: {
          label: "Basemap",
          fields: {
            tileMode: { label: "Tiles", input: "select", value: cfg.tileMode, options: [{ label: "OpenStreetMap", value: "osm" }, { label: "Satellite (Esri)", value: "satellite" }, { label: "None (offline)", value: "none" }, { label: "Custom URL", value: "custom" }] },
            customTileUrl: { label: "Tile URL", input: "string", value: cfg.customTileUrl, placeholder: "/data/tiles/{z}/{x}/{y}.png" },
            overlayUrl: { label: "Aerial overlay", input: "string", value: cfg.overlayUrl, placeholder: "/data/raw/.../aerialImg2.jpeg (+ .jgw)" },
          },
        },
        georef: {
          label: "Georeference",
          fields: {
            anchorMode: { label: "Local frame anchor", input: "select", value: cfg.anchorMode, options: [{ label: "Auto (from platform NavSat / service)", value: "auto" }, { label: "Manual", value: "manual" }] },
            manualLat: { label: "Anchor lat", input: "number", value: cfg.manualLat, step: 0.00001, precision: 6 },
            manualLon: { label: "Anchor lon", input: "number", value: cfg.manualLon, step: 0.00001, precision: 6 },
            manualAlt: { label: "Anchor alt (m)", input: "number", value: cfg.manualAlt, step: 1 },
            manualFrame: { label: "Local frame", input: "select", value: cfg.manualFrame, options: [{ label: "NED (x=N,y=E,z=Down)", value: "NED" }, { label: "ENU (x=E,y=N,z=Up)", value: "ENU" }] },
          },
        },
        roles: { label: "NavSatFix roles", children: roleChildren as never },
      },
    } as never);
  }

  function persist(): void {
    context.saveState({ ...cfg });
  }

  /* ---------------- lifecycle ---------------- */
  applyTiles();
  void applyOverlay();
  context.watch("allFrames");
  context.watch("currentTime");
  context.watch("topics");
  context.watch("colorScheme");
  context.setDefaultPanelTitle("Radar Map");
  updateSettings([]);
  void loadContext();

  context.onRender = (rs, done) => {
    lastRender = rs;
    if (rs.colorScheme && (rs.colorScheme === "dark") !== dark) {
      dark = rs.colorScheme === "dark";
      root.className = `er-root ${rs.colorScheme}`;
    }
    if (cfg.anchorMode === "manual" && !store.manualAnchor) applyAnchorConfig();
    subscribeTopics(rs);
    void loadContext();
    ingestFrames(rs);
    schedule();
    done();
  };

  const ro = new ResizeObserver(() => map.invalidateSize());
  ro.observe(mapDiv);

  return () => {
    ro.disconnect();
    map.remove();
    root.remove();
    setSharedAnchor(undefined);
  };
}
