// Extracted verbatim from control/control.test.mjs — WO-LI18 split A.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventRing } from "../events.mjs";
import { FEEDBACK_CONTRACT_VERSION, feedbackRows, normalizeMessage, readFeedback, readSidecar } from "../feedback.mjs";

test("FEEDBACK: the message text is carried verbatim, byte for byte", () => {
  // Newlines, bullets, em-dashes and trailing whitespace all survive: the
  // operator is judging whether this reads like a person wrote it, and any
  // normalisation here would forge the evidence.
  const body = "These are still failing \u2014 fix it.\n\n- use higher die: FAILING\n";
  const m = normalizeMessage({ kind: "feedback", attempt: 2, timestamp: 5, text: body }, 0);
  assert.equal(m.text, body);
  assert.equal(m.chars, body.length);
  assert.equal(m.kind, "feedback");
  assert.equal(m.kind_inferred, false);
});

test("FEEDBACK: a record with no kind is defaulted BUT says so", () => {
  // Sidecar records written before `kind` existed are real data. Relabelling
  // them as if the writer had stated a kind it never stated is a small lie of
  // exactly the sort this whole surface exists to prevent.
  const m = normalizeMessage({ attempt: 1, text: "x" }, 0);
  assert.equal(m.kind, "feedback");
  assert.equal(m.kind_inferred, true, "the inference must be visible, not silent");
});

test("FEEDBACK: feed rows are user-kind, because that is the fiction under test", () => {
  // Filing them under `harness` would quietly answer the question the operator
  // opened the feed to judge — whether these read as user turns.
  const rows = feedbackRows([
    normalizeMessage({ kind: "feedback", attempt: 2, timestamp: 1, text: "still failing" }, 0),
    normalizeMessage({ kind: "chunk", attempt: 1, timestamp: 0, text: "build a game" }, 1),
  ]);
  assert.ok(rows.every((r) => r.kind === "user"));
  assert.equal(rows[0].type, "user:feedback");
  assert.equal(rows[1].type, "user:chunk");
  assert.match(rows[1].name, /task chunk/);
});

test("FEEDBACK: an oversized message is capped and SAYS it was capped", () => {
  // A 33KB chunk prompt would swamp the feed. Truncating silently would let the
  // tail vanish with nothing to indicate it existed.
  const big = "x".repeat(9000);
  const [row] = feedbackRows([normalizeMessage({ kind: "chunk", text: big }, 0)], { textCap: 100 });
  assert.equal(row.text.length, 100);
  assert.equal(row.truncated, true);
  const [small] = feedbackRows([normalizeMessage({ kind: "chunk", text: "short" }, 0)], { textCap: 100 });
  assert.equal(small.truncated, false);
});

test("FEEDBACK: user row ids are run-qualified, so a new run never collides with a prior run", () => {
  // A tree wipe starts a fresh sidecar whose `seq` restarts at 0. If the id
  // were only `user-event:<seq>`, the new run's first message would collide with
  // the wiped run's already-admitted `user-event:0` and be refused forever.
  const oldRun = feedbackRows(
    [normalizeMessage({ kind: "feedback", attempt: 2, text: "still failing" }, 0)],
    { runDir: "1788672514/local/a", cell: "cell-0000" },
  );
  const newRun = feedbackRows(
    [normalizeMessage({ kind: "chunk", attempt: 1, text: "build a game" }, 0)],
    { runDir: "1788717847/local/a", cell: "cell-0000" },
  );
  assert.notEqual(oldRun[0].id, newRun[0].id, "same seq, different run → different id");
  assert.match(newRun[0].id, /1788717847/, "the current run's identity is embedded in the id");
});

test("RING: reset() clears pinned rows and the dedup set, so a new run re-admits cleanly", () => {
  const ring = new EventRing(50);
  const stale = { id: "user-event:old:cell-0000:0", kind: "user", type: "user:feedback" };
  assert.ok(ring.admit(stale), "the stale row is admitted");

  // The run changes — the control plane resets the ring instead of serving the
  // last run's rows. Pinned (never-evicted) rows must go too.
  ring.reset();
  assert.equal(ring.snapshot().events.length, 0, "reset clears every row, pinned or not");

  // The current run's chunk re-admits under the SAME id the stale row used to
  // hold space for — proving the dedup set was cleared along with the rows.
  const current = { id: "user-event:old:cell-0000:0", kind: "user", type: "user:chunk" };
  assert.ok(ring.admit(current), "the same id admits again after reset");
  assert.equal(ring.snapshot().events.length, 1);
});

test("RING: reset() keeps the seq cursor monotonic so an old `since` still works", () => {
  const ring = new EventRing(50);
  ring.admit({ id: "user-event:a:cell-0000:0", kind: "user", type: "user:chunk" });
  const before = ring.snapshot().cursor;
  ring.reset();
  ring.admit({ id: "user-event:b:cell-0000:0", kind: "user", type: "user:chunk" });
  const after = ring.snapshot().cursor;
  assert.ok(after > before, "cursor advances monotonically across a reset");
});

