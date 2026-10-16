// ─────────────────────────────────────────────────────────────────────────────
// PAUSE PANEL + PAUSE-AFTER-EACH-GRADE TOGGLE
//
//     cd dashboard && node --test
//
// Pins the pause surfaces the operator meets:
//
//   1. The pause panel renders for kind "round" and kind "final", with the
//      player-facing words from the brief.
//   2. told_text is ESCAPED — a told_text containing "<script>" must render as
//      text, never as markup (it is model-facing prose about to be sent).
//   3. The note box caps at 4000 chars and shows a live count.
//   4. The release call carries {note} ONLY when the box is non-empty; an empty
//      box sends no body.
//   5. The confirm-step pause toggle is visible ONLY in dev mode, defaults ON,
//      and reaches the start payload as pauseAfterGrade when on — but is never
//      sent when dev mode is off.
//   6. The tab-title prefix flips on a pause hold and restores after.
//
// Render tests import hold.js and create.js directly (no DOM), following the
// idiom in startup-feed.test.mjs. The release call drives board-actions'
// releaseHold against a body-capture fetch stub (devmode.test.mjs idiom).
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderHold, setHoldNote, holdNoteValue, resetHoldUi } from "./panels/hold.js";
import { releaseBody } from "./board-actions.js";
import {
  openCellConfirm,
  renderCreate,
  launchCell,
  toggleCreatePause,
} from "./panels/create.js";

// ── the pause-panel render states ────────────────────────────────────────────

const ROUND = {
  hold: {
    schema_version: 2,
    status: "held",
    kind: "round",
    attempt: 2,
    max_attempts: 4,
    held_seconds: 90,
    told_text: "Troubleshoot the broken gate.\nDo not guess.",
    url: "http://127.0.0.1:7718/game",
    ui_healthy: true,
    hold_path: "/run/x/hold-ui.json",
    grade: {
      verdict: "FAIL",
      n_problems: 12,
      failed_gates: ["[E02] a gate name", "[E07] another", "[E11] third", "[E40] fourth"],
    },
    release: { path: "/run/x/release" },
  },
};

const FINAL = {
  hold: {
    ...ROUND.hold,
    kind: "final",
    attempt: 4,
    told_text: null,
    grade: { verdict: "PASS", n_problems: 3, failed_gates: [] },
  },
};

const board = (hold) => ({ hold, run: {}, control: { capabilities: {} } });

test("round: the title and the waiting line are the player-facing words", () => {
  const html = renderHold(board(ROUND.hold));
  assert.match(html, /PAUSED — round 2 of 4 graded/);
  assert.match(html, /Nothing has been sent to the model yet\. It is waiting for you\./);
});

test("round: the grade line shows problems, failing checks, and the first gate names", () => {
  const html = renderHold(board(ROUND.hold));
  assert.match(html, /12 problems/);
  assert.match(html, /4 checks failing/);
  assert.ok(html.includes("[E02] a gate name"), "the first failing gate name is shown");
  assert.ok(html.includes("[E07] another"), "the second failing gate name is shown");
  // Only the first few are shown, not the whole list.
  assert.ok(!html.includes("[E40] fourth"), "only the first few failing gates are named");
});

test("round: PASS shows 'every check passes' and no gate names", () => {
  const html = renderHold(board({
    ...ROUND.hold,
    grade: { verdict: "PASS", n_problems: 5, failed_gates: [] },
  }));
  assert.match(html, /5 problems/);
  assert.match(html, /every check passes/);
  assert.ok(!html.includes("checks failing"));
});

test("the play-the-game link is prominent and opens a new tab", () => {
  const html = renderHold(board(ROUND.hold));
  assert.match(html, /▶ Play the game as it is now/);
  assert.ok(html.includes('href="http://127.0.0.1:7718/game"'));
  assert.ok(html.includes('target="_blank"'));
});

test("the told_text block is escaped — a told_text with <script> renders as text", () => {
  const evil = { ...ROUND.hold, told_text: "<script>alert(1)</script><img src=x>" };
  const html = renderHold(board(evil));
  assert.ok(!html.includes("<script>alert"), "markup reached the DOM unescaped");
  assert.ok(html.includes("&lt;script&gt;"), "it must render as escaped text");
  assert.match(html, /What the model will be told next:/);
});

test("final: the title, the no-more-will-be-sent line, and the end-the-run button", () => {
  const html = renderHold(board(FINAL.hold));
  assert.match(html, /PAUSED — final grade \(4 of 4\)/);
  assert.match(html, /This was the last grade; nothing more will be sent\./);
  assert.ok(!html.includes("What the model will be told next"), "final has no told-lines block");
  assert.match(html, /Continue — end the run/);
});

