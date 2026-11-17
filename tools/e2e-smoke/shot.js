// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
// Headless smoke test: open the app (optionally with a bag), print console errors, save a screenshot.
//   docker run --rm --network host -v "$PWD/tools/e2e-smoke":/pw -w /pw mcr.microsoft.com/playwright:v1.49.1-jammy \
//     sh -c "npm i playwright@1.49.1 >/dev/null && node shot.js <url> <wait_ms> <name>"
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const p = await b.newPage({ viewport: { width: 1700, height: 950 } });
  const errs = [];
  p.on("console", (m) => { if (m.type() === "error") errs.push("error: " + m.text().slice(0, 300)); });
  p.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 400)));
  await p.goto(process.argv[2], { waitUntil: "load" });
  await p.waitForTimeout(Number(process.argv[3] || 15000));
  await p.screenshot({ path: `/pw/${process.argv[4] || "shot"}.png` });
  console.log(errs.slice(0, 25).join("\n") || "no console errors");
  await b.close();
})();
