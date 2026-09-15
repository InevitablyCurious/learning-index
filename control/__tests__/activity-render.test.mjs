// Extracted verbatim from control/control.test.mjs — WO-LI18 split A.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { restatement, RESUME_UNSUPPORTED } from "../contract.mjs";
import { mapEvent, EventRing } from "../events.mjs";

import { BENCH } from "./_shared.mjs";

test("COMPACTION: the panel proposes, the server decides", () => {
  const src = readFileSync(join(BENCH, "dashboard", "panels", "create.js"), "utf8");
  // The panel holds a TRI-STATE and only sends the field when the operator
  // actually touched it. Sending `false` for "untouched" would strip compaction
  // from every model whose window asked for it.
  assert.match(src, /if \(ui\.compact !== null\) payload\.compact = ui\.compact;/);
  // And it renders a warning when the toggle is off — the failure it prevents
  // is silent and only surfaces hours later.
  assert.match(src, /function compactOffWarning\(/);
  assert.match(src, /\$\{compactOn \? "" : compactOffWarning\(compactDefault\)\}/);
});

test("COMPACTION: the ON arm gets a confirmation frame too", () => {
  // [+ run] used to jump straight to the launch checklist, so an ON cell was
  // the only cell that started without the operator seeing how it was
  // configured — including whether it would compact. An ON cell whose
  // compaction silently disagreed with its floor yields a delta measuring
  // compaction rather than memory.
  const panel = readFileSync(join(BENCH, "dashboard", "panels", "create.js"), "utf8");
  assert.match(panel, /export function openCellConfirm\(/);
  const board = readFileSync(join(BENCH, "dashboard", "board.js"), "utf8");
  assert.ok(
    !/doLaunchBaseline\(\{\s*model: t\.dataset\.runModel/.test(board),
    "[+ run] must enter the confirm frame, not jump straight to the launch checklist",
  );
  assert.match(board, /openCellConfirm\(\{/);
});

test("restatement names the arm in words, not just a code", () => {
  const on = restatement({ model: "m", arm: "on", org: "o", context: 262144 });
  assert.match(on, /MEMORY ON/);
  const off = restatement({ model: "m", arm: "off", org: null, context: null });
  assert.match(off, /CONTROL/);
  // A control cell must say the org is not applicable rather than silently
  // omitting the line — an absent line reads as an unanswered question.
  assert.match(off, /not applicable/);
});

// ── RESUME: the capability is declared false, with a reason ──────────────────

test("resume is unsupported and says why", () => {
  assert.equal(RESUME_UNSUPPORTED.supported, false);
  assert.match(RESUME_UNSUPPORTED.reason, /no mid-cell checkpoint/);
  assert.equal(RESUME_UNSUPPORTED.alternative, "archive_and_restart");
});

// ── EVENTS ───────────────────────────────────────────────────────────────────
//
// FIXTURES ARE REAL WIRE SHAPES. These were rebuilt from a live 45s capture
// against a running cell after the original fixtures — written from the `/doc`
// OpenAPI Event union — were found to describe events the pinned worker never
// emits. The schema advertises a full `session.next.*` family; the worker
// actually emits `message.part.updated` carrying a Part. Testing against the
// schema passed while production mapped 5 of 1635 events, so these fixtures
// must stay wire-shaped, never schema-shaped.

test("a failed tool call is mapped to the error kind, not the tool kind", () => {
  const ev = mapEvent({
    id: "evt_1",
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      part: {
        id: "prt_1", sessionID: "ses_1", type: "tool", tool: "edit",
        state: { status: "error", error: { data: { message: "boom" } } },
      },
    },
  });
  assert.equal(ev.kind, "error");
  assert.equal(ev.tool, "edit");
  assert.equal(ev.text, "boom");
});

test("a step is lifecycle, NOT error", () => {
  // A step finishing on `tool-calls` is the system working as designed.
  // Rendering it in the fail colour would read as alarm at the moment the
  // instrument is behaving correctly.
  const ev = mapEvent({
    id: "evt_2",
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      part: {
        id: "prt_2", sessionID: "ses_1", type: "step-finish",
        reason: "tool-calls", tokens: { input: 41000, output: 120 },
      },
    },
  });
  assert.equal(ev.kind, "lifecycle");
  assert.ok(ev.detail.includes("tool-calls"));
});

test("tool input is summarised, never dumped", () => {
  const big = "x".repeat(50000);
  const ev = mapEvent({
    id: "evt_3",
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      part: {
        id: "prt_3", sessionID: "ses_1", type: "tool", tool: "write",
        state: { status: "running", input: { filePath: "/a/b.ts", content: big } },
      },
    },
  });
  assert.equal(ev.text, "/a/b.ts");
  assert.ok(!String(ev.text).includes("xxxx"));
});

test("long tool input text is truncated and says so", () => {
  const ev = mapEvent({
    id: "evt_4",
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      part: {
        id: "prt_4", sessionID: "ses_1", type: "tool", tool: "bash",
        state: { status: "running", input: { command: "y".repeat(5000) } },
      },
    },
  });
  assert.equal(ev.truncated, true);
  assert.ok(ev.text.length <= 400);
});

test("the token stream is dropped, not rendered as one row per token", () => {
  // message.part.delta is ~83% of all traffic and carries no standalone
  // meaning — the completed part arrives separately. Mapping it would flood
  // the feed and push every real event out of the ring.
  const ev = mapEvent({
    id: "evt_5",
    type: "message.part.delta",
    properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", field: "text", delta: "a" },
  });
  assert.equal(ev, null);
});

test("assistant prose is not an activity row", () => {
  // `text` parts belong in the TRANSCRIPT tab. In the EVENTS feed they would
  // drown the tool calls the feed exists to show.
  const ev = mapEvent({
    id: "evt_6",
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      part: { id: "prt_6", sessionID: "ses_1", type: "text", text: "hello" },
    },
  });
  assert.equal(ev, null);
});

test("an event with no timestamp keeps a null time, never a fabricated one", () => {
  // Stamping Date.now() on an event that never carried a time would fabricate
  // ordering evidence the feed then displays as fact.
  const ev = mapEvent({
    id: "evt_7",
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      part: { id: "prt_7", sessionID: "ses_1", type: "step-start" },
    },
  });
  assert.equal(ev.at, null);
});

test("an unmapped event is counted, never silently dropped", () => {
  const ring = new EventRing(10);
  ring.push({ id: "e", type: "some.future.event", properties: {} });
  const snap = ring.snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.unmapped, 1);
  assert.equal(snap.events.length, 0);
  // An unmapped frame must NOT make the ring claim it dropped data.
  assert.equal(snap.capped, false, "unmapped frames are not lost renderable events");
});

// ── ADMIT: the out-of-ring rows, and the re-append defect ───────────────────
//
// Harness grading rows and the verbatim messages the model was sent are
// rebuilt FROM FILES on every poll. They are already in BoardEvent shape, so
// they cannot go through `push()`, and giving them a seq at request time from
// the ring's moving cursor made the same row arrive with a NEW seq every poll.
// The renderer appends anything with `seq > renderedSeq`, so it appended the
// same row again and again. Measured on a live run: one `task chunk
// (attempt 1)` came back as seq 706, then 713, then higher.

