// BOARD CHECK — open the real board in a real browser and use it.
//
//   node dashboard/check/board-check.mjs [url ...]
//
// With no urls it checks http://127.0.0.1:8717 and, when remote viewing is on,
// the LAN_ADDRESS from dashboard/.env. redeploy.sh runs it after every deploy.
//
// It opens every panel, tab and dialog an operator can open without changing
// anything, and fails when the page errors, a request fails, the control plane
// is reported unreachable, or a panel that should load its data never asked
// for it. That last one is the silent kind: a panel that quietly skips its
// fetch looks exactly like a panel with nothing to show.
//
// READ-ONLY: every write the page attempts is blocked and reported, except
// previews (they only describe what a write would do).
//
// Playwright comes from grader/node_modules, which the bench already installs.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const { chromium } = createRequire(join(REPO, "grader", "package.json"))("playwright");

function defaultTargets() {
  const targets = ["http://127.0.0.1:8717"];
  try {
    const env = readFileSync(join(HERE, "..", ".env"), "utf8");
    const lan = env.match(/^LAN_ADDRESS=(\S+)/m)?.[1];
    if (lan) targets.push(`http://${lan}:8717`);
  } catch {
    // no dashboard/.env — remote viewing is off
  }
  return targets;
}

async function checkTarget(browser, base) {
  const problems = [];
  const requests = []; // { method, path, status }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const origin = new URL(base).origin;

  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console error: ${msg.text()} (${msg.location()?.url ?? "?"})`);
  });
  page.on("response", (res) => {
    const u = new URL(res.url());
    if (u.origin !== origin || u.pathname === "/api/stream") return;
    requests.push({ method: res.request().method(), path: u.pathname, status: res.status() });
    if (res.status() >= 400) problems.push(`${res.request().method()} ${u.pathname} → ${res.status()}`);
  });
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === "GET" || path.endsWith("/preview")) return route.continue();
    problems.push(`the check tried to write (${req.method()} ${path}) — blocked`);
    return route.abort();
  });

  const settle = (ms = 800) => page.waitForTimeout(ms);
  const click = async (selector, what) => {
    const el = page.locator(selector).first();
    if (!(await el.count())) { problems.push(`missing: ${what}`); return false; }
    try {
      await el.click({ timeout: 3000 });
    } catch {
      problems.push(`could not press ${what}`);
      return false;
    }
    await settle();
    return true;
  };
  // Some lists fill in a beat after their step appears; give them 5s.
  const shows = (selector) =>
    page.waitForSelector(selector, { timeout: 5000 }).then(() => true, () => false);
  const expectFetched = (path, what) => {
    const hits = requests.filter((r) => r.path === path);
    if (!hits.length) problems.push(`${what} never asked for its data (${path})`);
  };

  // ── the board ─────────────────────────────────────────────────────────────
  await page.goto(base, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector(".topbar", { timeout: 15000 });
  } catch {
    problems.push("the board never rendered its top bar");
  }
  await settle(2500);

  if (await page.getByText("CONTROL PLANE NOT REACHABLE").count()) {
    problems.push("the board says the control plane is not reachable");
  }
  for (const s of await page.locator("section.panel").all()) {
    if (!(await s.innerText()).trim()) problems.push("a board panel rendered empty");
  }

  // Tabs are looked up by name each time: a live board redraws between clicks.
  for (const attr of ["data-curve-tab", "data-feedtab"]) {
    const names = await page.locator(`[${attr}]`).evaluateAll((els, a) => els.map((e) => e.getAttribute(a)), attr);
    for (const n of names) await click(`[${attr}="${n}"]`, `the ${n} tab`);
  }
  expectFetched("/api/stats", "the results stats strip");
  expectFetched("/api/backend-feed", "the backend feed");

  // Custom tools drawer.
  if (await click("[data-tools-open]", "the tools menu")) {
    expectFetched("/api/tools", "the tools menu");
    expectFetched("/api/routers", "the router keys list");
    await page.keyboard.press("Escape");
    await settle();
    if (await page.locator("[data-tools-close]").count()) await click("[data-tools-close]", "the tools close button");
  }

  // New-baseline window: local → first model → as far as it goes without
  // launching. Skipped while a run is in flight: the window rightly refuses to
  // go past the model step then.
  const runInFlight = (await page.locator(".topbar .tag.on").count()) > 0;
  if (!runInFlight && (await click("[data-create-open]", "the + BASELINE button"))) {
    await click('[data-create-kind="local"]', "the local baseline choice");
    await click("[data-create-next]", "the next button (kind)");
    await click("[data-create-model]", "a model to pick");
    await click("[data-create-next]", "the next button (model)");
    // In dev mode the next step offers build snapshots — judged from what the
    // top bar says, never from whether the page happened to ask.
    if (await page.locator(".devmode-on").count()) {
      expectFetched("/api/snapshots", "the snapshot step");
      if (!(await shows("[data-seed-pick]"))) problems.push("the snapshot step shows no choices");
      await click("[data-create-next]", "the next button (snapshot)");
    }
    expectFetched("/api/challenges", "the challenge step");
    if (!(await shows("[data-create-challenge]"))) problems.push("the challenge step lists no challenges");
    await page.keyboard.press("Escape");
    await settle();
  }

  if (await click("[data-restore-open]", "the RESTORE button")) {
    expectFetched("/api/backups", "the restore dialog");
    await click("[data-restore-cancel]", "the restore cancel button");
  }
  if (await click("[data-reset-open]", "the RESET button")) {
    expectFetched("/api/tree/reset/preview", "the reset dialog");
    await click("[data-reset-cancel]", "the reset cancel button");
  }

  // ── the history page ──────────────────────────────────────────────────────
  await page.goto(`${base}/history`, { waitUntil: "domcontentloaded" });
  await settle(2000);
  expectFetched("/api/history", "the history page");
  expectFetched("/api/play", "the history page's now-playing line");
  // A fresh machine has no runs; when there are some, opening one must load it.
  if (await page.locator("[data-run]").count()) {
    await page.locator("[data-run]").first().click();
    await settle(1500);
    expectFetched("/api/history/checkpoints", "a history row");
  }

  await page.close();
  return problems;
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : defaultTargets();
const browser = await chromium.launch();
let failed = false;
try {
  for (const base of targets) {
    const problems = [...new Set(await checkTarget(browser, base))];
    if (problems.length) {
      failed = true;
      console.log(`✗ ${base}`);
      for (const p of problems) console.log(`    ${p}`);
    } else {
      console.log(`✓ ${base} — every panel, tab and dialog loaded`);
    }
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
