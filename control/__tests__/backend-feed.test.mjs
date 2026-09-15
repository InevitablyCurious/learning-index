// Extracted verbatim from control/control.test.mjs — WO-LI18 split A.
// Dynamic import specifiers shifted ./ → ../ (file moved one level down).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("BACKEND FEED: two streams merge into one ordered view", async () => {
  // They are separate files because their facts have different LIFETIMES — a
  // cell's stream dies with the cell's tree, the control plane's outlives it —
  // and merged here because an operator asking "what is happening" does not care
  // which process holds the pen.
  const { readBackendFeed } = await import("../backend-feed.mjs");
  const root = mkdtempSync(join(tmpdir(), "okp-bfeed-"));
  const cell = join(root, "runs", "cumulative", "memoryOFF", "cell-0000");
  mkdirSync(cell, { recursive: true });
  const log = join(root, "cell.log");
  const J = (o) => `${JSON.stringify(o)}\n`;

  writeFileSync(
    join(cell, "live.jsonl"),
    J({ v: 1, ts: 1000, kind: "cell.start" }) +
      J({ v: 1, ts: 1100, kind: "heartbeat", phase: "initial" }) +
      J({ v: 1, ts: 1500, kind: "notice", source: "gates", event: "worker_died_mid_file", level: "error" }) +
      J({ v: 1, ts: 1600, kind: "ext", ns: "okp.plugin", type: "insession.capture" }) +
      "{ sliced mid-record",
  );
  writeFileSync(
    `${log}.notices.jsonl`,
    J({ v: 1, ts: 900, kind: "notice", source: "control", event: "run_queued", level: "info" }) +
      J({ v: 1, ts: 1700, kind: "notice", source: "sequencer", event: "scorecard_missing", level: "error" }),
  );

  try {
    const feed = await readBackendFeed({ runsRoot: join(root, "runs"), runDir: "cumulative", logPath: log });

    // ORDERED BY TIME ACROSS BOTH FILES — the control plane's `run_queued` at
    // 900 precedes the cell's own first record.
    assert.deepEqual(
      feed.rows.map((r) => r.source),
      ["control", "harness", "gates", "okp.plugin", "sequencer"],
    );

    // THE HEARTBEAT IS NOT ACTIVITY. It fires every 15s for the life of a cell —
    // 720 rows on a three-hour cell, all saying the same thing — and would bury
    // every record that carries information under one that does not.
    assert.ok(!feed.rows.some((r) => r.kind === "heartbeat"));

    // A TAIL STARTS AT A BYTE OFFSET, NOT A LINE BOUNDARY, so a sliced record is
    // expected and skipped rather than throwing.
    assert.equal(feed.total, 5);
    assert.equal(feed.sources.live.attached, true);
    assert.equal(feed.sources.notices.attached, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BACKEND FEED: a gate.result row surfaces the runner's own per-gate facts", async () => {
  // The producer states id/status/phase/duration_ms at the TOP LEVEL of the
  // record, and `detail` is the one field the row renderer reads — surfacing
  // them there is pass-through, not a second derivation. A null is OMITTED:
  // a not_run gate has no duration, and absence is a state, never a 0.
  const { readBackendFeed } = await import("../backend-feed.mjs");
  const root = mkdtempSync(join(tmpdir(), "okp-bfeed-gate-"));
  const cell = join(root, "runs", "cumulative", "memoryOFF", "cell-0000");
  mkdirSync(cell, { recursive: true });
  const J = (o) => `${JSON.stringify(o)}\n`;

  writeFileSync(
    join(cell, "live.jsonl"),
    J({ v: 1, ts: 1000, kind: "gate.result", attempt: 1, id: "G14", status: "pass", phase: "backend", duration_ms: 87123 }) +
      J({ v: 1, ts: 1100, kind: "gate.result", attempt: 1, id: "G15", status: "not_run", phase: "backend", duration_ms: null }),
  );

  try {
    const feed = await readBackendFeed({ runsRoot: join(root, "runs"), runDir: "cumulative", logPath: null });
    const [graded, notRun] = feed.rows;
    assert.deepEqual(graded.detail, { id: "G14", status: "pass", phase: "backend", duration_ms: 87123 });
    assert.equal(graded.source, "harness", "a core kind keeps its default chip");
    assert.equal(graded.attempt, 1);
    assert.deepEqual(notRun.detail, { id: "G15", status: "not_run", phase: "backend" });
    assert.ok(!("duration_ms" in notRun.detail), "a null duration is dropped, never fabricated as 0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BACKEND FEED: an external namespace keeps its own name, never a native source", async () => {
  // Folding `okp.plugin` into `harness` would file a BACKEND's telemetry under
  // the benchmark's name. In a merged list the source is the only thing telling
  // a benchmark fact from a contributor's own surroundings, so it must survive
  // intact — and this is what lets an `ext` lane appear later without reworking
  // the chip row.
  const { rowSource, rowLevel } = await import("../backend-feed.mjs");
  assert.equal(rowSource({ kind: "ext", ns: "okp.plugin" }), "okp.plugin");
  assert.equal(rowSource({ kind: "notice", source: "gates" }), "gates");
  // A core kind carries neither field: it is the harness's own record of the run.
  assert.equal(rowSource({ kind: "gate.result" }), "harness");

  // SEVERITY IS ONLY EVER STATED. Inferring it from a core kind — reading a
  // failing gate.result as an error — would conflate the CANDIDATE failing (the
  // measurement working) with the INSTRUMENT failing (the measurement lost),
  // which is the distinction this entire surface exists to keep.
  assert.equal(rowLevel({ kind: "gate.result", status: "fail" }), "info");
  assert.equal(rowLevel({ kind: "notice", level: "error" }), "error");
});

test("ERROR LOG: an error outside the activity window is still kept", async () => {
  // THE WHOLE POINT. The feed reads a tail, which is right for "what is
  // happening" and wrong for "what went wrong" — an error from three hours ago
  // is exactly the record someone reviewing a finished run came for, and it is
  // the first thing a tail drops.
  const { readBackendFeed, FEED_TAIL_BYTES } = await import("../backend-feed.mjs");
  const root = mkdtempSync(join(tmpdir(), "okp-errlog-"));
  const cell = join(root, "runs", "c", "memoryOFF", "cell-0000");
  mkdirSync(cell, { recursive: true });
  const log = join(root, "cell.log");
  const J = (o) => `${JSON.stringify(o)}\n`;

  try {
    let text = J({ v: 1, ts: 1, kind: "notice", source: "gates", event: "worker_died_mid_file", level: "error" });
    while (text.length < FEED_TAIL_BYTES + 8192) {
      text += J({ v: 1, ts: 100, kind: "gate.result", id: "G", status: "pass" });
    }
    writeFileSync(join(cell, "live.jsonl"), text);

    const feed = await readBackendFeed({ runsRoot: join(root, "runs"), runDir: "c", logPath: log });

    assert.equal(feed.windowed, true, "the fixture must actually exceed the window");
    assert.ok(!feed.rows.some((r) => r.event === "worker_died_mid_file"), "the tail dropped it, as designed");
    assert.equal(feed.errors_total, 1, "and the error log kept it");
    assert.equal(feed.errors[0].event, "worker_died_mid_file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ERROR LOG: an append reads only the new bytes; a REPLACED file rescans", async () => {
  // These streams are append-only, so the scan remembers its offset and a poll
  // that finds nothing new reads nothing. A file that got SHORTER is a different
  // file wearing the same name — a reset, or a new campaign in the same place —
  // and trusting an offset into it would silently skip its first records.
  const { readBackendFeed } = await import("../backend-feed.mjs");
  const root = mkdtempSync(join(tmpdir(), "okp-errlog-inc-"));
  mkdirSync(join(root, "runs", "c"), { recursive: true });
  const log = join(root, "cell.log");
  const J = (o) => `${JSON.stringify(o)}\n`;
  const read = () => readBackendFeed({ runsRoot: join(root, "runs"), runDir: "c", logPath: log });

  try {
    writeFileSync(`${log}.notices.jsonl`, J({ v: 1, ts: 1, kind: "notice", source: "control", event: "first", level: "error" }));
    assert.deepEqual((await read()).errors.map((e) => e.event), ["first"]);

    appendFileSync(`${log}.notices.jsonl`, J({ v: 1, ts: 2, kind: "notice", source: "control", event: "second", level: "error" }));
    assert.deepEqual((await read()).errors.map((e) => e.event), ["first", "second"], "the earlier error survives an append");

    // Shorter than before: the offset must be abandoned, not trusted.
    writeFileSync(`${log}.notices.jsonl`, J({ v: 1, ts: 3, kind: "notice", source: "control", event: "fresh", level: "error" }));
    assert.deepEqual((await read()).errors.map((e) => e.event), ["fresh"], "a replaced file is rescanned from the start");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ERROR LOG: only stated errors, never a level inferred from a kind", async () => {
  // A failing gate is the measurement WORKING. Sweeping it into the error log
  // would bury the instrument failures under the candidate's ordinary results —
  // which is the conflation this entire surface exists to prevent.
  const { readBackendFeed } = await import("../backend-feed.mjs");
  const root = mkdtempSync(join(tmpdir(), "okp-errlog-lvl-"));
  mkdirSync(join(root, "runs", "c"), { recursive: true });
  const log = join(root, "cell.log");
  const J = (o) => `${JSON.stringify(o)}\n`;
  try {
    writeFileSync(
      `${log}.notices.jsonl`,
      J({ v: 1, ts: 1, kind: "gate.result", id: "G07", status: "fail" }) +
        J({ v: 1, ts: 2, kind: "notice", source: "harness", event: "turn_truncated_retried", level: "warn" }) +
        J({ v: 1, ts: 3, kind: "notice", source: "gates", event: "worker_died_mid_file", level: "error" }),
    );
    const feed = await readBackendFeed({ runsRoot: join(root, "runs"), runDir: "c", logPath: log });
    assert.deepEqual(feed.errors.map((e) => e.event), ["worker_died_mid_file"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BACKEND FEED: a missing stream is stated, never rendered as silence", async () => {
  // A feed missing the control plane's half and a control plane with nothing to
  // say render identically without this — the exact failure this surface exists
  // to remove, reappearing inside the surface itself.
  const { readBackendFeed } = await import("../backend-feed.mjs");
  const root = mkdtempSync(join(tmpdir(), "okp-bfeed-none-"));
  try {
    const feed = await readBackendFeed({
      runsRoot: join(root, "runs"),
      runDir: "cumulative",
      logPath: join(root, "cell.log"),
    });
    assert.equal(feed.ok, true, "never 500s: no run is a real state");
    assert.deepEqual(feed.rows, []);
    assert.equal(feed.sources.live.attached, false);
    assert.equal(feed.sources.notices.attached, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

