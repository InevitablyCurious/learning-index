// Extracted verbatim from control/control.test.mjs — WO-LI18 split A.
// Dynamic import specifiers shifted ./ → ../ (file moved one level down).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NOTICE_SOURCES, NOTICE_LEVELS } from "../contract.mjs";
import { matchRuntime, CONTEXT_CHOICES } from "../roster.mjs";
import { sessionIdFrom, terminalFrom, pidAlive, confirmAlive, TERMINAL_STATUS, classifyTerminal } from "../runstate.mjs";

import { BENCH } from "./_shared.mjs";

test("session id is read from what the runner already publishes", () => {
  assert.equal(sessionIdFrom("blah session_id=ses_abc123 more"), "ses_abc123");
  assert.equal(sessionIdFrom("opencode attach http://x --session ses_XYZ"), "ses_XYZ");
  assert.equal(sessionIdFrom("nothing here"), null);
});

test("terminal status is read from the runner's own last JSON line", () => {
  // THE FIXTURE IS A STATUS PYTHON ACTUALLY EMITS. It was `awaiting_extract` —
  // a string no Python file in the repo writes — which is part of how that
  // phantom vocabulary survived long enough to blank the board.
  const t = terminalFrom('noise\n{"status":"done","memory_mode":"off"}\n');
  assert.equal(t.status, "done");
  assert.equal(terminalFrom("no json at all"), null);
});

