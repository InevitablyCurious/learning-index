// Extracted verbatim from control/control.test.mjs — WO-LI18 split A.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { confirmationToken, restatement, refuse } from "../contract.mjs";
import { RETIRED_ALIASES, readRoster } from "../roster.mjs";
import { COMPACT_DEFAULT_CEILING, CONTEXT_ADVISORY_FLOOR } from "../cloud.mjs";

import { HERE, BENCH } from "./_shared.mjs";

test("ROSTER: declared context comes from the proxy, never a local table", async () => {
  // The bench used to keep its own copy of each alias's window, and that copy
  // drifted. The proxy now reports context_length live from the runtime, and
  // the roster must show exactly that value.
  const proxy = {
    object: "list",
    data: [
      { id: "qwen3.6-35b-a3b-bench", upstream_model: "Qwen3.6-35B-A3B-MLX-8bit", purpose: "okp-bench", context_length: 262144, max_output_tokens: 32768 },
      { id: "deepseek-v4-flash-bench", upstream_model: "Vontra--DeepSeek-V4-Flash-0731-MXFP4-MLX", purpose: "okp-bench", context_length: 256512, max_output_tokens: 32768 },
      { id: "no-window", upstream_model: "x", purpose: "okp-bench" },
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
    assert.equal(byId["qwen3.6-35b-a3b-bench"].declared_context, 262144);
    assert.equal(byId["deepseek-v4-flash-bench"].declared_context, 256512);
    assert.equal(byId["no-window"].declared_context, null, "an unreported window stays unknown, never guessed");
  } finally {
    globalThis.fetch = realFetch;
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
  const src = readFileSync(join(BENCH, "harness", "rosters.py"), "utf8");
  const block = /RETIRED_MODEL_ALIASES: dict\[str, str\] = \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(block, "RETIRED_MODEL_ALIASES not found in config.py");
  const pythonIds = [...block[1].matchAll(/^\s{4}"([^"]+)":/gm)].map((m) => m[1]);
  assert.deepEqual(
    Object.keys(RETIRED_ALIASES).sort(),
    pythonIds.sort(),
    "a retirement is declared on one side only — the bench and the board disagree about what may run",
  );
});

test("ROSTER: every retirement states its reason", () => {
  for (const id of Object.keys(RETIRED_ALIASES)) {
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
  // The rule's home moved from server.mjs to lib/validate.mjs (LI-14 phase 1).
  const src = readFileSync(join(BENCH, "control", "lib", "validate.mjs"), "utf8");
  // The rule is written once, in the control plane's validation lib, and reads
  // the roster entry — which is a real row for a local model and a synthesised
  // one of the same shape for a cloud model, so one code path covers both.
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
  // The launch route moved from server.mjs to routes/run.mjs (LI-14 phase 2).
  const src = readFileSync(join(BENCH, "control", "routes", "run.mjs"), "utf8");
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
  // The launch route moved from server.mjs to routes/run.mjs (LI-14 phase 2).
  const src = readFileSync(join(BENCH, "control", "routes", "run.mjs"), "utf8");
  // The success return lives in finishValidate, which moved to lib/validate.mjs
  // (LI-14 phase 1); the destructures and the argv push below are route code
  // and live in routes/run.mjs.
  const validateSrc = readFileSync(join(BENCH, "control", "lib", "validate.mjs"), "utf8");

  // 1. validateStart must RETURN it, or every consumer destructures undefined.
  // Assert the FIELD is in the return, not the exact field list — pinning the
  // whole list makes every later addition look like a regression.
  const ret = validateSrc.match(/return \{ ok: true,[^}]*\}/);
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

test("REQUIRE TODOS: the preflight handler does NOT pass a flag preflight cannot take", () => {
  // /api/preflight shells out to bench_preflight.py, which has no
  // --require-todos argument — and its `compact` is a URL search param, not the
  // validated launch value. An insertion there was both a scope error and a bad
  // flag. Pin the shape so it cannot come back.
  // The preflight route moved from server.mjs to routes/run.mjs (LI-14 phase
  // 2); the entry's `path:` literal is the route's pin there.
  const src = readFileSync(join(BENCH, "control", "routes", "run.mjs"), "utf8");
  const handler = src.slice(src.indexOf('path: "/api/preflight"'));
  const body = handler.slice(0, handler.indexOf("execFile("));
  assert.ok(
    !body.includes("--require-todos"),
    "the preflight argv must not carry a flag bench_preflight.py does not define",
  );
});

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
// process — and since LI-14 phase 2 the preview/start route bodies live in
// control/routes/run.mjs, so these assertions read THAT source instead. That
// is weaker than calling the function, and it is chosen deliberately: a source
// assertion that pins the two load-bearing details is worth more than no guard
// at all on a bug that already shipped once.
const RUN_ROUTES_SRC = readFileSync(join(HERE, "routes", "run.mjs"), "utf8");

function previewHandlerSource() {
  const start = RUN_ROUTES_SRC.indexOf('path: "/api/run/preview"');
  assert.notEqual(start, -1, "the /api/run/preview route disappeared");
  const end = RUN_ROUTES_SRC.indexOf('path: "/api/run/start"', start);
  assert.notEqual(end, -1, "could not find the end of the preview handler");
  return RUN_ROUTES_SRC.slice(start, end);
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
  const startIdx = RUN_ROUTES_SRC.indexOf('path: "/api/run/start"');
  assert.notEqual(startIdx, -1, "the /api/run/start route disappeared");
  const src = RUN_ROUTES_SRC.slice(startIdx, startIdx + 1600);
  assert.doesNotMatch(
    src,
    /requireConfirm:\s*false/,
    "start must NEVER skip confirmation — that is what makes the second click meaningful",
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

