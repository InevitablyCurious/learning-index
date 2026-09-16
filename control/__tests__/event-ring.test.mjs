// Extracted verbatim from control/control.test.mjs — WO-LI18 split A.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EVENT_RING_MAX, EVENT_RENDER_CAP, GATE_STALL_THRESHOLD_S } from "../contract.mjs";
import { EventRing, mergeGrading } from "../events.mjs";
import { parseGateEvents, gradingStatus } from "../gate-events.mjs";

import { BENCH } from "./_shared.mjs";

test("ADMIT: the same row keeps its seq no matter how far the ring advances", () => {
  const ring = new EventRing(50);
  const row = { id: "user-event:1", kind: "user", type: "user:chunk", name: "task chunk (attempt 1)" };

  const first = ring.admit(row);
  assert.ok(first, "the first admission returns the row");
  const assigned = first.seq;

  // The ring moves on, exactly as it does during a live run.
  for (let i = 0; i < 12; i += 1) {
    ring.push({ id: `e${i}`, type: "file.edited", properties: { file: `/f${i}` } });
  }

  // Every later poll re-offers the SAME row, rebuilt from the same file.
  for (let i = 0; i < 5; i += 1) {
    assert.equal(ring.admit(row), null, "a row already admitted is refused");
  }

  const rows = ring.snapshot({ limit: 100 }).events.filter((e) => e.id === "user-event:1");
  assert.equal(rows.length, 1, "it must appear EXACTLY once, however many polls occurred");
  assert.equal(rows[0].seq, assigned, "and its seq must never be recomputed");
});

test("ADMIT: an admitted seq can never collide with a pushed one", () => {
  // The reason admission goes through the ring's own counter rather than being
  // numbered from `cursor` at request time: a shared counter makes a collision
  // structurally impossible. A collision would make the renderer drop one of
  // the two rows, since it only ever appends strictly-increasing seqs.
  const ring = new EventRing(50);
  ring.push({ id: "a", type: "file.edited", properties: { file: "/a" } });
  ring.admit({ id: "harness:x", kind: "harness", type: "harness:gate-start" });
  ring.push({ id: "b", type: "file.edited", properties: { file: "/b" } });
  ring.admit({ id: "harness:y", kind: "harness", type: "harness:gate-end" });

  const seqs = ring.snapshot({ limit: 100 }).events.map((e) => e.seq);
  assert.deepEqual(seqs, [...new Set(seqs)], "no two rows share a seq");
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), "and the line stays monotonic");
});

test("ADMIT: a row with no identity is REFUSED, never admitted repeatedly", () => {
  // Without an id the row cannot be recognised next poll, so admitting it would
  // reproduce the exact re-append defect. Refusing is the honest failure: the
  // row is absent and traceable, rather than present five hundred times.
  const ring = new EventRing(10);
  assert.equal(ring.admit({ kind: "harness", type: "harness:gate-start" }), null);
  assert.equal(ring.admit({ id: "", kind: "harness" }), null);
  assert.equal(ring.snapshot().events.length, 0);
});

test("ADMIT: `since` excludes an already-rendered row, so it is sent once", () => {
  // The client's incremental contract. Once it has rendered up to `cursor`, the
  // admitted row must not come back on the next request.
  const ring = new EventRing(50);
  ring.admit({ id: "user-event:1", kind: "user", type: "user:chunk" });
  const first = ring.snapshot({ limit: 100 });
  assert.equal(first.events.length, 1);

  ring.admit({ id: "user-event:1", kind: "user", type: "user:chunk" });
  const next = ring.snapshot({ limit: 100, since: first.cursor });
  assert.equal(next.events.length, 0, "nothing new — the row is already on screen");
});

test("the ring is bounded and reports that it capped", () => {
  const ring = new EventRing(5);
  for (let i = 0; i < 20; i += 1) {
    ring.push({ id: `e${i}`, type: "file.edited", properties: { file: `/f${i}` } });
  }
  const snap = ring.snapshot();
  assert.equal(snap.retained, 5);
  assert.equal(snap.total, 20);
  assert.equal(snap.capped, true);
});

test("the feed is OLDEST-FIRST — it is a transcript, not a ticker", () => {
  // A reversed transcript is unreadable as narrative, and a reasoning delta
  // rendered above the tool call it preceded actively misleads.
  const ring = new EventRing(50);
  ring.push({ id: "a", type: "file.edited", properties: { file: "/first" } });
  ring.push({ id: "b", type: "file.edited", properties: { file: "/second" } });
  const snap = ring.snapshot();
  assert.equal(snap.order, "oldest_first");
  assert.equal(snap.events[0].file, "/first");
  assert.equal(snap.events[1].file, "/second");
});

