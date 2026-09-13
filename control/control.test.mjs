// ─────────────────────────────────────────────────────────────────────────────
// CONTROL PLANE TESTS — stdlib runner only
//
//   cd okp-bench/control && node --test
//
// WHAT THESE TESTS ARE FOR. Two of them are DRIFT tests that assert this JS
// agrees with the Python harness it describes. Those are the ones that matter
// most: every other property here is local to this directory and would be
// caught by reading it, but a context registry or an alias list that silently
// stops matching the program it claims to describe produces a UI that lies
// confidently. Drift fails loudly here or not at all.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  confirmationToken,
  restatement,
  EVENT_MAP,
  RESUME_UNSUPPORTED,
  EVENT_RING_MAX,
  EVENT_RENDER_CAP,
  GATE_STALL_THRESHOLD_S,
  STALL_THRESHOLD_S,
  refuse,
} from "./contract.mjs";
import { matchRuntime, DECLARED_CONTEXT, CONTEXT_CHOICES, RETIRED_ALIASES, readRoster } from "./roster.mjs";
import { COMPACT_DEFAULT_CEILING } from "./cloud.mjs";
import { readBaselines, BASELINES_FILE, isArchivedRun, baselineId, identifyCell, collectCells, collectOffCells, baselineFor } from "./baselines.mjs";
import { manifestArgFor, campaignDirName, campaignTargetFor } from "./campaign.mjs";
import {
  segment,
  subjectTriple,
  campaignSegments,
  modeDir,
  isTreeId,
  campaignTreeId,
  mintTree,
  ensureTree,
  activeTreeId,
  readTreePointer,
  listCampaignDirs,
  listLiveCampaignDirs,
  TREE_POINTER,
  isBenchmarkData,
  planReset,
  resetAll,
  BACKUPS_DIR,
  sweepToBackup,
} from "./tree.mjs";
import {
  listBackups,
  describeBackup,
  checkBackup,
  resolveBackupDir,
  restoreBackup,
} from "./backups.mjs";
import {
  readCloud,
  resolveCloudModel,
  cloudCatalog,
  CLOUD_MODELS,
  CONTEXT_ADVISORY_FLOOR,
} from "./cloud.mjs";
import { sessionIdFrom, terminalFrom, pidAlive, confirmAlive, newestLog, readRunState, runDirOf, TERMINAL_STATUS, classifyTerminal } from "./runstate.mjs";
import { NOTICE_SOURCES, NOTICE_LEVELS } from "./contract.mjs";
import { mapEvent, EventRing, mergeGrading } from "./events.mjs";
import { parseGateEvents, gradingStatus } from "./gate-events.mjs";
import { readModelsLedger } from "./models-ledger.mjs";
import {
  attemptRecords,
  DEFAULT_RUN_DIR,
  foldGateStates,
  readStatusRecords,
  readWall,
  resolveRunDir,
} from "./wall.mjs";
import {
  assignIds,
  parsePlaywrightList,
  parseVitestList,
  suiteFingerprint,
  tierOf,
} from "../grader/roster.mjs";
import {
  firstMeaningfulLine,
  foldGateResults,
  normalizeStatus,
  runnerFailureObserved,
} from "../grader/gate-results.mjs";
import {
  FEEDBACK_CONTRACT_VERSION,
  feedbackRows,
  normalizeMessage,
  readFeedback,
  readSidecar,
} from "./feedback.mjs";
import { resolveDevMode, readDevMode, writeDevMode } from "./devmode.mjs";
import { listRunCells, readCheckpointIndex, readDiffText, readTranscriptText } from "./history.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, "..");