test("FEEDBACK: a torn sidecar yields every intact message before the tear", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-"));
  try {
    const path = join(dir, "worktree.user-events.jsonl");
    writeFileSync(
      path,
      '{"type":"user","kind":"chunk","attempt":1,"text":"a"}\n' +
        '{"type":"user","kind":"feedback","attempt":2,"text":"b"}\n' +
        '{"type":"user","kind":"feed',
    );
    const records = await readSidecar(path);
    assert.equal(records.length, 2);
    assert.equal(records[1].text, "b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FEEDBACK: no sidecar yet is ok:true + unwired, never an error", async () => {
  // Before the first prompt is sent there is genuinely nothing. That is a state
  // to report, not a failure — and it must stay distinguishable from "this
  // surface is not wired up".
  const dir = mkdtempSync(join(tmpdir(), "fb-"));
  try {
    const res = await readFeedback({ runsRoot: dir, runDir: "cumulative" });
    assert.equal(res.ok, true);
    assert.deepEqual(res.messages, []);
    assert.deepEqual(res.unwired, ["user-events"]);
    assert.match(res.unwired_reasons["user-events"], /first prompt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FEEDBACK: run_dir traversal is refused, same as the wall", async () => {
  const res = await readFeedback({ runsRoot: "/runs", runDir: "../../etc" });
  assert.equal(res.ok, false);
  assert.equal(res.code, "bad_run_dir");
});

test("FEEDBACK: text can be omitted for an index, and that is stated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-"));
  try {
    const cell = join(dir, "cumulative", "memoryOFF", "cell-0000");
    mkdirSync(cell, { recursive: true });
    writeFileSync(
      join(cell, "worktree.user-events.jsonl"),
      '{"type":"user","kind":"feedback","attempt":2,"text":"body here"}\n',
    );
    const withText = await readFeedback({ runsRoot: dir, runDir: "cumulative", sequenceIndex: 0 });
    assert.equal(withText.messages[0].text, "body here");
    assert.equal(withText.text_included, true);
    assert.equal(withText.counts.feedback, 1);

    const without = await readFeedback({ runsRoot: dir, runDir: "cumulative", sequenceIndex: 0, includeText: false });
    assert.equal(without.text_included, false, "a client must tell 'no text here' from 'no text sent'");
    assert.equal(without.messages[0].text, undefined);
    assert.equal(without.messages[0].chars, "body here".length, "the length still reports");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FEEDBACK: the cell is keyed by sequence_index — absent or unresolvable reads EMPTY, never the newest", async () => {
  // The silent newest-cell fallback is dead: an unkeyed read (or a key that
  // resolves nowhere) returns no messages and reports which cells exist,
  // instead of selecting one nobody asked for.
  const dir = mkdtempSync(join(tmpdir(), "fb-"));
  try {
    const cell = join(dir, "cumulative", "memoryOFF", "cell-0000");
    mkdirSync(cell, { recursive: true });
    writeFileSync(
      join(cell, "worktree.user-events.jsonl"),
      '{"type":"user","kind":"feedback","attempt":2,"text":"body here"}\n',
    );

    const unkeyed = await readFeedback({ runsRoot: dir, runDir: "cumulative" });
    assert.equal(unkeyed.ok, true);
    assert.equal(unkeyed.cell, null);
    assert.deepEqual(unkeyed.messages, []);
    assert.deepEqual(unkeyed.cells, ["cell-0000"], "what exists is reported, not selected");

    const missing = await readFeedback({ runsRoot: dir, runDir: "cumulative", sequenceIndex: 5 });
    assert.equal(missing.ok, true);
    assert.equal(missing.cell, null);
    assert.deepEqual(missing.messages, [], "an index that resolves nowhere never falls back to cell-0000");

    const keyed = await readFeedback({ runsRoot: dir, runDir: "cumulative", sequenceIndex: 0 });
    assert.equal(keyed.cell, "cell-0000");
    assert.equal(keyed.messages[0].text, "body here");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FEEDBACK: the contract version is declared", () => {
  assert.equal(typeof FEEDBACK_CONTRACT_VERSION, "number");
});

// ─────────────────────────────────────────────────────────────────────────────
// THE MODEL LEDGER — the three launch gates
//
// These pin the rules that cost real hours when broken. A wrongly-OPEN gate
// starts a ~3h cell that cannot be scored; a wrongly-CLOSED one strands the
// campaign. Both are silent, which is why they are asserted rather than read.
// ─────────────────────────────────────────────────────────────────────────────

/** A run dir on disk: one schedule slot plus its status record. */