test("a ui-healthy=false hold still allows Continue/Stop and shows the boot detail", () => {
  const html = renderHold(board({
    ...ROUND.hold,
    ui_healthy: false,
    boot_detail: "exit 1: build failed",
    server_log: "/run/x/server.log",
    url: null,
  }));
  assert.match(html, /The game did not start\./);
  assert.match(html, /exit 1: build failed/, "the boot detail is shown");
  assert.match(html, /server\.log/, "the log path is shown");
  assert.match(html, /Continue — send this to the model/);
  assert.match(html, /Stop the run/);
});

test("LAN-reachable: the normal pause panel with one quiet line, never a failure band", () => {
  const html = renderHold(board({
    ...ROUND.hold,
    bind: { lan_reachable: true, lan_address: "192.168.1.20:7718" },
  }));
  assert.ok(!html.includes("LAN EXPOSED"), "the failure band must be gone");
  assert.ok(!html.includes("RELEASE ANYWAY"), "the old LAN wording must be gone");
  assert.match(html, /While paused, this game can also be reached from other devices on your network \(192\.168\.1\.20:7718\)/);
});

test("released: a short neutral line (the hold is gone, round or final)", () => {
  const html = renderHold(board({ released: true }));
  assert.match(html, /RELEASED/);
  assert.match(html, /carries on from where it stopped/);
});

test("final: the final build gets the grade line and its own note box", () => {
  const html = renderHold(board(FINAL.hold));
  assert.match(html, /problems/);
  assert.match(html, /Your note on the final build \(saved for Claude, never sent to the model\)/);
  assert.doesNotMatch(html, /What the model will be told next/);
});

test("a hold the board cannot read says so plainly and offers Stop — no fallback review surface", () => {
  for (const h of [
    { invalid_schema: true, schema_version: 1, hold_path: "/runs/x/hold-ui.json", reason: "only v2 is produced" },
    { schema_version: 2, status: "held", url: "http://localhost:1" },
  ]) {
    const html = renderHold(board(h));
    assert.match(html, /THIS PAUSE CAN'T BE SHOWN|THIS PAUSE CAN&#39;T BE SHOWN/);
    assert.match(html, /data-stop-open/);
    assert.doesNotMatch(html, /data-hold-release|data-hold-continue|HELD — REVIEW/);
  }
});

test("no hold renders nothing", () => {
  assert.equal(renderHold(board(null)), "");
});

// ── the note box ─────────────────────────────────────────────────────────────

test("the note box caps at 4000 chars and shows a live count", () => {
  resetHoldUi(ROUND.hold); // prime: this hold's note is now the one being tracked
  setHoldNote("hi");
  const html = renderHold(board(ROUND.hold));
  assert.ok(html.includes('maxlength="4000"'), "the 4000-char cap is enforced in the textarea");
  assert.match(html, /2 \/ 4000/, "the count reflects the current note");
  assert.match(html, /saved for Claude, never sent to the model/);
});

test("a new hold resets the previous hold's note", () => {
  resetHoldUi(ROUND.hold);
  setHoldNote("stale note");
  assert.equal(holdNoteValue(), "stale note");
  // A DIFFERENT hold path clears it.
  resetHoldUi({ ...ROUND.hold, hold_path: "/run/other/hold-ui.json" });
  assert.equal(holdNoteValue(), "", "the note belongs to one hold, not the previous");
});

// ── the release call carries the note only when non-empty ────────────────────

test("the next pause of the same cell starts with an empty note box", () => {
  // Every pause reuses the cell's one hold file: same path, next attempt.
  renderHold(board(ROUND.hold));
  setHoldNote("round 2 looked fine");
  assert.equal(holdNoteValue(), "round 2 looked fine");
  renderHold(board({ ...ROUND.hold, attempt: 3, started_at: "2026-10-14T23:00:00Z" }));
  assert.equal(holdNoteValue(), "", "a note must never carry over to the next round's pause");
});

test("the release body carries {note} only when the note is non-empty", () => {
  assert.deepEqual(releaseBody("a real note"), { note: "a real note" });
  assert.deepEqual(releaseBody("   "), null, "whitespace counts as empty");
  assert.deepEqual(releaseBody(""), null, "an empty note sends no body");
  assert.deepEqual(releaseBody(null), null, "no note sends no body");
});

// ── the confirm-step pause toggle ────────────────────────────────────────────

/** A board whose ledger answers the confirm frame and dev mode is on. */
const BOARD = {
  models_ledger: {
    startable: [{ id: "a/model", label: "A Model", context: 262144 }],
    cloud: { spend_ceiling_usd: 5, spend_note: "" },
  },
  control: { capabilities: { dev_mode: { enabled: true } } },
};

test("the pause toggle renders ONLY in dev mode, default ON", () => {
  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });
  const html = renderCreate(BOARD);
  assert.match(html, /PAUSE AFTER EACH GRADE: ON/, "the toggle defaults on");
  assert.ok(html.includes("data-create-pause"), "the click hook the board routes on");
  assert.match(html, /The run stops after every grade so you can play the game and read what the model will be told, before anything is sent\./);
});