test("DRIFT: declared context matches WORKER_MODEL_REGISTRY in config.py", () => {
  const src = readFileSync(join(BENCH, "harness", "config.py"), "utf8");
  for (const [alias, ctx] of Object.entries(DECLARED_CONTEXT)) {
    const idx = src.indexOf(`"${alias}"`);
    assert.ok(idx > -1, `alias '${alias}' is not present in config.py WORKER_MODEL_REGISTRY`);
    // READ THE VALUE, NEVER SEARCH THE BLOCK. A substring match is defeated by
    // any occurrence of the number, and config.py's own warning comment on
    // DSV4F names the WRONG value (`# 256512, NOT 262144`) — so the block
    // contained `262144` while the data said `256_512`, and the mirror's drift
    // passed this test for as long as both lines existed. Comments are stripped
    // and the `"context":` literal itself is compared.
    const block = src
      .slice(idx, idx + 800)
      .replace(/#[^\n]*/g, "");
    const found = block.match(/"context"\s*:\s*([\d_]+)/);
    assert.ok(found, `alias '${alias}' has no "context" in its config.py registry block`);
    assert.equal(
      Number(found[1].replace(/_/g, "")),
      ctx,
      `alias '${alias}' declares context ${ctx} here but config.py says ${found[1]}`,
    );
  }
});

test("ROSTER: a retired alias is refused bench eligibility even when the proxy blesses it", async () => {
  // `okp-bench-worker` maps upstream to `auto` — a cell run on it measures
  // whichever model happened to be resident and records no identity. The design
  // is retired, but the PROXY still advertises the alias with purpose
  // 'okp-bench' (its roster lives in another service). Eligibility computed
  // from purpose alone therefore kept offering it a [+ baseline] button.
  const proxy = {
    object: "list",
    data: [
      { id: "okp-bench-worker", upstream_model: "auto", purpose: "okp-bench" },
      { id: "qwen3.6-35b-a3b-bench", upstream_model: "Qwen3.6-35B-A3B-MLX-8bit", purpose: "okp-bench" },
    ],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    new Response(JSON.stringify(String(url).includes("/v1/models") ? proxy : { data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  try {
    const roster = await readRoster({ proxyUrl: "http://x", runtimeUrl: "http://y" });
    const byId = Object.fromEntries(roster.models.map((m) => [m.id, m]));

    assert.equal(byId["okp-bench-worker"].bench_eligible, false, "a retired alias is never bench-eligible");
    assert.match(byId["okp-bench-worker"].retired_reason, /resident behind the proxy/);
    // It is still LISTED — vanishing without explanation looks like the proxy
    // lost it, which is a different and false diagnosis.
    assert.equal(byId["okp-bench-worker"].purpose, "okp-bench");
    assert.equal(byId["qwen3.6-35b-a3b-bench"].bench_eligible, true);
    assert.equal(byId["qwen3.6-35b-a3b-bench"].retired_reason, null);
    assert.deepEqual(roster.bench_models.map((m) => m.id), ["qwen3.6-35b-a3b-bench"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("DRIFT: retired aliases match RETIRED_MODEL_ALIASES in config.py", () => {
  // The two sides cannot import each other (JS control plane, Python harness),
  // so they are pinned. A retirement declared on ONE side only is the dangerous
  // case: the CLI would refuse the alias while the board still offered it a
  // [+ baseline] button, or the reverse.
  const src = readFileSync(join(BENCH, "harness", "config.py"), "utf8");
  const block = /RETIRED_MODEL_ALIASES: dict\[str, str\] = \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(block, "RETIRED_MODEL_ALIASES not found in config.py");
  const pythonIds = [...block[1].matchAll(/^\s{4}"([^"]+)":/gm)].map((m) => m[1]);
  assert.deepEqual(
    Object.keys(RETIRED_ALIASES).sort(),
    pythonIds.sort(),
    "a retirement is declared on one side only — the bench and the board disagree about what may run",
  );
});

test("ROSTER: a retired alias declares no bench context", () => {
  // The two maps must not disagree: a declared context is a promise the bench
  // will run the alias at that window.
  for (const id of Object.keys(RETIRED_ALIASES)) {
    assert.equal(DECLARED_CONTEXT[id], undefined, `${id} is retired but still declares a bench context`);
    assert.match(RETIRED_ALIASES[id], /retired/i, "a retirement states its reason");
  }
});

// ── CONFIRMATION: a stale token must not validate ────────────────────────────

test("confirmation token is a pure function of the parameters", () => {
  const a = confirmationToken({ model: "m", arm: "off", org: null, context: null });
  const b = confirmationToken({ model: "m", arm: "off", org: null, context: null });
  assert.equal(a, b);
});

test("changing ANY parameter invalidates the token", () => {
  const base = { model: "m", arm: "off", org: null, context: null };
  const t = confirmationToken(base);
  assert.notEqual(t, confirmationToken({ ...base, model: "other" }));
  assert.notEqual(t, confirmationToken({ ...base, arm: "on" }));
  assert.notEqual(t, confirmationToken({ ...base, org: "org-1" }));
  assert.notEqual(t, confirmationToken({ ...base, context: 262144 }));
  // Compaction changes what the cell DOES — six extra model turns and a
  // turn/token scale no uncompacted cell shares. A token minted for one must
  // never confirm the other.
  assert.notEqual(t, confirmationToken({ ...base, compact: true }));
});

test("COMPACTION: the token separates on from off, and the restatement says which", () => {
  const base = { model: "m", arm: "off", org: null, context: null, kind: "local" };
  assert.notEqual(
    confirmationToken({ ...base, compact: true }),
    confirmationToken({ ...base, compact: false }),
  );
  // STATED EITHER WAY. An operator who sees nothing cannot tell a cell that
  // declined compaction from one that was never offered it.
  assert.match(restatement({ ...base, compact: true }), /compaction: ON/);
  assert.match(restatement({ ...base, compact: false }), /compaction: OFF/);
});

test("COMPACTION: the default follows the context window, on both substrates", () => {
  const src = readFileSync(join(BENCH, "control", "server.mjs"), "utf8");
  // The rule is written once, in the server, and reads the roster entry — which
  // is a real row for a local model and a synthesised one of the same shape for
  // a cloud model, so one code path covers both.
  assert.match(src, /function compactDefaultFor\(entry\)/);
  assert.match(src, /COMPACT_DEFAULT_CEILING/);
  // An unknown window compacts: a model nobody could size is likelier narrow
  // than roomy, and six turns is the cheaper mistake.
  assert.match(src, /if \(!known\.length\) return true;/);
});

test("COMPACTION: the ceiling is its own constant, not the advisory floor", () => {
  // Two different questions wearing a similar shape: the advisory floor asks
  // "will this cell hit the provider ceiling and die", the compaction ceiling
  // asks "will the build crowd the repair phase out of its context". Sharing a
  // constant would move one whenever the other moved for its own reasons.
  assert.equal(COMPACT_DEFAULT_CEILING, 524288);
  assert.notEqual(COMPACT_DEFAULT_CEILING, CONTEXT_ADVISORY_FLOOR);
});

test("COMPACTION: the start passes the flag EXPLICITLY, never by omission", () => {
  const src = readFileSync(join(BENCH, "control", "server.mjs"), "utf8");
  // Both forms, always. Passing nothing when compaction is off would hand the
  // decision back to a default and the arm the operator confirmed would stop
  // being the arm guaranteed to run.
  assert.match(src, /compact \? "--compact" : "--no-compact"/);
});

test("REQUIRE TODOS: every name that reads the value is in a scope that HAS it", () => {
  // THE BUG THIS EXISTS FOR. `requireTodos` was added to validateStart's
  // PARAMETERS and to the launch argv, but never to what validateStart RETURNS
  // — so the launch site destructured a field that was not there, and the
  // /api/preflight handler referenced a name that did not exist in its scope at
  // all. `node --check` passed (the syntax is fine) and the whole 234-test
  // suite passed, because nothing here executed those two lines. The board got
  // HTTP 500 "requireTodos is not defined" on the first click.
  //
  // Source-shape assertions are the cheap guard for a plain-JS server with no
  // type checker: they cost nothing and they pin the three points that have to
  // agree.
  const src = readFileSync(join(BENCH, "control", "server.mjs"), "utf8");

  // 1. validateStart must RETURN it, or every consumer destructures undefined.
  // Assert the FIELD is in the return, not the exact field list — pinning the
  // whole list makes every later addition look like a regression.
  const ret = src.match(/return \{ ok: true,[^}]*\}/);
  assert.ok(ret, "validateStart's success return not found");
  assert.match(ret[0], /requireTodos/, "validateStart must return requireTodos, not merely accept it");

  // 2. Every site that destructures `compact` off `check` must take it too —
  //    those are the same object, and a partial destructure is a silent undefined.
  const destructures = src.match(/const \{ model, arm, org, context, kind, cloud, compact[^}]*\} = check;/g) ?? [];
  assert.ok(destructures.length >= 2, "expected the preview and launch destructures");
  for (const d of destructures) {
    assert.match(d, /requireTodos/, `destructure missing requireTodos: ${d}`);
  }

  // 3. The flag reaches the harness.
  assert.match(src, /if \(requireTodos\) argv\.push\("--require-todos"\)/);
});

test("REQUIRE TODOS: the value is on the LAUNCH payload, not a bystander function", () => {
  // THE BUG THIS EXISTS FOR. `requireTodos` was added to `createSelection()`,
  // which reads like the launch payload and is not: the real body is built
  // inline in the launch flow and spread into both /api/run/preview and
  // /api/run/start. The toggle rendered, persisted, and posted nothing. The
  // cell came up with REQUIRE_TODOS empty and the agent worked without todos.
  //
  // Pin it to the object that is actually sent, right beside the compact line
  // it must live next to.
  const src = readFileSync(join(BENCH, "dashboard", "panels", "create.js"), "utf8");

  const launch = src.slice(src.indexOf("const payload = { model: ui.model"));
  const body = launch.slice(0, launch.indexOf("/api/run/start"));
  assert.match(
    body,
    /payload\.requireTodos = requireTodosOn\(\)/,
    "the launch payload must carry the operator's switch, or the flag never leaves the browser",
  );

  // And it must be read from the drawer's store, never mirrored into `ui` —
  // a second copy would drift the moment the operator flips it mid-wizard.
  // The symbol must come from the drawer's store; the import line may carry
  // other symbols beside it.
  const imp = src.match(/import \{[^}]*\} from "\.\/switches\.js"/);
  assert.ok(imp, "create.js must import from switches.js");
  assert.match(imp[0], /requireTodosOn/, "never mirror the preference into `ui` — read it from the store");
});

test("RECORD AT CHUNK END: the same three points must agree", () => {
  // Same chain, same three failure points as REQUIRE TODOS above. Written at
  // the same time as the feature this run, because the previous flag shipped
  // broken twice for exactly these reasons.
  const src = readFileSync(join(BENCH, "control", "server.mjs"), "utf8");
  assert.match(src, /const recordAtChunkEnd = payload\?\.recordAtChunkEnd === true;/);
  // Asserts the FIELD is returned, not the identity of its neighbours. Pinning
  // the exact tuple made this fail when an unrelated setting was threaded
  // through — a false alarm that says nothing about record-at-chunk-end.
  const returned = /return \{ ok: true, model, arm[^}]*\};/.exec(src);
  assert.ok(returned, "validateStart no longer returns its usual shape");
  assert.match(returned[0], /\brecordAtChunkEnd\b/, "validateStart must RETURN it");
  const destructures = src.match(/const \{ model, arm, org, context, kind, cloud, compact[^}]*\} = check;/g) ?? [];
  for (const d of destructures) assert.match(d, /recordAtChunkEnd/, `destructure missing it: ${d}`);
  assert.match(src, /if \(recordAtChunkEnd\) argv\.push\("--record-at-chunk-end"\)/);

  // And it must be on the object that is actually POSTed, not a bystander.
  const create = readFileSync(join(BENCH, "dashboard", "panels", "create.js"), "utf8");
  const launch = create.slice(create.indexOf("const payload = { model: ui.model"));
  const body = launch.slice(0, launch.indexOf("/api/run/start"));
  assert.match(body, /payload\.recordAtChunkEnd = recordAtChunkEndOn\(\)/);
});

test("REQUIRE TODOS: the preflight handler does NOT pass a flag preflight cannot take", () => {
  // /api/preflight shells out to bench_preflight.py, which has no
  // --require-todos argument — and its `compact` is a URL search param, not the
  // validated launch value. An insertion there was both a scope error and a bad
  // flag. Pin the shape so it cannot come back.
  const src = readFileSync(join(BENCH, "control", "server.mjs"), "utf8");
  const handler = src.slice(src.indexOf('path === "/api/preflight"'));
  const body = handler.slice(0, handler.indexOf("execFile("));
  assert.ok(
    !body.includes("--require-todos"),
    "the preflight argv must not carry a flag bench_preflight.py does not define",
  );
});

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
  const { notice, noticesPathFor } = await import("./notices.mjs");
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
  const { notice, noticesPathFor } = await import("./notices.mjs");
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
  const { notice } = await import("./notices.mjs");
  const missing = join(tmpdir(), "okp-no-such-dir-9c1f", "deep", "cell.log");
  assert.equal(await notice(missing, "run_queued"), false, "reports failure, does not throw");
});

test("NOTICES: an off-vocabulary level falls back to info rather than being dropped", async () => {
  // An unrecognised level is a CALLER drifting from the contract. Dropping the
  // record would hide that drift on the one surface built to show it; the drift
  // test is what makes it loud, and this is what makes it harmless.
  const { notice, noticesPathFor } = await import("./notices.mjs");
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

test("BACKEND FEED: two streams merge into one ordered view", async () => {
  // They are separate files because their facts have different LIFETIMES — a
  // cell's stream dies with the cell's tree, the control plane's outlives it —
  // and merged here because an operator asking "what is happening" does not care
  // which process holds the pen.
  const { readBackendFeed } = await import("./backend-feed.mjs");
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
  const { readBackendFeed } = await import("./backend-feed.mjs");
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
  const { rowSource, rowLevel } = await import("./backend-feed.mjs");
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
  const { readBackendFeed, FEED_TAIL_BYTES } = await import("./backend-feed.mjs");
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
  const { readBackendFeed } = await import("./backend-feed.mjs");
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
  const { readBackendFeed } = await import("./backend-feed.mjs");
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
  const { readBackendFeed } = await import("./backend-feed.mjs");
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

test("every refusal carries a human-readable reason", () => {
  const r = refuse("run_in_flight", "a cell is running");
  assert.equal(r.ok, false);
  assert.equal(r.code, "run_in_flight");
  assert.ok(r.reason.length > 0);
});

// ── GUARD: preview must validate the same parameters start does ──────────────
//
// REAL DEFECT, 2026-08-12. /api/run/preview minted a confirmation token for ANY
// payload without validating it. An ON cell with no org returned 200, so the UI
// armed a confirm button for a run that /api/run/start would then refuse with
// `org_required` — the refusal arrived AFTER the operator committed, which is
// the one place it is useless.
//
// server.mjs calls listen() at import, so it cannot be imported into a test
// process. These assertions read the source instead. That is weaker than
// calling the function, and it is chosen deliberately: a source assertion that
// pins the two load-bearing details is worth more than no guard at all on a bug
// that already shipped once.
const SERVER_SRC = readFileSync(join(HERE, "server.mjs"), "utf8");

function previewHandlerSource() {
  const start = SERVER_SRC.indexOf('path === "/api/run/preview"');
  assert.notEqual(start, -1, "the /api/run/preview route disappeared");
  const end = SERVER_SRC.indexOf('path === "/api/run/start"', start);
  assert.notEqual(end, -1, "could not find the end of the preview handler");
  return SERVER_SRC.slice(start, end);
}

test("preview validates parameters through the same path as start", () => {
  const src = previewHandlerSource();
  assert.match(
    src,
    /validateStart\(/,
    "preview no longer calls validateStart — it can once again mint a token for a run start would refuse",
  );
});

test("preview does not demand the token it exists to mint", () => {
  const src = previewHandlerSource();
  assert.match(
    src,
    /requireConfirm:\s*false/,
    "preview must pass requireConfirm:false — requiring the confirmation there is " +
      "circular and refuses every valid preview with bad_confirmation",
  );
});

test("preview reports the serial gate without refusing on it", () => {
  const src = previewHandlerSource();
  // can_start is a fact about NOW, not about the parameters. Reviewing the next
  // cell while one is in flight must stay possible, so preview overrides the
  // gate for validation and surfaces it as a separate advisory field.
  assert.match(src, /can_start:\s*true/, "preview must not refuse on the serial gate");
  assert.match(src, /blocked_now/, "preview must still surface that a run is in flight");
});

test("start still requires the confirmation token", () => {
  const startIdx = SERVER_SRC.indexOf('path === "/api/run/start"');
  assert.notEqual(startIdx, -1, "the /api/run/start route disappeared");
  const src = SERVER_SRC.slice(startIdx, startIdx + 1600);
  assert.doesNotMatch(
    src,
    /requireConfirm:\s*false/,
    "start must NEVER skip confirmation — that is what makes the second click meaningful",
  );
});

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
  const py = readFileSync(join(BENCH, "harness", "adapters", "backgammon.py"), "utf8");
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
  const py = readFileSync(join(BENCH, "harness", "adapters", "backgammon.py"), "utf8");
  const fn = py.slice(py.indexOf("def _run_gate_report"), py.indexOf("def _kill_process_group"));
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

test("the board never mints its own confirmation token", () => {
  // A client-generated confirmation confirms nothing the server can trust. The
  // token fingerprints the exact parameters, so it must be RECEIVED from
  // /api/run/preview and echoed back verbatim — never reconstructed in the
  // browser, which would let a stale confirmation start a run with parameters
  // the operator never saw. Run-START lives in create.js's launchCell (one
  // uninterrupted preview→start sequence); runstart.js is now the STOP surface.
  const src = readFileSync(join(BENCH, "dashboard", "panels", "create.js"), "utf8");
  assert.match(src, /pvData\.token/, "create.js must read the token from the preview response");
  assert.match(
    src,
    /confirm:\s*pvData\.token/,
    "create.js must echo the preview token verbatim to /api/run/start",
  );
  assert.ok(
    !/confirmationToken/.test(src),
    "create.js references confirmationToken — the browser must never compose one",
  );
});

test("changing a run parameter disarms a pending confirmation", () => {
  // The token is a fingerprint of the parameters; a stale one must never
  // survive an edit. The old two-step flow (preview, then a separate START
  // click) needed an explicit disarm() on every parameter change. The
  // one-click launchCell flow replaced it: preview→start is one uninterrupted
  // sequence and the token lives in a function-local (pvData), so there is no
  // pending confirmation to disarm — the property holds by construction.
  const src = readFileSync(join(BENCH, "dashboard", "panels", "create.js"), "utf8");
  assert.match(
    src,
    /const\s+pvData\s*=\s*await\s+pv\.json/,
    "the preview token must be function-local — it cannot outlive the launch and go stale",
  );
});

test("the dashboard server stays read-only: no write route, no POST handler", () => {
  // GET-only, bench repo mounted :ro, uid 1000, no docker socket. Those are
  // kernel-enforced properties and they are what make "the dashboard corrupted
  // a run" impossible rather than merely unlikely. Every write goes to the
  // control plane, which the browser posts to directly.
  const src = readFileSync(join(BENCH, "dashboard", "server.mjs"), "utf8");
  assert.ok(
    !/req\.method\s*===\s*"POST"/.test(src),
    "the dashboard server handles a POST — writes belong to the control plane alone",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE WALL (WO-GATE-ROSTER)
//
// The wall answers a question `failed_gates` structurally could not: for every
// gate in the suite, what happened to it? These tests pin the distinctions that
// make that answer honest — most importantly that "no result" is never allowed
// to read as "passed".
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal two-phase roster; enough to exercise every fold branch. */
function fakeRoster() {
  return {
    schema_version: 1,
    total: 4,
    by_phase: { backend: 3, frontend: 1 },
    suite_fingerprint: "sha256:deadbeef",
    enumeration: { executed_tests: false, complete: true, incomplete_reason: null },
    gates: [
      { id: "G01", phase: "backend", req: "REQ-INIT", title: "initial position", gate_token: "G01", tier: "core" },
      { id: "G02", phase: "backend", req: "REQ-PIP", title: "pip count", gate_token: "G02", tier: "core" },
      { id: "G03", phase: "backend", req: "REQ-DICE", title: "dice", gate_token: "G03", tier: "core" },
      { id: "F01", phase: "frontend", req: "REQ-RENDER", title: "renders", gate_token: "F01", tier: "core" },
    ],
  };
}

test("WALL: a gate that never ran is never reported as passed", () => {
  // THE DEFECT THIS WHOLE SURFACE EXISTS TO REMOVE. Under `failed_gates` alone,
  // G03 (never executed) and G01 (executed, passed) were both simply "not in
  // the failing list" — indistinguishable, and the natural reading of that
  // silence is success.
  const roster = fakeRoster();
  const attempts = [
    {
      attempt: 1,
      gate_results: [
        { id: "G01", status: "pass" },
        { id: "G02", status: "fail" },
        { id: "G03", status: "not_run", reason: "phase aborted before execution" },
      ],
    },
  ];
  const { gates } = foldGateStates({ roster, attempts });
  const byId = Object.fromEntries(gates.map((g) => [g.id, g]));
  assert.equal(byId.G01.state, "passing");
  assert.equal(byId.G02.state, "failing");
  assert.equal(byId.G03.state, "untested", "a not_run gate must never be resolved");
  // A gate absent from the results array entirely is the same class of fact.
  assert.equal(byId.F01.state, "untested", "an unreported gate must never be resolved");
});

test("WALL: not_run is untested, but error is a failure", () => {
  // The two ways the three-way split goes wrong, pinned in one place.
  // `not_run`  — the runner never reached it. No measurement exists.
  // `error`    — it ran and could not complete. It has NOT been shown to work.
  const roster = fakeRoster();
  const attempts = [
    {
      attempt: 1,
      gate_results: [
        { id: "G01", status: "not_run" },
        { id: "G02", status: "error" },
      ],
    },
  ];
  const byId = Object.fromEntries(
    foldGateStates({ roster, attempts }).gates.map((g) => [g.id, g]),
  );
  assert.equal(byId.G01.state, "untested", "an unreached gate must not invent a red square");
  assert.equal(byId.G02.state, "failing", "a broken gate must not hide in the not-yet bucket");
});

test("WALL: totals partition the suite exactly", () => {
  // Every gate lands in exactly one of THREE states, so the totals must sum to
  // the suite size. If they ever do not, the board is rendering a suite that
  // does not exist.
  const roster = fakeRoster();
  const attempts = [
    { attempt: 1, gate_results: [{ id: "G01", status: "pass" }, { id: "G02", status: "fail" }] },
  ];
  const { gates, totals } = foldGateStates({ roster, attempts });
  const sum = totals.passing + totals.failing + totals.untested;
  assert.equal(sum, roster.total, "totals must sum to the suite total");
  assert.equal(sum, gates.length);
  assert.equal(Object.keys(totals).length, 3, "three states, and no more");
});

test("WALL: `unmeasured` counts stated non-results, never gates nobody reached", () => {
  // THE TWO ABSENCES ARE NOT THE SAME FACT. A gate the stream has not mentioned
  // is not reached yet — normal, and the whole suite looks like that early in a
  // cell. A gate the runner explicitly published as `not_run` is one it reached
  // the phase for and produced no verdict against: four of those, with their
  // siblings measured normally, is the fingerprint a grading worker leaves when
  // it dies mid-file. Counting them together would peg the footer at the suite
  // size for the first minutes of every healthy run and say nothing.
  const roster = fakeRoster();

  // G01 measured, G02 explicitly not_run, the rest never mentioned.
  const { totals, unmeasured, gates } = foldGateStates({
    roster,
    attempts: [
      { attempt: 1, gate_results: [{ id: "G01", status: "pass" }, { id: "G02", status: "not_run" }] },
    ],
  });
  assert.equal(unmeasured, 1, "only the stated non-result counts");

  // IT IS A SUBSET, NOT A BUCKET. The three states still partition the suite,
  // and `not_run` still colours as untested — the wall invents no verdict.
  assert.equal(totals.passing + totals.failing + totals.untested, roster.total);
  assert.equal(Object.keys(totals).length, 3, "three states, and no more");
  assert.ok(unmeasured <= totals.untested, "unmeasured is contained by untested");
  assert.equal(gates.find((g) => g.id === "G02").state, "untested");

  // A RUN THAT HAS PUBLISHED NOTHING HAS NO UNMEASURED GATES — it has no
  // measurements at all, which is a different statement and already carried by
  // `outcomes_published`.
  assert.equal(foldGateStates({ roster, attempts: [] }).unmeasured, 0);
});

test("WALL: the LAST completed test run wins — a fixed gate turns green", () => {
  // The wall reports the current state of the code, not the history of how it
  // got there. Attempt 2 supersedes attempt 1 outright.
  const roster = fakeRoster();
  const attempts = [
    { attempt: 1, gate_results: [{ id: "G01", status: "fail" }, { id: "G02", status: "fail" }] },
    { attempt: 2, gate_results: [{ id: "G01", status: "pass" }, { id: "G02", status: "fail" }] },
  ];
  const byId = Object.fromEntries(
    foldGateStates({ roster, attempts }).gates.map((g) => [g.id, g]),
  );
  assert.equal(byId.G01.state, "passing", "fixed in attempt 2");
  assert.equal(byId.G02.state, "failing", "still broken in attempt 2");
});

test("WALL: a gate that REGRESSED reads red, not green", () => {
  // The mirror image, and the reason the fold takes the latest result rather
  // than "passed at least once". A gate that passed attempt 1 and broke in
  // attempt 2 is broken NOW, and a wall that showed it green would be reporting
  // a pass that no longer holds.
  const roster = fakeRoster();
  const attempts = [
    { attempt: 1, gate_results: [{ id: "G01", status: "pass" }] },
    { attempt: 2, gate_results: [{ id: "G01", status: "fail" }] },
  ];
  const byId = Object.fromEntries(
    foldGateStates({ roster, attempts }).gates.map((g) => [g.id, g]),
  );
  assert.equal(byId.G01.state, "failing");
});

test("WALL: a gate row carries NO phase and no live signal", () => {
  // The wall is a dumb surface: the server hands it the verdict, the identity
  // needed to check a square against the log, and — since the trajectory split
  // — two facts about RECORDED HISTORY. Nothing else.
  //
  // The invariant this test exists for is unchanged and is asserted explicitly
  // below: no phase, and nothing live. `first_pass_attempt` / `ever_failed` are
  // folded from completed attempts already on disk, so they cannot reintroduce
  // the in-flight ambers this rebuild removed. `state` is still the only field
  // that answers pass/fail.
  const roster = fakeRoster();
  const attempts = [{ attempt: 1, gate_results: [{ id: "G01", status: "pass" }] }];
  const [row] = foldGateStates({ roster, attempts }).gates;
  // `unmeasured_cause` joins the row because the PANEL consumes it: an
  // instrument fault and a gate nobody reached are both unmeasured, drew
  // identically, and are not the same fact. It is folded from completed
  // attempts on disk like the two trajectory facts beside it, so it cannot
  // reintroduce an in-flight state. An earlier attempt at this put a derived
  // count on the row that no surface read; that one was rightly rejected.
  assert.deepEqual(
    Object.keys(row).sort(),
    ["ever_failed", "first_pass_attempt", "id", "req", "state", "title", "unmeasured_cause"],
  );

  // THE ACTUAL PROHIBITION, stated as itself rather than as a key count.
  for (const forbidden of ["phase", "live", "in_flight", "provisional", "attempts", "status"]) {
    assert.ok(!(forbidden in row), `a gate row must not carry "${forbidden}"`);
  }
});

test("WALL: run_dir is confined to a child of the runs root", () => {
  // The value reaches an fs path. Traversal would let a caller read arbitrary
  // JSON off the host through a read-only endpoint.
  assert.equal(resolveRunDir("/runs", "../../etc"), null);
  assert.equal(resolveRunDir("/runs", "/etc/passwd"), null);
  // ── NESTED IS NOW LEGAL, TRAVERSAL IS STILL NOT ─────────────────────────
  //
  // The separator ban was correct for a flat layout where every run directory
  // was a direct child. Under the benchmark tree a campaign home IS a path
  // (`<tree>/<substrate>/<router>/<provider>/<model>`), so rejecting separators
  // outright would refuse every legitimate run_dir on a bench that is running
  // normally. The containment property is unchanged and asserted below.
  assert.equal(resolveRunDir("/runs", "a/b")?.name, "a/b", "a nested campaign home resolves");
  assert.equal(
    resolveRunDir("/runs", "1787310000/local/local-llm-proxy/omlx/model-x")?.name,
    "1787310000/local/local-llm-proxy/omlx/model-x",
    "a full tree path resolves",
  );
  // Every escape still refused — each segment is validated before resolution,
  // and the resolved path must still sit under the root.
  assert.equal(resolveRunDir("/runs", "a/../../etc"), null, "traversal through a nested path");
  assert.equal(resolveRunDir("/runs", "a/./b"), null, "a dot segment");
  assert.equal(resolveRunDir("/runs", "a//b"), null, "an empty segment");
  assert.equal(resolveRunDir("/runs", "/etc/passwd"), null, "an absolute path");
  assert.equal(resolveRunDir("/runs", ".."), null);
  assert.equal(resolveRunDir("/runs", "cumulative")?.name, "cumulative");
  assert.equal(resolveRunDir("/runs", "")?.name, "cumulative", "empty falls back to the default run dir");
});

// ── THE WIPE BOUNDARY ───────────────────────────────────────────────────────
//
// Cell logs are written to the runs ROOT; the run state they describe lives in
// `runs/<run_dir>/`. Archiving or wiping a run moves the directory and leaves
// the log, so the log outlives its own data.
//
// MEASURED 2026-08-13: after a wipe, `runs/off-cell-20260813T051334.log`
// remained at the root and every reader resolved it as the live run. /api/wall
// served `suite.total:null` (the run dir was gone) beside `grading.active:true
// phase:frontend stalled:true silent_s:4848` parsed out of that dead log — a
// wiped bench reporting a run in progress, which the operator could not clear
// without hand-deleting files after every wipe.

test("WIPE: a cell log whose run directory is gone is not resolved as the live run", async () => {
  const root = mkdtempSync(join(tmpdir(), "wipe-"));
  try {
    const runs = join(root, "runs");
    mkdirSync(runs, { recursive: true });
    // The exact post-wipe shape: the run dir archived away, the log left behind.
    mkdirSync(join(runs, "cumulative.wiped-sim", "sessions"), { recursive: true });
    writeFileSync(
      join(runs, "off-cell-orphan.log"),
      "PROGRESS step=worktree-git-init path=" +
        join(runs, "cumulative", "sessions", "cell", "worktree") +
        "\nPROGRESS step=gate-phase-start phase=frontend\n",
    );

    assert.equal(
      await newestLog(runs),
      null,
      "an orphan log describes a run that no longer exists and is not live",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WIPE: a cell log whose run directory still exists IS resolved as live", async () => {
  const root = mkdtempSync(join(tmpdir(), "wipe-"));
  try {
    const runs = join(root, "runs");
    mkdirSync(join(runs, "cumulative", "sessions"), { recursive: true });
    writeFileSync(
      join(runs, "off-cell-live.log"),
      "PROGRESS step=worktree-git-init path=" +
        join(runs, "cumulative", "sessions", "cell", "worktree") +
        "\n",
    );

    const log = await newestLog(runs);
    assert.ok(log, "a log whose run dir exists is still the live run");
    assert.equal(log.run_dir, "cumulative");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WIPE: a fresh log that has not yet named a run dir is live, not orphaned", async () => {
  const root = mkdtempSync(join(tmpdir(), "wipe-"));
  try {
    const runs = join(root, "runs");
    mkdirSync(runs, { recursive: true });
    // A just-launched cell prints banner lines before any artifact path.
    writeFileSync(join(runs, "off-cell-new.log"), "This is mini-swe-agent version 2.4.5.\n");

    const log = await newestLog(runs);
    assert.ok(log, "a log that has not named a run dir yet must not be discarded");
    assert.equal(log.run_dir, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WIPE: an orphan is skipped in favour of an older log that is still live", async () => {
  const root = mkdtempSync(join(tmpdir(), "wipe-"));
  try {
    const runs = join(root, "runs");
    mkdirSync(join(runs, "cumulative", "sessions"), { recursive: true });

    const livePath = join(runs, "off-cell-live.log");
    writeFileSync(
      livePath,
      "PROGRESS step=worktree-git-init path=" + join(runs, "cumulative", "s", "w") + "\n",
    );
    // Newer by mtime, but its run dir is gone: recency must not beat existence.
    const orphanPath = join(runs, "off-cell-orphan.log");
    writeFileSync(
      orphanPath,
      "PROGRESS step=worktree-git-init path=" + join(runs, "cumulative.gone", "s", "w") + "\n",
    );
    utimesSync(livePath, new Date(1000), new Date(1000));
    utimesSync(orphanPath, new Date(9000), new Date(9000));

    const log = await newestLog(runs);
    assert.equal(log?.name, "off-cell-live.log", "the newest LIVE log wins, not the newest log");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WALL: a wiped bench shows the suite defined and every gate untested", async () => {
  const root = mkdtempSync(join(tmpdir(), "wiped-"));
  try {
    const runs = join(root, "runs");
    mkdirSync(runs, { recursive: true });

    const wall = await readWall({ runsRoot: runs, runDir: null, benchRoot: BENCH });

    assert.equal(wall.ok, true);
    assert.equal(wall.suite_source, "enumerated", "the suite came from the harness, not a run");
    // The count is whatever the harness enumerates — asserted as a real number
    // rather than a literal, so adding a gate does not fail this test.
    assert.ok(wall.suite.total > 0, "the suite size is known");
    assert.equal(
      wall.totals.untested,
      wall.suite.total,
      "every gate is untested: defined, not yet evaluated",
    );
    assert.equal(wall.totals.passing, 0);
    assert.equal(
      wall.totals.failing,
      0,
      "a bench that has not run must never read as everything-failed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WALL: the suite denominator is never fabricated when the harness cannot be reached", async () => {
  const root = mkdtempSync(join(tmpdir(), "noharness-"));
  try {
    const runs = join(root, "runs");
    mkdirSync(runs, { recursive: true });
    // benchRoot with no gates dir: the enumerator cannot run.
    const wall = await readWall({ runsRoot: runs, runDir: null, benchRoot: root });

    assert.equal(wall.ok, true, "a missing enumerator is a state, not a 500");
    assert.equal(wall.suite.total, null, "unknowable stays null, never 0 (invariant I-2)");
    assert.ok(wall.unwired.includes("gate-roster"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WALL: a run's own pinned roster wins over live enumeration", async () => {
  const root = mkdtempSync(join(tmpdir(), "pinned-"));
  try {
    const runs = join(root, "runs");
    mkdirSync(join(runs, "cumulative"), { recursive: true });
    // A roster pinned to this run describes the suite it was GRADED against and
    // must not be replaced by today's suite, or every comparison re-baselines.
    writeFileSync(
      join(runs, "cumulative", "gate-roster.json"),
      JSON.stringify({
        schema_version: 1,
        total: 2,
        suite_fingerprint: "sha256:pinned",
        gates: [
          { id: "G01", phase: "backend", tier: "core" },
          { id: "G02", phase: "backend", tier: "core" },
        ],
      }),
    );

    const wall = await readWall({ runsRoot: runs, runDir: "cumulative", benchRoot: BENCH });
    assert.equal(wall.suite_source, "run", "the pinned roster is authoritative");
    assert.equal(wall.suite.total, 2);
    assert.equal(wall.suite.fingerprint, "sha256:pinned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WALL: a truncated status stream yields every intact record before the tear", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wall-"));
  try {
    const path = join(dir, "manifest.status.jsonl");
    writeFileSync(
      path,
      '{"type":"attempt","attempt":1,"gate_results":[]}\n' +
        '{"type":"turn_terminal"}\n' +
        '{"type":"attempt","attempt":2,"gate_r',
    );
    const records = await readStatusRecords(path);
    assert.equal(records.length, 2, "the intact records survive");
    assert.equal(attemptRecords(records).length, 1, "the torn attempt record is not invented");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the producer side ───────────────────────────────────────────────────────

test("ROSTER: a colliding token falls back to a slug instead of merging gates", () => {
  // [G10] covers five separate tests in the real suite. Using the bare token as
  // an id would silently merge them into one square and drop four gates from
  // the denominator.
  const gates = assignIds([
    { gate_token: "G01", phase: "backend", file: "backend/a.test.ts", full_name: "s > [G01] one" },
    { gate_token: "G10", phase: "backend", file: "backend/b.test.ts", full_name: "s > [G10] first" },
    { gate_token: "G10", phase: "backend", file: "backend/b.test.ts", full_name: "s > [G10] second" },
  ]);
  assert.equal(gates[0].id, "G01", "a token identifying exactly one test IS the id");
  assert.notEqual(gates[1].id, "G10");
  assert.notEqual(gates[1].id, gates[2].id, "colliding tokens must not produce colliding ids");
  assert.equal(gates[1].gate_token, "G10", "the token survives for grouping");
});

test("ROSTER: the fingerprint changes when the suite changes, not when it is reordered", () => {
  // The fingerprint's whole job is detecting that the suite changed mid-campaign
  // — which invalidates cross-cell gate comparison. A reorder is not a change.
  const a = [{ id: "G01" }, { id: "G02" }];
  const b = [{ id: "G02" }, { id: "G01" }];
  const c = [{ id: "G01" }, { id: "G03" }];
  assert.equal(suiteFingerprint(a), suiteFingerprint(b), "order must not affect the fingerprint");
  assert.notEqual(suiteFingerprint(a), suiteFingerprint(c));
});

test("ROSTER: the list parsers read what the runners actually print", () => {
  const vit = parseVitestList(
    "backend/gates-01-08.test.ts > Backgammon backend gates 01-08 > [G01] REQ-INIT — initial position\n" +
      "not a test line\n",
  );
  assert.equal(vit.length, 1);
  assert.equal(vit[0].file, "backend/gates-01-08.test.ts");
  assert.deepEqual(vit[0].chain, ["Backgammon backend gates 01-08", "[G01] REQ-INIT — initial position"]);

  const pw = parsePlaywrightList(
    "Listing tests:\n" +
      "  [chromium] › core.spec.ts:108:1 › [F01] REQ-RENDER — page loads\n" +
      "Total: 1 test in 1 file\n",
  );
  assert.equal(pw.length, 1, "the banner and the total are not tests");
  assert.equal(pw[0].file, "core.spec.ts");
  assert.equal(pw[0].line, 108);
  assert.deepEqual(pw[0].chain, ["[F01] REQ-RENDER — page loads"]);
});

test("GATE RESULTS: every roster gate appears exactly once, not_run included", () => {
  // INVARIANT I-4 stated as a shape: the output array is the roster, always.
  const roster = {
    available: true,
    fingerprint: "sha256:x",
    gates: [
      { id: "G01", phase: "backend", file: "a.test.ts", full_name: "one", test_name: "one" },
      { id: "G02", phase: "backend", file: "a.test.ts", full_name: "two", test_name: "two" },
    ],
    byKey: new Map(),
  };
  const matcher = { unmatched: [] };
  const folded = foldGateResults({
    roster,
    matcher,
    observed: [{ id: "G01", status: "pass", phase: "backend", duration_ms: 3 }],
    phaseRan: { backend: true },
  });
  assert.equal(folded.gate_results.length, 2);
  const g2 = folded.gate_results.find((r) => r.id === "G02");
  assert.equal(g2.status, "not_run");
  assert.match(g2.reason, /produced no result/);
  assert.deepEqual(folded.gate_totals, { total: 2, pass: 1, fail: 0, not_run: 1, error: 0 });
});

test("GATE RESULTS: with no roster, the denominator is null — never zero", () => {
  // INVARIANT I-2. Zero reads as "nothing was missed"; null reads as "unknown".
  // Only one of those is true when the suite is unknown.
  const folded = foldGateResults({
    roster: { available: false, reason: "no --roster supplied", gates: [], byKey: new Map() },
    matcher: { unmatched: [] },
    observed: [{ id: "G01", status: "pass" }],
    phaseRan: {},
  });
  assert.equal(folded.gate_totals.total, null);
  assert.equal(folded.gate_totals.not_run, null);
  assert.equal(folded.gate_roster.available, false);
  assert.match(folded.gate_roster.reason, /no --roster/);
});

test("GATE RESULTS: a runner's status words map onto the published vocabulary", () => {
  assert.equal(normalizeStatus("passed").status, "pass");
  assert.equal(normalizeStatus("failed").status, "fail");
  // A test that blew its own timeout DID run and did NOT satisfy the gate.
  assert.equal(normalizeStatus("timedOut").status, "fail");
  // Skipped and interrupted did NOT run — and must never read as pass.
  assert.equal(normalizeStatus("skipped").status, "not_run");
  assert.equal(normalizeStatus("interrupted").status, "not_run");
  // An unknown word is surfaced as an error, never quietly treated as a pass.
  assert.equal(normalizeStatus("wat").status, "error");
});

test("ROSTER: tiers partition the suite without shrinking it", () => {
  // A tier says what KIND of gate this is so the board can render an edge-case
  // square differently and a scorecard can quote a core-only bar. It is NOT a
  // way to make a gate optional — `total` stays the true enumerated count
  // (invariant I-1), and tiers only slice it.
  const tiers = { fallback: "core", rules: [{ tier: "edge", path_segment: "edge" }] };
  assert.equal(tierOf("backend/edge/edge-gates.test.ts", tiers), "edge");
  assert.equal(tierOf("backend/gates-01-08.test.ts", tiers), "core");
  // Substring matches must not count — only a whole path SEGMENT named `edge`.
  assert.equal(tierOf("edges.spec.ts", tiers), "core", "edges.spec.ts is a core frontend file");
  assert.equal(tierOf("backend/hedge/x.test.ts", tiers), "core");
  // No rules at all: everything is labelled, nothing is dropped.
  assert.equal(tierOf("anything.test.ts", { fallback: "core", rules: [] }), "core");
});

// ─────────────────────────────────────────────────────────────────────────────
// GRADED TEXT (WO-FEEDBACK-1)
//
// The harness renders gate results into prose and hands it to the model as a
// user turn. These pin the one property that makes the surface worth having:
// the text is carried VERBATIM. A surface that cleaned it up would answer a
// different question than the one an operator opens it to judge.
// ─────────────────────────────────────────────────────────────────────────────

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
    const cell = join(dir, "cumulative", "sessions", "cell-0");
    mkdirSync(cell, { recursive: true });
    writeFileSync(
      join(cell, "worktree.user-events.jsonl"),
      '{"type":"user","kind":"feedback","attempt":2,"text":"body here"}\n',
    );
    const withText = await readFeedback({ runsRoot: dir, runDir: "cumulative" });
    assert.equal(withText.messages[0].text, "body here");
    assert.equal(withText.text_included, true);
    assert.equal(withText.counts.feedback, 1);

    const without = await readFeedback({ runsRoot: dir, runDir: "cumulative", includeText: false });
    assert.equal(without.text_included, false, "a client must tell 'no text here' from 'no text sent'");
    assert.equal(without.messages[0].text, undefined);
    assert.equal(without.messages[0].chars, "body here".length, "the length still reports");
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
function writeRun(root, dir, { seq = 0, model = "m-a", arm = "off", status = null }) {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "manifest.json"), JSON.stringify({
    created_at: "2026-08-13T00:00:00Z",
    // The arm field is `memory_mode` and the model is bare in `provider_pin`.
    schedule: [{ sequence_index: seq, memory_mode: arm, provider_pin: model }],
  }));
  if (status) writeFileSync(join(d, "manifest.status.jsonl"), `${JSON.stringify(status)}\n`);
  return d;
}

/**
 * A MULTI-SLOT campaign: one schedule, both arms, one status record per slot.
 *
 * This is the shape a real campaign has — `harness/cumulative/ordering.py`
 * schedules ONE model per directory, slot 0 as the OFF floor and every later
 * slot an ON repetition of it — and it is what the runs of a baseline are read
 * from. `writeRun` above is the single-slot case kept for the gate tests.
 */
function writeCampaign(root, dir, slots, { model = "m-a" } = {}) {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "manifest.json"), JSON.stringify({
    created_at: "2026-08-13T00:00:00Z",
    schedule: slots.map((s) => ({ sequence_index: s.seq, memory_mode: s.arm, provider_pin: model })),
  }));
  const status = slots.filter((s) => s.status).map((s) => JSON.stringify(s.status)).join("\n");
  if (status) writeFileSync(join(d, "manifest.status.jsonl"), `${status}\n`);
  return d;
}

const OFF_PASS = { type: "attempt", sequence_index: 0, verdict: "PASS", progress: { turns: 9, total_tokens: 400, wall_seconds: 60 } };

test("LEDGER: a valid OFF cell is the baseline, and it opens + run but not + baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative", { status: OFF_PASS });

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
    runInFlight: false,
  });
  const m = led.models[0];
  assert.equal(m.baseline.scorable, true);
  assert.equal(m.can_run.allowed, true);
  // Re-baselining is a declared act (RUNBOOK 5.13), never a live button.
  assert.equal(m.can_baseline.allowed, false);

  // The card's own rooting carries the same verdict on the same floor.
  const row = led.baseline_rows.find((b) => b.model === "m-a");
  assert.ok(row, "a measured floor has no row in baseline_rows");
  assert.equal(row.can_run.allowed, true);
  assert.equal(row.run_count, 0, "no ON cell has been measured against it yet");
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: a VOID baseline counts as NO baseline and re-opens + baseline", async () => {
  // The failure this prevents: void numbers exist and look like success, so a
  // gate keyed on "a cell completed" would green-light an ON run whose every Δ
  // is measured against the harness rather than the model.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative", {
    status: { type: "attempt", sequence_index: 0, verdict: "FAIL", terminal_reason: "transport_incomplete", progress: { turns: 2 } },
  });

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
    runInFlight: false,
  });
  const m = led.models[0];
  assert.equal(m.baseline.scorable, false);
  assert.equal(m.baseline.voided, true);
  assert.equal(m.can_run.allowed, false, "nothing may be measured against a void floor");
  assert.equal(m.can_baseline.allowed, true, "the operator must be able to re-measure");
  assert.match(m.can_baseline.reason ?? "", /^$|void/i);
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: attempt_ceiling_reached is a real FAIL, not a void instrument", async () => {
  // A model that fails every attempt is the bench's most important finding.
  // Calling it an instrument fault would discard it.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative", {
    status: { type: "attempt", sequence_index: 0, verdict: "FAIL", terminal_reason: "attempt_ceiling_reached", progress: { turns: 40 } },
  });

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
    runInFlight: false,
  });
  assert.equal(led.models[0].baseline.scorable, true, "a capability FAIL is a usable floor");
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: an archived run never supplies a baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative.wiped-recommission-20260813T0150", { status: OFF_PASS });

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
    runInFlight: false,
  });
  assert.equal(led.models[0].baseline.exists, false);
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: one cell in flight blocks EVERY button on EVERY model", async () => {
  // The serial rule is a property of the bench, not of a row. A per-row UI is
  // exactly where this gets broken, because each row looks independent.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative", { status: OFF_PASS });

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }, { id: "m-b", bench_eligible: true }],
    runInFlight: true,
    blockedReason: "a cell is running (off-cell-3.log)",
  });
  assert.equal(led.run_in_flight, true);
  for (const m of led.models) {
    assert.equal(m.can_baseline.allowed, false);
    assert.equal(m.can_run.allowed, false);
    assert.match(m.can_baseline.reason, /cell is running/);
  }
  for (const b of led.baseline_rows) {
    assert.equal(b.can_run.allowed, false, "a floor row must not offer a launch either");
    assert.match(b.can_run.reason, /cell is running/);
  }
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: a floor on one model never blocks another model's + baseline", async () => {
  // THE DEFECT THIS PINS. The profile subject rule was applied to OFF cells as
  // well as ON, so freezing the first profile disabled [+ baseline] on every
  // OTHER bench model — and since a run gates on a floor, no second model could
  // ever be benchmarked. The whole bench silently locked to whichever model was
  // profiled first, with four permanently disabled buttons to show for it. The
  // profile store is gone; this pins the surviving rule.
  //
  // A baseline is measured against nothing. One floor per model, and no other
  // model's floor has any bearing on it.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative", { status: OFF_PASS });           // m-a has a floor

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [
      { id: "m-a", bench_eligible: true },
      { id: "m-b", bench_eligible: true },
      { id: "m-c", bench_eligible: true },
    ],
    runInFlight: false,
  });

  const byId = Object.fromEntries(led.models.map((m) => [m.id, m]));
  // m-a is floored: no second baseline, but a run against it is open.
  assert.equal(byId["m-a"].can_baseline.allowed, false);
  assert.match(byId["m-a"].can_baseline.reason, /already has a valid baseline/);
  assert.equal(byId["m-a"].can_run.allowed, true);
  // Every other model may still measure its own floor.
  for (const id of ["m-b", "m-c"]) {
    assert.equal(byId[id].can_baseline.allowed, true, `${id} must be able to measure its own floor`);
    assert.equal(byId[id].can_baseline.reason, null, "an open gate states no refusal");
    // …and nothing can be measured against a floor it does not have.
    assert.equal(byId[id].can_run.allowed, false);
  }
  rmSync(root, { recursive: true, force: true });
});

test("CAMPAIGN: a second model gets its own directory; the first keeps runs/cumulative", async () => {
  // WHY THIS EXISTS. Every launch used to target runs/cumulative/manifest.json,
  // whose roster hash is frozen to ONE model. A baseline for a second model died
  // at startup with `roster hash drift detected` — so opening [+ baseline] for
  // every un-floored model is only honest if each model has somewhere to write.
  const root = mkdtempSync(join(tmpdir(), "okp-camp-"));
  mkdirSync(join(root, "cumulative"), { recursive: true });
  writeFileSync(join(root, "cumulative", "manifest.json"), JSON.stringify({
    roster: [{ model: "local-llm-proxy/m-a" }],
    schedule: [{ sequence_index: 0, memory_mode: "off", provider_pin: "m-a" }],
  }));

  // The owner keeps the default path — null means "pass no --manifest", so the
  // live campaign's invocation is byte-identical to what it has always been.
  assert.equal(await manifestArgFor("m-a", root), null);
  // Every other model is routed away from it.
  assert.equal(await manifestArgFor("m-b", root), join(root, "cumulative-m-b", "manifest.json"));

  // …and STABLY: a second call for the same model resolves to the same place,
  // so cell 2 continues the campaign cell 1 started.
  assert.equal(await manifestArgFor("m-b", root), join(root, "cumulative-m-b", "manifest.json"));
  rmSync(root, { recursive: true, force: true });
});

test("CAMPAIGN: a dotted model alias never produces an archive-shaped directory", () => {
  // `isArchivedRun()` reads ANY dot as the archive convention
  // (runs/cumulative.<why>-<date>). A directory named for `qwen3.6-…` would
  // therefore be treated as archived and its baseline would silently disappear
  // from the floor index — a measured ~3h cell, invisible, with no error.
  const name = campaignDirName("qwen3.6-35b-a3b-bench");
  assert.equal(name, "cumulative-qwen3-6-35b-a3b-bench");
  assert.equal(isArchivedRun(name), false, "the campaign directory must not read as archived");
  assert.equal(isArchivedRun("cumulative.void-truncation-20260812"), true, "…while a real archive still does");
});

test("CAMPAIGN: an unreadable legacy manifest never relocates the live campaign", async () => {
  // Corrupt manifest => the harness must fail loudly on the default path. Moving
  // the campaign to a fresh directory instead would present as the entire run
  // history having vanished.
  const root = mkdtempSync(join(tmpdir(), "okp-camp-"));
  mkdirSync(join(root, "cumulative"), { recursive: true });
  writeFileSync(join(root, "cumulative", "manifest.json"), "{ not json");
  assert.equal(await manifestArgFor("m-a", root), null, "a broken campaign is faced, not routed around");

  // Readable but model-less: also treated as "mine" rather than relocated.
  writeFileSync(join(root, "cumulative", "manifest.json"), JSON.stringify({ schedule: [] }));
  assert.equal(await manifestArgFor("m-a", root), null);

  // ABSENT is the different answer: nothing has claimed the default directory,
  // so this model names its own.
  rmSync(join(root, "cumulative"), { recursive: true, force: true });
  assert.equal(await manifestArgFor("m-a", root), join(root, "cumulative-m-a", "manifest.json"));
  rmSync(root, { recursive: true, force: true });
});

test("BASELINES: the index is the single export, and it is written to disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-base-"));
  writeRun(root, "cumulative", { status: OFF_PASS });           // m-a floored
  const models = [{ id: "m-a", bench_eligible: true }, { id: "m-b", bench_eligible: true }];

  const idx = await readBaselines({ runsRoot: root, models });
  assert.equal(idx.ok, true);
  assert.equal(idx.models["m-a"].scorable, true);
  // A model with no OFF cell still gets an ENTRY carrying the reason — an
  // absent key is indistinguishable from "not on the bench".
  assert.equal(idx.models["m-b"].scorable, false);
  assert.match(idx.models["m-b"].reason, /no OFF cell has ever been run/);

  // STORED: the export lands on disk, and matches what was served.
  assert.equal(idx.stored.written, true);
  const onDisk = JSON.parse(readFileSync(join(root, BASELINES_FILE), "utf8"));
  assert.deepEqual(onDisk.models, idx.models);

  // Re-derived with nothing changed: same answer, and the file is NOT rewritten
  // — the mtime stays meaningful as "when the floor last changed".
  const again = await readBaselines({ runsRoot: root, models });
  assert.deepEqual(again.models, idx.models);
  assert.equal(again.stored.written, false);

  // THE LEDGER READS THIS SAME INDEX rather than deriving its own.
  const led = await readModelsLedger({ runsRoot: root, benchModels: models, runInFlight: false });
  assert.deepEqual(led.baselines.models, idx.models);
  for (const m of led.models) assert.deepEqual(m.baseline.scorable, idx.models[m.id].scorable);
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: a floor with no ON cell reports an empty run list, not an excuse", async () => {
  // A campaign whose schedule holds only the OFF slot has had nothing measured
  // against its floor. That is an EMPTY LIST, which the card states as "0" —
  // never a sentence about why the runs could not be attributed, because there
  // is no attribution step any more for one to fail at.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative", { status: OFF_PASS });

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
    runInFlight: false,
  });
  const row = led.baseline_rows.find((b) => b.model === "m-a");
  assert.deepEqual(row.runs, []);
  assert.equal(row.run_count, 0);
  assert.equal(row.best, null, "no run means no best, never a zero delta");
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: the ON cells of the floor\'s own campaign ARE its runs, read off disk", async () => {
  // WHAT THIS REPLACED. Runs used to be whatever the profile store had recorded
  // at launch, joined back to a cell by a key the launcher wrote down. Nothing
  // is recorded now: a campaign schedules ONE model, slot 0 as the OFF floor and
  // every later slot an ON repetition of it, so the runs are simply the ON cells
  // in the floor\'s own directory. A cell started at the CLI therefore appears
  // here, where the profile store called it "real but unattributed".
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeCampaign(root, "cumulative", [
    { seq: 0, arm: "off", status: { ...OFF_PASS, sequence_index: 0 } },
    { seq: 1, arm: "on", status: { type: "attempt", sequence_index: 1, verdict: "PASS", progress: { turns: 6, total_tokens: 300, wall_seconds: 40 } } },
    { seq: 2, arm: "on", status: { type: "attempt", sequence_index: 2, verdict: "PASS", progress: { turns: 7, total_tokens: 350, wall_seconds: 45 } } },
  ]);

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
    runInFlight: false,
  });
  const row = led.baseline_rows.find((b) => b.model === "m-a");
  assert.equal(row.run_count, 2, "both ON cells are runs; the OFF cell is the floor, not a run");

  // NEWEST FIRST on the wire, and the ordinals are positions in the SCHEDULE —
  // a run\'s number never changes when a later one is added.
  assert.deepEqual(row.runs.map((r) => r.seq), [2, 1]);
  assert.deepEqual(row.runs.map((r) => r.sequence_index), [2, 1]);
  for (const r of row.runs) assert.ok(r.cell, "an ON cell on disk always carries its measurement");

  // Δ IS AGAINST THIS ROW\'S FLOOR, and `better` is a word, not the sign.
  const first = row.runs.find((r) => r.seq === 1);
  assert.equal(first.delta.computable, true);
  assert.equal(first.delta.turns, 6 - 9);
  assert.equal(first.delta.better, true, "fewer turns than the floor is an improvement");

  // BEST IS EFFICIENCY ONLY and says so.
  assert.equal(row.best.run_seq, 1);
  assert.equal(row.best.turns, -3);
  assert.equal(row.best.axis, "efficiency");
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: the floor\'s own OFF cell is never listed as a run against itself", async () => {
  // A Δ of a cell against itself is zero, and it would sit at the top of every
  // list looking like a measurement. The arm is the filter: only ON cells are
  // runs. This also replaces the old wrong-arm check — a recorded key could
  // point at the OFF cell and adopt its numbers for an ON run, inverting the
  // sign of every Δ. Nothing is recorded now, so that state is unreachable.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeCampaign(root, "cumulative", [
    { seq: 0, arm: "off", status: { ...OFF_PASS, sequence_index: 0 } },
    { seq: 1, arm: "on", status: { type: "attempt", sequence_index: 1, verdict: "PASS", progress: { turns: 6 } } },
  ]);

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
    runInFlight: false,
  });
  const row = led.baseline_rows.find((b) => b.model === "m-a");
  assert.equal(row.sequence_index, 0, "the floor is slot 0");
  assert.equal(row.run_count, 1);
  assert.deepEqual(row.runs.map((r) => r.sequence_index), [1], "slot 0 is the floor, not a run against it");
  rmSync(root, { recursive: true, force: true });
});