test("per-kind counts survive an active filter", () => {
  // The filter chips must keep showing "THINKING 768" while thinking is hidden.
  // If counts were computed over the returned slice, switching a filter on
  // would zero its own count and the operator would lose the number that says
  // what they are hiding.
  const ring = new EventRing(50);
  for (let i = 0; i < 3; i += 1) {
    ring.push({
      id: `t${i}`,
      type: "message.part.updated",
      properties: { sessionID: "ses_1", part: { id: `prt_${i}`, type: "reasoning", time: { start: 1, end: 2000 } } },
    });
  }
  ring.push({ id: "f", type: "file.edited", properties: { file: "/one" } });

  const filtered = ring.snapshot({ kinds: ["file"] });
  assert.equal(filtered.events.length, 1);
  assert.equal(filtered.counts.thinking, 3, "thinking count must survive being filtered out");
  assert.equal(filtered.counts.file, 1);
  assert.equal(filtered.hidden_by_filter, 3);
});

test("a render window is not reported as data loss", () => {
  // `capped` means the ring DROPPED events. `windowed` means this response
  // merely returned fewer than the ring holds. Conflating them would tell the
  // operator data was lost when it was only paged.
  const ring = new EventRing(100);
  for (let i = 0; i < 10; i += 1) {
    ring.push({ id: `e${i}`, type: "file.edited", properties: { file: `/f${i}` } });
  }
  const snap = ring.snapshot({ limit: 4 });
  assert.equal(snap.capped, false, "nothing was dropped from the ring");
  assert.equal(snap.windowed, true, "but the response was windowed");
  assert.equal(snap.events.length, 4);
});

test("retention exceeds the render cap so filters stay honest", () => {
  // If retention == render cap, filtering to ERROR would show only the errors
  // inside the last 400 events rather than the last 400 errors.
  assert.ok(
    EVENT_RING_MAX > EVENT_RENDER_CAP,
    `ring retention ${EVENT_RING_MAX} must exceed render cap ${EVENT_RENDER_CAP}`,
  );
});

test("events are filterable by kind", () => {
  const ring = new EventRing(50);
  ring.push({ id: "a", type: "file.edited", properties: { file: "/one" } });
  ring.push({ id: "b", type: "message.part.updated", properties: { sessionID: "ses_1", part: { id: "prt_b", type: "reasoning", time: { start: 1, end: 2000 } } } });
  const files = ring.snapshot({ kinds: ["file"] });
  assert.equal(files.events.length, 1);
  assert.equal(files.events[0].file, "/one");
});

// ── PINNING: grading rows are never evicted ─────────────────────────────────
//
// The user/harness chips count rows over the WHOLE ring, but delivery is
// windowed. Grading rows are admitted early (between agent turns), so under
// plain oldest-first eviction they would be the first to go: the chip count
// would zero out AND the rows it counts would be unfilterable on the board.

test("PIN: grading rows survive eviction that would otherwise drop them", () => {
  const ring = new EventRing(5);
  ring.admit({ id: "user-event:1", kind: "user", type: "user:chunk" });
  ring.admit({ id: "harness:1", kind: "harness", type: "harness:gate-start" });
  // Without pinning, these 8 pushes would evict both grading rows and retain
  // only the last 5 agent events.
  for (let i = 0; i < 8; i += 1) {
    ring.push({ id: `e${i}`, type: "file.edited", properties: { file: `/f${i}` } });
  }

  const ids = ring.items.map((e) => e.id);
  assert.ok(ids.includes("user-event:1"), "the pinned user row survives");
  assert.ok(ids.includes("harness:1"), "the pinned harness row survives");
  assert.equal(ring.items.length, 5, "the ring stays bounded");
  // ONLY non-grading rows were dropped, oldest-first: the earliest agent
  // events are gone and the recent tail is intact.
  assert.deepEqual(ids, ["user-event:1", "harness:1", "e5", "e6", "e7"]);
});

test("mergeGrading: missing grading rows merge in seq order, present ones never duplicate", () => {
  const events = [
    { id: "e1", kind: "file", seq: 10 },
    { id: "e2", kind: "tool", seq: 11 },
  ];
  const items = [
    { id: "user-event:1", kind: "user", seq: 2 }, // missing from events → merged
    { id: "harness:1", kind: "harness", seq: 5 }, // missing → merged
    { id: "e1", kind: "file", seq: 10 }, // already delivered → not a grading row anyway
    { id: "e9", kind: "tool", seq: 12 }, // non-grading and missing → NOT merged
  ];

  const merged = mergeGrading(events, items);
  assert.deepEqual(
    merged.map((e) => e.id),
    ["user-event:1", "harness:1", "e1", "e2"],
    "grading rows the window left behind come first, ascending by seq",
  );
  assert.deepEqual(merged.map((e) => e.seq), [2, 5, 10, 11]);

  // A grading row ALREADY in events is not duplicated.
  const onePresent = mergeGrading([{ id: "user-event:1", kind: "user", seq: 2 }], items);
  assert.deepEqual(onePresent.map((e) => e.id), ["user-event:1", "harness:1"]);

  // No-op when nothing is missing: the input array is returned untouched.
  assert.equal(mergeGrading(merged, items), merged, "no missing grading rows → same array back");
});

