// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
// UI flow: Run browser -> "Fix time + open" on a seconds-bag -> play -> screenshots.
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const p = await b.newPage({ viewport: { width: 1700, height: 950 } });
  const errs = [];
  p.on("console", (m) => { if (m.type() === "error") errs.push("error: " + m.text().slice(0, 300)); });
  p.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 400)));
  await p.goto(process.argv[2], { waitUntil: "load" });
  await p.waitForTimeout(12000);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(1000);
  const row = p.locator("tr", { hasText: process.argv[3] }).first();
  console.log("row found:", await row.count());
  await row.locator("button", { hasText: /Fix time|Open/ }).click();
  await p.waitForURL(/ds\.url=/, { timeout: 120000 });
  console.log("opened:", p.url());
  await p.waitForTimeout(25000);
  await p.keyboard.press("Space");
  await p.waitForTimeout(15000);
  await p.screenshot({ path: "/pw/flow1.png" });
  await p.waitForTimeout(15000);
  await p.screenshot({ path: "/pw/flow2.png" });
  console.log(errs.slice(0, 25).join("\n") || "no console errors");
  await b.close();
})();
