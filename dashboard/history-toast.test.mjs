// Toasts on /history.
//
// THE RULE THEY SERVE: standardise the view, never the data. This bench's
// history is heterogeneous — runs stopped early, trees written before the
// conventions this code knows, cells that never reached a build. None of that
// is repaired on the way to the screen. Anything that cannot be shown or done
// says WHY, in a sentence that can be copied and handed to somebody else.
//
// So what is tested here is that the reason SURVIVES: verbatim into the toast,
// verbatim into the clipboard block, with the row it came from attached.

import assert from "node:assert/strict";
import test from "node:test";

import {
  copyToast,
  currentToasts,
  dismissToast,
  renderToast,
  renderToasts,
  startPlay,
  toast,
  toastText,
} from "./history.js";

function clearToasts() {
  for (const t of [...currentToasts()]) dismissToast(t.id);
}

test("a toast keeps the code, the reason and where it happened", () => {
  clearToasts();
  const t = toast({
    code: "no_build",
    reason: "no build to play at /runs/x/worktree — this cell produced no source tree",
    where: "1788804359 · cell-0000",
  });
  assert.equal(t.code, "no_build");
  assert.match(t.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(currentToasts().length, 1);
});

test("the copy block carries everything needed to act on it", () => {
  const text = toastText({
    code: "port_ignored",
    reason: "this build ignores the PORT it is given and binds a fixed port",
    where: "1788804359 · cell-0000",
    detail: '{"error":"Error: not implemented"}',
    at: "2026-09-10T09:00:00.000Z",
  });
  assert.match(text, /^\[port_ignored\] this build ignores the PORT/);
  assert.match(text, /^where: 1788804359 · cell-0000$/m);
  assert.match(text, /^detail: \{"error":"Error: not implemented"\}$/m);
  assert.match(text, /^at: 2026-09-10T09:00:00\.000Z$/m);
});

test("renderToast offers copy and dismiss, and escapes the reason", () => {
  const html = renderToast({
    id: "t1",
    code: "boot_failed",
    reason: '<script>alert(1)</script> & "quoted"',
    where: "r · c",
  });
  assert.match(html, /data-toast-copy="t1"/);
  assert.match(html, /data-toast-close="t1"/);
  assert.ok(!html.includes("<script>"), "the reason is data, not markup");
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test("repeats are NOT collapsed — the same failure twice is two facts", () => {
  clearToasts();
  toast({ code: "no_build", reason: "same", where: "a" });
  toast({ code: "no_build", reason: "same", where: "b" });
  assert.equal(currentToasts().length, 2);
});

test("the list is bounded so a storm cannot bury the page", () => {
  clearToasts();
  for (let i = 0; i < 12; i++) toast({ code: "x", reason: `r${i}` });
  assert.equal(currentToasts().length, 5);
  assert.equal(currentToasts().at(-1).reason, "r11", "the newest survive");
});

test("dismiss removes exactly one", () => {
  clearToasts();
  const a = toast({ code: "a", reason: "a" });
  toast({ code: "b", reason: "b" });
  dismissToast(a.id);
  assert.deepEqual(currentToasts().map((t) => t.code), ["b"]);
});

test("copyToast writes the pasteable block to the clipboard", async () => {
  clearToasts();
  const t = toast({ code: "no_entrypoint", reason: "nothing says how to start it", where: "r · c" });
  const written = [];
  const realNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (s) => written.push(s) } },
    configurable: true,
  });
  try {
    assert.equal(await copyToast(t.id), true);
    assert.match(written[0], /\[no_entrypoint\] nothing says how to start it/);
    assert.match(written[0], /where: r · c/);
  } finally {
    Object.defineProperty(globalThis, "navigator", realNav);
  }
});

test("a denied clipboard is reported, never thrown", async () => {
  clearToasts();
  const t = toast({ code: "x", reason: "y" });
  const realNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async () => { throw new Error("denied"); } } },
    configurable: true,
  });
  try {
    assert.equal(await copyToast(t.id), false);
  } finally {
    Object.defineProperty(globalThis, "navigator", realNav);
  }
});

// ── the refusals actually reach it ──────────────────────────────────────────

function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  return fn().finally(() => { globalThis.fetch = real; });
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

test("a play refusal reaches a toast with its code, reason and row", async () => {
  clearToasts();
  await withFetch(
    async (url) =>
      json(404, {
            ok: false,
            code: "no_build",
            reason: "no build to play at /runs/x/worktree — this cell produced no source tree",
          }),
    async () => {
      await startPlay("1788804359", "cell-0000", () => {});
      const [t] = currentToasts();
      assert.equal(t.code, "no_build", "the SERVER's code, not a generic one");
      assert.match(t.reason, /no source tree/);
      assert.match(t.where, /1788804359 · cell-0000/);
    },
  );
});

test("a build that boots but cannot serve its page toasts too, with the body", async () => {
  clearToasts();
  await withFetch(
    async (url) =>
      json(200, {
            ok: true,
            url: "http://localhost:5/",
            port: 5,
            pid: 1,
            page_status: 500,
            page_excerpt: '{"error":"Error: not implemented"}',
          }),
    async () => {
      const opened = [];
      await startPlay("r", "c", (u) => opened.push(u));
      // It still opens — seeing a broken board is the point.
      assert.deepEqual(opened, ["http://localhost:5/"]);
      const [t] = currentToasts();
      assert.equal(t.code, "page_not_served");
      assert.match(t.reason, /answered HTTP 500/);
      assert.match(toastText(t), /not implemented/);
    },
  );
});

test("renderToasts renders the whole list", () => {
  clearToasts();
  toast({ code: "a", reason: "one" });
  toast({ code: "b", reason: "two" });
  const html = renderToasts({ items: currentToasts() });
  assert.match(html, /one/);
  assert.match(html, /two/);
});

test("an open debug seam is toasted, and says why no gate caught it", async () => {
  clearToasts();
  await withFetch(
    async (url) =>
      json(200, {
            ok: true, url: "http://localhost:5/", port: 5, pid: 1,
            page_status: 200, page_excerpt: "<html>",
            debug_seam_open: true, debug_seam_status: 200,
          }),
    async () => {
      await startPlay("r", "c", () => {});
      const t = currentToasts().at(-1);
      assert.equal(t.code, "debug_seam_open");
      assert.match(t.reason, /No gate checks this/);
    },
  );
});

test("a closed debug seam is silent", async () => {
  clearToasts();
  await withFetch(
    async (url) =>
      json(200, {
            ok: true, url: "http://localhost:5/", port: 5, pid: 1,
            page_status: 200, debug_seam_open: false, debug_seam_status: 404,
          }),
    async () => {
      await startPlay("r", "c", () => {});
      assert.equal(currentToasts().length, 0, "a healthy build raises nothing");
    },
  );
});
