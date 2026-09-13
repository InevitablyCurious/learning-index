// ─────────────────────────────────────────────────────────────────────────────
// AGENT-EVENT PERSISTENCE + BACKEND-FEED RUN_DIR RESOLUTION TESTS
//
//   cd bench/control && node --test
//
// WHAT THESE TESTS ARE FOR. A board viewing a PAST run must be served that
// run's own agent events and that run's own backend feed — resolved from
// run_dir alone, never from whatever is live now. A board viewing ONE CELL of
// a run must likewise be served that cell's own events and stream — resolved
// from (run_dir, sequence_index), never from the newest cell. These tests pin
// the module level of that fix (agent-events.mjs, runstate.mjs
// logPathForRunDir + cellDirForRun/cellSessionId, backend-feed.mjs) and
// source-pin the server.mjs routes that wire it,
// because server.mjs calls listen() at import and cannot be imported here
// (the same tradeoff control.test.mjs makes for its SERVER_SRC guards).
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_EVENTS_FILENAME,
  agentEventsPath,
  appendAgentEvents,
  readAgentEvents,
  createAgentEventSink,
} from "./agent-events.mjs";
import { EventRing } from "./events.mjs";
import { cellDirForRun, cellSessionId, logPathForRunDir } from "./runstate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = readFileSync(join(HERE, "server.mjs"), "utf8");

// ── AGENT EVENTS ─────────────────────────────────────────────────────────────