test("the pause toggle is hidden entirely when dev mode is off", () => {
  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });
  const html = renderCreate({
    ...BOARD,
    control: { capabilities: { dev_mode: { enabled: false } } },
  });
  assert.ok(!html.includes("PAUSE AFTER EACH GRADE"), "no toggle when dev mode is off");
  assert.ok(!html.includes("data-create-pause"));
});

test("pause on reaches the start payload as pauseAfterGrade (dev mode on)", async () => {
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method ?? "GET";
    seen.push({ url: u, method, opts });
    if (u.startsWith("/api/preflight")) {
      return { ok: true, status: 200, json: async () => ({ verdict: "go", blocking_failures: 0, checks: [] }) };
    }
    if (u === "/api/run/preview" && method === "POST") {
      return { ok: true, status: 200, json: async () => ({ ok: true, token: "t" }) };
    }
    if (u === "/api/run/start" && method === "POST") {
      return { ok: true, status: 200, json: async () => ({ ok: true, pid: 1 }) };
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };

  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });
  // Default ON; confirm the toggle is on, then launch with dev mode on.
  await launchCell({ devOn: true });

  const start = seen.find((c) => c.url === "/api/run/start" && c.method === "POST");
  const body = JSON.parse(start.opts.body);
  assert.equal(body.pauseAfterGrade, true, "the start body carries pauseAfterGrade: true");
});

test("pause is never sent when dev mode is off", async () => {
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method ?? "GET";
    seen.push({ url: u, method, opts });
    if (u.startsWith("/api/preflight")) {
      return { ok: true, status: 200, json: async () => ({ verdict: "go", blocking_failures: 0, checks: [] }) };
    }
    if (u === "/api/run/preview" && method === "POST") {
      return { ok: true, status: 200, json: async () => ({ ok: true, token: "t" }) };
    }
    if (u === "/api/run/start" && method === "POST") {
      return { ok: true, status: 200, json: async () => ({ ok: true, pid: 1 }) };
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };

  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });
  toggleCreatePause(); // force it to whatever; the point is dev mode is off
  await launchCell({ devOn: false });

  const start = seen.find((c) => c.url === "/api/run/start" && c.method === "POST");
  const body = JSON.parse(start.opts.body);
  assert.ok(!("pauseAfterGrade" in body), "dev mode off means the key is never sent");
});

// ── the tab-title prefix ─────────────────────────────────────────────────────

test("paintTitle prefixes while a pause hold is shown and restores after", async () => {
  // paintTitle is module-private in board.js, invoked from render() (which the
  // browser boot guard calls every frame). Under Node there is no DOM, so we
  // pin the behaviour structurally: the per-frame painter exists, keys on a
  // non-released round/final hold, and uses the exact prefix and restore title.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./board.js", import.meta.url), "utf8");
  assert.match(src, /⏸ Paused — your turn · Bench Board v2/, "the pause prefix is exact");
  assert.match(src, /document\.title = paused \? /, "the title is set from a paused boolean");
  assert.match(src, /h\.kind === "round" \|\| h\.kind === "final"/, "only a round/final hold pauses");
  assert.match(src, /Bench Board v2" ?:/, "the restored (non-paused) title is the board name");
  assert.match(src, /function paintTitle/, "it rides the board's own render (no new timer)");
});
test("the pause says whether the dice are fixed, and why not when they aren't", () => {
  const fixed = renderHold(board({ ...ROUND.hold, dice: { fixed: true, queued: 60, opening: [5, 3], detail: null } }));
  assert.match(fixed, /The dice are fixed for this pause: you open with <span class="bright">5<\/span> against the computer's <span class="bright">3<\/span>/);
  const random = renderHold(board({ ...ROUND.hold, started_at: "x2", dice: { fixed: false, queued: 0, opening: [5, 3], detail: "/api/debug/roll failed: HTTP 404" } }));
  assert.match(random, /The dice are random this time — fixing them failed: \/api\/debug\/roll failed: HTTP 404/);
});
