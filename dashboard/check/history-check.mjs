// Exercise expansion on the served page, including placement in the viewport.
// Read-only: uses the existing history and blocks every non-GET API request.
// node dashboard/check/history-check.mjs [http://127.0.0.1:8717]
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { chromium } = createRequire(new URL("../../grader/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:8717";
const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const width of [1440, 800]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.route("**/api/**", (route) => route.request().method() === "GET" ? route.continue() : route.abort());
    await page.goto(`${base}/history`);
    await page.waitForSelector("[data-run]");
    const rows = page.locator("[data-run]");
    const rowCount = await rows.count();
    assert.ok(rowCount > 1, "requires at least two recorded runs to check inline placement");
    for (const index of [0, 1]) {
      const response = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/history/checkpoints");
      await rows.nth(index).click();
      const res = await response;
      assert.equal(res.status(), 200);
      const data = await res.json();
      await page.waitForFunction(() => !document.querySelector(".hist-cps")?.textContent.includes("reading checkpoints"));
      assert.equal(await rows.nth(index).getAttribute("aria-expanded"), "true");
      const placement = await rows.nth(index).evaluate((row) => {
        const details = row.parentElement.nextElementSibling;
        return { id: details?.id, top: details?.getBoundingClientRect().top, viewport: innerHeight };
      });
      assert.equal(placement.id, "history-details", "details must immediately follow the selected row");
      assert.ok(placement.top >= 0 && placement.top < placement.viewport, JSON.stringify(placement));
      assert.equal(await page.locator("[data-cp]").count(), data.checkpoints?.length ?? 0);

      const changed = data.diffs?.find((diff) => diff.files?.length);
      if (changed) {
        await page.locator(`[data-cp="${changed.to}"]`).click();
        const files = page.locator("[data-file]");
        assert.equal(await files.count(), changed.files.length);
        await files.first().click();
        await page.waitForSelector(".hist-diff .d2h-file-wrapper");
      }
      await rows.nth(index).click();
      assert.equal(await page.locator("#history-details").count(), 0);
      assert.equal(await rows.nth(index).getAttribute("aria-expanded"), "false");
      console.log(JSON.stringify({ width, row: index, checkpoints: data.checkpoints?.length ?? 0, files: changed?.files.length ?? 0, placement, collapsed: true }));
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser.close();
}