test("DRIFT: the terminal vocabulary matches the sequencer's TypedDict literals", () => {
  // WHY THIS TEST EXISTS. The harness prints its terminal object as the last
  // log line and the control plane scrapes it; there is no shared import
  // between Python and JS, the same standing condition that makes the cloud
  // catalogue a mirror. Without a pin, `runstate.mjs` matched on `"ok"` and
  // `"awaiting_extract"` while the sequencer emitted `"done"` — so every
  // cleanly finished cell was classified `failed` and the board rendered
  // `CELL ENDED — NO RESULT` over it, live, for as long as nobody read both
  // files in one sitting.
  //
  // This is the SMALLEST instance of the drift class the instrumentation plan
  // is built to remove, and it is deliberately the first one pinned: the
  // pattern here is what every later vocabulary reuses.
  const src = readFileSync(join(BENCH, "harness", "cumulative", "sequencer.py"), "utf8");
  const pyStatuses = [...src.matchAll(/^\s{4}status:\s*Literal\["([^"]+)"\]/gm)].map((m) => m[1]);
  assert.ok(pyStatuses.length > 0, "no `status: Literal[...]` declarations parsed out of sequencer.py");

  // THE COUNTS MUST AGREE. Two membership loops can both pass while the sides
  // hold different numbers of entries if either repeats a key.
  assert.equal(
    pyStatuses.length,
    Object.keys(TERMINAL_STATUS).length,
    `sequencer.py declares ${pyStatuses.length} terminal statuses and the control plane maps ${Object.keys(TERMINAL_STATUS).length}`,
  );

  for (const status of pyStatuses) {
    assert.ok(
      TERMINAL_STATUS[status],
      `sequencer.py can emit '${status}' and the control plane does not map it`,
    );
  }
  // AND THE OTHER DIRECTION. A status mapped here and absent from Python is a
  // phantom — exactly what `ok` and `awaiting_extract` were.
  for (const status of Object.keys(TERMINAL_STATUS)) {
    assert.ok(
      pyStatuses.includes(status),
      `the control plane maps '${status}' and no sequencer TypedDict declares it`,
    );
  }
});

test("NOTICES: the control plane writes beside the run's log, and nowhere without one", async () => {
  // RUN-SCOPED, DELIBERATELY. No log means no run means nothing to attach a
  // notice to. The alternative — a run-independent file at the runs root — is a
  // stream no tree retirement ever clears: the stats-baseline hazard inverted,
  // a file that outlives every run it describes.
  const { notice, noticesPathFor } = await import("../notices.mjs");
  const dir = mkdtempSync(join(tmpdir(), "okp-notices-"));
  const logPath = join(dir, "cell-20260904T000000.log");
  try {
    assert.equal(await notice(null, "run_queued"), false, "no log, no notice");
    assert.equal(await notice("", "run_queued"), false);

    assert.equal(await notice(logPath, "run_queued", { detail: { model: "m" } }), true);
    assert.equal(noticesPathFor(logPath), `${logPath}.notices.jsonl`);

    const [rec] = readFileSync(noticesPathFor(logPath), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(rec.kind, "notice");
    assert.equal(rec.source, "control");
    assert.equal(rec.event, "run_queued");
    assert.equal(rec.level, "info", "level defaults to info, it is never guessed from the name");
    assert.deepEqual(rec.detail, { model: "m" });
    assert.equal(rec.v, 1, "the envelope version matches the live stream's");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NOTICES: a null detail is DROPPED, not written as null", async () => {
  // A null on the wire cannot be told apart from "this producer does not set
  // that field", and absence is a state everywhere else on these streams.
  const { notice, noticesPathFor } = await import("../notices.mjs");
  const dir = mkdtempSync(join(tmpdir(), "okp-notices-null-"));
  const logPath = join(dir, "cell.log");
  try {
    await notice(logPath, "stop_signalled");
    const [rec] = readFileSync(noticesPathFor(logPath), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(!("detail" in rec), "an absent detail must not appear as a null key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NOTICES: an unwritable stream costs a row, never the caller", async () => {
  // Telemetry about a failure must not become a second failure. These calls sit
  // on the launch and stop paths, where throwing would turn a missing log line
  // into a failed stop.
  const { notice } = await import("../notices.mjs");
  const missing = join(tmpdir(), "okp-no-such-dir-9c1f", "deep", "cell.log");
  assert.equal(await notice(missing, "run_queued"), false, "reports failure, does not throw");
});

test("NOTICES: an off-vocabulary level falls back to info rather than being dropped", async () => {
  // An unrecognised level is a CALLER drifting from the contract. Dropping the
  // record would hide that drift on the one surface built to show it; the drift
  // test is what makes it loud, and this is what makes it harmless.
  const { notice, noticesPathFor } = await import("../notices.mjs");
  const dir = mkdtempSync(join(tmpdir(), "okp-notices-lvl-"));
  const logPath = join(dir, "cell.log");
  try {
    await notice(logPath, "odd", { level: "critical" });
    const [rec] = readFileSync(noticesPathFor(logPath), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(rec.level, "info");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DRIFT: the notice vocabulary matches harness/live_stream.py", () => {
  // THE SAME PIN AS THE TERMINAL STATUSES, on the vocabulary the backend feed's
  // filter chips are built from. A source that exists in Python and not here has
  // no chip, so its rows are unfilterable; one that exists here and not in
  // Python is a chip that can never light. Both directions, and the counts, so a
  // duplicate on either side cannot hide behind two passing membership loops.
  const src = readFileSync(join(BENCH, "harness", "live_stream.py"), "utf8");

  const parseTuple = (name) => {
    const at = src.indexOf(`${name} = (`);
    assert.ok(at > -1, `${name} not found in live_stream.py`);
    const block = src.slice(at, src.indexOf(")", at));
    return [...block.matchAll(/"([a-z_.]+)"/g)].map((m) => m[1]);
  };

  for (const [pyName, jsList] of [
    ["NOTICE_SOURCES", NOTICE_SOURCES],
    ["NOTICE_LEVELS", NOTICE_LEVELS],
  ]) {
    const py = parseTuple(pyName);
    assert.ok(py.length > 0, `no values parsed out of ${pyName}`);
    assert.equal(py.length, jsList.length, `${pyName}: Python has ${py.length}, the control plane mirrors ${jsList.length}`);
    for (const v of py) assert.ok(jsList.includes(v), `${pyName}: Python emits '${v}' and the control plane does not mirror it`);
    for (const v of jsList) assert.ok(py.includes(v), `${pyName}: the control plane mirrors '${v}' and Python never emits it`);
  }
});

test("NOTICE: `notice` is a core kind, and external services are not sources", () => {
  // A SOURCE IS WHO IS SPEAKING, not who the notice is about. The relay serves
  // monotonic counters over HTTP and knows nothing about cells — it announces
  // nothing, so it can never be the speaker. An observation of it is reported by
  // its observer, under `control`. Attributing a row to a service that never
  // reported it is fabrication however accurate the number is, and this is the
  // assertion that keeps someone from adding the convenient chip later.
  const src = readFileSync(join(BENCH, "harness", "live_stream.py"), "utf8");
  assert.match(src, /"notice",\s*#/, "notice must be declared a core kind");

  for (const forbidden of ["relay", "proxy", "opencode", "okp", "hub", "mcp"]) {
    assert.ok(
      !NOTICE_SOURCES.includes(forbidden),
      `'${forbidden}' is outside this repo and cannot be a notice source — the control plane observes it`,
    );
  }
});

test("TERMINAL: a written record ENDS the run; only its quality is in question", () => {
  // The three answers, and each is a different fact:
  //   done           — ended, and vouched for
  //   halted_on_gate — ended, adversely: a walk gate stopped the campaign
  //   anything else  — ended, unvouched. NOT a failure verdict.
  assert.deepEqual(classifyTerminal({ status: "done" }), { state: "complete", ok: true });
  assert.deepEqual(classifyTerminal({ status: "halted_on_gate" }), { state: "complete", ok: false });

  // AN UNKNOWN STATUS MUST NOT REPRODUCE THE ORIGINAL BUG. A future Python
  // status the control plane has not learned yet still ENDED the run; filing it
  // as `failed` is what put `CELL ENDED — NO RESULT` over clean completions,
  // and it would recur for every status added from here on. The drift test
  // above is what makes the disagreement loud; this makes it harmless.
  assert.deepEqual(classifyTerminal({ status: "some_future_status" }), { state: "complete", ok: null });

  // NO RECORD AT ALL is not this function's call — the run never said how it
  // ended, and the liveness probe decides whether that is a corpse.
  assert.equal(classifyTerminal(null), null);
  assert.equal(classifyTerminal({}), null);
});

test("pidAlive is honest about a pid that cannot exist", () => {
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(process.pid), true);
});

test("confirmAlive reports the crash and the log tail when the pid dies immediately", async () => {
  const res = await confirmAlive(4242, {
    isAlive: () => false,
    readTailImpl: async () => "ValueError: cannot resume: chunk-plan hash drift",
    windowMs: 1000,
    pollMs: 10,
  });
  assert.equal(res.ok, false);
  assert.match(res.log_tail, /chunk-plan hash drift/);
});

test("confirmAlive reports ok when the pid survives the whole window", async () => {
  const res = await confirmAlive(4242, { isAlive: () => true, windowMs: 30, pollMs: 5 });
  assert.equal(res.ok, true);
  assert.equal(res.log_tail, null);
});

// ── ROSTER ───────────────────────────────────────────────────────────────────

test("runtime matching survives the two services' different naming", () => {
  // The proxy says `Qwen3.6-35B-A3B-MLX-8bit`; the runtime says
  // `qwen/qwen3.6-35b-a3b`. A failed match must return null, never a guess.
  const idx = new Map([
    ["qwen/qwen3.6-35b-a3b", { state: "loaded", max_context: 262144, loaded_context: 262144 }],
  ]);
  const hit = matchRuntime("Qwen3.6-35B-A3B-MLX-8bit", idx);
  assert.ok(hit, "expected the proxy alias to match the runtime entry");
  assert.equal(hit.loaded_context, 262144);
  assert.equal(matchRuntime("something-entirely-else", idx), null);
  assert.equal(matchRuntime(null, idx), null);
});

test("context choices are offered as an explicit list", () => {
  assert.ok(CONTEXT_CHOICES.includes(262144));
  assert.ok(CONTEXT_CHOICES.every((n) => Number.isInteger(n) && n > 0));
});

// ── REFUSALS ─────────────────────────────────────────────────────────────────