// ── CLOUD BASELINES ─────────────────────────────────────────────────────────

test("DRIFT: the cloud catalogue matches CLOUD_ORCAROUTER_PROVIDER in config.py", () => {
  // The control plane is JS and the provider block is Python, so there is no
  // shared import — the same standing condition that makes roster.mjs mirror the
  // worker context registry. This is the test that makes the mirror safe: a
  // model added on one side and not the other fails here rather than presenting
  // to the operator as "that model does not exist".
  const src = readFileSync(join(BENCH, "harness", "config.py"), "utf8");
  const start = src.indexOf("CLOUD_ORCAROUTER_PROVIDER");
  assert.ok(start > -1, "CLOUD_ORCAROUTER_PROVIDER not found in config.py");

  // THE BLOCK'S ACTUAL EXTENT, not a fixed window. This test first read a
  // 4000-character slice, which covered the five models the block held at the
  // time and silently stopped covering it the moment the catalogue grew — the
  // failure mode being that the test still PASSES while checking a fraction of
  // the list. The models dict is delimited, so it is read by its delimiters.
  const mstart = src.indexOf('    "models": {', start);
  assert.ok(mstart > -1, "the provider block has no models dict");
  const mend = src.indexOf("\n    },\n", mstart);
  assert.ok(mend > mstart, "the models dict is not terminated");
  const block = src.slice(mstart, mend);

  const pyKeys = [...block.matchAll(/^\s{8}"([^"]+\/[^"]+)":\s*\{/gm)].map((m) => m[1]);
  assert.ok(pyKeys.length > 0, "no {provider}/{model} keys parsed out of the provider block");
  // THE COUNTS MUST AGREE. Two set-membership loops can both pass while the two
  // sides hold different numbers of entries if either contains a duplicate key,
  // so the size is asserted rather than inferred from them.
  assert.equal(
    pyKeys.length,
    Object.keys(CLOUD_MODELS).length,
    `config.py lists ${pyKeys.length} cloud models and the control plane mirrors ${Object.keys(CLOUD_MODELS).length}`,
  );

  for (const key of Object.keys(CLOUD_MODELS)) {
    assert.ok(
      pyKeys.includes(key),
      `cloud model '${key}' is mirrored here but absent from config.py's provider block`,
    );
  }
  // AND THE OTHER DIRECTION. A model present in Python and missing here is the
  // more damaging drift: the bench can run it and the board will not offer it.
  for (const key of pyKeys) {
    assert.ok(CLOUD_MODELS[key], `config.py offers '${key}' and the control plane does not mirror it`);
  }

  // THE LIMITS TRAVEL TOO. `context` and `output` are not decoration: the board
  // states them on the picker, and an output ceiling set below what the model
  // can emit truncates a response — which this bench classifies as a VOID
  // INSTRUMENT, a cell that burns hours and measures the harness. A mirror that
  // agreed on the model list and disagreed on its ceilings would be worse than
  // no mirror, because it would look correct.
  for (const key of pyKeys) {
    const entry = block.slice(block.indexOf(`"${key}":`));
    const lim = entry.match(/"limit":\s*\{"context":\s*(\d+),\s*"output":\s*(\d+)\}/);
    assert.ok(lim, `config.py entry for '${key}' has no parsable limit`);
    assert.equal(Number(lim[1]), CLOUD_MODELS[key].context, `context drift on '${key}'`);
    assert.equal(Number(lim[2]), CLOUD_MODELS[key].output, `output drift on '${key}'`);
  }
});

test("CLOUD: every mirrored model is shaped for the picker, and narrow windows are BADGED not hidden", () => {
  // THE CATALOGUE IS NOT FILTERED. Every model the provider offers is offered
  // here, because the benchmark measures an INFORMATION DELTA WITHIN one model:
  // the same model runs OFF then ON repeatedly, so it is its own control and its
  // context window cancels out of its own delta. A narrow window does not bias
  // the measurement, so hiding the model would be the picker deciding something
  // it has no standing to decide.
  //
  // What a narrow window does risk is the cell hitting the provider's context
  // ceiling mid-run. That is a runnability caveat, so it is SURFACED: the entry
  // carries its real window and a note, and the board badges it.
  for (const [key, m] of Object.entries(CLOUD_MODELS)) {
    assert.ok(m.output > 0, `'${key}' states no output ceiling`);
    assert.ok(m.context > 0, `'${key}' states no context window`);
    assert.ok(m.name && !m.name.includes("/"), `'${key}' has no readable label (got ${JSON.stringify(m.name)})`);
    assert.equal(key.split("/").length, 2, `'${key}' is not a {provider}/{model} key`);
  }

  // The advisory floor must reach the browser as data, not as a filter.
  const catalogue = cloudCatalog();
  assert.equal(catalogue.length, Object.keys(CLOUD_MODELS).length, "the catalogue drops models");
  for (const entry of catalogue) {
    const narrow = entry.context < CONTEXT_ADVISORY_FLOOR;
    assert.equal(entry.below_advisory_floor, narrow, `'${entry.key}' flag disagrees with its window`);
    if (narrow) {
      assert.ok(entry.context_note, `'${entry.key}' is below the floor and carries no note to show`);
      assert.match(entry.context_note, /compaction/i, `'${entry.key}' note omits the compaction caveat`);
    } else {
      assert.equal(entry.context_note, null, `'${entry.key}' is above the floor and should carry no note`);
    }
  }
});

test("CLOUD: a model key resolves to the provider and model the harness expects", () => {
  // `--cloud --provider <vendor> --model <model>` is what run_cumulative.py's
  // _compose_cloud_slug consumes; passing the whole key as --model would compose
  // orcarouter/anthropic/anthropic/... and be refused for a model the operator
  // never picked.
  const r = resolveCloudModel("anthropic/claude-opus-5");
  assert.equal(r.ok, true);
  assert.equal(r.provider, "anthropic");
  assert.equal(r.model, "claude-opus-5");
  assert.equal(r.slug, "orcarouter/anthropic/claude-opus-5");
});

test("CLOUD: an unknown or malformed model is refused BY NAME, with the alternatives", () => {
  const unknown = resolveCloudModel("acme/does-not-exist");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "cloud_model_unknown");
  assert.match(unknown.reason, /available:/);

  // A three-segment key is a composed slug that still carries its router.
  const malformed = resolveCloudModel("orcarouter/anthropic/claude-opus-5");
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, "cloud_model_malformed");
});

test("CLOUD: the key report carries presence and a fingerprint, never the key", async () => {
  // This object is published to the browser. A leak here is a credential on the
  // wire, so the test asserts the absence of the secret rather than only the
  // presence of the report.
  const root = mkdtempSync(join(tmpdir(), "okp-cloud-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "cloud.env"), "ORCAROUTER_API_KEY=sk-secret-value\n");

  const cloud = await readCloud({ benchRoot: root, env: {} });
  assert.equal(cloud.key.present, true);
  assert.equal(cloud.key.source, "key_file");
  assert.equal(cloud.can_start, true);
  assert.match(cloud.key.fingerprint, /^[0-9a-f]{8}$/);
  assert.ok(
    !JSON.stringify(cloud).includes("sk-secret-value"),
    "the cloud report contains the API key — it is published to the browser and must never carry the secret",
  );
  rmSync(root, { recursive: true, force: true });
});

test("CLOUD: no key means the substrate refuses BEFORE anything is written", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-cloud-"));
  const cloud = await readCloud({ benchRoot: root, env: {} });
  assert.equal(cloud.key.present, false);
  assert.equal(cloud.can_start, false);
  // The path is named. "No key" with no location is a dead end for an operator
  // who believes they configured one.
  assert.match(cloud.can_start_reason, /cloud\.env/);
  rmSync(root, { recursive: true, force: true });
});

test("CLOUD: an exported key wins over the file, mirroring spend_key", async () => {
  // The spawned harness inherits the control plane's environment, so reporting
  // the file's key while the harness would use the environment's would be a
  // report about a run that is not the one about to happen.
  const root = mkdtempSync(join(tmpdir(), "okp-cloud-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "cloud.env"), "ORCAROUTER_API_KEY=from-file\n");

  const cloud = await readCloud({ benchRoot: root, env: { ORCAROUTER_API_KEY: "from-env" } });
  assert.equal(cloud.key.source, "environment");
  rmSync(root, { recursive: true, force: true });
});

test("CAMPAIGN: a cloud slug yields a FLAT campaign directory name", () => {
  // A slash in a directory name is not a name, it is a path. Left in, a cloud
  // baseline's campaign would land at runs/cumulative-anthropic/claude-opus-5 —
  // nested under a parent holding no manifest, so every reader that scans runs/
  // walks straight past it and the measurements are invisible on the board the
  // cell was launched from.
  const name = campaignDirName("anthropic/claude-opus-5");
  assert.ok(!name.includes("/"), `campaign dir '${name}' contains a path separator`);
  // Dots too: isArchivedRun() treats ANY dot as the archive convention, so a
  // dotted name would make the baseline silently vanish from the floor index.
  assert.ok(!isArchivedRun(campaignDirName("qwen/qwen3.8-max")));
  // Local names are UNCHANGED by the slash rule — no existing campaign moves.
  assert.equal(campaignDirName("qwen3.6-35b-a3b-bench"), "cumulative-qwen3-6-35b-a3b-bench");
});

test("BASELINE: a cloud OFF cell is identified by vendor, not by the router", () => {
  // provider_pin is built by _provider_pin_from_model, which returns the FIRST
  // segment for anything that is not a local-llm-proxy slug — the router. Read
  // naively, every cloud baseline in the bench resolves to the single identity
  // "orcarouter", folding four vendors' floors into one row and attributing all
  // of them to a model that does not exist.
  const cloud = identifyCell(
    { model: "orcarouter/anthropic/claude-opus-5", provider_pin: "orcarouter" },
    {},
  );
  assert.equal(cloud.kind, "cloud");
  assert.equal(cloud.id, "anthropic/claude-opus-5");
  assert.equal(cloud.provider, "anthropic");

  const local = identifyCell(
    { model: "local-llm-proxy/m-a", provider_pin: "m-a" },
    {},
  );
  assert.equal(local.kind, "local");
  assert.equal(local.id, "m-a");
});

test("BASELINE: the list is rooted in cells, so a cloud floor appears without a roster", async () => {
  // `models` is keyed by the local proxy roster because that is what a GATE
  // needs. `list` is derived from the CELLS, which is the only reason a cloud
  // floor — whose model the local proxy has never heard of — is findable at all.
  const root = mkdtempSync(join(tmpdir(), "okp-bl-"));
  const dir = join(root, "cumulative-anthropic-claude-opus-5");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    created_at: "2026-08-15T00:00:00Z",
    schedule: [{ sequence_index: 0, memory_mode: "off", model: "orcarouter/anthropic/claude-opus-5", provider_pin: "orcarouter" }],
  }));
  writeFileSync(join(dir, "manifest.status.jsonl"), `${JSON.stringify({
    type: "attempt", sequence_index: 0, attempt: 1, verdict: "PASS",
    gate_totals: { pass: 69, fail: 2, error: 0, not_run: 0, total: 71 },
    progress: { turns: 31, total_tokens: 900, wall_seconds: 120 },
  })}\n`);

  // NOTE the empty roster: this is the cold case where the local proxy is down.
  const idx = await readBaselines({ runsRoot: root, models: [] });
  assert.equal(idx.list.length, 1);
  const row = idx.list[0];
  assert.equal(row.model, "anthropic/claude-opus-5");
  assert.equal(row.kind, "cloud");
  assert.equal(row.state, "complete");
  assert.equal(row.turns, 31);
  assert.equal(row.gates.total, 71);
  assert.match(row.id, /^base-[0-9a-f]{4}$/);
  assert.deepEqual(idx.counts, { complete: 1, running: 0, void: 0 });
  rmSync(root, { recursive: true, force: true });
});