// ── RUN STATE ────────────────────────────────────────────────────────────────

test("completed sessions stamp complete_gate and never extracted_from", () => {
  const src = readFileSync(join(BENCH, "harness", "cumulative", "sequencer.py"), "utf8");
  assert.match(src, /session\.complete_gate = True/);
  assert.doesNotMatch(src, /session\.extracted_from/);
});

// ─────────────────────────────────────────────────────────────────────────────
// GRADING VISIBILITY (WO-GRADE-VIS-1)
//
// Between attempts the agent is idle BY DESIGN while the harness grades. The
// worker's event stream correctly says nothing, so before this existed the feed
// went silent for the length of a grade — measured at 32 minutes on 2026-08-12,
// during which a slow grade was indistinguishable from a wedged one.
// ─────────────────────────────────────────────────────────────────────────────

test("gate events are parsed from the harness's own PROGRESS lines", () => {
  const rows = parseGateEvents(
    "2026-08-12 02:21:58,778 INFO run_cumulative PROGRESS run_label=x step=gate-attempt-start attempt=3 target=/wt\n" +
    "2026-08-12 02:22:01,000 INFO run_cumulative PROGRESS step=gate-phase-start phase=conformance log=/a.log\n" +
    "2026-08-12 02:22:08,000 INFO run_cumulative PROGRESS step=gate-phase-end phase=conformance status=fail problems=2 log=/a.log\n",
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0].kind, "harness");
  assert.equal(rows[1].phase, "conformance");
  assert.match(rows[2].detail, /conformance fail · 2 problems/);
});

// ─────────────────────────────────────────────────────────────────────────────
// EVENT SEQ CONTRACT — the defect that made the harness feed invisible.
//
// Gate rows and feedback rows are built OUTSIDE EventRing, so they never pass
// through push() — the only place `seq` is assigned. They reached the client
// with `seq: undefined`, and the renderer appends incrementally with
//   rows.filter((e) => (e.seq ?? -1) > renderedSeq)          [panels/live.js]
// so every one scored -1 and NOTHING was ever appended. Observed live: a
// harness filter chip counting 282 events beside a completely empty feed.
// ─────────────────────────────────────────────────────────────────────────────

test("EVENTS: appended gate/feedback rows carry a seq that CONTINUES the ring", () => {
  // The exact merge the endpoint performs. Restarting the numbering at 0 would
  // place these rows at or below the client's cursor and reproduce the silence,
  // so the assertion is specifically that they continue PAST the ring cursor.
  const ringCursor = 40;
  const appended = [
    { kind: "harness", type: "harness:gate-phase-start" },
    { kind: "harness", type: "harness:gate-phase-end" },
    { kind: "user", type: "user:chunk" },
  ];

  let tailSeq = ringCursor;
  const sequenced = appended.map((r) => ({ ...r, seq: (tailSeq += 1) }));

  assert.deepEqual(sequenced.map((r) => r.seq), [41, 42, 43]);
  assert.ok(
    sequenced.every((r) => Number.isInteger(r.seq)),
    "a row without an integer seq can never pass the renderer's append filter",
  );
  assert.ok(
    sequenced.every((r) => (r.seq ?? -1) > ringCursor),
    "appended rows must sort AFTER the ring's own rows, never at 0",
  );
  assert.equal(tailSeq, 43, "the reported cursor must cover the appended rows");
});

test("EVENTS: a row with no seq is invisible to the renderer's append filter", () => {
  // Encodes WHY the bug was silent, so a future change that drops seq fails
  // here with the reason rather than shipping an empty feed again.
  const renderedSeq = 0; // the state after any first paint
  const unsequenced = [{ kind: "harness" }, { kind: "harness" }];
  const fresh = unsequenced.filter((e) => (e.seq ?? -1) > renderedSeq);
  assert.equal(fresh.length, 0, "this is the defect: real rows, none renderable");
});

test("the doubled PROGRESS emission yields ONE row, not two", () => {
  // Every PROGRESS line is emitted twice by the harness — once through the
  // structured logger and once bare. Verified on disk; the dashboard's run-log
  // source carries the same dedupe for the same reason. Without this the whole
  // grading feed renders visibly doubled.
  const line = "PROGRESS step=gate-phase-start phase=backend log=/a.log";
  const rows = parseGateEvents(
    `2026-08-12 02:22:01,000 INFO run_cumulative run_cumulative.progress ${line}\n` +
    `2026-08-12 02:22:01,000 INFO run_cumulative ${line}\n`,
  );
  assert.equal(rows.length, 1, "duplicate emission must collapse to one row");
});

