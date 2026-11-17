// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
// Subscribes a panel to the radar-relevant topics (preloaded) and feeds a RadarStore.

import { MessageEvent, PanelExtensionContext, RenderState, Subscription } from "./lichtblick";
import { RadarStore, Role, classifySchema, detectCarrierNamespace } from "./radarData";

const KINDS = new Set(["radarDetection", "cvDetection", "trackArray", "geoTrack", "detectionArray", "groundTruth", "navSat", "odometryGt"]);

export class DataFeed {
  readonly store = new RadarStore();
  private processed = 0;
  private first: unknown;
  private key = "";

  constructor(
    private readonly context: PanelExtensionContext,
    private readonly roles: Record<string, Role> = {},
  ) {}

  /** Returns true if new data was ingested. */
  update(rs: RenderState): boolean {
    this.store.roles = this.roles;
    const topics = (rs.topics ?? []).filter((t) => KINDS.has(classifySchema(t.schemaName, t.name)));
    this.store.carrierNs = detectCarrierNamespace(rs.topics ?? []);
    const subs: Subscription[] = [];
    for (const t of topics) {
      if (classifySchema(t.schemaName, t.name) === "navSat" && this.store.roleFor(t.name) === "ignore") continue;
      subs.push({ topic: t.name, preload: true });
    }
    const key = subs.map((s) => s.topic).sort().join("|");
    if (key !== this.key) {
      this.key = key;
      this.context.subscribe(subs);
      this.processed = 0;
      this.store.reset();
    }
    const all = rs.allFrames;
    let changed = false;
    if (all) {
      if (all.length < this.processed || (all.length > 0 && this.first !== undefined && all[0] !== this.first)) {
        this.processed = 0;
        this.store.reset();
      }
      this.first = all[0];
      if (all.length > this.processed) {
        for (let i = this.processed; i < all.length; i++) this.store.ingest(all[i] as MessageEvent);
        this.processed = all.length;
        changed = true;
      }
    }
    this.store.resolve();
    return changed;
  }

  reset(): void {
    this.processed = 0;
    this.store.reset();
  }
}