test("BASELINES: a tree-layout campaign carries the FULL relative run_dir, not the leaf", async () => {
  // A row keyed by the LEAF (`qwen3-6-35b-a3b-bench`) names a directory that
  // does not exist under the runs root — the campaign lives at
  // <tree>/<substrate>/<router>/<provider>/<model> — so an operator following
  // it finds nothing, and the same model in two trees would collide on the id
  // derived from it. A flat campaign's leaf IS its full relative path, so
  // pre-tree history keeps the run_dir it has always had.
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    const t = await mintTree(runs, { now: 1787310000_000 });

    const rel = join(t.active, "local", "local-llm-proxy", "omlx", "qwen3-6-35b-a3b-bench");
    const dir = join(runs, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      created_at: "2026-08-20T00:00:00Z",
      schedule: [{ sequence_index: 0, memory_mode: "off", provider_pin: "m-a" }],
    }));
    writeFileSync(join(dir, "manifest.status.jsonl"), `${JSON.stringify(OFF_PASS)}\n`);

    // A legacy flat campaign beside the tree. A DIFFERENT model, because the
    // list is one row per model — two m-a floors would fold into a single row.
    writeRun(runs, "cumulative-legacy-model", { model: "m-b", status: OFF_PASS });

    const idx = await readBaselines({ runsRoot: runs, models: [] });
    assert.equal(idx.list.length, 2);

    const treeRow = idx.list.find((r) => r.model === "m-a");
    assert.equal(treeRow.state, "complete");
    assert.equal(treeRow.run_dir, rel, "the full runs-root-relative path — the one that is findable on disk");

    const flatRow = idx.list.find((r) => r.model === "m-b");
    assert.equal(flatRow.run_dir, "cumulative-legacy-model", "a flat campaign's leaf is its full path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BASELINE: an id is stable across derivations and distinct per cell", async () => {
  // An operator quotes this id in a report. It is derived from the run directory
  // and the schedule index rather than from a counter, so it survives a service
  // restart and cannot be reassigned to a different cell.
  assert.equal(baselineId("cumulative", 0), baselineId("cumulative", 0));
  assert.notEqual(baselineId("cumulative", 0), baselineId("cumulative", 1));
  assert.notEqual(baselineId("cumulative", 0), baselineId("cumulative-m-b", 0));
  assert.match(baselineId("cumulative", 0), /^base-[0-9a-f]{4}$/);
});

test("TOKEN: the substrate is part of the confirmation fingerprint", () => {
  // `kind` decides whether the cell runs on the resident local model or is
  // routed to a vendor that bills for it — the largest difference any single
  // parameter makes. Omitted from the token, a confirmation minted for a local
  // cell would be valid for a cloud one carrying the same model id: a run the
  // operator never saw a restatement for, and one that spends money.
  const base = { model: "m", arm: "off", org: null, context: null };
  assert.notEqual(
    confirmationToken({ ...base, kind: "local" }),
    confirmationToken({ ...base, kind: "cloud" }),
  );
});

test("TOKEN: the armed snapshot is part of the confirmation fingerprint", () => {
  // A confirmation binds to the snapshot armed when it was minted. Omitted
  // from the token, arming a different snapshot between preview and start
  // would still validate the old confirmation — the operator confirms one
  // snapshot and the run reads another. Arming ANY snapshot after an
  // unset-snapshot preview must likewise invalidate the pending confirmation.
  assert.notEqual(
    confirmationToken({ model: "m", arm: "off", snapshotId: "snap-a" }),
    confirmationToken({ model: "m", arm: "off", snapshotId: "snap-b" }),
  );
  assert.notEqual(
    confirmationToken({ model: "m", arm: "off", snapshotId: null }),
    confirmationToken({ model: "m", arm: "off", snapshotId: "snap-a" }),
  );
});