test("a FAILING gate phase is never rendered as an error", () => {
  // Gates failing is the normal, expected measurement outcome — the benchmark
  // exists to observe it. Colouring it as an error would make a healthy run
  // look broken and train the operator to ignore real errors.
  const [row] = parseGateEvents(
    "PROGRESS step=gate-phase-end phase=frontend status=fail problems=7 log=/a.log\n",
  );
  assert.equal(row.kind, "harness");
  assert.notEqual(row.kind, "error");
});

test("a gate TIMEOUT is an error — the attempt was never graded", () => {
  const [row] = parseGateEvents(
    "PROGRESS step=gate-timeout wall_s=3600.0 limit_s=3600 log=/a.log\n",
  );
  assert.equal(row.kind, "error");
  assert.match(row.detail, /never graded|not graded/);
});

test("grading status pairs phase START with END so an in-phase hang is visible", () => {
  const open = parseGateEvents("PROGRESS step=gate-phase-start phase=backend log=/a.log\n");
  const s1 = gradingStatus(open, { logMtimeMs: Date.now() - 700_000 });
  assert.equal(s1.grading, true, "an unclosed phase means grading is still in flight");
  assert.equal(s1.phase, "backend");
  assert.equal(s1.stalled, true, "700s past a 600s threshold is a stall");

  const closed = parseGateEvents(
    "PROGRESS step=gate-phase-start phase=backend log=/a.log\n" +
    "PROGRESS step=gate-phase-end phase=backend status=pass problems=0 log=/a.log\n",
  );
  const s2 = gradingStatus(closed, { logMtimeMs: Date.now() - 700_000 });
  assert.equal(s2.grading, false, "a closed phase is not grading");
  assert.equal(s2.silent_s, null, "no elapsed figure when nothing is open");
  assert.equal(s2.stalled, false, "an idle harness must never raise a stall alarm");
});

test("the stall ALARM fires well before the harness's destructive timeout", () => {
  // DRIFT TEST. Two different jobs: the alarm is a visual signal that must fire
  // early so a human can look; the timeout is a kill that must fire late so it
  // never truncates a slow-but-working grade. If these ever cross, the gate is
  // killed before the operator is ever told anything was wrong.
  const py = readFileSync(join(BENCH, "harness", "adapters", "challenge", "constants.py"), "utf8");
  const m = /DEFAULT_GATE_TIMEOUT_S\s*=\s*(\d+)/.exec(py);
  assert.ok(m, "DEFAULT_GATE_TIMEOUT_S vanished from backgammon.py");
  const timeout = Number(m[1]);
  assert.ok(
    GATE_STALL_THRESHOLD_S < timeout,
    `alarm (${GATE_STALL_THRESHOLD_S}s) must fire before the kill (${timeout}s)`,
  );
});

test("the harness streams gate output instead of buffering it", () => {
  // DRIFT TEST against the Python. A buffered gate writes ZERO bytes until it
  // exits, which is what made a 32-minute grade invisible. If this regresses to
  // capture_output the entire feature is silently dead while still "passing".
  const py = readFileSync(join(BENCH, "harness", "adapters", "challenge", "grading.py"), "utf8");
  const fn = py.slice(py.indexOf("def _run_gate_report"), py.indexOf("def _emit_gate_phase_progress"));
  assert.ok(fn.length > 0, "_run_gate_report vanished");
  // Strip the docstring before asserting: it deliberately NAMES the old
  // buffered call to explain why streaming exists, and matching prose instead
  // of code would make this test fail on its own documentation.
  const code = fn.replace(/"""[\s\S]*?"""/g, "");
  assert.doesNotMatch(code, /capture_output\s*=\s*True/, "gate output must not be buffered");
  assert.match(code, /start_new_session\s*=\s*True/, "gate must own a process group so its tree can be killed");

  // The flush that matters is the one INSIDE the reader loop. Asserting a bare
  // `log_file.flush()` anywhere is too weak: the header and footer flush too,
  // so the assertion still passed with the per-line flush deleted (verified by
  // injecting exactly that regression). Scope the match to the loop body.
  const loop = code.slice(code.indexOf("for line in proc.stdout"));
  assert.ok(loop.length > 0, "the streaming reader loop vanished");
  const loopBody = loop.slice(0, loop.indexOf("proc.wait("));
  assert.match(
    loopBody,
    /log_file\.write\(line\)[\s\S]*?log_file\.flush\(\)/,
    "each streamed line must be flushed AS IT IS READ — an unflushed buffer " +
      "reintroduces exactly the invisibility this feature removes",
  );
});

