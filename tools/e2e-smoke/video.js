// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
// Records a webm of: open app -> pick a run (time-fixed copy) -> play.
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const ctx = await b.newContext({ viewport: { width: 1500, height: 850 }, recordVideo: { dir: "/pw/video", size: { width: 1500, height: 850 } } });
  const p = await ctx.newPage();
  await p.goto(process.argv[2], { waitUntil: "load" });
  await p.waitForTimeout(12000);
  await p.screenshot({ path: "/pw/start.png" });
  await p.keyboard.press("Escape");
  await p.waitForTimeout(25000);
  await p.keyboard.press("Space");
  await p.waitForTimeout(40000);
  await p.screenshot({ path: "/pw/play.png" });
  await ctx.close();
  await b.close();
})();