test("LEDGER: startable spans both substrates and gates each one separately", async () => {
  // The [+ PROFILE] modal's baseline branch renders this list. A picker that
  // offers a model the launch would refuse teaches the operator that the UI
  // lies, and the lesson generalises to every other control on the board.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "cloud.env"), "ORCAROUTER_API_KEY=k\n");
  writeRun(root, "cumulative", { status: OFF_PASS });

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
    runInFlight: false,
    cloud: await readCloud({ benchRoot: root, env: {} }),
  });

  const local = led.startable.find((s) => s.id === "m-a");
  // It already has a floor, so re-baselining is refused — and the refusal names
  // the declared act that IS the way to do it.
  assert.equal(local.can_baseline.allowed, false);
  assert.match(local.can_baseline.reason, /declared act/);

  const cloud = led.startable.find((s) => s.id === "anthropic/claude-opus-5");
  assert.equal(cloud.kind, "cloud");
  assert.equal(cloud.can_baseline.allowed, true);
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: with no key, every cloud model refuses and says which key is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [],
    runInFlight: false,
    cloud: await readCloud({ benchRoot: root, env: {} }),
  });
  const cloudRows = led.startable.filter((s) => s.kind === "cloud");
  assert.ok(cloudRows.length > 0);
  for (const row of cloudRows) {
    assert.equal(row.can_baseline.allowed, false);
    assert.match(row.can_baseline.reason, /ORCAROUTER_API_KEY/);
  }
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: a cell in flight blocks every launch on every row, both substrates", async () => {
  // The serial rule is a property of the BENCH, not of any row. It is the rule
  // most easily broken by a per-row UI, because each row looks independent.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "cloud.env"), "ORCAROUTER_API_KEY=k\n");
  writeRun(root, "cumulative", { status: OFF_PASS });

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
    runInFlight: true,
    blockedReason: "a cell is already in flight",
    cloud: await readCloud({ benchRoot: root, env: {} }),
  });

  for (const s of led.startable) assert.equal(s.can_baseline.allowed, false);
  for (const b of led.baseline_rows) {
    assert.equal(b.can_run.allowed, false);
    assert.match(b.can_run.reason, /already in flight/);
  }
  rmSync(root, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION: THE GATE WALL READ A RUN DIRECTORY THAT NO LONGER EXISTS.
//
// Campaigns became per-model (`campaignDirName` → `runs/cumulative-<model>`)
// while every run-scoped read still defaulted to the literal `"cumulative"`.
// Nothing failed loudly: `readWall` found no pinned roster there, enumerated the
// live suite instead, found no `manifest.status.jsonl`, and served a TRUE
// denominator with zero outcomes against it. The board printed `0/71 passing`
// over 71 empty squares while the run's own artifacts recorded 16 passing and
// 2 failing — the exact "measured and passed" vs "not measured" confusion the
// wall was rebuilt to make impossible.
//
// The old suite could not catch this: every fixture named its run directory
// `cumulative`, so the stale default was correct in the tests and wrong only on
// disk. These two assert the join the server actually depends on — the run
// directory is RESOLVED FROM THE LOG, and a per-model campaign folds normally.
// ─────────────────────────────────────────────────────────────────────────────

/** A campaign directory with a pinned roster and one attempt's outcomes. */
function writeCampaignCell(runs, dir, { gates, results }) {
  mkdirSync(join(runs, dir, "sessions"), { recursive: true });
  writeFileSync(
    join(runs, dir, "gate-roster.json"),
    JSON.stringify({ total: gates.length, enumeration: { complete: true }, gates }),
  );
  writeFileSync(
    join(runs, dir, "manifest.status.jsonl"),
    JSON.stringify({ type: "attempt", attempt: 1, gate_results: results }) + "\n",
  );
  writeFileSync(
    join(runs, "off-cell-live.log"),
    "PROGRESS step=worktree-git-init path=" + join(runs, dir, "sessions", "cell", "worktree") + "\n",
  );
}

test("RUN STATE: the resolved run directory is PUBLISHED, not dropped as null", async () => {
  const root = mkdtempSync(join(tmpdir(), "rundir-"));
  try {
    const runs = join(root, "runs");
    const dir = campaignDirName("minimax/minimax-m3");
    writeCampaignCell(runs, dir, {
      gates: [{ id: "CONF" }],
      results: [{ id: "CONF", status: "pass" }],
    });

    const state = await readRunState({ runsRoot: runs, launcher: null });
    assert.equal(
      state.run_dir,
      dir,
      "the log names its run directory and the contract declares the field — publishing null " +
        "forces every run-scoped reader back onto a default that a per-model campaign invalidates",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WALL: a per-model campaign's outcomes are served, never a zeroed suite", async () => {
  const root = mkdtempSync(join(tmpdir(), "wall-campaign-"));
  try {
    const runs = join(root, "runs");
    const dir = campaignDirName("minimax/minimax-m3");
    writeCampaignCell(runs, dir, {
      gates: [{ id: "CONF" }, { id: "A" }, { id: "B" }],
      results: [
        { id: "CONF", status: "pass" },
        { id: "A", status: "fail" },
        { id: "B", status: "not_run" },
      ],
    });

    // What the server now passes: the run directory resolved from the log.
    const runDir = (await readRunState({ runsRoot: runs, launcher: null })).run_dir;
    const wall = await readWall({ runsRoot: runs, runDir });

    assert.equal(wall.run_dir, dir);
    assert.equal(wall.suite_source, "run", "the run's own pinned roster is authoritative");
    assert.deepEqual(wall.totals, { passing: 1, failing: 1, untested: 1 });
    assert.deepEqual(wall.unwired, [], "outcomes exist, so nothing is unwired");

    // AND THE DEFAULT ALONE IS NOT THE ANSWER. Naming no run directory falls
    // back to `cumulative`, which this campaign never wrote — the read must
    // report that as unwired rather than as a suite nobody passed.
    const stale = await readWall({ runsRoot: runs, runDir: null });
    assert.equal(stale.run_dir, DEFAULT_RUN_DIR);
    assert.ok(
      stale.unwired.includes("gate-roster"),
      "an absent run directory is unwired-with-a-reason, never a wall of zeroes",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION: 53 UNMEASURED GATES, EXPLAINED BY A NODE WARNING.
//
// When a runner exits nonzero with no failing test, the suite did not finish and
// every gate it never reached is recorded `not_run`. That string is the ONLY
// account of why. On the 2026-08-17 minimax-m3 cell it was
// "(node:43741) PromiseRejectionHandledWarning: ... (rejection id: 19)" —
// stderr's first line, and pure boilerplate — recorded against 53 gates, twice.
// ─────────────────────────────────────────────────────────────────────────────

/** Verbatim stderr from that cell's aborted backend phase. */
const NODE_WARNING_STDERR = [
  "(node:43741) PromiseRejectionHandledWarning: Promise rejection was handled asynchronously (rejection id: 19)",
  "(Use `node --trace-warnings ...` to show where the warning was created)",
  "(node:43741) PromiseRejectionHandledWarning: Promise rejection was handled asynchronously (rejection id: 250)",
].join("\n");

test("DIAGNOSTIC: Node's own warnings are never mistaken for the failure", () => {
  assert.equal(
    firstMeaningfulLine(NODE_WARNING_STDERR),
    "",
    "a stderr made entirely of Node boilerplate yields NO explanation, rather than a confident wrong one",
  );
  assert.equal(
    firstMeaningfulLine(`${NODE_WARNING_STDERR}\nError: listen EADDRINUSE :::8002`),
    "Error: listen EADDRINUSE :::8002",
    "the real line is selected even when warnings precede it",
  );
});

test("DIAGNOSTIC: an aborted runner reports how it died and how far it got", () => {
  const observed = runnerFailureObserved(
    "backend",
    { status: 1, signal: null, stderr: NODE_WARNING_STDERR },
    { reported: 7, expected: 56 },
  );

  assert.match(observed, /runner exited 1/, "how the process ended");
  assert.match(observed, /reported 7 of 56 gate results/, "how far it got — the gap IS the finding");
  assert.match(observed, /no test failed/, "and that nothing was measured as failing");
  assert.ok(
    !observed.includes("PromiseRejectionHandledWarning"),
    "the warning that used to be the entire explanation does not appear",
  );
});

test("DIAGNOSTIC: a KILLED runner is not reported as one that merely exited", () => {
  const killed = runnerFailureObserved(
    "backend",
    { status: null, signal: "SIGKILL", stderr: "" },
    { reported: 0, expected: 56 },
  );
  assert.match(killed, /killed by SIGKILL/);

  const exited = runnerFailureObserved("backend", { status: 2, signal: null, stderr: "" }, {});
  assert.match(exited, /exited 2/);
  assert.ok(!exited.includes("killed"), "and the two are never conflated");
});

test("DIAGNOSTIC: a spawn failure names itself rather than the exit code", () => {
  const observed = runnerFailureObserved(
    "frontend",
    { error: new Error("spawn npx ENOENT"), stderr: "" },
    {},
  );
  assert.match(observed, /spawn failed: spawn npx ENOENT/);
});

// ─────────────────────────────────────────────────────────────────────────────
// GRADABILITY — an aborted runner does not publish a score.
//
// The minimax-m3 cell published `16/71 pass` with `backend:runner` sitting in
// `failed_gates`, so a harness abort reached the board as a gate the MODEL
// failed, inside a ratio that read like a result. That worktree scores 69/71.
// ─────────────────────────────────────────────────────────────────────────────

/** A status stream whose newest attempt carries an explicit gradability. */
function writeGradabilityRun(runs, dir, attempt) {
  mkdirSync(join(runs, dir), { recursive: true });
  writeFileSync(
    join(runs, dir, "gate-roster.json"),
    JSON.stringify({ total: 2, enumeration: { complete: true }, gates: [{ id: "A" }, { id: "B" }] }),
  );
  writeFileSync(
    join(runs, dir, "manifest.status.jsonl"),
    JSON.stringify({
      type: "attempt",
      attempt: 1,
      gate_results: [
        { id: "A", status: "pass" },
        { id: "B", status: "not_run" },
      ],
      ...attempt,
    }) + "\n",
  );
}

test("WALL: an ungradable attempt is published as ungradable, with its reason", async () => {
  const root = mkdtempSync(join(tmpdir(), "gradable-"));
  try {
    const runs = join(root, "runs");
    writeGradabilityRun(runs, "cumulative", {
      gradable: false,
      ungradable_reason: "backend gates-13-16.test.ts aborted without reporting a failing test",
      aborted_runners: ["backend gates-13-16.test.ts"],
    });

    const wall = await readWall({ runsRoot: runs, runDir: "cumulative" });
    assert.equal(wall.gradable, false);
    assert.match(wall.ungradable_reason, /aborted without reporting a failing test/);
    assert.deepEqual(wall.aborted_runners, ["backend gates-13-16.test.ts"]);

    // The squares are UNAFFECTED — gradability answers "was this measured",
    // never "did it pass", and must not repaint a single gate.
    assert.deepEqual(wall.totals, { passing: 1, failing: 0, untested: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WALL: gradability is null — never true — for an attempt recorded before the field", async () => {
  const root = mkdtempSync(join(tmpdir(), "gradable-legacy-"));
  try {
    const runs = join(root, "runs");
    writeGradabilityRun(runs, "cumulative", {});

    const wall = await readWall({ runsRoot: runs, runDir: "cumulative" });
    assert.equal(
      wall.gradable,
      null,
      "an attempt nothing checked is of UNKNOWN gradability; defaulting to true would vouch for it",
    );
    assert.equal(wall.ungradable_reason, null);
    assert.deepEqual(wall.aborted_runners, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WALL: a completed run is gradable and carries no reason", async () => {
  const root = mkdtempSync(join(tmpdir(), "gradable-ok-"));
  try {
    const runs = join(root, "runs");
    writeGradabilityRun(runs, "cumulative", { gradable: true, ungradable_reason: null, aborted_runners: [] });

    const wall = await readWall({ runsRoot: runs, runDir: "cumulative" });
    assert.equal(wall.gradable, true);
    assert.equal(wall.ungradable_reason, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── PER-FILE BACKEND INVOCATION ─────────────────────────────────────────────

test("REPORT: the backend phase spawns one runner PER FILE, under one phase marker", () => {
  const src = readFileSync(join(BENCH, "grader", "report.mjs"), "utf8");
  const body = src.slice(src.indexOf("function runBackendPhase()"), src.indexOf("function firstFrontendFailureMessage"));

  assert.match(body, /for \(const file of backendTestFiles\(\)\)/, "the suite is invoked file by file");
  assert.match(body, /spawnRunner\(`backend \$\{file\}`/, "each file gets its own process");
  assert.ok(
    !/spawnPhase\(/.test(body),
    "and NOT via spawnPhase — a second `[report] phase=backend` opener would tell the board a new phase began",
  );

  // Exactly one open and one close for the whole set: the python adapter turns
  // these two lines into the board's gate-phase-start / gate-phase-end events.
  assert.equal((body.match(/\[report\] phase=backend target=/g) ?? []).length, 1, "one phase opener");
  assert.equal((body.match(/\[report\] phase=backend status=/g) ?? []).length, 1, "one phase closer");
});

// ─────────────────────────────────────────────────────────────────────────────
// TRAJECTORY — how many attempts a gate needed, folded once, server-side.
//
// Shapes taken from the real 2026-08-17 minimax-m3 stream, whose 71 gates
// followed exactly five paths across three attempts:
//   5  pass → pass → pass          clean
//   8  fail → pass → pass          recovered on 2
//   3  fail → fail → pass          recovered on 3
//   2  fail → fail → fail          failing
//  53  pass → not_run → not_run    the harness abort
// ─────────────────────────────────────────────────────────────────────────────

const trajectoryAttempts = (paths) => {
  const ids = Object.keys(paths);
  const rounds = Math.max(...ids.map((id) => paths[id].length));
  return Array.from({ length: rounds }, (_, i) => ({
    type: "attempt",
    attempt: i + 1,
    gate_results: ids
      .filter((id) => paths[id][i] !== undefined)
      .map((id) => ({ id, status: paths[id][i] })),
  }));
};

test("TRAJECTORY: first_pass_attempt is the EARLIEST pass, and ever_failed excludes not_run", () => {
  const paths = {
    clean: ["pass", "pass", "pass"],
    late2: ["fail", "pass", "pass"],
    late3: ["fail", "fail", "pass"],
    broken: ["fail", "fail", "fail"],
    aborted: ["pass", "not_run", "not_run"],
    regressed: ["pass", "fail", "pass"],
  };
  const roster = { gates: Object.keys(paths).map((id) => ({ id })) };
  const { gates } = foldGateStates({ roster, attempts: trajectoryAttempts(paths) });
  const by = Object.fromEntries(gates.map((g) => [g.id, g]));

  assert.deepEqual(
    { s: by.clean.state, f: by.clean.first_pass_attempt, e: by.clean.ever_failed },
    { s: "passing", f: 1, e: false },
  );
  assert.deepEqual(
    { s: by.late2.state, f: by.late2.first_pass_attempt, e: by.late2.ever_failed },
    { s: "passing", f: 2, e: true },
  );
  assert.deepEqual(
    { s: by.late3.state, f: by.late3.first_pass_attempt, e: by.late3.ever_failed },
    { s: "passing", f: 3, e: true },
  );
  assert.deepEqual(
    { s: by.broken.state, f: by.broken.first_pass_attempt, e: by.broken.ever_failed },
    { s: "failing", f: null, e: true },
  );

  // A gate that passed then went UNMEASURED is untested and has NOT failed —
  // colouring an abort as damage is the absence-reads-as-a-verdict defect.
  assert.deepEqual(
    { s: by.aborted.state, f: by.aborted.first_pass_attempt, e: by.aborted.ever_failed },
    { s: "untested", f: 1, e: false },
  );

  // pass → fail → pass: it passed first on attempt 1 AND it broke on the way.
  // Both facts are published; the panel needs `ever_failed` to render it honestly.
  assert.deepEqual(
    { s: by.regressed.state, f: by.regressed.first_pass_attempt, e: by.regressed.ever_failed },
    { s: "passing", f: 1, e: true },
  );
});

test("TRAJECTORY: the verdict is unchanged by it — totals still come from the LAST attempt", () => {
  const paths = {
    a: ["fail", "pass", "pass"],
    b: ["pass", "pass", "fail"],
    c: ["fail", "fail", "fail"],
  };
  const roster = { gates: Object.keys(paths).map((id) => ({ id })) };
  const { totals } = foldGateStates({ roster, attempts: trajectoryAttempts(paths) });
  assert.deepEqual(
    totals,
    { passing: 1, failing: 2, untested: 0 },
    "a gate that passed earlier and fails now is FAILING — the wall reports the current state of the code",
  );
});

test("TRAJECTORY: a single-attempt run marks every pass as first-attempt green", () => {
  const roster = { gates: [{ id: "x" }, { id: "y" }] };
  const attempts = [{ type: "attempt", attempt: 1, gate_results: [{ id: "x", status: "pass" }, { id: "y", status: "fail" }] }];
  const { gates } = foldGateStates({ roster, attempts });
  const by = Object.fromEntries(gates.map((g) => [g.id, g]));
  assert.equal(by.x.first_pass_attempt, 1);
  assert.equal(by.x.ever_failed, false);
  assert.equal(by.y.first_pass_attempt, null);
});


// ═════════════════════════════════════════════════════════════════════════════
// BENCHMARK TREE
//
// The layout decides where hours of measurement land and which of them a board
// can still see. Every rule below is one an operator would otherwise discover by
// losing a run.
// ═════════════════════════════════════════════════════════════════════════════

function treeFixture() {
  const root = mkdtempSync(join(tmpdir(), "tree-"));
  return { root, runs: join(root, "runs") };
}

function campaignAt(runs, rel, { status = true } = {}) {
  const dir = join(runs, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ created_at: "2026-08-20T00:00:00Z" }));
  if (status) writeFileSync(join(dir, "manifest.status.jsonl"), "");
  return dir;
}

test("TREE: a segment can never carry a dot or a slash", () => {
  // A DOT WOULD MAKE THE CAMPAIGN INVISIBLE. isArchivedRun() reads any dot as
  // the archive convention, so `qwen3.6-…` would land in a directory every floor
  // reader skips — the baseline would simply vanish with no error anywhere.
  assert.equal(segment("qwen3.6-35b-a3b-bench"), "qwen3-6-35b-a3b-bench");
  assert.equal(isArchivedRun(segment("qwen3.6-35b")), false);
  // A SLASH WOULD BE ANOTHER LEVEL OF TREE, landing the campaign one directory
  // deeper than every reader looks for it.
  assert.equal(segment("anthropic/claude-opus-5"), "anthropic-claude-opus-5");
  // An empty segment silently collapses a level, so it is named instead.
  assert.equal(segment(""), "unknown");
  assert.equal(segment(null, "unknown-model"), "unknown-model");
});

test("TREE: the subject triple is total for every shape the harness produces", () => {
  // Cloud: `{provider}/{model}` under a router — what _compose_cloud_slug builds.
  assert.deepEqual(subjectTriple({ kind: "cloud", cloud: { provider: "deepseek", model: "deepseek-v4" } }), {
    substrate: "cloud",
    router: "orcarouter",
    provider: "deepseek",
    model: "deepseek-v4",
  });
  // Local bench aliases are BARE. The proxy is the normalizer and oMLX is its
  // backend, so those are stated rather than left blank.
  assert.deepEqual(subjectTriple({ kind: "local", model: "qwen3.6-35b-a3b-bench" }), {
    substrate: "local",
    router: "local-llm-proxy",
    provider: "omlx",
    model: "qwen3-6-35b-a3b-bench",
  });
  // An explicit local slug is honoured as written.
  assert.deepEqual(subjectTriple({ kind: "local", model: "local-llm-proxy/vontra/deepseek-v4-flash" }), {
    substrate: "local",
    router: "local-llm-proxy",
    provider: "vontra",
    model: "deepseek-v4-flash",
  });
  // TOTAL MEANS TOTAL: a subject that failed to resolve would land its campaign
  // where no reader looks and present as a run that produced nothing.
  const empty = subjectTriple({});
  assert.equal(empty.substrate, "local");
  assert.ok(empty.model, "an unnameable model still gets a named directory");
  assert.equal(campaignSegments({ kind: "cloud", cloud: { provider: "p", model: "m" } }).length, 4);
});

test("TREE: mode directories are the two arms, and an unknown arm is never folded into one", () => {
  assert.equal(modeDir("off"), "memoryOFF");
  assert.equal(modeDir("on"), "memoryON");
  // Filing an unresolved arm under a real one would corrupt the contrast this
  // bench exists to measure, so it gets its own container.
  assert.equal(modeDir("banana"), "memoryUNKNOWN");
  assert.equal(modeDir(null), "memoryUNKNOWN");
});

test("TREE: minting points the pointer forward and DELETES NOTHING", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    const first = await mintTree(runs, { now: 1787310000_000 });
    campaignAt(runs, join(first.active, "local", "local-llm-proxy", "omlx", "model-a"));
    assert.equal(await activeTreeId(runs), first.active);

    const second = await mintTree(runs, { now: 1787320000_000 });
    assert.equal(second.previous, first.active, "the retired tree is named back to the caller");
    assert.equal(await activeTreeId(runs), second.active);

    // THE WHOLE SAFETY PROPERTY. A reset that unlinked would be the same class
    // of irreversible act that cost this bench a night of records once.
    assert.ok(existsSync(join(runs, first.active)), "the retired tree is still on disk");
    assert.ok(
      existsSync(join(runs, first.active, "local", "local-llm-proxy", "omlx", "model-a", "manifest.json")),
      "the retired tree's measurements are untouched",
    );
    const pointer = await readTreePointer(runs);
    assert.deepEqual(pointer.history, [first.active], "the retired tree stays findable by id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TREE: two resets inside one second are refused rather than sharing a tree", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    await mintTree(runs, { now: 1787310000_000 });
    // Silently re-pointing at an existing tree would put the second operator's
    // cells on top of the first operator's measurements.
    await assert.rejects(() => mintTree(runs, { now: 1787310000_400 }), /already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TREE: an unreadable pointer raises rather than silently starting a new tree", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, TREE_POINTER), "{ this is not json");
    // Absent and unreadable are DIFFERENT answers. Collapsing them would route a
    // live campaign into a brand new tree and present as the whole run history
    // having vanished.
    await assert.rejects(() => readTreePointer(runs), /refusing to guess/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TREE: discovery finds nested campaigns AND legacy flat ones", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    const t = await mintTree(runs, { now: 1787310000_000 });
    campaignAt(runs, join(t.active, "local", "local-llm-proxy", "omlx", "model-a"));
    campaignAt(runs, join(t.active, "cloud", "orcarouter", "deepseek", "deepseek-v4"));
    // Pre-tree history must not disappear the moment this ships.
    campaignAt(runs, "cumulative-legacy-model");

    const found = await listCampaignDirs(runs);
    assert.equal(found.length, 3, "two nested and one flat");
    assert.ok(found.some((c) => c.name === "model-a"));
    assert.ok(found.some((c) => c.name === "cumulative-legacy-model"));

    // A campaign never contains another campaign — the walk must not descend
    // into worktrees and node_modules on a 2s board poll.
    mkdirSync(join(runs, t.active, "local", "local-llm-proxy", "omlx", "model-a", "memoryOFF", "cell-0000"), {
      recursive: true,
    });
    assert.equal((await listCampaignDirs(runs)).length, 3, "cells are not campaigns");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TREE: a retired tree stops being read, and that is the whole of the wipe", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    const first = await mintTree(runs, { now: 1787310000_000 });
    campaignAt(runs, join(first.active, "local", "local-llm-proxy", "omlx", "model-a"));
    campaignAt(runs, "cumulative-legacy-model");
    assert.equal((await listLiveCampaignDirs(runs)).length, 2);

    await mintTree(runs, { now: 1787320000_000 });
    const live = await listLiveCampaignDirs(runs);
    // The retired tree's campaign is gone from the board WITHOUT being deleted.
    assert.ok(!live.some((c) => c.name === "model-a"), "the retired tree is not read");
    // Legacy flat campaigns are not inside any tree and are never retired by a
    // reset — retiring them would be a deletion the operator never asked for.
    assert.ok(live.some((c) => c.name === "cumulative-legacy-model"), "legacy history survives a reset");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TREE: campaignTargetFor composes the tree path, and falls back when there is no tree", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });

    // No tree yet → the legacy resolver, byte-identical to before.
    const legacy = await campaignTargetFor({ model: "model-a", kind: "local" }, runs);
    assert.equal(legacy.tree, null);
    assert.ok(legacy.manifest_arg.endsWith(join("cumulative-model-a", "manifest.json")));

    const t = await ensureTree(runs, { now: 1787310000_000 });
    assert.equal(t.minted, true, "a fresh bench self-initialises rather than requiring a reset first");

    const local = await campaignTargetFor({ model: "qwen3.6-35b", kind: "local" }, runs);
    assert.equal(local.tree, t.active);
    assert.ok(
      local.manifest_arg.endsWith(join(t.active, "local", "local-llm-proxy", "omlx", "qwen3-6-35b", "manifest.json")),
      `unexpected local path: ${local.manifest_arg}`,
    );

    const cloud = await campaignTargetFor(
      { model: "deepseek-v4", kind: "cloud", cloud: { provider: "deepseek", model: "deepseek-v4" } },
      runs,
    );
    assert.ok(
      cloud.manifest_arg.endsWith(join(t.active, "cloud", "orcarouter", "deepseek", "deepseek-v4", "manifest.json")),
      `unexpected cloud path: ${cloud.manifest_arg}`,
    );

    // A bare string is still accepted — every pre-tree call site keeps working.
    const bare = await campaignTargetFor("model-a", runs);
    assert.equal(bare.tree, t.active);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TREE: a run dir is resolved as a PATH, so a retired tree cannot read as live", () => {
  // The campaign home is nested; a capture that stops at the first slash yields
  // the TREE ID, which exists on disk for every retired tree — so a dead log
  // would resolve as live and the wipe boundary would never trip.
  assert.equal(
    runDirOf("PROGRESS step=worktree-git-init path=/x/runs/1787310000/local/local-llm-proxy/omlx/m/memoryOFF/cell-0000/worktree\n"),
    "1787310000/local/local-llm-proxy/omlx/m",
  );
  // Legacy paths resolve EXACTLY as they always did.
  assert.equal(runDirOf("path=/x/runs/cumulative/sessions/cell/worktree\n"), "cumulative");
  assert.equal(runDirOf("path=/x/runs/cumulative.gone/s/w\n"), "cumulative.gone");
  assert.equal(runDirOf("no path here"), null);
  assert.equal(isTreeId("1787310000"), true);
  assert.equal(isTreeId("cumulative"), false);
  assert.equal(campaignTreeId(join("1787310000", "local", "r", "p", "m")), "1787310000");
  assert.equal(campaignTreeId(join("cumulative-model", "x")), null);
});


// ═════════════════════════════════════════════════════════════════════════════
// RESET ALL BENCHMARK DATA
// ═════════════════════════════════════════════════════════════════════════════

test("RESET: live process state and tooling output are NEVER swept", () => {
  // THE ONE THAT BREAKS THE BENCH. `mcp4550.pid` holds the PID of the running
  // bench MCP on :4550 and `mcp4550.log` is being appended to by it. Moving
  // either orphans a live process and the next `bench-mcp.sh stop` cannot find
  // what it is meant to stop.
  assert.equal(isBenchmarkData("mcp4550.pid"), false);
  assert.equal(isBenchmarkData("mcp4550.log"), false);

  // Tooling output is about the SOFTWARE, not about a measurement. An operator
  // clearing the benchmark is not asking to lose their build history.
  for (const n of [
    "pytest-20260811T051148.log",
    "pytest-last.log",
    "redeploy-20260815T044328.log",
    "dashboard-rebuild-20260820T222605.log",
    "worker-rebuild-20260816T144401.log",
    "hold-ui-verify-20260810T115428.log",
    "control-plane.log",
    "proxy-e2e",
  ]) {
    assert.equal(isBenchmarkData(n), false, `${n} must be left alone`);
  }

  // The backup folder is never swept into itself.
  assert.equal(isBenchmarkData(BACKUPS_DIR), false);

  // UNRECOGNISED STAYS PUT — the allow list fails safe by design.
  assert.equal(isBenchmarkData("something-nobody-anticipated"), false);
});

test("RESET: every surface the board reads IS swept", () => {
  // These are exactly the things that survived the first version of reset and
  // left an operator staring at their old baselines on a supposedly clean bench.
  for (const n of [
    "1787293682",          // a results tree
    "active-tree.json",    // which tree was live
    "baselines.json",      // the floor
    "cumulative-kimi-kimi-k2-5",
    "cumulative-minimax-minimax-m3",
    "off-cell-20260820T154843.log",
    "on-cell-20260820T154843.log",
    "master",
    "failed",
    "failed-starts",
    "backgammon",
  ]) {
    assert.equal(isBenchmarkData(n), true, `${n} must be swept`);
  }
});

test("RESET: everything moves to a backup and the bench comes back empty", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    const old = await mintTree(runs, { now: 1787310000_000 });
    campaignAt(runs, join(old.active, "local", "local-llm-proxy", "omlx", "model-a"));
    writeFileSync(join(runs, "baselines.json"), "{}");
    campaignAt(runs, "cumulative-legacy-model");
    writeFileSync(join(runs, "off-cell-20260820T154843.log"), "x");
    // Live + tooling, which must survive untouched.
    writeFileSync(join(runs, "mcp4550.pid"), "30673");
    writeFileSync(join(runs, "pytest-last.log"), "x");

    const plan = await planReset(runs);
    assert.ok(plan.keeps.includes("mcp4550.pid"));

    const done = await resetAll(runs, { now: 1787320000_000 });

    // NOTHING DELETED — every swept item is in the backup, under its own name.
    for (const n of ["baselines.json", "cumulative-legacy-model", "off-cell-20260820T154843.log", old.active]) {
      assert.ok(existsSync(join(runs, BACKUPS_DIR, done.backup_id, n)), `${n} must be in the backup`);
      assert.ok(!existsSync(join(runs, n)), `${n} must be gone from the runs root`);
    }
    assert.ok(
      existsSync(join(runs, BACKUPS_DIR, done.backup_id, old.active, "local", "local-llm-proxy", "omlx", "model-a", "manifest.json")),
      "the backed-up results are intact, not just the folder",
    );

    // THE LIVE BENCH IS UNTOUCHED.
    assert.ok(existsSync(join(runs, "mcp4550.pid")), "the running bench MCP's pid file must not move");
    assert.ok(existsSync(join(runs, "pytest-last.log")), "tooling logs must not move");

    // AND THE BOARD READS AS BRAND NEW.
    assert.equal(await activeTreeId(runs), done.active);
    assert.equal((await listLiveCampaignDirs(runs)).length, 0, "no results, no legacy rows, nothing");
    const pointer = await readTreePointer(runs);
    assert.deepEqual(pointer.history, [], "a reset bench carries no history forward");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RESET: two resets inside one second are refused rather than merging backups", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "baselines.json"), "{}");
    await resetAll(runs, { now: 1787310000_000 });
    // Merging two resets into one backup folder would make the older one
    // unrecoverable as a distinct state.
    await assert.rejects(() => resetAll(runs, { now: 1787310000_400 }), /already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


// ═════════════════════════════════════════════════════════════════════════════
// RESTORE FROM HISTORY
// ═════════════════════════════════════════════════════════════════════════════

/** A bench with results, a floor and a run log — then reset. */
async function benchWithHistory(runs, { now = 1787310000_000 } = {}) {
  const tree = await mintTree(runs, { now });
  const dir = join(runs, tree.active, "local", "local-llm-proxy", "omlx", "model-a");
  mkdirSync(join(dir, "memoryOFF", "cell-0000"), { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      created_at: "2026-08-20T15:48:58Z",
      org_id: "okp-org-0",
      task: "backgammon-cumulative-primary",
      seed: 20260709,
      schedule: [
        { memory_mode: "off", model: "orcarouter/kimi/kimi-k2.5", sequence_index: 0 },
        { memory_mode: "on", model: "orcarouter/kimi/kimi-k2.5", sequence_index: 1 },
      ],
    }),
  );
  writeFileSync(join(dir, "manifest.status.jsonl"), '{"type":"attempt"}\n{"type":"attempt"}\n');
  writeFileSync(join(runs, "baselines.json"), "{}");
  writeFileSync(join(runs, "off-cell-20260820T154843.log"), "x");
  return tree;
}

test("RESTORE: a backup id is confined to a child of the backups folder", () => {
  // The id arrives in a request body and reaches an fs path.
  assert.equal(resolveBackupDir("/runs", "../../etc"), null);
  assert.equal(resolveBackupDir("/runs", "/etc/passwd"), null);
  assert.equal(resolveBackupDir("/runs", "1787310000/../.."), null);
  assert.equal(resolveBackupDir("/runs", "not-a-timestamp"), null);
  assert.ok(resolveBackupDir("/runs", "1787310000")?.endsWith(join("backups", "1787310000")));
});

test("RESTORE: the list describes a backup by its CONTENT, not just its timestamp", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    await benchWithHistory(runs);
    await resetAll(runs, { now: 1787320000_000 });

    const list = await listBackups(runs);
    assert.equal(list.length, 1);
    const b = list[0];

    // The line an operator actually recognises their own work by.
    assert.deepEqual([...new Set(b.results.flatMap((r) => r.models))], ["orcarouter/kimi/kimi-k2.5"]);
    assert.equal(b.counts.results, 1);
    assert.equal(b.counts.run_logs, 1);
    assert.equal(b.results[0].cells_off, 1);
    assert.equal(b.results[0].cells_on, 1);
    assert.equal(b.results[0].org_id, "okp-org-0");
    assert.ok(b.bytes > 0);
    assert.equal(b.check.ok, true);
    // The id IS the moment, so the two can never disagree.
    assert.equal(b.created_at, new Date(1787320000_000).toISOString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CHECK: a pointer naming a tree that is not in the backup is a HARD refusal", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    const dir = join(runs, BACKUPS_DIR, "1787320000");
    mkdirSync(dir, { recursive: true });
    // The dangerous shape: it restores QUIETLY WRONG — a bench that renders as
    // empty while holding results, with no error anywhere.
    writeFileSync(join(dir, "active-tree.json"), JSON.stringify({ active: "1787310000" }));
    const check = await checkBackup(dir);
    assert.equal(check.ok, false);
    assert.match(check.errors.join(" "), /points at tree 1787310000, which is not in this backup/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CHECK: foreign content and an empty folder are refused; a soft problem only warns", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });

    const empty = join(runs, BACKUPS_DIR, "1787320001");
    mkdirSync(empty, { recursive: true });
    assert.equal((await checkBackup(empty)).ok, false, "an empty backup restores nothing");

    // Everything here is about to be moved into the runs root, so anything the
    // bench would not recognise there does not belong here either.
    const foreign = join(runs, BACKUPS_DIR, "1787320002");
    mkdirSync(join(foreign, "some-random-folder"), { recursive: true });
    const f = await checkBackup(foreign);
    assert.equal(f.ok, false);
    assert.match(f.errors.join(" "), /does not recognise/);

    // SOFT: an unreadable result folder is named but does not block — the
    // operator can still recover everything else in the backup.
    const soft = join(runs, BACKUPS_DIR, "1787320003");
    mkdirSync(join(soft, "cumulative-broken"), { recursive: true });
    writeFileSync(join(soft, "cumulative-broken", "manifest.json"), "{ not json");
    const sc = await checkBackup(soft);
    assert.equal(sc.ok, true, "a broken result folder must not block the whole restore");
    assert.match(sc.warnings.join(" "), /will not appear on the board/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RESTORE: the live bench is parked first, so nothing is ever overwritten", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    const original = await benchWithHistory(runs);
    const wiped = await resetAll(runs, { now: 1787320000_000 });

    // Work done AFTER the reset — the thing a naive overwrite would destroy.
    writeFileSync(join(runs, "baselines.json"), '{"since":"the reset"}');
    writeFileSync(join(runs, "off-cell-20260821T090000.log"), "newer work");

    const done = await restoreBackup(runs, wiped.backup_id, { now: 1787330000_000 });

    // The old bench is back, in place.
    assert.ok(existsSync(join(runs, original.active, "local", "local-llm-proxy", "omlx", "model-a", "manifest.json")));
    assert.equal(await activeTreeId(runs), original.active, "the restored pointer is the one in charge");
    assert.equal((await listLiveCampaignDirs(runs)).length, 1);

    // And the work done since the reset was SAVED, not lost.
    assert.equal(done.parked_as, "1787330000");
    assert.ok(existsSync(join(runs, BACKUPS_DIR, "1787330000", "off-cell-20260821T090000.log")));
    assert.equal(
      JSON.parse(readFileSync(join(runs, BACKUPS_DIR, "1787330000", "baselines.json"), "utf8")).since,
      "the reset",
    );

    // The restored backup is consumed — its contents are the bench now, so
    // leaving an empty folder would read as data loss.
    assert.equal(done.consumed, true);
    assert.ok(!existsSync(join(runs, BACKUPS_DIR, wiped.backup_id)));

    // RESTORE IS REVERSIBLE: what we just left is the newest entry in the list.
    const list = await listBackups(runs);
    assert.deepEqual(list.map((b) => b.id), ["1787330000"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RESTORE: a backup that fails the check is refused before anything moves", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "baselines.json"), '{"live":true}');
    const bad = join(runs, BACKUPS_DIR, "1787320000");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "active-tree.json"), JSON.stringify({ active: "1787310000" }));

    await assert.rejects(() => restoreBackup(runs, "1787320000"), /did not pass the check/);
    // THE BENCH IS UNTOUCHED. A refusal that had already parked the live data
    // would leave an operator worse off than before they clicked.
    assert.ok(existsSync(join(runs, "baselines.json")));
    assert.equal((await listBackups(runs)).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── LIVENESS IS A KERNEL FACT, NOT A LOG MTIME (2026-08-26) ─────────────────
//
// `launcher` is null on the documented CLI launch path, and `alive` used to be
// hardcoded false there — so run state reduced to log recency alone and was
// wrong in both directions. These two tests pin both directions.

// ── LIVENESS — THE HARNESS SAYS SO, NOTHING INFERS IT ────────────────────────
//
// THE DEFECT THIS CLOSES: liveness was inferred from the harness LOG'S MTIME,
// but the harness writes PROGRESS at PHASE boundaries and one build phase ran
// 86 model turns between two of them — so the header read
// `CELL STALLED — SILENT 21:49` over a cell that was mid-turn. A first repair
// took the minimum of the log age and the serve event feed; that narrowed the
// window and did not close it, because a disconnected or merely quiet feed
// falls back to the log-mtime signal already known to be wrong.
//
// Liveness now comes from ONE place: the `heartbeat` record the harness writes
// into its cell's live.jsonl every 15s. These four pin the whole contract.

/** A run tree whose live stream holds exactly the records given. */
function writeLiveStream(runs, campaignDir, records) {
  const cellDir = join(runs, campaignDir, "memoryOFF", "cell-0000");
  mkdirSync(cellDir, { recursive: true });
  writeFileSync(
    join(cellDir, "live.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""),
  );
  return join(cellDir, "live.jsonl");
}

test("LIVENESS: a fresh heartbeat means running, however old the log is", async () => {
  const root = mkdtempSync(join(tmpdir(), "liveness-beat-"));
  try {
    const runs = join(root, "runs");
    const dir = campaignDirName("qwen/qwen3.6-flash");
    writeCampaignCell(runs, dir, { gates: [{ id: "CONF" }], results: [] });
    const first = await readRunState({ runsRoot: runs, launcher: null, aliveProbe: async () => true });
    // The log has said nothing for 25 minutes — a normal mid-drive phase.
    const old = Date.now() / 1000 - (STALL_THRESHOLD_S + 600);
    utimesSync(first.log_path, old, old);

    const state = await readRunState({
      runsRoot: runs,
      launcher: null,
      aliveProbe: async () => true,
      heartbeatProbe: async () => 3000,
    });

    assert.equal(state.state, "running", "a beating cell is not wedged, whatever the log says");
    assert.equal(state.liveness, "live");
    assert.equal(state.heartbeat_age_s, 3);
    assert.ok(state.log_silent_s >= STALL_THRESHOLD_S, "the log really is that stale");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LIVENESS: a stopped heartbeat IS a stall, however fresh the log is", async () => {
  // The corner that must survive every future change to this file. 15s beats
  // against a 900s threshold is 60 missed beats — nothing but a wedge reaches it.
  const root = mkdtempSync(join(tmpdir(), "liveness-stall-"));
  try {
    const runs = join(root, "runs");
    const dir = campaignDirName("qwen/qwen3.6-flash");
    writeCampaignCell(runs, dir, { gates: [{ id: "CONF" }], results: [] });

    const state = await readRunState({
      runsRoot: runs,
      launcher: null,
      aliveProbe: async () => true,
      heartbeatProbe: async () => (STALL_THRESHOLD_S + 60) * 1000,
    });

    assert.equal(state.state, "stalled", "the log being fresh must not rescue a dead heartbeat");
    assert.equal(state.liveness, "stalled");
    assert.equal(state.can_start, false, "a stalled-but-alive cell still holds the tree");
    assert.match(String(state.blocked_reason), /strictly serial/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LIVENESS: NO heartbeat is unknown — never stalled", async () => {
  // A cell from a harness that predates the record, or one whose stream could
  // not be written, has not reported anything. Calling that a wedge is exactly
  // the defect this replaced, and inventing a zero would be the mirror of it.
  const root = mkdtempSync(join(tmpdir(), "liveness-unknown-"));
  try {
    const runs = join(root, "runs");
    const dir = campaignDirName("qwen/qwen3.6-flash");
    writeCampaignCell(runs, dir, { gates: [{ id: "CONF" }], results: [] });
    const first = await readRunState({ runsRoot: runs, launcher: null, aliveProbe: async () => true });
    const old = Date.now() / 1000 - (STALL_THRESHOLD_S + 600);
    utimesSync(first.log_path, old, old);

    const state = await readRunState({
      runsRoot: runs,
      launcher: null,
      aliveProbe: async () => true,
      heartbeatProbe: async () => null,
    });

    assert.equal(state.liveness, "unknown");
    assert.equal(state.heartbeat_age_s, null, "no reading is null, never 0");
    assert.notEqual(state.state, "stalled", "silence from a cell that never spoke is not a wedge");
    assert.equal(state.state, "running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LIVENESS: heartbeatAge reads the real stream through the designated resolver", async () => {
  // End-to-end over an actual live.jsonl, including the two things a hand-built
  // reader gets wrong: the path is under memory<ARM>/cell-<seq>/ and NOT at the
  // campaign root, and the stream is full of non-heartbeat records.
  const { heartbeatAge } = await import("./runstate.mjs");
  const root = mkdtempSync(join(tmpdir(), "liveness-real-"));
  try {
    const runs = join(root, "runs");
    const dir = campaignDirName("qwen/qwen3.6-flash");
    const now = Date.now();
    writeLiveStream(runs, dir, [
      { v: 1, ts: now - 60000, kind: "run.start", task: "backgammon" },
      { v: 1, ts: now - 59000, kind: "cell.start", session_id: "ses_x" },
      { v: 1, ts: now - 40000, kind: "heartbeat", phase: "initial-chunk-1", since_ms: 19000 },
      { v: 1, ts: now - 30000, kind: "gate.result", id: "CONF", status: "fail" },
      { v: 1, ts: now - 5000, kind: "heartbeat", phase: "initial-chunk-2", since_ms: 54000 },
      { v: 1, ts: now - 1000, kind: "ext", ns: "okp.plugin", type: "capture" },
    ]);

    const age = await heartbeatAge({ runsRoot: runs, runDir: dir, now });
    assert.equal(age, 5000, "the NEWEST heartbeat, ignoring later records of other kinds");

    // A stream with no heartbeat at all, and a run directory with no stream.
    writeLiveStream(runs, dir, [{ v: 1, ts: now, kind: "cell.start", session_id: "ses_x" }]);
    assert.equal(await heartbeatAge({ runsRoot: runs, runDir: dir, now }), null);
    assert.equal(await heartbeatAge({ runsRoot: runs, runDir: "nope", now }), null);
    assert.equal(await heartbeatAge({ runsRoot: runs, runDir: null, now }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DRIFT: the harness's heartbeat is the one this control plane reads", async () => {
  // A CROSS-LANGUAGE DRIFT TEST, and the most valuable one here. The producer
  // is Python (harness/live_stream.py) and the consumer is this JS; nothing but
  // this test makes them agree on the record shape OR on where the file lives.
  //
  // Both halves have already been wrong about the location once: the spec said
  // `runs/<run>/live.jsonl`, both dashboard readers built the campaign-level
  // path from it, and every run reported "no live.jsonl yet" for its entire
  // life — a reason indistinguishable from a run that never wrote one. The
  // real path is <campaign>/memory<ARM>/cell-<seq>/live.jsonl, which is why
  // this writes a full campaign-shaped tree rather than a flat file.
  //
  // Skipped where python3 is unavailable rather than failing — the seam works
  // as designed in a JS-only checkout.
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "xlang-heartbeat-"));
  try {
    const runs = join(root, "runs");
    const runDir = join("tree0", "local", "p", "omlx", "model");
    const cell = join(runs, runDir, "memoryOFF", "cell-0000");
    mkdirSync(cell, { recursive: true });

    const script = [
      "import sys, time",
      `sys.path.insert(0, ${JSON.stringify(BENCH)})`,
      "from harness.live_stream import LiveStream, Heartbeat",
      `st = LiveStream.for_run(${JSON.stringify(cell)}, run_id="r1")`,
      'st.emit("cell.start", session_id="ses_x")',
      "hb = Heartbeat(st, cell_seq=0, interval_s=0.02)",
      'hb.set_phase("initial-chunk-5", attempt=1)',
      "hb.start(); time.sleep(0.12); hb.stop()",
    ].join("\n");
    try {
      execFileSync("python3", ["-c", script], { stdio: "pipe" });
    } catch {
      return; // no python3 here, or the harness package is not importable
    }

    const { heartbeatAge } = await import("./runstate.mjs");
    const age = await heartbeatAge({ runsRoot: runs, runDir });
    assert.notEqual(age, null, "the consumer must find the record the producer just wrote");
    assert.ok(age >= 0 && age < 60_000, `implausible age ${age}`);

    // The fields the verdict and the UI depend on, asserted on the real output.
    const beats = readFileSync(join(cell, "live.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.kind === "heartbeat");
    assert.ok(beats.length >= 2, "a heartbeat beats on a clock");
    assert.equal(beats.at(-1).phase, "initial-chunk-5", "the beat names the phase");
    assert.equal(beats.at(-1).attempt, 1);
    assert.equal(beats.at(-1).v, 1, "envelope version");
    assert.equal(typeof beats.at(-1).ts, "number");
    assert.equal(typeof beats.at(-1).since_ms, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RUN STATE: a killed CLI-launched run does not block reset behind a fresh log", async () => {
  const root = mkdtempSync(join(tmpdir(), "runstate-dead-"));
  try {
    const runs = join(root, "runs");
    const dir = campaignDirName("qwen/qwen3.6-flash");
    writeCampaignCell(runs, dir, { gates: [{ id: "CONF" }], results: [] });

    // Log written moments ago, process gone: the state immediately after a
    // harness is killed mid-cell. Log recency alone called this "running" and
    // refused reset for the full 15-minute stall threshold.
    const state = await readRunState({
      runsRoot: runs,
      launcher: null,
      aliveProbe: async () => false,
    });

    assert.equal(state.state, "failed", "no terminal record and no process is an abandoned run");
    assert.equal(
      state.can_start,
      true,
      "reset/restore must not be refused over a process that is already gone",
    );
    assert.equal(state.blocked_reason, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RUN STATE: a LIVE run that has gone quiet still blocks reset", async () => {
  // ── INTENT PRESERVED, MECHANISM REPLACED ──────────────────────────────────
  //
  // The property this has always protected is the dangerous direction: never
  // OFFER a reset over a cell that is still running. That is unchanged and is
  // what the `can_start` assertions below hold.
  //
  // What changed is what "gone quiet" MEANS. This test used to age the LOG and
  // expect `stalled`, which encoded log-mtime as a liveness signal — and that
  // is precisely the inference that put `CELL STALLED — SILENT 21:49` in the
  // header of a working cell, because the harness logs at phase boundaries and
  // one phase ran 86 model turns. Quiet is now a stopped HEARTBEAT, and a
  // quiet log with a beating heart is just a long phase.
  const root = mkdtempSync(join(tmpdir(), "runstate-quiet-"));
  try {
    const runs = join(root, "runs");
    const dir = campaignDirName("qwen/qwen3.6-flash");
    writeCampaignCell(runs, dir, { gates: [{ id: "CONF" }], results: [] });

    const first = await readRunState({ runsRoot: runs, launcher: null, aliveProbe: async () => true });
    // Age the log well past the stall threshold, process still alive.
    const old = Date.now() / 1000 - (STALL_THRESHOLD_S + 120);
    utimesSync(first.log_path, old, old);

    // THE HEARTBEAT STOPPED — genuinely wedged.
    const wedged = await readRunState({
      runsRoot: runs,
      launcher: null,
      aliveProbe: async () => true,
      heartbeatProbe: async () => (STALL_THRESHOLD_S + 120) * 1000,
    });
    // Log recency alone once called this "failed" and OFFERED a reset while the
    // cell was still running — precisely the loss treeResetGate exists to
    // prevent. Quiet is not dead.
    assert.equal(wedged.state, "stalled");
    assert.equal(wedged.can_start, false, "a stalled-but-alive cell still holds the tree");
    assert.match(String(wedged.blocked_reason), /strictly serial/);

    // THE HEART IS BEATING — the same stale log, and the cell is fine. It still
    // blocks reset, because it is still running.
    const working = await readRunState({
      runsRoot: runs,
      launcher: null,
      aliveProbe: async () => true,
      heartbeatProbe: async () => 2000,
    });
    assert.equal(working.state, "running", "a stale log over a beating cell is a long phase");
    assert.equal(working.can_start, false, "still running, so reset stays refused");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── WO-CHUNKVIS-1: BUILD CHUNKS FOLD FIRST-NON-EMPTY ───────────────────────
//
// Build chunks exist ONLY on attempt 1 — attempts 2+ are single-prompt feedback
// drives that run no chunks and carry an empty list. Folding them by the
// `gate_totals` rule (last attempt wins) would blank the strip the instant
// attempt 2 landed, and the operator would watch the build record vanish from a
// cell that is merely still being graded.

const CHUNKS_ATTEMPT_1 = [
  { chunk: 1, state: "complete", marker: true },
  { chunk: 2, state: "complete", marker: true },
  { chunk: 3, state: "complete", marker: true },
  { chunk: 4, state: "died", marker: false, reason: "run_timeout" },
  { chunk: 5, state: "not_reached", marker: false },
  { chunk: 6, state: "not_reached", marker: false },
];

function writeTwoAttemptRun(root, { chunksOnFirst = true } = {}) {
  const d = join(root, "cumulative");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "manifest.json"), JSON.stringify({
    created_at: "2026-08-26T00:00:00Z",
    schedule: [{ sequence_index: 0, memory_mode: "off", provider_pin: "m-a" }],
  }));
  const a1 = { type: "attempt", sequence_index: 0, attempt: 1, verdict: "FAIL",
    progress: { turns: 9, total_tokens: 400,
      build_chunks: chunksOnFirst ? CHUNKS_ATTEMPT_1 : [] } };
  // Attempt 2: a feedback drive. No chunks ran, so the list is EMPTY.
  const a2 = { type: "attempt", sequence_index: 0, attempt: 2, verdict: "PASS",
    progress: { turns: 4, total_tokens: 120, build_chunks: [] } };
  writeFileSync(join(d, "manifest.status.jsonl"),
    `${JSON.stringify(a1)}\n${JSON.stringify(a2)}\n`);
  return d;
}

test("CHUNKS: attempt 2's empty list must not blank attempt 1's build record", async () => {
  const root = mkdtempSync(join(tmpdir(), "chunkvis-"));
  try {
    writeTwoAttemptRun(root);
    const cells = await collectCells(root);
    assert.equal(cells.length, 1);

    const chunks = cells[0].build_chunks;
    assert.ok(Array.isArray(chunks), "the build record must survive a later feedback attempt");
    assert.equal(chunks.length, 6);
    assert.deepEqual(chunks.map((c) => c.state), [
      "complete", "complete", "complete", "died", "not_reached", "not_reached",
    ]);
    assert.equal(chunks[3].reason, "run_timeout", "the culprit stays named");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CHUNKS: a cell that never ran a build reports null, never 'all incomplete'", async () => {
  const root = mkdtempSync(join(tmpdir(), "chunkvis-none-"));
  try {
    writeTwoAttemptRun(root, { chunksOnFirst: false });
    const cells = await collectCells(root);
    assert.equal(
      cells[0].build_chunks,
      null,
      "absent data must render as 'no data' — reporting six incomplete chunks would cry wolf",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── VOID-INSTRUMENT: truncated_turns/length_truncations live on the record,
// not on `progress` ──────────────────────────────────────────────────────────
//
// THE MEASURED DEFECT (found via a real OFF baseline, run 1788537083,
// qwen3.6-35b-a3b-bench): the harness scorer voided the cell
// (`provider_truncation`, 35 truncated turns) while this file's own fold
// reported `scorable: true` with a real 44/53 gate tally — the two void
// definitions the header comment says must never disagree, disagreeing. Cause:
// the fold read `p.truncated_turns` / `p.length_truncations` where
// `p = r.progress`, but the harness writes both fields as SIBLINGS of
// `progress`, not inside it. `int(undefined) ?? 0` is always zero, so the
// `truncated_turns > 0` void condition could never fire — a `terminal_reason`
// other than `transport_incomplete`/`harness_error` (e.g.
// `attempt_ceiling_reached`, which alone is NOT void — a model failing every
// attempt is a real capability result) then folded the cell as scorable no
// matter how many turns had been truncated.
// `unrecoveredAnomalyTurns` defaults to `truncatedTurns` so every existing caller
// keeps meaning "a genuine instrument anomaly". Pass 0 to write the loop-guard
// case: turns were anomalous, but the harness recovered every one of them.
function writeTruncatedRun(root, {
  terminalReason = "attempt_ceiling_reached",
  truncatedTurns = 35,
  unrecoveredAnomalyTurns = undefined,
} = {}) {
  const d = join(root, "cumulative");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "manifest.json"), JSON.stringify({
    created_at: "2026-09-04T00:00:00Z",
    schedule: [{ sequence_index: 0, memory_mode: "off", provider_pin: "m-a" }],
  }));
  const a1 = {
    type: "attempt", sequence_index: 0, attempt: 5, verdict: "FAIL",
    terminal_reason: terminalReason,
    truncated_turns: truncatedTurns,
    unrecovered_anomaly_turns: unrecoveredAnomalyTurns ?? truncatedTurns,
    length_truncations: 0,
    progress: { turns: 479, total_tokens: 297344, build_chunks: [] },
  };
  writeFileSync(join(d, "manifest.status.jsonl"), `${JSON.stringify(a1)}\n`);
  return d;
}

test("VOID-INSTRUMENT: a cell with truncated turns must fold as void, matching the harness scorer", async () => {
  const root = mkdtempSync(join(tmpdir(), "void-truncated-"));
  try {
    writeTruncatedRun(root);
    const cells = await collectCells(root);
    assert.equal(cells.length, 1);
    assert.equal(
      cells[0].void_instrument,
      true,
      "35 truncated turns must void the cell here exactly as harness/cumulative/run_artifacts.py voids it — a disagreement lets a corrupted cell stand as a model's floor",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("VOID-INSTRUMENT: a LOOPING model is not void — the ledger must agree with the scorer", async () => {
  // Jerry's ruling, 2026-09-05: nudging on a loop is model behaviour, not a
  // void classifier. Measured on run 1788599410 — five graded attempts, 39/53
  // passing, discarded because all three anomalous turns were
  // `terminal: guard_abort` (clean `finish_reason: "tool-calls"`,
  // `truncations_seen: 0`, every one retried and recovered).
  //
  // `truncated_turns` counts every anomaly including those aborts;
  // `unrecovered_anomaly_turns` counts only the anomalies the harness did NOT
  // recover — a recovered `guard_abort` / `provider_unavailable` /
  // `stream_finalize_timeout` never voids — and is what all three
  // implementations of this rule now read. This asserts the ledger half.
  const root = mkdtempSync(join(tmpdir(), "void-loop-"));
  try {
    writeTruncatedRun(root, { truncatedTurns: 3, unrecoveredAnomalyTurns: 0 });
    const cells = await collectCells(root);
    assert.equal(
      cells[0].void_instrument,
      false,
      "a model the harness caught looping is a capability observation — voiding it deletes the finding",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("VOID-INSTRUMENT: a clean attempt_ceiling_reached cell (no truncation) is NOT void", async () => {
  const root = mkdtempSync(join(tmpdir(), "void-clean-"));
  try {
    writeTruncatedRun(root, { truncatedTurns: 0 });
    const cells = await collectCells(root);
    assert.equal(
      cells[0].void_instrument,
      false,
      "a model failing every attempt with no instrument fault is a real capability result, not void",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── WO-SNAP-03: A SEEDED CELL IS NEVER A FLOOR ─────────────────────────────
//
// `seeded_from_snapshot` is written TOP-LEVEL on the attempt record — a sibling
// of `progress`, the same field-path trap as the truncation counters above. The
// producer ships in WO-SNAP-04; until then only these tests synthesize it, and
// the fold must already refuse it: a seeded cell skips the build, so its
// turn/token totals sit on a different scale than the floor a Δ is measured
// against. The property is bidirectional — seeded never scores, unseeded still
// does.
function writeSeededRun(root, { dir = "cumulative", snapshotId = "snap-fixture-1" } = {}) {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "manifest.json"), JSON.stringify({
    created_at: "2026-09-04T00:00:00Z",
    schedule: [{ sequence_index: 0, memory_mode: "off", provider_pin: "m-a" }],
  }));
  const a1 = {
    type: "attempt", sequence_index: 0, attempt: 5, verdict: "PASS",
    progress: { turns: 12, total_tokens: 900, build_chunks: [] },
  };
  // TOP-LEVEL — sibling of `progress`, never inside it.
  if (snapshotId !== null) a1.seeded_from_snapshot = snapshotId;
  writeFileSync(join(d, "manifest.status.jsonl"), `${JSON.stringify(a1)}\n`);
  return d;
}

test("SEEDED: a cell carrying seeded_from_snapshot folds with the id and never scores", async () => {
  const root = mkdtempSync(join(tmpdir(), "seeded-off-"));
  try {
    writeSeededRun(root);
    const cells = await collectCells(root);
    assert.equal(cells.length, 1);
    assert.equal(
      cells[0].seeded_from_snapshot,
      "snap-fixture-1",
      "the fold must carry the id from the TOP-LEVEL record field — reading r.progress.seeded_from_snapshot would silently null it",
    );

    const b = baselineFor("m-a", await collectOffCells(root));
    assert.equal(b.scorable, false, "a seeded cell must never become a model's floor — even complete, PASS, non-void");
    assert.equal(b.seeded, true);
    assert.equal(b.voided, undefined, "no voided flag — baselineList must compute state 'none' and drop the row");
    assert.equal(b.pending, undefined, "no pending flag either");
    assert.equal(
      b.reason,
      "seeded from snapshot `snap-fixture-1` — a seeded cell skips the build and sits on a different turn/token scale than the floor a Δ is measured against.",
      "the refusal sentence is spec'd verbatim — backticks, em-dash and Δ included",
    );

    // THE SAFETY PROPERTY, END TO END: the ledger's baseline_rows — what
    // PROFILE·1 renders — must not carry a row for the seeded cell's model.
    const led = await readModelsLedger({
      runsRoot: root,
      benchModels: [{ id: "m-a", bench_eligible: true }],
      runInFlight: false,
    });
    assert.equal(led.models[0].baseline.scorable, false);
    assert.equal(led.baseline_rows.length, 0, "state 'none' drops the row — a seeded cell never appears in baseline_rows");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SEEDED: the same cell WITHOUT the field stays a scorable floor", async () => {
  const root = mkdtempSync(join(tmpdir(), "seeded-clean-"));
  try {
    writeSeededRun(root, { snapshotId: null });
    const cells = await collectCells(root);
    assert.equal(cells[0].seeded_from_snapshot, null, "an absent field folds to null, never undefined");

    const b = baselineFor("m-a", await collectOffCells(root));
    assert.equal(b.scorable, true, "a complete, non-void, unseeded OFF cell is a valid floor");
    assert.equal(b.exists, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SEEDED: a model with BOTH a seeded and an unseeded OFF cell keeps the unseeded floor", async () => {
  const root = mkdtempSync(join(tmpdir(), "seeded-mixed-"));
  try {
    writeSeededRun(root, { dir: "cumulative-seeded" });
    writeSeededRun(root, { dir: "cumulative-real", snapshotId: null });
    const offCells = await collectOffCells(root);
    assert.equal(offCells.length, 2);

    const b = baselineFor("m-a", offCells);
    assert.equal(b.scorable, true, "the unseeded cell remains the floor");
    assert.equal(b.run_dir, "cumulative-real", "the resolved floor is the unseeded cell, whichever order the walk found them");
    assert.equal(b.candidates, 1, "the seeded cell is not a candidate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── run state publishes the boolean its callers read ────────────────────────
//
// THE MEASURED DEFECT: `running` was computed inside readRunState and never
// returned. Four call sites in server.mjs read `state.running` and all four got
// `undefined` — STOP refused every live cell, and the guard that stops
// worker-image-rebuild from rebuilding the substrate under a running cell never
// fired once.
//
// Pinned on the CONTRACT (the field exists and agrees with `state`) rather than
// on any one caller, because the bug was that the field was absent for all of
// them.
test("RUNSTATE: `running` is published and agrees with `state`", async () => {
  const { readRunState } = await import("./runstate.mjs");
  const root = mkdtempSync(join(tmpdir(), "okp-runstate-"));
  try {
    const idle = await readRunState({ runsRoot: root, launcher: null });
    assert.equal(
      Object.hasOwn(idle, "running"),
      true,
      "readRunState must publish `running` — four callers in server.mjs read it",
    );
    assert.equal(typeof idle.running, "boolean", "`running` must be a boolean, never undefined");
    assert.equal(
      idle.running,
      !idle.can_start,
      "`running` and `can_start` are the same fact and must never disagree",
    );
    // A live cell is the case that mattered: an undefined here is what made
    // STOP refuse and the substrate guard fall open.
    assert.equal(idle.running, false, "an empty runs root has no cell in flight");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The stop path's container filters must track the names the harness actually
// creates. A stale prefix here is silent: stop reports success and leaves the
// sidecar running, and the next cell contends with it.
test("STOP sweeps the egress sidecar the harness actually names", async () => {
  const src = readFileSync(join(HERE, "server.mjs"), "utf8");
  const py = readFileSync(join(HERE, "..", "harness", "egress.py"), "utf8");
  const prefix = /f"([a-z0-9-]+-)\{hashlib/.exec(py);
  assert.ok(prefix, "egress.py must still build the sidecar name from a literal prefix");
  assert.ok(
    src.includes(`name=${prefix[1]}`),
    `server.mjs stop filter must use the harness's own prefix '${prefix[1]}'`,
  );
  assert.ok(!src.includes("name=wv-egress-"), "the pre-rename prefix must not linger in the stop path");
});

// ── THE DEV-SHIM SEAM ───────────────────────────────────────────────────────
//
// Tools that serve the iterate-on-the-bench loop live in dev/, not here, and
// attach through OKP_BENCH_TOOLS_MANIFEST. These pin both sides of that: a
// clone of bench/ ALONE must be clean, and an attached manifest must never be
// able to reach machinery it has no business in.

test("SEAM: a clone of bench/ alone contributes no external tools", async () => {
  // The whole reason the manifest exists. Declaring dev tools in the registry
  // would put contributor orchestration into the repo people clone to measure
  // their own memory system, and a tool permanently "blocked because ../dev is
  // missing" is worse than no tool — it advertises what the clone cannot do.
  const { describeTools } = await import("./tools.mjs");
  const saved = process.env.OKP_BENCH_TOOLS_MANIFEST;
  delete process.env.OKP_BENCH_TOOLS_MANIFEST;
  try {
    const tools = describeTools(BENCH);
    assert.ok(tools.length > 0, "the built-in tools must still be there");
    assert.equal(
      tools.filter((t) => t.external).length,
      0,
      "an unset manifest must contribute nothing at all",
    );
    assert.ok(
      !tools.some((t) => t.id === "external-tools"),
      "an unset manifest is not an error and must not render a blocked row",
    );
  } finally {
    if (saved === undefined) delete process.env.OKP_BENCH_TOOLS_MANIFEST;
    else process.env.OKP_BENCH_TOOLS_MANIFEST = saved;
  }
});

test("SEAM: a broken manifest is REPORTED, never silently skipped", async () => {
  // Returning [] would make a typo in the path indistinguishable from a
  // manifest that legitimately declares nothing — the operator would go looking
  // for their tool and find no trace of why it is absent.
  const { describeTools } = await import("./tools.mjs");
  const saved = process.env.OKP_BENCH_TOOLS_MANIFEST;
  const dir = mkdtempSync(join(tmpdir(), "okp-tools-"));
  try {
    process.env.OKP_BENCH_TOOLS_MANIFEST = join(dir, "absent.json");
    let row = describeTools(BENCH).find((t) => t.id === "external-tools");
    assert.ok(row, "a missing manifest must surface as a named blocked row");
    assert.equal(row.status, "blocked");
    assert.match(row.blocked_reason, /cannot read/);

    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json", "utf8");
    process.env.OKP_BENCH_TOOLS_MANIFEST = bad;
    row = describeTools(BENCH).find((t) => t.id === "external-tools");
    assert.equal(row.status, "blocked");

    const noTools = join(dir, "empty.json");
    writeFileSync(noTools, JSON.stringify({ schema_version: 1 }), "utf8");
    process.env.OKP_BENCH_TOOLS_MANIFEST = noTools;
    row = describeTools(BENCH).find((t) => t.id === "external-tools");
    assert.match(row.blocked_reason, /no "tools" array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.OKP_BENCH_TOOLS_MANIFEST;
    else process.env.OKP_BENCH_TOOLS_MANIFEST = saved;
  }
});

test("SEAM: a manifest cannot redefine a built-in, and cannot reach mcp-admin", async () => {
  // TWO LIMITS, BOTH DELIBERATE. `mcp-admin` runs as the BENCH IDENTITY against
  // the leader keystore; identity-bearing handlers stay in the bench repo where
  // they can be reviewed. And a manifest must not be able to make
  // `worker-image-rebuild` mean something else on one installation.
  const { describeTools, toolRegistry } = await import("./tools.mjs");
  const saved = process.env.OKP_BENCH_TOOLS_MANIFEST;
  const dir = mkdtempSync(join(tmpdir(), "okp-tools-"));
  try {
    const manifest = join(dir, "tools.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        tools: [
          { id: "worker-image-rebuild", name: "hijack", command: "/bin/echo" },
          { id: "sneaky", name: "sneaky", command: "/bin/echo", invoke: { kind: "mcp-admin" } },
        ],
      }),
      "utf8",
    );
    process.env.OKP_BENCH_TOOLS_MANIFEST = manifest;

    const registry = toolRegistry(BENCH);
    const builtin = registry.filter((t) => t.id === "worker-image-rebuild");
    assert.equal(builtin.length, 1, "the built-in must survive intact");
    assert.match(
      String(builtin[0].invoke.argv[0] ?? ""),
      /rebuild_worker_image\.py$/,
      "the built-in must not be replaced",
    );

    const collision = describeTools(BENCH).find(
      (t) => t.id === "worker-image-rebuild-external",
    );
    assert.equal(collision.status, "blocked");
    assert.match(collision.blocked_reason, /built-in/);

    const sneaky = registry.find((t) => t.id === "sneaky");
    assert.equal(
      sneaky.invoke.kind,
      "script",
      "an external tool is FORCED onto the generic script runner — it must never select mcp-admin",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.OKP_BENCH_TOOLS_MANIFEST;
    else process.env.OKP_BENCH_TOOLS_MANIFEST = saved;
  }
});

test("SEAM: the dev manifest that ships in this workspace is valid and wires up", async () => {
  // The manifest lives in dev/, so this is skipped in a bench-only checkout
  // rather than failing — which is the seam working as designed.
  const manifest = join(BENCH, "..", "dev", "bench-tools.json");
  if (!existsSync(manifest)) return;

  const { describeTools } = await import("./tools.mjs");
  const saved = process.env.OKP_BENCH_TOOLS_MANIFEST;
  process.env.OKP_BENCH_TOOLS_MANIFEST = manifest;
  try {
    // bench-mcp-restart lives here too: it drives ../dev/scripts/bench-mcp.sh,
    // so declaring it as a built-in put a permanently blocked row advertising
    // dev/ on the board of anyone who cloned bench alone.
    const mcp = describeTools(BENCH).find((t) => t.id === "bench-mcp-restart");
    assert.ok(mcp, "dev/bench-tools.json must contribute bench-mcp-restart");
    assert.equal(mcp.external, true, "the bench MCP supervisor is a dev shim, not a built-in");

    const ready = describeTools(BENCH).find((t) => t.id === "bench-ready");
    assert.ok(ready, "dev/bench-tools.json must contribute bench-ready");
    assert.equal(ready.external, true, "a contributed tool must be marked as one");
    assert.equal(
      ready.status,
      "wired",
      `bench-ready is blocked: ${ready.blocked_reason}`,
    );
    assert.equal(
      ready.refuse_while_running,
      true,
      "converging the substrate mid-cell would change what is being measured",
    );
    assert.ok(ready.seams.length >= 3, "an operator must be able to see what it will do");
  } finally {
    if (saved === undefined) delete process.env.OKP_BENCH_TOOLS_MANIFEST;
    else process.env.OKP_BENCH_TOOLS_MANIFEST = saved;
  }
});

// ── A TOOL REPORTS ITS OWN OUTCOME ──────────────────────────────────────────
//
// THE MEASURED DEFECT (2026-09-03). The drawer's success block hardcoded
// request-join's vocabulary, so every tool that succeeded rendered "SENT — the
// org's leader still has to accept it on their dashboard". A worker-image
// rebuild that ran a real ten-second docker build reported that it was waiting
// on a human to approve something, and the build log the control plane returns
// in full was thrown away. From the board there was no way to tell a working
// button from a dead one.
//
// Pinned on the SHAPE (the note is data on the tool, and output is rendered)
// rather than on any one string, because the bug was that one tool's words were
// structural.

test("TOOLS: the success caveat belongs to the tool, not to the drawer", async () => {
  const { describeTools } = await import("./tools.mjs");
  const saved = process.env.OKP_BENCH_TOOLS_MANIFEST;
  delete process.env.OKP_BENCH_TOOLS_MANIFEST;
  try {
    const tools = describeTools(BENCH);
    const join = tools.find((t) => t.id === "request-join");
    assert.match(
      String(join.success_note ?? ""),
      /accept/i,
      "request-join must carry its own 'submitted is not accepted' caveat",
    );
    for (const t of tools.filter((t) => t.id !== "request-join")) {
      assert.equal(
        t.success_note,
        null,
        `${t.id} must not inherit another tool's outcome line — its output is its report`,
      );
    }
  } finally {
    if (saved === undefined) delete process.env.OKP_BENCH_TOOLS_MANIFEST;
    else process.env.OKP_BENCH_TOOLS_MANIFEST = saved;
  }
});

test("TOOLS: the drawer renders the command's own output", () => {
  // The control plane returns stdout and stderr on success AND failure. A
  // drawer that drops them leaves an operator with a verdict and no evidence,
  // which is the state that made a successful rebuild look like nothing.
  const src = readFileSync(join(BENCH, "dashboard", "panels", "tools.js"), "utf8");
  assert.match(src, /r\.stdout/, "tools.js must render stdout");
  assert.match(src, /r\.stderr/, "tools.js must render stderr");
  assert.ok(
    !/leader still has to accept/.test(src),
    "one tool's outcome line must not be hardcoded in the drawer",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// STATS — the ledger footer's one numbers surface
//
// Two populations behind one route. The tests below pin the two properties the
// surface exists to hold: the zones stay separate, and a source that could not
// be reached never reads as a measured zero.
// ─────────────────────────────────────────────────────────────────────────────

/** Run `fn` with the stats manifest pointed at `path`, then put the env back. */
async function withStatsManifest(path, fn) {
  const saved = process.env.OKP_BENCH_STATS_MANIFEST;
  if (path === null) delete process.env.OKP_BENCH_STATS_MANIFEST;
  else process.env.OKP_BENCH_STATS_MANIFEST = path;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.OKP_BENCH_STATS_MANIFEST;
    else process.env.OKP_BENCH_STATS_MANIFEST = saved;
  }
}

test("STATS: a fresh clone gets both zones, empty, and is told the manifest is absent", async () => {
  // The empty CUSTOM zone must be distinguishable from an attached manifest
  // that contributed nothing — one is "you have no such services", the other is
  // "your services said nothing", and only the second is a defect to chase.
  const { collectStats } = await import("./runstats.mjs");
  const out = await withStatsManifest(null, () => collectStats());

  // THE NATIVE SLOTS ARE CLAIMED, AND SAY THEY HAVE NOTHING TO SAY. They were
  // `[]` while which numbers belong in the footer was an open question, and the
  // strip drew PLACEHOLDER for each. Now that they are chosen, an idle board
  // must render the readout with no reading — not a vacant slot, which would
  // claim the number had never been decided on.
  assert.deepEqual(
    out.bench.map((s) => s.id),
    ["scored", "voided", "unmeasured", "loop_errors", "stream_errors", "stalled_errors"],
  );
  // NO RUN IS `absent`, NEVER A ZERO AND NEVER A FAILURE. Nothing could not be
  // reached; there is no run for these to describe.
  for (const stat of out.bench) {
    assert.equal(stat.state, "absent", `${stat.id} must be absent with no run`);
    assert.equal(stat.value, null, `${stat.id} must carry no value with no run`);
  }

  assert.deepEqual(out.custom, [], "a clone contributes nothing without a manifest");
  assert.equal(out.custom_manifest_attached, false);
});

test("STATS: an unreachable source reads as unavailable, NEVER as zero", async () => {
  // THE PROPERTY THIS WHOLE SURFACE TURNS ON. The founding stat is a loop-guard
  // FIRE COUNT: a relay that is down rendering as 0 says "this run tripped the
  // guard zero times", which is a measurement nobody took. `value` must be null
  // so the strip can draw "—".
  const { collectStats } = await import("./runstats.mjs");
  const dir = mkdtempSync(join(tmpdir(), "okp-stats-"));
  const manifest = join(dir, "stats.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      // Port 1 is reserved and never listening; no service is harmed to fail.
      stats: [{ id: "dead", label: "LOOP ERRORS", url: "http://127.0.0.1:1/nope", pick: "fires" }],
    }),
  );
  try {
    const out = await withStatsManifest(manifest, () => collectStats());
    assert.equal(out.custom.length, 1);
    assert.equal(out.custom[0].state, "unavailable");
    assert.equal(out.custom[0].value, null, "a dead source must not report a number");
    assert.notEqual(out.custom[0].value, 0, "unavailable and zero are different facts");
    assert.equal(out.custom_manifest_attached, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("STATS: a live source is read through its dotted pick path", async () => {
  const { collectStats } = await import("./runstats.mjs");
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ fires: 0, byChannel: { reasoning: 7 } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), "okp-stats-"));
  const manifest = join(dir, "stats.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      stats: [
        { id: "fires", label: "LOOP ERRORS", url: `http://127.0.0.1:${port}/`, pick: "fires" },
        { id: "reason", label: "REASONING", url: `http://127.0.0.1:${port}/`, pick: "byChannel.reasoning" },
      ],
    }),
  );
  try {
    const out = await withStatsManifest(manifest, () => collectStats());
    // A REAL zero is a reading and must survive as one. This is the other half
    // of the rule above: the surface refuses to invent zeros, and equally
    // refuses to discard one it was actually given.
    assert.deepEqual(
      out.custom.map((s) => [s.label, s.state, s.value]),
      [
        ["LOOP ERRORS", "ok", 0],
        ["REASONING", "ok", 7],
      ],
    );
    // THE ZONES ARE NEVER CONCATENATED: a contributor's number is not a result.
    // Asserted as the actual invariant rather than as `bench` being empty —
    // `bench` now carries the three native readouts, and a test that only said
    // "empty" would have stopped checking the separation the moment it filled.
    const customIds = out.custom.map((s) => s.id);
    const benchIds = out.bench.map((s) => s.id);
    assert.deepEqual(benchIds, ["scored", "voided", "unmeasured", "loop_errors", "stream_errors", "stalled_errors"]);
    for (const id of customIds) {
      assert.ok(!benchIds.includes(id), `custom stat '${id}' leaked into the BENCHMARK zone`);
    }
    for (const id of benchIds) {
      assert.ok(!customIds.includes(id), `native stat '${id}' leaked into the CUSTOM zone`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

test("STATS: the native readouts come off the published scorecard, not a re-fold", async () => {
  // WHY THE ARTIFACT AND NOT A DERIVATION. The scored/void split is decided by
  // `build_scorecard` in Python. The control plane could fold the run manifest
  // and status stream itself — and would then be a SECOND implementation of the
  // VOID-INSTRUMENT rule, which is how the two paths come to disagree. So the
  // producer publishes and this reads. The fixture is a scorecard exactly as the
  // harness writes it.
  const { collectStats } = await import("./runstats.mjs");
  const dir = mkdtempSync(join(tmpdir(), "okp-scorecard-"));
  writeFileSync(
    join(dir, "manifest.scorecard.json"),
    JSON.stringify({
      schema_version: 1,
      scored_sessions: 2,
      void_instrument: [{ sequence_index: 0, memory_mode: "off", void_reason: "provider_truncation" }],
      error_totals: {
        guard_aborted_turns: 3,
        finalize_timeout_turns: 2,
        instrument_anomaly_turns: 2,
        stalled_turns: 1,
      },
    }),
  );
  try {
    const out = await withStatsManifest(null, () => collectStats({ runDir: dir }));
    const by = Object.fromEntries(out.bench.map((s) => [s.id, s]));
    assert.deepEqual([by.scored.state, by.scored.value], ["ok", 2]);
    assert.deepEqual([by.voided.state, by.voided.value], ["ok", 1]);
    assert.deepEqual([by.loop_errors.label, by.loop_errors.state, by.loop_errors.value], ["LOOP ERRORS", "ok", 3]);
    assert.deepEqual([by.stream_errors.label, by.stream_errors.state, by.stream_errors.value], ["STREAM ERRORS", "ok", 2]);
    assert.deepEqual([by.stalled_errors.label, by.stalled_errors.state, by.stalled_errors.value], ["STALLED ERRORS", "ok", 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("STATS: a run with no scorecard yet is unavailable, NEVER zero", async () => {
  // Before the first cell completes the harness has published no scorecard.
  // "No cell has finished" is not "no cell scored", and a fabricated 0 in the
  // first hour of a healthy campaign reads as a run producing nothing — the
  // exact class of lie this surface refuses everywhere else.
  const { collectStats } = await import("./runstats.mjs");
  const dir = mkdtempSync(join(tmpdir(), "okp-scorecard-none-"));
  try {
    const out = await withStatsManifest(null, () => collectStats({ runDir: dir }));
    const by = Object.fromEntries(out.bench.map((s) => [s.id, s]));
    for (const id of ["scored", "voided", "loop_errors", "stream_errors", "stalled_errors"]) {
      assert.equal(by[id].state, "unavailable", `${id} must not invent a reading`);
      assert.equal(by[id].value, null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("STATS: a corrupt scorecard is unavailable and does not take the board down", async () => {
  // A half-written or truncated artifact must read as unavailable, exactly like
  // an unreachable source. It is replaced atomically by the writer, so this
  // should not occur — which is the reason to assert it rather than assume it.
  const { collectStats } = await import("./runstats.mjs");
  const dir = mkdtempSync(join(tmpdir(), "okp-scorecard-bad-"));
  writeFileSync(join(dir, "manifest.scorecard.json"), '{"scored_sessions": 2, "void_ins');
  try {
    const out = await withStatsManifest(null, () => collectStats({ runDir: dir }));
    const by = Object.fromEntries(out.bench.map((s) => [s.id, s]));
    assert.equal(by.scored.state, "unavailable");
    assert.equal(by.voided.state, "unavailable");
    for (const id of ["loop_errors", "stream_errors", "stalled_errors"]) {
      assert.equal(by[id].state, "unavailable");
      assert.equal(by[id].value, null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("STATS: error totals are per-run and do not leak across runs", async () => {
  // The three error totals are read fresh from each run's own scorecard —
  // readScorecard is uncached and keyed on ctx.runDir. A new run's directory
  // must not inherit the previous run's numbers, and a run whose scorecard has
  // not published error totals yet must read unavailable, never the prior
  // run's value. (This is the reset-on-new-benchmark guarantee: it is natural —
  // no explicit clear is needed.)
  const { collectStats } = await import("./runstats.mjs");
  const dirA = mkdtempSync(join(tmpdir(), "okp-err-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "okp-err-b-"));
  writeFileSync(
    join(dirA, "manifest.scorecard.json"),
    JSON.stringify({
      schema_version: 1,
      scored_sessions: 1,
      void_instrument: [],
      // `instrument_anomaly_turns` is every anomalous turn EXCEPT the loop
      // guard's, and it CONTAINS the narrow finalize-timeout kind — so 3 here
      // means three stream failures, two of which were finalize timeouts.
      // STREAM ERRORS reads the containing field: reading the subset alone left
      // the slot at 0 through a run whose stream died mid-turn.
      error_totals: {
        guard_aborted_turns: 5,
        finalize_timeout_turns: 2,
        instrument_anomaly_turns: 3,
        stalled_turns: 1,
      },
    }),
  );
  // dirB is a fresh run with no scorecard yet.
  try {
    const a = await withStatsManifest(null, () => collectStats({ runDir: dirA }));
    const byA = Object.fromEntries(a.bench.map((s) => [s.id, s]));
    assert.deepEqual([byA.loop_errors.label, byA.loop_errors.state, byA.loop_errors.value], ["LOOP ERRORS", "ok", 5]);
    assert.deepEqual([byA.stream_errors.label, byA.stream_errors.state, byA.stream_errors.value], ["STREAM ERRORS", "ok", 3]);
    assert.deepEqual([byA.stalled_errors.label, byA.stalled_errors.state, byA.stalled_errors.value], ["STALLED ERRORS", "ok", 1]);

    const b = await withStatsManifest(null, () => collectStats({ runDir: dirB }));
    const byB = Object.fromEntries(b.bench.map((s) => [s.id, s]));
    for (const id of ["loop_errors", "stream_errors", "stalled_errors"]) {
      assert.equal(byB[id].state, "unavailable", `${id} must not leak across runs`);
      assert.equal(byB[id].value, null);
    }
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("STATS: a malformed manifest contributes nothing and does not throw", async () => {
  // A dev shim that cannot load must not be able to take the board down.
  const { collectStats } = await import("./runstats.mjs");
  const dir = mkdtempSync(join(tmpdir(), "okp-stats-"));
  const manifest = join(dir, "stats.json");
  writeFileSync(manifest, "{ not json at all");
  try {
    const out = await withStatsManifest(manifest, () => collectStats());
    assert.deepEqual(out.custom, []);
    assert.equal(out.custom_manifest_attached, true, "attached-but-broken is still attached");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── DELTA MODE — scoping a monotonic source to the run ───────────────────────
//
// The defect these pin: the relay's loop-guard counter is monotonic since the
// RELAY process started, and the footer drew that lifetime total as if it were
// the running cell's. 13 fires over 13 hours and 812 turns were read as 13
// loops in one 40-minute build chunk. The number was never wrong; it was
// answering a question nobody asked.

test("STATS/delta: a monotonic source is reported against the run's own zero", async () => {
  const { collectStats } = await import("./runstats.mjs");
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ fires: 14 }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), "okp-stats-"));
  const manifest = join(dir, "stats.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      stats: [{ id: "fires", label: "LOOP ERRORS", url: `http://127.0.0.1:${port}/`, pick: "fires", mode: "delta" }],
    }),
  );
  try {
    const out = await withStatsManifest(manifest, () =>
      collectStats({ baselines: { fires: 10 } }),
    );
    // 14 lifetime, 10 of them before this run started => 4 belong to this run.
    assert.deepEqual(out.custom.map((s) => [s.state, s.value]), [["ok", 4]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

test("STATS/delta: with NO baseline it reads unavailable, NEVER the lifetime total", async () => {
  // THE REGRESSION GUARD. Falling back to the source's own number is the exact
  // bug — it is the most plausible-looking wrong answer on the board, because
  // it is a real number from a healthy service. A run this control plane never
  // queued has no zero, and "no zero" is a fact the footer must state.
  const { collectStats } = await import("./runstats.mjs");
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ fires: 14 }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), "okp-stats-"));
  const manifest = join(dir, "stats.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      stats: [{ id: "fires", label: "LOOP ERRORS", url: `http://127.0.0.1:${port}/`, pick: "fires", mode: "delta" }],
    }),
  );
  try {
    const out = await withStatsManifest(manifest, () => collectStats());
    assert.deepEqual(out.custom.map((s) => [s.state, s.value]), [["unavailable", null]]);
    assert.notEqual(out.custom[0].value, 14, "the lifetime total must never leak through");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

test("STATS/delta: scopeToRun holds the whole contract", async () => {
  const { scopeToRun } = await import("./runstats.mjs");
  assert.deepEqual(scopeToRun(14, 10), { state: "ok", value: 4 });
  // A run that has fired nothing yet is a MEASURED zero and stays one.
  assert.deepEqual(scopeToRun(10, 10), { state: "ok", value: 0 });
  // No zero recorded for this run.
  assert.deepEqual(scopeToRun(14, undefined), { state: "unavailable", value: null });
  // The counter went BACKWARDS: the source restarted and began again, so the
  // snapshot describes a generation that no longer exists. Clamping to 0 here
  // would draw a freshly-restarted relay as a clean run.
  assert.deepEqual(scopeToRun(2, 10), { state: "unavailable", value: null });
});

test("STATS/delta: the baseline is taken per-run, sits beside the log, and round-trips", async () => {
  const { captureStatsBaseline, readStatsBaseline, baselinePathFor } = await import("./runstats.mjs");
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ fires: 10, turns: 684 }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), "okp-stats-"));
  const manifest = join(dir, "stats.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      stats: [
        { id: "fires", label: "LOOP ERRORS", url: `http://127.0.0.1:${port}/`, pick: "fires", mode: "delta" },
        // Not monotonic: no zero is taken for it and none is needed.
        { id: "turns", label: "TURNS", url: `http://127.0.0.1:${port}/`, pick: "turns" },
      ],
    }),
  );
  const logPath = join(dir, "off-cell-20260904T054056.log");
  try {
    const captured = await withStatsManifest(manifest, () => captureStatsBaseline({ logPath }));
    assert.deepEqual(captured, { fires: 10 }, "only monotonic sources get a zero");
    // BESIDE THE LOG, so retiring the tree retires the baseline with it. A
    // baseline that outlived its run would scope the NEXT run to the wrong zero.
    assert.equal(baselinePathFor(logPath), `${logPath}.stats-baseline.json`);
    assert.ok(existsSync(baselinePathFor(logPath)));
    assert.deepEqual(await readStatsBaseline({ logPath }), { fires: 10 });
    // A run with no baseline file gets `{}`, not a throw and not a guess.
    assert.deepEqual(await readStatsBaseline({ logPath: join(dir, "never-ran.log") }), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

test("STATS/delta: a source that is down at queue time does not block the launch", async () => {
  // captureStatsBaseline runs on the launch path, ahead of the spawn. A relay
  // that is down must cost the tile for that run, never the run.
  const { captureStatsBaseline } = await import("./runstats.mjs");
  const dir = mkdtempSync(join(tmpdir(), "okp-stats-"));
  const manifest = join(dir, "stats.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      // Port 1 is closed; the fetch fails rather than answering.
      stats: [{ id: "fires", label: "LOOP ERRORS", url: "http://127.0.0.1:1/", pick: "fires", mode: "delta" }],
    }),
  );
  const logPath = join(dir, "off-cell-20260904T054056.log");
  try {
    const captured = await withStatsManifest(manifest, () => captureStatsBaseline({ logPath }));
    assert.deepEqual(captured, {}, "an unreachable source contributes no zero and no exception");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SEAM: the dev stats manifest is valid and the relay loop counter stays retired", async () => {
  // The relay's loop-guard counter (id "relay-loop-fires", label "LOOP ERRORS")
  // read the relay's LIFETIME fire count — shared across ALL relay traffic, the
  // wrong number per benchmark — and is RETIRED. Per-benchmark LOOP/STREAM/
  // STALLED errors now come from the scorecard's error_totals (BENCHMARK zone).
  // This pins the retirement: the shared relay counter must not come back
  // through the CUSTOM seam. Skipped in a bench-only checkout (the seam is
  // dev-only). See dev/bench-stats.json.
  const manifest = join(BENCH, "..", "dev", "bench-stats.json");
  if (!existsSync(manifest)) return;
  const parsed = JSON.parse(readFileSync(manifest, "utf8"));
  assert.ok(Array.isArray(parsed.stats), "the manifest must carry a stats array");
  assert.ok(
    !parsed.stats.some((s) => s.id === "relay-loop-fires" || s.label === "LOOP ERRORS"),
    "the relay's shared loop-guard counter must stay retired from the CUSTOM zone",
  );
  for (const s of parsed.stats) {
    assert.ok(s.id && s.url && s.pick, "every entry needs id, url and pick");
    assert.deepEqual(
      Object.keys(s).filter((k) => !k.startsWith("//")).sort(),
      ["id", "label", "mode", "pick", "url"].filter((k) => k in s || k !== "mode").sort(),
      "a stat entry carries id, label, url, pick and optionally mode",
    );
    if ("mode" in s) assert.equal(s.mode, "delta", "delta is the only mode there is");
  }
});

// ── PREFLIGHT REFUSAL -> THE BUTTON THAT FIXES IT ────────────────────────────
//
// A refusal on the board used to end at "Fix what preflight named, then start
// again", and what preflight named was a shell command — so the board sent the
// operator to a terminal for something the board itself can do. Preflight now
// names the remedy by TOOL ID; this side turns that id into a button, because
// this side is the one that knows which tools exist here.

test("REMEDY: a failure's tool id resolves to the registry's own name and status", async () => {
  const { attachRemedies, describeTools } = await import("./tools.mjs");
  const registry = describeTools(BENCH);
  const rebuild = registry.find((t) => t.id === "worker-image-rebuild");
  assert.ok(rebuild, "worker-image-rebuild is a built-in and must be in the registry");

  const checks = [
    { name: "worker image", status: "fail", remedy_tool: "worker-image-rebuild" },
  ];
  attachRemedies(checks, registry);

  assert.equal(checks[0].remedy.id, "worker-image-rebuild");
  // THE REGISTRY'S NAME, not a copy. A second id->name table is exactly the
  // drift this seam exists to prevent.
  assert.equal(checks[0].remedy.name, rebuild.name);
  assert.equal(checks[0].remedy.status, rebuild.status);
  assert.equal(checks[0].remedy.refuse_while_running, true);
});

test("REMEDY: an id this installation does not have becomes null, never a button", async () => {
  // `bench-ready` and `bench-mcp-restart` are dev-contributed: a bare clone of
  // bench/ has neither. Rendering a button for a tool that is not registered
  // would refuse the moment it was pressed, which is worse than the words the
  // check already carries.
  const { attachRemedies } = await import("./tools.mjs");
  const checks = [{ name: "control plane", status: "fail", remedy_tool: "not-installed-here" }];
  attachRemedies(checks, []);
  assert.equal(checks[0].remedy, null);
});

test("REMEDY: a check with no remedy_tool is left completely alone", async () => {
  // Most failures have no button — a campaign slot to archive, a dead hub, a
  // roster that disagrees with itself. Those must not grow an empty `remedy`
  // key the board could mistake for "resolved to nothing".
  const { attachRemedies, describeTools } = await import("./tools.mjs");
  const checks = [{ name: "campaign slot", status: "fail" }, { name: "disk free", status: "pass" }];
  attachRemedies(checks, describeTools(BENCH));
  assert.ok(!("remedy" in checks[0]));
  assert.ok(!("remedy" in checks[1]));
});

test("SEAM: every remedy preflight can name is a real tool id somewhere", async () => {
  // THE CROSS-FILE CONTRACT, pinned. Preflight names tools by id in a Python
  // file; the registry defines them in JS. Nothing but this test connects the
  // two, and an id that matches nothing degrades SILENTLY to "no button" —
  // which looks exactly like a check that never had a remedy.
  const { toolRegistry } = await import("./tools.mjs");
  const src = readFileSync(join(BENCH, "scripts", "bench_preflight.py"), "utf8");
  const declared = [...src.matchAll(/^TOOL_[A-Z_]+ = "([a-z0-9-]+)"$/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 3, `preflight declares no remedy tool ids: ${declared}`);

  // The dev manifest is what contributes bench-ready/bench-mcp-restart, and it
  // is present in this workspace — so here, every declared id must resolve.
  const saved = process.env.OKP_BENCH_TOOLS_MANIFEST;
  process.env.OKP_BENCH_TOOLS_MANIFEST = join(BENCH, "..", "dev", "bench-tools.json");
  try {
    const ids = new Set(toolRegistry(BENCH).map((t) => t.id));
    for (const id of declared) {
      assert.ok(ids.has(id), `preflight names remedy tool "${id}" and nothing registers it`);
    }
  } finally {
    if (saved === undefined) delete process.env.OKP_BENCH_TOOLS_MANIFEST;
    else process.env.OKP_BENCH_TOOLS_MANIFEST = saved;
  }
});

// ── DEV MODE ─────────────────────────────────────────────────────────────────
//
// The mode is SERVER state: environment → state file → default OFF. A pinned
// environment makes the board's toggle a lie, so it publishes settable:false
// and the write REFUSES. A malformed setting reads OFF — the safe direction —
// but never as "nobody configured anything". env is injected as a parameter
// here; process.env is never touched.

test("DEVMODE: env truthy resolves ON and pins the toggle", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  const r = await resolveDevMode({ benchRoot: root, env: { OKP_BENCH_DEV_MODE: "on" } });
  assert.equal(r.enabled, true);
  assert.equal(r.source, "environment");
  // PINNED: the toggle must refuse rather than write a file the next read ignores.
  assert.equal(r.settable, false);
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: env falsy resolves OFF and pins the toggle", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  const r = await resolveDevMode({ benchRoot: root, env: { OKP_BENCH_DEV_MODE: "off" } });
  assert.equal(r.enabled, false);
  assert.equal(r.source, "environment");
  assert.equal(r.settable, false);
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: an exported value wins over the state file", async () => {
  // CI and scripted runs pin the mode without writing to disk; a file saying
  // otherwise must not change the answer.
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "devmode.json"), JSON.stringify({ enabled: false }));

  const r = await resolveDevMode({ benchRoot: root, env: { OKP_BENCH_DEV_MODE: "on" } });
  assert.equal(r.enabled, true);
  assert.equal(r.source, "environment");
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: no env reads the state file and stays toggleable", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "devmode.json"), JSON.stringify({ enabled: true }));

  const r = await resolveDevMode({ benchRoot: root, env: {} });
  assert.equal(r.enabled, true);
  assert.equal(r.source, "state_file");
  assert.equal(r.settable, true);
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: a fresh clone is OFF by default and toggleable", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  const r = await resolveDevMode({ benchRoot: root, env: {} });
  assert.equal(r.enabled, false);
  assert.equal(r.source, "default");
  assert.equal(r.settable, true);
  // NOT a reason — nothing is wrong, so the board renders no warning.
  assert.equal(r.reason, null);
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: a malformed env value reads OFF and says misconfiguration", async () => {
  // Absence and misconfiguration are different facts. A silently-ignored
  // setting is how an operator concludes the feature is broken.
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  const r = await resolveDevMode({ benchRoot: root, env: { OKP_BENCH_DEV_MODE: "banana" } });
  assert.equal(r.enabled, false);
  assert.equal(r.source, "environment_malformed");
  assert.equal(r.settable, false);
  assert.match(r.reason, /misconfiguration/);
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: a malformed state file reads OFF but stays settable", async () => {
  // STILL SETTABLE: writing repairs it. A refusal would leave the operator
  // with a broken file and no board-side way to fix it.
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "devmode.json"), "enabled: true\n");

  const r = await resolveDevMode({ benchRoot: root, env: {} });
  assert.equal(r.enabled, false);
  assert.equal(r.source, "state_file_malformed");
  assert.equal(r.settable, true);
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: a state file with no boolean enabled reads OFF but stays settable", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "devmode.json"), JSON.stringify({ mode: "dev" }));

  const r = await resolveDevMode({ benchRoot: root, env: {} });
  assert.equal(r.enabled, false);
  assert.equal(r.source, "state_file_malformed");
  assert.equal(r.settable, true);
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: an env-pinned mode REFUSES the write and writes nothing", async () => {
  // The POST must not succeed-and-be-ignored: the refusal is the point.
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  const w = await writeDevMode({ benchRoot: root, enabled: false, env: { OKP_BENCH_DEV_MODE: "on" } });
  assert.equal(w.ok, false);
  assert.equal(w.code, "pinned_by_environment");
  assert.equal(existsSync(join(root, "config", "devmode.json")), false, "a refused write must not touch the state file");
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: writeDevMode round-trips through the state file", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  const on = await writeDevMode({ benchRoot: root, enabled: true, env: {} });
  assert.equal(on.ok, true);
  // The RE-RESOLVED state, never what the writer hoped it wrote.
  assert.equal(on.dev_mode.enabled, true);
  assert.equal(on.dev_mode.source, "state_file");

  const read1 = await readDevMode({ benchRoot: root, env: {} });
  assert.equal(read1.dev_mode.enabled, true);

  const off = await writeDevMode({ benchRoot: root, enabled: false, env: {} });
  assert.equal(off.ok, true);
  const read2 = await readDevMode({ benchRoot: root, env: {} });
  assert.equal(read2.dev_mode.enabled, false);
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: a non-boolean write is refused by name", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  const w = await writeDevMode({ benchRoot: root, enabled: "yes", env: {} });
  assert.equal(w.ok, false);
  assert.equal(w.code, "enabled_not_boolean");
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: the toggled state survives a restart", async () => {
  // Persistence, not process memory: a FRESH resolve (a restarted control
  // plane) must read the file the previous process wrote.
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  const w = await writeDevMode({ benchRoot: root, enabled: true, env: {} });
  assert.equal(w.ok, true);

  const restarted = await resolveDevMode({ benchRoot: root, env: {} });
  assert.equal(restarted.enabled, true);
  assert.equal(restarted.source, "state_file");
  rmSync(root, { recursive: true, force: true });
});

// ── RUNDIR: a log line carrying two /runs/ paths ────────────────────────────
//
// MEASURED DEFECT, 2026-09-05. `runDirOf`'s anchored branch was
// `/\/runs\/(.+?)\/(?:…|memoryOFF|…)\//` and `.` matches a space. A run
// directory is a path and can never contain one, so the character class was
// always wrong — it just had nothing to bite on until a single log line carried
// TWO `/runs/` paths.
//
// Seeding produced the first one. Starting at the FIRST `/runs/`, the lazy
// `.+?` grew across the space and the `dst=` to reach `/memoryOFF/`, capturing
// `snapshots/<id>/tree dst=/Users/…/<model>`. No such directory exists, so
// `newestLog` rejected the only candidate and returned null, and `readRunState`
// reported `state:"idle"` while the harness was alive and grading — which the
// board drew as "SOMETHING FAILED · the process probe no longer sees the
// harness" over a healthy cell.
test("RUNDIR: a seed line's two /runs/ paths resolve to the destination run", () => {
  const line =
    "PROGRESS step=seed-copy src=/x/bench/runs/snapshots/1788598797371/tree "
    + "dst=/x/bench/runs/1788599410/local/local-llm-proxy/omlx/qwen3-6-35b-a3b-bench/memoryOFF/cell-0000/worktree";
  assert.equal(runDirOf(line), "1788599410/local/local-llm-proxy/omlx/qwen3-6-35b-a3b-bench");
});

test("RUNDIR: the capture never spans whitespace", () => {
  // The property, not the one line that exposed it: whatever a log carries, a
  // run directory is one path. A capture containing a space is a capture that
  // crossed from one path into another, and it can only ever name a directory
  // that does not exist.
  const lines = [
    "a=/r/runs/snapshots/1/tree b=/r/runs/2000000000/s/p/m/memoryON/cell-0000/worktree",
    "/r/runs/snapshots/1/tree /r/runs/2000000000/s/p/m/sessions/x",
    "old=/r/runs/1999999999/a/b/c/d/memoryOFF/ new=/r/runs/2000000000/s/p/m/memoryOFF/",
  ];
  for (const l of lines) {
    const got = runDirOf(l);
    assert.ok(got && !/\s/.test(got), `run dir must not contain whitespace: ${JSON.stringify(got)}`);
  }
});

test("RUNDIR: an ordinary single-path line is unchanged", () => {
  // The fix must not cost the case that always worked.
  assert.equal(
    runDirOf("step=worktree-git-init path=/x/bench/runs/1788592301/local/p/o/m/memoryOFF/cell-0000/worktree"),
    "1788592301/local/p/o/m",
  );
});

// ── HISTORY: ─────────────────────────────────────────────────────────────────
// The run forest's pure reader (WO-HIST-04). history.mjs enumerates cells
// across ALL eras and reads their artifacts back; benchmark_id, cell, and the
// diff relPath all arrive from the wire, so every refusal shape (invalid_run /
// path_traversal / not_found) is asserted here, not just the happy path.
// server.mjs self-listens at import, so its wiring is pinned by source text
// (SERVER_SRC) — the same deliberate trade the GUARD section makes.

const HISTORY_DIFF = "--- a/src/game.ts\n+++ b/src/game.ts\n@@ -1 +1 @@\n-old\n+new\n";
const HISTORY_CAMPAIGN = "local/local-llm-proxy/omlx/qwen3-6-35b-a3b-bench";

// One cell on disk, plus the manifest.json that makes its campaign visible to
// listCampaignDirs — the campaign home is the parent of the /^memory/i arm.
function writeHistoryCell(root, rel, { withCheckpoints = false, withTranscript = false } = {}) {
  const segs = rel.split("/");
  const armIdx = segs.findIndex((s) => /^memory/i.test(s));
  assert.notEqual(armIdx, -1, `writeHistoryCell: no memory arm segment in ${rel}`);
  const cellDir = join(root, rel);
  mkdirSync(cellDir, { recursive: true });
  writeFileSync(join(root, ...segs.slice(0, armIdx), "manifest.json"), "{}");
  if (withCheckpoints) {
    const diffs = join(cellDir, "checkpoints", "diffs", "cp-01_to_cp-02");
    mkdirSync(join(diffs, "files", "src"), { recursive: true });
    writeFileSync(
      join(cellDir, "checkpoints", "index.json"),
      JSON.stringify({
        run_id: "r1",
        checkpoints: [
          { id: "cp-01", attempt: 1, phase: "initial", state_hash: "h1", wall_ts: 1, tree_path: "checkpoints/cp-01/tree" },
        ],
        diffs: [
          {
            id: "cp-01_to_cp-02",
            from: "cp-01",
            to: "cp-02",
            combined: "checkpoints/diffs/cp-01_to_cp-02/combined.diff",
            files: [
              { path: "src/game.ts", change: "modified", diff: "checkpoints/diffs/cp-01_to_cp-02/files/src/game.ts.diff" },
            ],
          },
        ],
      }),
    );
    writeFileSync(join(diffs, "combined.diff"), HISTORY_DIFF);
    writeFileSync(join(diffs, "files", "src", "game.ts.diff"), HISTORY_DIFF);
  }
  if (withTranscript) {
    writeFileSync(join(cellDir, "transcript.md"), "# Session transcript\n\n## 1. User\nhello\n");
  }
  return { cellDir, rel, treeId: segs[0] };
}

// The (benchmark_id, cell) pair as the wire carries it: cell is rel minus its
// tree-id head — exactly what listRunCells reports and resolveCellDir re-joins.
const historyWireCell = (h) => h.rel.split("/").slice(1).join("/");

test("HISTORY: listRunCells returns most-recent-first with honest null artifact fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-hist-list-"));
  try {
    writeHistoryCell(root, `1788672514/${HISTORY_CAMPAIGN}/memoryOFF/cell-0000`);
    const populated = writeHistoryCell(root, `1788672514/${HISTORY_CAMPAIGN}/memoryOFF/cell-0001`, {
      withCheckpoints: true,
      withTranscript: true,
    });
    writeHistoryCell(root, `1788600000/${HISTORY_CAMPAIGN}/memoryOFF/cell-0000`);
    writeHistoryCell(root, `1788600000/${HISTORY_CAMPAIGN}/memoryOFF/cell-0001`);

    const cells = await listRunCells(root);
    assert.equal(cells.length, 4);

    // Tree ids are epoch stamps: numeric descending, cell path descending within.
    assert.deepEqual(
      cells.map((c) => [c.benchmark_id, c.cell]),
      [
        ["1788672514", `${HISTORY_CAMPAIGN}/memoryOFF/cell-0001`],
        ["1788672514", `${HISTORY_CAMPAIGN}/memoryOFF/cell-0000`],
        ["1788600000", `${HISTORY_CAMPAIGN}/memoryOFF/cell-0001`],
        ["1788600000", `${HISTORY_CAMPAIGN}/memoryOFF/cell-0000`],
      ],
    );

    // The full entry shape — 11 keys, in source order (history.mjs cells.push).
    // `tree_id`, `archived` and `unreadable` were added 2026-09-10 for the
    // archive. They are DISPLAY identity, derived from the path, deliberately
    // separate from the resolvable (benchmark_id, cell) pair rather than
    // replacing it — and `unreadable` carries WHY when the path does not match
    // the layout the reset writes, because the rule is to standardise the view
    // and never the data.
    const KEYS = [
      "benchmark_id",
      "cell",
      "tree_id",
      "archived",
      "unreadable",
      "dev_mode_enabled",
      "dev_mode_source",
      "dev_mode_file",
      "checkpoints_dir",
      "transcript_file",
      "mapping_file",
    ];
    for (const c of cells) assert.deepEqual(Object.keys(c), KEYS);

    // Presence is measured with stat, never guessed: the populated cell carries
    // absolute paths; the bare three carry honest nulls. mapping.json is never
    // written by the fixture — not even the populated cell may invent one.
    assert.equal(cells[0].checkpoints_dir, join(populated.cellDir, "checkpoints"));
    assert.equal(cells[0].transcript_file, join(populated.cellDir, "transcript.md"));
    assert.equal(cells[0].mapping_file, null);
    for (const bare of cells.slice(1)) {
      assert.equal(bare.checkpoints_dir, null);
      assert.equal(bare.transcript_file, null);
      assert.equal(bare.mapping_file, null);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HISTORY: listRunCells carries dev_mode fields when provided and defaults otherwise", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-hist-devmode-"));
  try {
    writeHistoryCell(root, `1788672514/${HISTORY_CAMPAIGN}/memoryOFF/cell-0000`);

    // The reader never measures dev mode itself — absent input means defaults.
    const defaults = await listRunCells(root);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].dev_mode_enabled, false);
    assert.equal(defaults[0].dev_mode_source, null);
    assert.equal(defaults[0].dev_mode_file, null);

    // What the caller measured once is broadcast onto every entry as-is.
    const carried = await listRunCells(root, {
      enabled: true,
      source: "state_file",
      file: "/bench/config/devmode.json",
    });
    assert.equal(carried.length, 1);
    for (const c of carried) {
      assert.equal(c.dev_mode_enabled, true);
      assert.equal(c.dev_mode_source, "state_file");
      assert.equal(c.dev_mode_file, "/bench/config/devmode.json");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HISTORY: absent artifacts are honest null/404, never 500", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-hist-absent-"));
  try {
    const h = writeHistoryCell(root, `1788672514/${HISTORY_CAMPAIGN}/memoryOFF/cell-0000`);
    const cell = historyWireCell(h);

    // A run without checkpoint history is a legitimate state, not a failure.
    assert.deepEqual(await readCheckpointIndex(root, h.treeId, cell), {
      ok: true,
      checkpoints: null,
      diffs: null,
    });

    const diff = await readDiffText(root, h.treeId, cell, "diffs/x/combined.diff");
    assert.equal(diff.ok, false);
    assert.equal(diff.code, "not_found");
    assert.equal(diff.status, 404);

    // A transcript is the record of what the model was actually told — absence
    // is a 404, never an empty string passed off as content.
    const transcript = await readTranscriptText(root, h.treeId, cell);
    assert.equal(transcript.ok, false);
    assert.equal(transcript.code, "not_found");
    assert.equal(transcript.status, 404);

    // Only an invalid identifier is refused — as a 400, never a throw.
    const invalid = await readCheckpointIndex(root, "../..", cell);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, "invalid_run");
    assert.equal(invalid.status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HISTORY: diff route refuses path traversal", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-hist-traversal-"));
  try {
    const h = writeHistoryCell(root, `1788672514/${HISTORY_CAMPAIGN}/memoryOFF/cell-0000`, {
      withCheckpoints: true,
    });
    const cell = historyWireCell(h);

    // relPath is wire input: `..` segments, absolute paths, and the backslash
    // form are all refused BEFORE any read — a 400, never a served /etc/passwd.
    for (const evil of ["../../etc/passwd", "/etc/passwd", "..\\..\\etc"]) {
      const got = await readDiffText(root, h.treeId, cell, evil);
      assert.equal(got.ok, false, `expected refusal for ${JSON.stringify(evil)}`);
      assert.equal(got.code, "path_traversal");
      assert.equal(got.status, 400);
    }

    // The cell identifier is wire input too — containment is checked first.
    const badCell = await readDiffText(root, h.treeId, "../../etc", "diffs/x/combined.diff");
    assert.equal(badCell.ok, false);
    assert.equal(badCell.code, "invalid_run");
    assert.equal(badCell.status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HISTORY: a synthetic run round-trips checkpoints, diff, and transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-hist-roundtrip-"));
  try {
    const h = writeHistoryCell(root, `1788672514/${HISTORY_CAMPAIGN}/memoryOFF/cell-0000`, {
      withCheckpoints: true,
      withTranscript: true,
    });
    const cell = historyWireCell(h);

    const idx = await readCheckpointIndex(root, h.treeId, cell);
    assert.equal(idx.ok, true);
    assert.equal(idx.checkpoints.length, 1);
    assert.equal(idx.diffs.length, 1);
    assert.equal(idx.diffs[0].files[0].path, "src/game.ts");

    // index.json records every path relative to the CELL dir, so a served
    // relPath may arrive with the checkpoints/ prefix — one leading prefix is
    // stripped and both forms resolve identically.
    const bare = await readDiffText(root, h.treeId, cell, "diffs/cp-01_to_cp-02/combined.diff");
    assert.equal(bare.ok, true);
    assert.ok(bare.text.includes("+new"));
    const prefixed = await readDiffText(root, h.treeId, cell, "checkpoints/diffs/cp-01_to_cp-02/combined.diff");
    assert.equal(prefixed.ok, true);
    assert.equal(prefixed.text, bare.text);

    const transcript = await readTranscriptText(root, h.treeId, cell);
    assert.equal(transcript.ok, true);
    assert.ok(transcript.text.includes("## 1. User"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HISTORY: server.mjs wires the four routes, the import, and sendText", () => {
  // server.mjs calls listen() at import, so the wiring is pinned by source
  // text — the same deliberate trade the GUARD section's SERVER_SRC makes.
  for (const needle of [
    '"/api/history"',
    '"/api/history/checkpoints"',
    '"/api/history/diff"',
    '"/api/history/transcript"',
    'from "./history.mjs"',
    "function sendText(",
  ]) {
    assert.ok(SERVER_SRC.includes(needle), `server.mjs no longer contains ${needle}`);
  }
});

// ── /history must show the archive, and the board must not (2026-09-10) ─────

test("HISTORY: archived trees are enumerated, live-only walks still are not", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-hist-backups-"));
  try {
    // A live tree, and one parked by a reset at backups/<new>/<old>/…
    const live = join(root, "1789023699", "local", "prov", "omlx", "model-a");
    const arch = join(root, "backups", "1789023699", "1788976174", "local", "prov", "omlx", "model-a");
    for (const campaign of [live, arch]) {
      mkdirSync(join(campaign, "memoryOFF", "cell-0000"), { recursive: true });
      writeFileSync(join(campaign, "manifest.json"), "{}");
    }

    const cells = await listRunCells(root);
    const ids = cells.map((c) => c.tree_id).sort();
    assert.deepEqual(ids, ["1788976174", "1789023699"], "the archive is history too");

    const archived = cells.find((c) => c.archived);
    assert.equal(archived.tree_id, "1788976174", "display id is the run's own, not 'backups'");
    assert.equal(archived.benchmark_id, "backups", "resolvable half is unchanged");
    assert.ok(
      archived.cell.startsWith("1789023699"),
      "the cell path carries the rest, so resolveCellDir still re-joins it",
    );

    // The board's walk must be untouched: descending into backups there is how
    // a reset would undo itself on the next poll.
    const live_only = await listCampaignDirs(root);
    assert.equal(live_only.length, 1, "default walk must still skip the archive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HISTORY: an archived cell still resolves to a real directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-hist-resolve-"));
  try {
    const campaign = join(root, "backups", "1789023699", "1788976174", "local", "prov", "omlx", "m");
    mkdirSync(join(campaign, "memoryOFF", "cell-0000", "checkpoints"), { recursive: true });
    writeFileSync(join(campaign, "manifest.json"), "{}");
    writeFileSync(
      join(campaign, "memoryOFF", "cell-0000", "checkpoints", "index.json"),
      JSON.stringify({ run_id: "r", checkpoints: [{ id: "cp-01" }], diffs: [] }),
    );

    const [row] = await listRunCells(root);
    const got = await readCheckpointIndex(root, row.benchmark_id, row.cell);
    assert.equal(got.ok, true, "the pair listRunCells reports must be resolvable");
    assert.equal(got.checkpoints.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── A LAUNCH SETTING MUST REACH THE ARGV (2026-09-11) ───────────────────────
//
// `graderWorkerTarget` was threaded through five places — payload parse, the
// preview call, the preview signature, its return, and the argv builder — and
// ONE destructure of `check` was missed. Everything parsed, every test passed,
// and the failure surfaced as `launcher_failed: graderWorkerTarget is not
// defined` when the operator pressed Launch.
//
// A source-level check, because that is where the defect lives: the value is
// not in scope at the site that uses it. Running the server would need a whole
// launch to reach that line.

test("LAUNCH: every setting the argv builder uses is destructured everywhere", () => {
  const src = readFileSync(join(HERE, "server.mjs"), "utf-8");

  // SCOPED TO THE LAUNCH BUILDER, not to every argv in the file. The first
  // version scanned all of them and flagged `cloudProvider`, which is a local
  // in an unrelated GET handler — a test that cries wolf gets disabled, and
  // then it catches nothing.
  //
  // The launch builder is the block that pushes the `run` subcommand. Read from
  // there to the end of its statement list.
  const start = src.indexOf('argv.push("run", "--mode", arm');
  assert.ok(start > 0, "the launch argv builder has moved — find it and re-scope this test");
  const region = src.slice(start, start + 1200);

  const pushes = [...region.matchAll(/if \((\w+)\)\s*argv\.push\("--[\w-]+"/g)].map((m) => m[1]);
  const guarded = [...region.matchAll(/if \((\w+) != null\) \{\s*\n\s*argv\.push\("--[\w-]+"/g)].map(
    (m) => m[1],
  );
  const used = [...new Set([...pushes, ...guarded])];
  assert.ok(used.length >= 3, `expected several launch settings, found ${used.join(", ")}`);

  // Every destructure of the preview result must carry all of them: the argv
  // builder sits inside one of these scopes and cannot see what it did not name.
  const destructures = [...src.matchAll(/const \{ model, arm[^}]*\} = check;/g)].map((m) => m[0]);
  assert.ok(destructures.length > 0, "no destructure of `check` found — has the shape moved?");

  for (const d of destructures) {
    for (const name of used) {
      assert.ok(
        d.includes(name),
        `\`${name}\` is pushed into the launch argv but missing from a destructure of ` +
          `\`check\`. That is not a parse error — it fails at LAUNCH with ` +
          `"${name} is not defined", after preflight has already passed.`,
      );
    }
  }

  // And the preview must return each one, or the destructure above is reading
  // a key nobody wrote.
  const ret = /return \{ ok: true, model, arm[^}]*\};/.exec(src);
  assert.ok(ret, "the preview no longer returns its usual shape");
  for (const name of used) {
    assert.ok(ret[0].includes(name), `preview does not return \`${name}\``);
  }
});

// ── STREAM ERRORS MUST COUNT STREAM ERRORS (2026-09-11) ─────────────────────
//
// The slot read `error_totals.finalize_timeout_turns` — ONE narrow kind, a turn
// killed while the stream was FINALIZING. A plain `transport_error`, the stream
// dying mid-turn, is not that. Measured on a live run: the stream died on
// initial-chunk-2, the harness recorded it, and the board's counter never moved.
//
// A counter that reads zero through the failure it is named for is worse than
// no counter: it is an active assurance that nothing went wrong.

test("STATS: STREAM ERRORS reads the whole stream-failure family, not one kind", () => {
  const src = readFileSync(join(HERE, "runstats.mjs"), "utf-8");
  const block = /id: "stream_errors"[\s\S]*?\n    \},/.exec(src);
  assert.ok(block, "the stream_errors provider has moved");
  assert.match(
    block[0],
    /error_totals\?\.instrument_anomaly_turns/,
    "STREAM ERRORS must read instrument_anomaly_turns — every anomalous turn " +
      "except the loop guard's, which has its own slot. finalize_timeout_turns " +
      "is a subset and misses the common case.",
  );
  assert.ok(
    !/error_totals\?\.finalize_timeout_turns/.test(block[0]),
    "reading the narrow field alone is the defect this replaced",
  );
});

test("STATS: each error slot reads a DIFFERENT counter", () => {
  // Three slots, three failure families. Two slots reading one field would make
  // one family permanently invisible — which is exactly what happened.
  const src = readFileSync(join(HERE, "runstats.mjs"), "utf-8");
  const fields = [...src.matchAll(/error_totals\?\.(\w+)/g)].map((m) => m[1]);
  assert.equal(
    new Set(fields).size,
    fields.length,
    `two error slots read the same counter: ${fields.join(", ")}`,
  );
  assert.ok(fields.length >= 3, `expected three error counters, found ${fields.join(", ")}`);
});

test("STATS: every counter a slot reads is one the scorecard actually writes", () => {
  // The producer/consumer seam. A slot reading a field `build_scorecard` never
  // emits sits at "—" forever and nothing says why — which is how the missing
  // `instrument_anomaly_turns` went unnoticed.
  const src = readFileSync(join(HERE, "runstats.mjs"), "utf-8");
  const py = readFileSync(
    join(HERE, "..", "harness", "cumulative", "run_artifacts.py"),
    "utf-8",
  );
  const emitted = /error_totals = \{([\s\S]*?)\n    \}/.exec(py);
  assert.ok(emitted, "build_scorecard no longer builds error_totals");
  for (const field of [...src.matchAll(/error_totals\?\.(\w+)/g)].map((m) => m[1])) {
    assert.match(
      emitted[1],
      new RegExp(`"${field}"`),
      `the board reads error_totals.${field}, which build_scorecard does not write`,
    );
  }
});