test("AGENT EVENTS: append + read round-trips the same BoardEvent row shape", async () => {
  // The persisted transcript must serve the SAME row shape the live ring does —
  // one BoardEvent per line, seq included — so a board renders a past run with
  // the exact renderer it uses for a live one.
  const root = mkdtempSync(join(tmpdir(), "okp-agent-events-rt-"));
  try {
    const runDir = "my-run";
    const path = agentEventsPath(root, runDir);
    const rows = [
      { id: "evt_1", kind: "tool", type: "message.part.updated:tool", at: 1000, session_id: "ses_1", tool: "edit", file: null, name: null, detail: null, text: "boom", truncated: false, seq: 1 },
      { id: "evt_2", kind: "error", type: "session.error", at: 1001, session_id: "ses_1", tool: null, file: null, name: "error", detail: "boom", text: "boom", truncated: false, seq: 2 },
    ];
    await appendAgentEvents(path, rows);
    const result = await readAgentEvents({ runsRoot: root, runDir });
    assert.deepEqual(result.rows, rows);
    assert.equal(result.attached, true);
    assert.equal(result.total, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AGENT EVENTS: read tolerates a torn last line", async () => {
  // A crash mid-append leaves a half-written final line. That is expected, not
  // exceptional: the whole transcript before it must still be served.
  const root = mkdtempSync(join(tmpdir(), "okp-agent-events-torn-"));
  try {
    const J = (o) => `${JSON.stringify(o)}\n`;
    const runDir = "my-run";
    const path = agentEventsPath(root, runDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, J({ id: "evt_1", seq: 1 }) + J({ id: "evt_2", seq: 2 }) + '{"id":"broken"');
    const result = await readAgentEvents({ runsRoot: root, runDir });
    assert.equal(result.rows.length, 2, "the two whole lines survive the torn tail");
    assert.equal(result.attached, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AGENT EVENTS: read returns attached:false for a missing run", async () => {
  // "No transcript exists" and "the transcript is empty" are different facts and
  // must render differently — the sources.attached rule the backend feed follows.
  const root = mkdtempSync(join(tmpdir(), "okp-agent-events-missing-"));
  try {
    const result = await readAgentEvents({ runsRoot: root, runDir: "no-such-run" });
    assert.equal(result.attached, false);
    assert.deepEqual(result.rows, []);
    assert.equal(result.total, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AGENT EVENTS: read honors since + limit", async () => {
  // The persisted branch of /api/events must window exactly like the live ring:
  // `since` is a seq cursor (strictly greater), `limit` keeps the NEWEST tail
  // and reports the true total beside it.
  const root = mkdtempSync(join(tmpdir(), "okp-agent-events-cursor-"));
  try {
    const runDir = "my-run";
    const path = agentEventsPath(root, runDir);
    const rows = [1, 2, 3, 4, 5].map((n) => ({
      id: `evt_${n}`, kind: "tool", type: "message.part.updated:tool", at: 1000 + n,
      session_id: "ses_1", tool: "edit", file: null, name: null, detail: null,
      text: null, truncated: false, seq: n,
    }));
    await appendAgentEvents(path, rows);

    const sinceTwo = await readAgentEvents({ runsRoot: root, runDir, since: 2 });
    assert.deepEqual(sinceTwo.rows.map((r) => r.seq), [3, 4, 5]);

    const limited = await readAgentEvents({ runsRoot: root, runDir, since: 0, limit: 2 });
    assert.deepEqual(limited.rows.map((r) => r.seq), [4, 5], "limit keeps the newest tail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AGENT EVENTS: ring sink enqueues pushed events", async () => {
  // The ring hands every MAPPED event to the injected sink (events.mjs push():
  // `this.sink?.enqueue(ev)`). NOTE: the state here is `completed`, not `error`
  // — fromPart reclassifies an errored tool part to kind "error"
  // (events.mjs:157-161), and this test pins the tool row reaching the sink.
  const ring = new EventRing();
  const seen = [];
  ring.sink = { enqueue: (r) => seen.push(r) };
  ring.push({
    id: "evt_1",
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      part: {
        id: "prt_1",
        sessionID: "ses_1",
        type: "tool",
        tool: "edit",
        state: { status: "completed", input: { filePath: "x.txt" } },
      },
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "tool");
  assert.equal(typeof seen[0].seq, "number");
});

test("AGENT EVENTS: sink flush appends buffered rows to the active run's file", async () => {
  // The flush must file rows under the run getRunDir() NAMES — proving the write
  // lands in the right run_dir is the whole point of the resolver indirection.
  const root = mkdtempSync(join(tmpdir(), "okp-agent-events-sink-"));
  try {
    const sink = createAgentEventSink({ runsRoot: root, getRunDir: async () => "my-run" });
    const row1 = { id: "evt_1", kind: "tool", seq: 1 };
    const row2 = { id: "evt_2", kind: "tool", seq: 2 };
    sink.enqueue(row1);
    sink.enqueue(row2);
    await sink.flush();
    assert.ok(existsSync(join(root, "my-run", AGENT_EVENTS_FILENAME)));
    const result = await readAgentEvents({ runsRoot: root, runDir: "my-run" });
    assert.deepEqual(result.rows, [row1, row2]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── BACKEND FEED ─────────────────────────────────────────────────────────────

test("BACKEND FEED: logPathForRunDir resolves a past run's log by run_dir", async () => {
  // A board viewing a finished run needs THAT run's launch log, not the newest
  // one — the resolver matches by the run_dir the log's own tail names.
  const root = mkdtempSync(join(tmpdir(), "okp-backend-feed-logpath-"));
  try {
    writeFileSync(
      join(root, "off-cell-1.log"),
      "step=worktree-git-init path=/x/runs/my-run/memoryOFF/cell-0000/worktree\n",
    );
    writeFileSync(
      join(root, "on-cell-2.log"),
      "step=worktree-git-init path=/x/runs/other-run/memoryOFF/cell-0000/worktree\n",
    );
    assert.equal(await logPathForRunDir(root, "my-run"), join(root, "off-cell-1.log"));
    assert.equal(await logPathForRunDir(root, "no-such-run"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BACKEND FEED: both halves resolve for a past run via readBackendFeed", async () => {
  // The route-level fix at module level: with run_dir + the resolved logPath,
  // BOTH streams attach — the run's own live.jsonl (found under its cell) and
  // the notices sidecar of ITS launch log (logPath + ".notices.jsonl").
  const { readBackendFeed } = await import("./backend-feed.mjs");
  const root = mkdtempSync(join(tmpdir(), "okp-backend-feed-past-"));
  try {
    const J = (o) => `${JSON.stringify(o)}\n`;
    const cellDir = join(root, "my-run", "memoryOFF", "cell-0000");
    mkdirSync(cellDir, { recursive: true });
    writeFileSync(
      join(cellDir, "live.jsonl"),
      J({ ts: 1000, kind: "cell.start", event: "cell.start" }) +
        J({ ts: 1001, kind: "gate.result", id: "g1", status: "pass", phase: "build" }),
    );
    writeFileSync(
      join(root, "off-cell-1.log"),
      "step=worktree-git-init path=/x/runs/my-run/memoryOFF/cell-0000/worktree\n",
    );
    writeFileSync(
      join(root, "off-cell-1.log.notices.jsonl"),
      J({ ts: 1002, kind: "notice", source: "control", event: "run_queued", level: "info", v: 1 }),
    );

    const logPath = await logPathForRunDir(root, "my-run");
    const feed = await readBackendFeed({ runsRoot: root, runDir: "my-run", logPath });
    assert.equal(feed.sources.live.attached, true);
    assert.equal(feed.sources.notices.attached, true);
    assert.ok(feed.rows.some((r) => r.kind === "cell.start"), "the live half is present");
    assert.ok(feed.rows.some((r) => r.kind === "notice"), "the notices half is present");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── CELL-SCOPED READS ────────────────────────────────────────────────────────

// A realistic full run_dir: <timestamp>/<profile>/<router>/<family>/<model>-bench.
const CELL_RUN_DIR = "1788717847/local/local-llm-proxy/omlx/qwen3-6-35b-a3b-bench";

// Build a two-cell fixture run under `root`: cell-0000 (memoryOFF, ses_A) and
// cell-0001 (memoryON, ses_B), each with its own live.jsonl (cell.start first —
// the record cellSessionId reads — then non-heartbeat records with DISTINCT
// event values so a leaked cell is provable), plus a run-level
// agent-events.jsonl mixing both sessions' rows.
function writeCellFixture(root) {
  const J = (o) => `${JSON.stringify(o)}\n`;
  const runRoot = join(root, CELL_RUN_DIR);

  const cellA = join(runRoot, "memoryOFF", "cell-0000");
  mkdirSync(cellA, { recursive: true });
  writeFileSync(
    join(cellA, "live.jsonl"),
    J({ v: 1, ts: 1, kind: "cell.start", session_id: "ses_A", cell_seq: 0, arm: "off" }) +
      J({ v: 1, ts: 2, kind: "heartbeat" }) +
      J({ v: 1, ts: 3, kind: "notice", source: "a", event: "off-notice", level: "info" }),
  );

  const cellB = join(runRoot, "memoryON", "cell-0001");
  mkdirSync(cellB, { recursive: true });
  writeFileSync(
    join(cellB, "live.jsonl"),
    J({ v: 1, ts: 1, kind: "cell.start", session_id: "ses_B", cell_seq: 1, arm: "on" }) +
      J({ v: 1, ts: 3, kind: "notice", source: "a", event: "on-notice", level: "info" }),
  );

  writeFileSync(
    join(runRoot, "agent-events.jsonl"),
    J({ id: "evt_1", kind: "tool", type: "message.part.updated:tool", at: 1001, session_id: "ses_A", seq: 1 }) +
      J({ id: "evt_2", kind: "tool", type: "message.part.updated:tool", at: 1002, session_id: "ses_A", seq: 2 }) +
      J({ id: "evt_3", kind: "tool", type: "message.part.updated:tool", at: 1003, session_id: "ses_B", seq: 3 }),
  );
}

test("CELL SCOPE: cellDirForRun resolves (run_dir, sequence_index) to one cell dir", async () => {
  // The cell dir is runs-root-relative (callers join their own runsRoot) and
  // carries the arm it was found under; a sequence that never ran is null,
  // never a guess at a neighboring cell.
  const root = mkdtempSync(join(tmpdir(), "okp-cell-dir-"));
  try {
    writeCellFixture(root);
    const cell = await cellDirForRun(root, CELL_RUN_DIR, 0);
    assert.ok(cell, "cell-0000 resolves");
    assert.ok(
      cell.cellDir.endsWith(join("memoryOFF", "cell-0000")),
      `cellDir is the runs-root-relative cell path, got ${cell.cellDir}`,
    );
    assert.equal(cell.arm, "memoryOFF");
    assert.equal(cell.cellName, "cell-0000");
    assert.equal(await cellDirForRun(root, CELL_RUN_DIR, 9), null, "a cell that never ran resolves to null");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CELL SCOPE: cellSessionId reads the session_id from the cell's own cell.start", async () => {
  // The join key for cell-scoped agent events comes from the cell's OWN
  // live.jsonl head — never from a launch log that may describe another cell.
  const root = mkdtempSync(join(tmpdir(), "okp-cell-sid-"));
  try {
    writeCellFixture(root);
    assert.equal(await cellSessionId(root, CELL_RUN_DIR, 0), "ses_A");
    assert.equal(await cellSessionId(root, CELL_RUN_DIR, 1), "ses_B");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CELL SCOPE: readAgentEvents filters to one cell's session when sequenceIndex is passed", async () => {
  // One run's transcript mixes every cell's sessions; a board viewing ONE cell
  // must be served exactly that cell's rows — keyed by the cell's session_id —
  // and the unscoped read must still serve the whole run.
  const root = mkdtempSync(join(tmpdir(), "okp-cell-events-"));
  try {
    writeCellFixture(root);
    const cellA = await readAgentEvents({ runsRoot: root, runDir: CELL_RUN_DIR, sequenceIndex: 0 });
    assert.equal(cellA.rows.length, 2, "exactly the two ses_A rows");
    assert.ok(cellA.rows.every((r) => r.session_id === "ses_A"));

    const cellB = await readAgentEvents({ runsRoot: root, runDir: CELL_RUN_DIR, sequenceIndex: 1 });
    assert.equal(cellB.rows.length, 1, "exactly the one ses_B row");
    assert.equal(cellB.rows[0].session_id, "ses_B");

    const all = await readAgentEvents({ runsRoot: root, runDir: CELL_RUN_DIR });
    assert.equal(all.rows.length, 3, "no sequenceIndex serves the whole run transcript");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CELL SCOPE: readBackendFeed pins the live half to the requested cell's live.jsonl", async () => {
  // Without the pin the live half resolves to the NEWEST cell — a board viewing
  // cell 0 would watch cell 1's stream. Pinned, it reads exactly that cell's
  // live.jsonl, and a different cell's records never leak in.
  const { readBackendFeed } = await import("./backend-feed.mjs");
  const root = mkdtempSync(join(tmpdir(), "okp-cell-feed-"));
  try {
    writeCellFixture(root);
    const feed = await readBackendFeed({
      runsRoot: root,
      runDir: CELL_RUN_DIR,
      logPath: null,
      sequenceIndex: 0,
    });
    assert.equal(feed.sources.live.attached, true, "the pinned cell's stream attaches");
    const events = feed.rows.map((r) => r.event);
    assert.ok(events.includes("off-notice"), "the pinned cell's records are served");
    assert.ok(!events.includes("on-notice"), "another cell's records never leak in");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── SERVER WIRING (source-pin) ───────────────────────────────────────────────

test("SERVER WIRING: /api/events has a persisted ?run_dir= branch", () => {
  // server.mjs calls listen() at import, so the route is pinned by source —
  // weaker than calling it, and chosen deliberately (control.test.mjs's rule).
  assert.match(SERVER_SRC, /url\.searchParams\.get\("run_dir"\)/);
  assert.match(SERVER_SRC, /readAgentEvents/);
});

test("SERVER WIRING: backend-feed resolves notices from ?run_dir=", () => {
  assert.match(SERVER_SRC, /logPathForRunDir\(RUNS_ROOT, requestedRunDir\)/);
  assert.match(SERVER_SRC, /createAgentEventSink/);
});

test("SERVER WIRING: both routes read ?sequence_index= and pin their reads to it", () => {
  // CELL-SCOPED READS: /api/events and /api/backend-feed must each read the
  // param AND hand it to their reader — a board viewing one cell is served
  // that cell's events and that cell's stream, never the newest cell's.
  assert.match(SERVER_SRC, /url\.searchParams\.get\("sequence_index"\)/);
  const paramReads = SERVER_SRC.match(/url\.searchParams\.get\("sequence_index"\)/g) ?? [];
  assert.ok(paramReads.length >= 2, "both routes read the param");
  assert.ok(SERVER_SRC.includes("sequenceIndex"));
  assert.match(SERVER_SRC, /readAgentEvents\(\{[^)]*sequenceIndex/, "the events route passes sequenceIndex through");
  // The intent is "sequenceIndex reaches the reader", not "it is the last key in
  // the object literal" — pinning key ORDER makes an unrelated addition fail.
  assert.match(SERVER_SRC, /readBackendFeed\(\{[\s\S]*?sequenceIndex,/, "the backend-feed route passes sequenceIndex through");

  // A ?run_dir= READ IS COMPLETE. The tail window and row cap serve the live
  // path; on a concluded cell they cut the START of the run — measured, a 310KB
  // live.jsonl against a 256KB window hid the first 1h44m of a 2h19m cell.
  assert.match(
    SERVER_SRC,
    /readBackendFeed\(\{[\s\S]*?complete: Boolean\(requestedRunDir\)/,
    "a historical backend read must not be windowed",
  );
});

// ── THE HISTORICAL REBUILD MUST NOT SHRINK THE TRANSCRIPT ───────────────────

test("a rebuilt transcript keeps every row: append for agent rows, admit for prompts", () => {
  // THE DEFECT THIS PINS. The historical assembly first routed EVERY row through
  // EventRing.admit(), which dedupes on `id`. Agent rows legitimately share one:
  // a streaming part emits `message.part.updated` repeatedly as it grows, all
  // carrying the same `prt_…`. Measured on a real 4,312-row transcript, 2,116
  // rows survived and the tool count fell from 2,181 to 468 — while the response
  // went on reporting the total it had just discarded.
  const part = (id, at) => ({ id, kind: "tool", type: "message.part.updated:tool", at, session_id: "ses_a" });
  const agent = [part("prt_1", 1), part("prt_1", 2), part("prt_1", 3), part("prt_2", 4)];
  const prompt = { id: "user-event:r:c:1", kind: "user", at: 2, name: "task chunk" };

  const ring = new EventRing(Number.MAX_SAFE_INTEGER);
  const promptIds = new Set([prompt.id]);
  for (const r of [...agent, prompt].sort((a, b) => a.at - b.at)) {
    if (promptIds.has(r.id)) ring.admit(r);
    else ring.append(r);
  }

  assert.equal(ring.items.length, 5, "four agent rows (three sharing an id) plus one prompt");
  assert.equal(ring.items.filter((r) => r.kind === "tool").length, 4, "no streaming update is collapsed away");

  // The prompt family still dedupes — it is rebuilt from files, so the same row
  // arrives again on the next read and must enter once.
  ring.admit(prompt);
  assert.equal(ring.items.length, 5, "re-admitting a prompt is a no-op");

  // Every row takes a seq from the SAME counter, so the two rules cannot collide.
  const seqs = ring.items.map((r) => r.seq);
  assert.equal(new Set(seqs).size, seqs.length, "seq is unique across both admission paths");
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, "and monotonic in admission order");
});

test("BACKEND FEED: a structural record's own facts reach the row", async () => {
  // THE DEFECT THIS PINS. Every producer in live.jsonl writes what a record is
  // ABOUT at the top level beside its kind — `phase.start` has `phase`,
  // `attempt.end` has `verdict` and `failed`, `cell.end` has `terminal_reason`.
  // The row renderer reads ONE field (`detail`), so all of them rendered as a
  // bare kind name with an empty line: a birds-eye view of a run that could not
  // say which phase started or how an attempt ended.
  const root = mkdtempSync(join(tmpdir(), "okp-bfeed-"));
  const cell = join(root, "r1", "memoryOFF", "cell-0000");
  mkdirSync(cell, { recursive: true });
  writeFileSync(join(root, "r1", "manifest.json"), JSON.stringify({
    schedule: [{ sequence_index: 0, memory_mode: "off", provider_pin: "m-a" }],
  }));
  writeFileSync(join(cell, "live.jsonl"), [
    JSON.stringify({ v: 1, ts: 1000, kind: "cell.start", cell_seq: 0, session_id: "ses_a", arm: "off", model: "m-a" }),
    JSON.stringify({ v: 1, ts: 2000, kind: "phase.start", cell_seq: 0, phase: "initial-chunk-3" }),
    JSON.stringify({ v: 1, ts: 3000, kind: "attempt.end", cell_seq: 0, attempt: 2, verdict: "FAIL", conformed: true, failed: 5 }),
    JSON.stringify({ v: 1, ts: 4000, kind: "cell.end", cell_seq: 0, verdict: "FAIL", terminal_reason: "attempt_ceiling_reached" }),
  ].join("\n") + "\n");

  const { readBackendFeed } = await import("./backend-feed.mjs");
  const feed = await readBackendFeed({ runsRoot: root, runDir: "r1", logPath: null, sequenceIndex: 0, complete: true });
  const by = Object.fromEntries(feed.rows.map((r) => [r.kind, r.detail]));

  assert.equal(by["phase.start"].phase, "initial-chunk-3", "a phase must name itself");
  assert.equal(by["attempt.end"].verdict, "FAIL");
  assert.equal(by["attempt.end"].failed, 5, "how many gates failed is the point of the row");
  assert.equal(by["cell.end"].terminal_reason, "attempt_ceiling_reached", "why the cell stopped");
  assert.equal(by["cell.start"].arm, "off");

  // ABSENCE IS OMITTED, never rendered as a zero — a field the producer did not
  // write is a measurement that was not taken.
  assert.equal("session_id" in by["phase.start"], false, "a lifted key absent from the record is not invented");

  // AND THE COMPLETE READ IS COMPLETE: no window, no row cap, and it says so.
  assert.equal(feed.windowed, false);
  assert.equal(feed.complete, true);
  assert.equal(feed.returned, feed.total);

  rmSync(root, { recursive: true, force: true });
});

test("the historical rebuild preserves ARRIVAL order and drops prompts into it", async () => {
  // THE DEFECT THIS PINS. 201 rows of a real 4,457-row transcript carry no `at`
  // at all — file.edited (145), session.idle (39), session.error (11),
  // session.compacted (6). Sorting the merge by `at` read every one of them as
  // timestamp 0 and filed them at the TOP of the feed: a run whose first 145
  // events were file edits that actually happened throughout, and whose errors
  // all appeared before the work that caused them.
  //
  // agent-events.jsonl is append-only IN ARRIVAL ORDER, which is the true order
  // and the one the live feed showed, so it is left exactly as it lies.
  const SRC = SERVER_SRC;
  assert.match(SRC, /interleaveByArrival\(persisted\.rows, promptRows\)/,
    "the rebuild must not re-sort the transcript");
  assert.doesNotMatch(
    SRC,
    /\[\.\.\.persisted\.rows, \.\.\.promptRows\]\s*\n?\s*\.sort/,
    "the plain time-sort of both families must not come back",
  );

  // The function itself, exercised through the module's own source (it is
  // private to server.mjs, which is not import-safe — it listens at import).
  const body = SRC.slice(SRC.indexOf("function interleaveByArrival"));
  const fn = new Function(`${body.slice(0, body.indexOf("\n}\n") + 3)}; return interleaveByArrival;`)();

  const agent = [
    { id: "a1", at: 100, kind: "tool" },
    { id: "a2", at: 0, kind: "file" },      // untimed — must NOT move
    { id: "a3", at: 300, kind: "tool" },
    { id: "a4", kind: "error" },            // untimed — must NOT move
    { id: "a5", at: 500, kind: "tool" },
  ];
  const prompts = [{ id: "p1", at: 250, kind: "user" }, { id: "p2", at: 400, kind: "user" }];

  const out = fn(agent, prompts);
  assert.deepEqual(out.map((r) => r.id), ["a1", "a2", "p1", "a3", "a4", "p2", "a5"]);

  // The agent rows keep their file order exactly, untimed ones included.
  assert.deepEqual(out.filter((r) => !r.id.startsWith("p")).map((r) => r.id), ["a1", "a2", "a3", "a4", "a5"]);

  // A prompt later than every agent row still lands, at the end.
  assert.deepEqual(fn(agent, [{ id: "p9", at: 9999 }]).at(-1).id, "p9");
  // And no agent row is lost when there are no prompts at all.
  assert.equal(fn(agent, []).length, agent.length);
});
