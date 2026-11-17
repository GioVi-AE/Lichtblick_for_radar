// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
import { registerConverters } from "./converters";
import { ExtensionContext } from "./lichtblick";
import { initKpiDashboard } from "./panels/kpiDashboard";
import { initRadarMap } from "./panels/radarMap";
import { initRunBrowser } from "./panels/runBrowser";
import { initRvMap } from "./panels/rvMap";

export function activate(extensionContext: ExtensionContext): void {
  registerConverters(extensionContext);
  extensionContext.registerPanel({ name: "RadarMap", initPanel: initRadarMap });
  extensionContext.registerPanel({ name: "RadarKpi", initPanel: initKpiDashboard });
  extensionContext.registerPanel({ name: "RvMap", initPanel: initRvMap });
  extensionContext.registerPanel({ name: "RadarRuns", initPanel: initRunBrowser });
}
