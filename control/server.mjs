#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// BENCH CONTROL PLANE — SERVER
//
//   node server.mjs                 # http://127.0.0.1:7718
//   node server.mjs --port 8081
//
// ZERO DEPENDENCIES. Node stdlib only. No build step, no npm install.
//
// ── THIS IS THE ONLY PART OF THE BOARD THAT CAN CHANGE THE WORLD ─────────────
//
// The dashboard on :7717 is read-only by construction and MUST STAY THAT WAY:
// GET-only, bench repo mounted `:ro`, no docker socket, uid 1000. Those are
// kernel-enforced properties that make "the dashboard corrupted a run"
// impossible rather than unlikely.
//
// Starting runs cannot live there without destroying that. It lives here
// instead: a separate process, a separate port, a separate trust level, and a
// deliberately small surface.
//
// ── SAFETY PROPERTIES (deliberate, do not weaken) ────────────────────────────
//
//   - BINDS 127.0.0.1 AND HAS NO --host FLAG. The read-only dashboard may be
//     exposed on a LAN as a deliberate act; a control plane may not. There is
//     no code path that binds anything else.
//
//   - NO SHELL, EVER. Every process is spawned with an argv array and
//     `shell:false`. Operator-supplied values (model alias, org id) are argv
//     entries, never shell words, so command injection is impossible by
//     construction rather than by escaping.
//
//   - ONE RUN AT A TIME. Enforced server-side and refused with a stated
//     reason, never queued. The campaign is strictly serial (one resident local
//     model, one slot); a queue would let the UI imply a capability the
//     instrument does not have.
//
//   - THE MODEL MUST BE BENCH-ELIGIBLE. The proxy serves Walter's interactive
//     daily-driver aliases on the same endpoint as bench aliases. Starting a
//     benchmark against an interactive slot would contend with live use and
//     produce an indefensible measurement, so it is refused.
//
//   - EVERY REFUSAL CARRIES ITS REASON, VERBATIM, for a human on a stream.
//
//   - THE EVENT PROXY IS READ-ONLY AGAINST THE SERVE. GET /event only. It never
//     posts a prompt, aborts, or summarises — driving the session belongs to
//     the harness alone. A control plane that can inject a turn can corrupt the
//     measurement it displays.
// ─────────────────────────────────────────────────────────────────────────────

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { open, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTROL_CONTRACT_VERSION,
  RESUME_UNSUPPORTED,
  STALL_THRESHOLD_S,
  EVENT_RENDER_CAP,
  confirmationToken,
  restatement,
  refuse,
} from "./contract.mjs";
import { readRoster, CONTEXT_CHOICES } from "./roster.mjs";
import { readRunState, pidAlive, confirmAlive, findHarnessProcs, logPathForRunDir, cellDirForRun } from "./runstate.mjs";
import { readAgentEvents, createAgentEventSink } from "./agent-events.mjs";
import { EventRing, subscribe, mergeGrading } from "./events.mjs";
import { readGateActivity } from "./gate-events.mjs";
import { readWall, WALL_CONTRACT_VERSION } from "./wall.mjs";
import { readFeedback, feedbackRows, FEEDBACK_CONTRACT_VERSION } from "./feedback.mjs";
import { readModelsLedger } from "./models-ledger.mjs";
// THE FLOOR'S ONE OWNER — the same module the ledger's gates read and
// /api/baselines serves, so every refusal about a baseline on this server and
// every button on the board are answering from one derivation.
import { readBaselines, baselineFor, collectOffCells } from "./baselines.mjs";
import { TuiMirror } from "./tui.mjs";
import { readHold, releaseHold } from "./hold.mjs";
// WHERE A CELL'S MEASUREMENT LANDS. One campaign directory per model — see the
// module header. Split out so the rule is testable without binding a port.
import { campaignTargetFor } from "./campaign.mjs";
import { collectStats, captureStatsBaseline, readStatsBaseline } from "./runstats.mjs";
import { listSnapshots, readSnapshot, seedableBy, resolveArmed, writeArmed } from "./snapshots.mjs";
import { notice, noticesPathFor } from "./notices.mjs";
import { readBackendFeed } from "./backend-feed.mjs";
// THE BENCHMARK TREE. Minting is the control plane's act because the board
// container mounts the repo read-only — see tree.mjs for the layout and for
// why a reset rolls forward instead of unlinking.
import {
  ensureTree,
  readTreePointer,
  listCampaignDirs,
  campaignTreeId,
  planReset,
  resetAll,
} from "./tree.mjs";
// RESTORE. Listing, checking and putting a backup back — kept out of tree.mjs so
// the layout rules and the recovery rules can be read (and tested) apart.
import { listBackups, describeBackup, checkBackup, resolveBackupDir, restoreBackup } from "./backups.mjs";
// CUSTOM TOOLS. The harness owns the registry — the board renders what this
// serves rather than keeping its own copy that could claim a tool exists.
import { attachRemedies, describeTools, invokeTool } from "./tools.mjs";
// CLOUD BASELINES. The catalogue is a mirror of the harness's own provider
// block and the key is resolved server-side — see the header of cloud.mjs for
// why no credential ever crosses the wire in either direction.
import {
  readCloud,
  readCloudKey,
  resolveCloudModel,
  CLOUD_API_KEY_ENV,
  COMPACT_DEFAULT_CEILING,
} from "./cloud.mjs";
import { readRouters, writeRouterKey } from "./routers.mjs";
import { readDevMode, resolveDevMode, writeDevMode } from "./devmode.mjs";
import { listRunCells, readCheckpointIndex, readDiffText, readTranscriptText } from "./history.mjs";
import { playStatus, startPlay, stopPlay } from "./play.mjs";
import { deleteRun, planRunDelete } from "./rundelete.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    port: Number(process.env.OKP_CONTROL_PORT ?? 7718),
    benchRoot: process.env.OKP_CONTROL_BENCH_ROOT ?? resolve(HERE, ".."),
    proxyUrl: process.env.OKP_CONTROL_PROXY_URL ?? "http://127.0.0.1:4545",
    runtimeUrl: process.env.OKP_CONTROL_RUNTIME_URL ?? "http://127.0.0.1:1234",
    serveUrl: process.env.OKP_CONTROL_SERVE_URL ?? "http://127.0.0.1:4096",
    python: process.env.OKP_CONTROL_PYTHON ?? null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--bench-root") out.benchRoot = String(argv[++i]);
    else if (a === "--proxy-url") out.proxyUrl = String(argv[++i]);
    else if (a === "--runtime-url") out.runtimeUrl = String(argv[++i]);
    else if (a === "--serve-url") out.serveUrl = String(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// Stamped ONCE at module load: the moment this process parsed the code it is
// running. Read by /api/health so preflight can prove the running control plane
// is not older than control/ on disk. See the note on that field.
const PROCESS_STARTED_AT = new Date().toISOString();

if (args.help) {
  console.log(`
bench control plane

  node server.mjs [options]

  --port <n>          default 7718
  --bench-root <dir>  default: the parent of this file
  --proxy-url <url>   default http://127.0.0.1:4545   (model roster)
  --runtime-url <url> default http://127.0.0.1:1234   (residency + context)
  --serve-url <url>   default http://127.0.0.1:4096   (worker event stream)

  Binds 127.0.0.1 only. There is deliberately no --host flag.
`);
  process.exit(0);
}

const BENCH_ROOT = resolve(args.benchRoot);
const RUNS_ROOT = join(BENCH_ROOT, "runs");
const PYTHON = args.python ?? join(BENCH_ROOT, ".venv", "bin", "python");
const RUN_SCRIPT = join(BENCH_ROOT, "scripts", "run_cumulative.py");

/**
 * WHICH RUN DIRECTORY A RUN-SCOPED READ SHOULD DEFAULT TO.
 *
 * ── THE HOLE THIS FILLS ─────────────────────────────────────────────────────
 *
 * Run-scoped surfaces (`/api/wall`, `/api/feedback`) take `?run_dir=` and fell
 * back to the literal `"cumulative"` when the caller named none. That was true
 * while every cell wrote to `runs/cumulative`, and stopped being true when
 * campaigns became per-model: `campaign.mjs:campaignDirName` now lands a cell in
 * `runs/cumulative-<model>`, and the legacy directory is ARCHIVED on a wipe
 * (RUNBOOK §2) rather than reused.
 *
 * So the default addressed a directory that does not exist. `readWall` handled
 * that exactly as designed — no pinned roster, so it enumerated the live suite,
 * and no `manifest.status.jsonl`, so no gate carried an outcome — and served a
 * TRUE 71-gate denominator with zero results against it. The board rendered
 * what it was sent: `0/71 passing` over 71 empty squares, on a run whose own
 * artifacts recorded 16 passing, 2 failing, 53 not run.
 *
 * THE LOG IS THE AUTHORITY, not a name pattern. `newestLog` (via `readRunState`)
 * resolves the run directory from the harness's own PROGRESS lines and rejects a
 * log whose directory is gone, so this follows a rename, a per-model campaign,
 * and the legacy layout without knowing about any of them — `readGateActivity`
 * already resolves the live run this way.
 *
 * NULL IS A REAL ANSWER. A bench with no cell log has no active run, and this
 * returns null so `resolveRunDir` falls through to `DEFAULT_RUN_DIR` and the
 * reader reports `unwired` with its reason. An invented directory would be the
 * fabrication invariant I-2 forbids.
 */
async function activeRunDir() {
  try {
    const run = await readRunState({ runsRoot: RUNS_ROOT, launcher });
    return run?.run_dir ?? null;
  } catch {
    return null;
  }
}

// ── mutable state: the ONLY things this service owns ─────────────────────────

/** The launcher process this service spawned, if any. */
let launcher = null;

const ring = new EventRing();

// Persist the agent event feed: every pushed row is enqueued and flushed to
// the active run's agent-events.jsonl (append-only) so a past run's feed
// survives restart. Rows are held until a run is known; flushed every 1s and
// on shutdown. Grading rows (admit) are NOT persisted — they are already
// durable (rebuilt from files each poll).
const agentSink = createAgentEventSink({ runsRoot: RUNS_ROOT, getRunDir: activeRunDir });
ring.sink = agentSink;
const persistTimer = setInterval(() => { void agentSink.flush(); }, 1000);
persistTimer.unref?.();

// Which run dir the ring currently holds rows for. null until the first
// /api/events poll resolves it. Re-checked on every poll: when the active run
// changes (a tree wipe, a stopped run, a new cell), the ring is reset so a
// long-lived process never serves a prior run's pinned rows against the
// current one.
let ringRunDir = null;

// The event subscription runs for the life of the process and reconnects
// forever. A cell's serve dies and restarts across teardown; that is normal and
// must not require an operator action to recover the feed.
subscribe(`${args.serveUrl}/event`, ring);

// The TUI mirror is ON-DEMAND, unlike the event feed. It costs a resident
// `opencode attach` client, so it starts on the first poll and stops itself once
// nothing is reading — polling IS the keepalive. It NEVER writes to the pty, so
// it cannot disturb the live session it is showing.
const tui = new TuiMirror({ serveUrl: args.serveUrl });
process.on("exit", () => tui.shutdown());
process.on("SIGINT", () => { tui.shutdown(); void agentSink.flush().finally(() => process.exit(0)); });
process.on("SIGTERM", () => { tui.shutdown(); void agentSink.flush().finally(() => process.exit(0)); });

// ── helpers ──────────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendText(res, status, text, contentType) {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req, cap = 64 * 1024) {
  return await new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) {
        rejectBody(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

/** Every precondition a start must satisfy, each with its own stated reason. */
/**
 * Validate a start request.
 *
 * `requireConfirm` separates the two callers. PREVIEW must run every PARAMETER
 * check (so it can never green-light a run that start would refuse) but cannot
 * require the confirmation token — the token is what preview EXISTS to mint, so
 * demanding it there is circular and refuses every valid preview with
 * `bad_confirmation`. START requires it, and that is what makes the second click
 * meaningful.
 */
async function validateStart(
  payload,
  roster,
  run,
  { requireConfirm = true, runsRoot = null } = {},
) {
  const model = typeof payload?.model === "string" ? payload.model.trim() : "";
  const arm = payload?.arm === "on" || payload?.arm === "off" ? payload.arm : null;
  const org = typeof payload?.org === "string" && payload.org.trim() ? payload.org.trim() : null;
  const context = Number.isFinite(payload?.context) ? Number(payload.context) : null;
  // TRI-STATE ON PURPOSE. `true`/`false` are the operator's own choice, made on
  // the confirmation frame; `undefined` means "nobody chose", and the server
  // fills it from the model's context window in `finishValidate` — where the
  // roster entry is in hand. Coercing it to a boolean here would silently turn
  // "unspecified" into "off" for every client that has not been taught the
  // field, quietly stripping compaction from cells that should have it.
  const compactRequested =
    payload?.compact === true ? true : payload?.compact === false ? false : null;
  // PLAIN BOOLEAN, not tri-state like compaction. Compaction has a server-side
  // default resolved from the model's context window, so "unspecified" has to be
  // distinguishable from "off". This has no such default — the operator's switch
  // is the whole story, and absent means off.
  const requireTodos = payload?.requireTodos === true;
  // THE RECORDING TURN. Plain boolean like requireTodos — no server-side
  // default to resolve, so absent means off.
  const recordAtChunkEnd = payload?.recordAtChunkEnd === true;
  // MACHINE SHARE for grading. Validated here rather than trusted: a nonsense
  // fraction would reach the container and be silently ignored, which is worse
  // than being told. Absent leaves the container's own default.
  const rawTarget = Number(payload?.graderWorkerTarget);
  const graderWorkerTarget =
    Number.isFinite(rawTarget) && rawTarget > 0 && rawTarget <= 1 ? rawTarget : null;
  // THE SUBSTRATE IS DECLARED, NEVER SNIFFED. A model id could in principle be
  // classified by whether it contains a slash, and that would be a rule the
  // operator cannot see and the roster could break at any time. `kind` is an
  // explicit parameter, it defaults to local (every cell before this existed
  // was local), and anything else is refused by name.
  const kind = payload?.kind === "cloud" ? "cloud" : payload?.kind === "local" || payload?.kind === undefined || payload?.kind === null ? "local" : String(payload.kind);

  if (!run.can_start) {
    return refuse("run_in_flight", run.blocked_reason ?? "a cell is already in flight");
  }
  if (kind !== "local" && kind !== "cloud") {
    return refuse("unknown_kind", `'${kind}' is not a substrate — it is 'local' (the relay proxy) or 'cloud' (a routed vendor API)`);
  }
  if (!arm) {
    return refuse("org_required", "arm must be 'on' (memory) or 'off' (control)");
  }
  if (!model) {
    return refuse("unknown_model", "no model selected");
  }

  // ── CLOUD TAKES A DIFFERENT ROUTE THROUGH EVERY IDENTITY CHECK ──────────
  //
  // and only through the identity checks. A cloud cell is not served by the
  // local proxy, so the roster lookup below cannot find it and residency,
  // declared context and the retired-alias list have nothing to say about it.
  // Everything AFTER this block — the subject rule, the org rule, the baseline
  // gate, the confirmation token — is substrate-blind by construction and
  // applies to a cloud cell exactly as written. That is the reason this returns
  // an `entry` in the roster's shape rather than branching the whole function:
  // two copies of the baseline gate is how a cloud cell eventually launches
  // against no floor.
  if (kind === "cloud") {
    const cloud = resolveCloudModel(model);
    if (!cloud.ok) return refuse(cloud.code, cloud.reason);

    // THE KEY IS CHECKED HERE, NOT AT THE VENDOR. Without it the harness spawns,
    // builds a manifest, reserves spend and dies at the first request — leaving
    // a half-built campaign directory behind for a fault that was knowable
    // before anything was written.
    const key = await readCloudKey({ benchRoot: BENCH_ROOT });
    if (!key.present) {
      return refuse("cloud_key_missing", key.reason, { env: CLOUD_API_KEY_ENV });
    }

    const cloudEntry = {
      id: cloud.key,
      upstream_model: cloud.slug,
      bench_eligible: true,
      purpose: "okp-bench",
      resident: null,
      declared_context: cloud.context,
      max_context: cloud.context,
      retired_reason: null,
    };
    return await finishValidate(
      { model, arm, org, context, kind, entry: cloudEntry, cloud, compactRequested, requireTodos, recordAtChunkEnd, graderWorkerTarget },
      { requireConfirm, runsRoot, payload },
    );
  }

  const entry = roster.models.find((m) => m.id === model);
  if (!entry) {
    return refuse(
      "unknown_model",
      `'${model}' is not served by the proxy roster at ${args.proxyUrl}`,
    );
  }
  if (!entry.bench_eligible) {
    // TWO DIFFERENT INELIGIBILITIES, NAMED SEPARATELY. A retired alias carries
    // the proxy's bench purpose and is refused anyway; saying "interactive slot"
    // about it would be false and would send the operator looking at the proxy's
    // labels for a cause that is not there.
    if (entry.retired_reason) {
      return refuse("model_retired", `'${model}' — ${entry.retired_reason}`);
    }
    return refuse(
      "model_not_eligible",
      `'${model}' is an interactive slot (purpose=${entry.purpose ?? "unknown"}), not a bench ` +
        "alias. Running a benchmark on it contends with live daily-driver use and " +
        "produces a measurement that cannot be defended.",
    );
  }

  return await finishValidate(
    { model, arm, org, context, kind, entry, cloud: null, compactRequested, requireTodos },
    { requireConfirm, runsRoot, payload },
  );
}

/**
 * EVERY RULE THAT IS BLIND TO THE SUBSTRATE — which is every rule except
 * identity.
 *
 * Split out when cloud baselines landed, and split rather than branched for one
 * reason: the baseline gate. A cloud cell is a benchmark cell, so an ON cloud
 * cell needs a scorable floor exactly as an ON local cell does, and a second
 * copy of that check written for the cloud path is a second place for it to be
 * forgotten, weakened, or accidentally made conditional. There is one copy and
 * both substrates fall through it.
 *
 * `entry` is the roster row for a local model and a SYNTHESISED row of the same
 * shape for a cloud one, so the context ceiling below reads one field name
 * rather than asking which substrate it is looking at.
 */
/**
 * WHERE COMPACTION DEFAULTS ON, and the only place that rule is written.
 *
 * Below `COMPACT_DEFAULT_CEILING` the six-chunk build crowds the repair phase
 * out of its own context, so compaction starts ON. At or above it there is room
 * to spare and the build narration is worth keeping, so it starts OFF.
 *
 * Substrate-blind: a 200k cloud model has the same problem a 262k local one
 * does. `declared_context` is the model's own window; `max_context` is the
 * runtime ceiling observed for it. The SMALLER of the two is what the cell
 * actually gets, so that is what the rule reads.
 *
 * AN UNKNOWN WINDOW DEFAULTS ON. A model whose context nobody could determine
 * is more likely narrow than roomy, and the cost of compacting a model that did
 * not need it is six turns — against a build that runs out of room and a repair
 * phase that cannot see its own history.
 */
function compactDefaultFor(entry) {
  const declared = Number(entry?.declared_context);
  const max = Number(entry?.max_context);
  const known = [declared, max].filter((n) => Number.isFinite(n) && n > 0);
  if (!known.length) return true;
  return Math.min(...known) < COMPACT_DEFAULT_CEILING;
}

async function finishValidate(
  { model, arm, org, context, kind, entry, cloud, compactRequested = null, requireTodos = false, recordAtChunkEnd = false, graderWorkerTarget = null },
  { requireConfirm, runsRoot, payload },
) {
  // ON cells write memories into an org, so a cell needs an org id; OFF cells
  // must not carry one. This mirrors the harness's own argparse contract rather
  // than inventing a new rule.
  if (arm === "on" && !org) {
    return refuse("org_required", "an ON (memory) cell requires --org; it needs an org id to write into");
  }
  if (arm === "off" && org) {
    return refuse("org_forbidden", "a CONTROL cell must not carry an org — it writes no memories");
  }

  if (context !== null) {
    if (!CONTEXT_CHOICES.includes(context)) {
      return refuse(
        "context_unavailable",
        `context ${context} is not one of the offered lengths (${CONTEXT_CHOICES.join(", ")})`,
      );
    }
    if (Number.isFinite(entry.max_context) && context > entry.max_context) {
      return refuse(
        "context_unavailable",
        `context ${context} exceeds the runtime ceiling for ${model} (${entry.max_context})`,
      );
    }
  }

  // ── THE BASELINE GATE ──────────────────────────────────────────────────
  //
  // An ON cell measures memory lift as a Δ against that model's OFF floor. With
  // no valid floor there is nothing to subtract from, so the cell burns ~3h to
  // produce a number that cannot be interpreted — and the failure is silent,
  // because the cell itself succeeds. Refusing here turns hours into a sentence.
  //
  // THIS IS ALSO THE SAME-MODEL RULE, and since the profile store was removed
  // (2026-09-07) it is the ONLY place that rule is written. The floor it demands
  // is `baselineFor(model, ...)` — THIS cell's own model — so an ON cell can
  // only ever be measured against a floor the same model produced. The old
  // `model_not_subject` refusal restated that against a frozen profile subject;
  // it enforced nothing this line does not, and it locked [+ baseline] on every
  // other bench model as a side effect.
  //
  // OFF cells are exempt BY DEFINITION: an OFF cell IS the baseline, and gating
  // it on a baseline would make the first one impossible to run.
  //
  // VOID IS NOT A FLOOR. A void-instrument OFF cell produced numbers, which is
  // precisely why it must be rejected explicitly — nothing downstream can tell
  // an instrument artifact from a real measurement.
  // `runsRoot` is passed by the caller rather than read from module scope so
  // this function stays testable against a fixture directory. When it is absent
  // the gate CANNOT be evaluated, and an unevaluable safety gate must fail
  // closed — silently skipping it would let the exact cell it guards against
  // through.
  if (arm === "on") {
    if (!runsRoot) {
      return refuse(
        "baseline_required",
        "the baseline gate could not be evaluated (no runs root supplied), and an ON cell must " +
          "never launch on an unverified floor",
      );
    }
    const offCells = await collectOffCells(runsRoot);
    const baseline = baselineFor(model, offCells);
    if (!baseline.scorable) {
      return refuse("baseline_required", baseline.reason, { model, subject_model: model });
    }
  }

  // THE COMPACTION DECISION, RESOLVED IN ONE PLACE. The operator's explicit
  // choice wins; absent one, the model's own window decides. `entry` is the
  // roster row on either substrate (a synthesised one for cloud), so this reads
  // a single field name rather than asking which substrate it is looking at.
  const compact = compactRequested ?? compactDefaultFor(entry);

  // THE ARMED SNAPSHOT, RESOLVED BESIDE THE OTHER RUN PARAMETERS. Server-side
  // control-plane state, never a client payload field: a seed carried in the
  // start payload would mean this process trusts the browser's claim about what
  // the run is, which is the defect the confirmation-token design already
  // refuses. Read once here and RETURNED, so the preview mints its token over
  // the same value the start hands the harness — the two call sites must never
  // disagree.
  //
  // ── FOUR CONDITIONS, EACH REFUSED FOR ITS OWN REASON ──────────────────────
  // A snapshot armed while dev mode was on and left armed after it was turned
  // off must NOT seed: dev mode is the gate, and a mode that stops gating when
  // you look away is not a gate. It is ignored rather than refused, because the
  // operator did not ask for a seeded run this time — they asked for a normal
  // one, and that is exactly what they get.
  //
  // Absent / unreadable / model-mismatched DO refuse (§3.4, §6). Corpus drift
  // does NOT — D-SNAP-DEVMODE-EXCEPTIONS. The harness re-checks every one of
  // these itself; this is the early, quotable half so the operator is refused
  // before a container is spawned rather than after.
  let snapshotId = null;
  const devMode = await resolveDevMode({ benchRoot: BENCH_ROOT });
  if (devMode.enabled) {
    const armed = await resolveArmed({ benchRoot: BENCH_ROOT });
    if (armed.snapshot_id) {
      const row = await readSnapshot(RUNS_ROOT, armed.snapshot_id);
      const check = seedableBy(row, model);
      if (!check.ok) return refuse("snapshot_not_seedable", check.reason, { snapshot_id: armed.snapshot_id, model });
      snapshotId = armed.snapshot_id;
    }
  }

  const expected = confirmationToken({ model, arm, org, context, kind, compact, snapshotId });
  if (requireConfirm && payload?.confirm !== expected) {
    return refuse(
      "bad_confirmation",
      "the confirmation did not match these parameters — they changed after the " +
        "preview was shown. Review the restatement and confirm again.",
      {
        expected_token: expected,
        restatement: restatement({ model, arm, org, context, kind, cloud, compact }),
      },
    );
  }

  return { ok: true, model, arm, org, context, kind, entry, cloud, compact, requireTodos, recordAtChunkEnd, graderWorkerTarget, snapshotId };
}

/**
 * Stop the running benchmark, if any.
 *
 * Sends SIGINT — NOT SIGTERM — to the harness's process group. The harness
 * (run_cumulative.py) treats SIGINT as a KeyboardInterrupt, which runs its
 * unconditional teardown: the DockerCell context-manager removes the cell, the
 * egress sidecar and the session-db volume, and the process reaper sweeps any
 * remainder. SIGTERM, by contrast, terminates the process WITHOUT that teardown
 * and leaks containers/volumes (the exact residue a later run trips on).
 *
 * Belt-and-suspenders: after the interrupt, a broad docker sweep removes any
 * bench cell / egress sidecar / session-db volume the reaper missed, so a reset
 * always lands on a clean slate even when the run was wedged.
 */
// ── WATCHING A SERVICE THAT ANNOUNCES NOTHING ───────────────────────────────
//
// THE PROBLEM. A contributor's service — the relay's loop-guard counter is the
// founding case — serves monotonic counters over HTTP and knows nothing about
// cells or runs. It pushes no events and never will. So when its count moves,
// there is no record of it anywhere, and a loop-guard fire that ultimately
// VOIDS a whole cell leaves the feed completely silent.
//
// THE ATTRIBUTION IS THE WHOLE POINT. This notice is written by the control
// plane, under `control`, and says what the control plane OBSERVED. It is not
// attributed to the relay, because the relay said nothing — synthesising a row
// in another process's voice about an event that process never reported is
// fabrication however accurate the number is. `detail.stat` names what was
// watched, so a reader can see both who spoke and what about.
//
// WHY HERE AND NOT ON A TIMER. This route already polls every custom source,
// throttled by the board. A dedicated poller would be a SECOND reader of a
// service the bench does not ship, and `events.mjs` states the reason that is
// unwelcome: one predictable consumer, never N. The side effect on a GET is a
// record of what that GET saw, which is self-describing rather than surprising.
//
// A FIRST SIGHTING IS NOT A MOVE. The first reading of a run establishes what
// the counter says; only a CHANGE is an event. Without this every board poll
// after a restart would announce a fire that never happened.
//
// MEMORY IS PER RUN and reset when the run changes, so one campaign's readings
// can never be compared against the next run's, and the map cannot grow across
// runs.
let counterWatch = { logPath: null, seen: new Map() };

async function watchExternalCounters(logPath, stats) {
  if (!logPath) return stats;
  if (counterWatch.logPath !== logPath) counterWatch = { logPath, seen: new Map() };

  for (const stat of stats.custom ?? []) {
    // Only real readings. `unavailable` is not a value and must never be
    // differenced against one — that is how a restarted source reads as a
    // clean run.
    if (stat.state !== "ok" || typeof stat.value !== "number") continue;
    const previous = counterWatch.seen.get(stat.id);
    counterWatch.seen.set(stat.id, stat.value);
    if (previous === undefined || previous === stat.value) continue;
    await notice(logPath, "external_counter_moved", {
      level: "warn",
      detail: { stat: stat.id, label: stat.label, from: previous, to: stat.value },
    });
  }
  return stats;
}

async function stopRun() {
  // ── WHOSE HARNESS IS IT ─────────────────────────────────────────────────
  //
  // `launcher` is the handle for a run THIS PROCESS spawned, and it is
  // in-memory only. Two ordinary situations leave it null over a live cell:
  //
  //   · the operator launched from the CLI — the documented path in
  //     USER-BENCHMARKING-GUIDE, on which the control plane never held a pid;
  //   · the control plane was restarted mid-run — the harness is `detached`
  //     with its stdio on a file, so it survives us, but its handle does not.
  //
  // The old code skipped the interrupt entirely in both cases and fell through
  // to the docker sweep below. That is strictly worse than the SIGTERM this
  // function's own doc-comment refuses to send: it tears the cell, the egress
  // sidecar and the session-db volume out from under a harness that is still
  // running, so the teardown the SIGINT exists to trigger never happens AND
  // the process is left alive writing into a bench that no longer has one.
  // A stop must find the harness by asking the kernel, not by remembering it.
  // The SAME read answers both questions: which tree this stop is about, and
  // which log the run's notices hang off. Reading it twice would be two answers
  // to "which run is this".
  const stopState = await readRunState({ runsRoot: RUNS_ROOT, launcher });
  const runDir = stopState.run_dir;
  const logPath = stopState.log_path;
  const targets = [];
  if (launcher && pidAlive(launcher.pid)) {
    targets.push({ pid: launcher.pid, pgid: launcher.pid, own: true });
  } else {
    const procs = await findHarnessProcs({ runDir });
    // `null` is a FAILED SCAN, not an empty machine. Signalling nothing and
    // sweeping docker anyway is the failure described above, so a stop that
    // cannot see the process list does not get to claim the process is gone —
    // it just has nothing to signal, and says as much in the log.
    if (procs === null) {
      // A FAILED SCAN IS NOT AN EMPTY MACHINE, and this is the one place that
      // distinction was stated to nobody but a terminal nobody reads.
      console.error("[stop] ps scan failed; no harness could be interrupted");
      await notice(logPath, "stop_scan_failed", {
        level: "error",
        detail: { run_dir: runDir ?? null, signalled: 0 },
      });
    } else {
      for (const p of procs.bound.length ? procs.bound : procs.other) {
        targets.push({ pid: p.pid, pgid: p.pgid, own: false });
      }
    }
  }

  for (const t of targets) {
    // THE GROUP ONLY WHEN THE HARNESS LEADS IT. A detached spawn is its own
    // group leader, so `kill(-pgid)` reaches the harness and the Python
    // children it fanned out. A CLI-launched harness sits in the operator's
    // SHELL group, and interrupting that group would interrupt their terminal
    // and every sibling in it. When we do not own the group, signal the one
    // process; the harness installs the KeyboardInterrupt handler itself, so
    // its own teardown still runs.
    const groupIsOurs = t.own || (Number.isInteger(t.pgid) && t.pgid === t.pid);
    try {
      process.kill(groupIsOurs ? -t.pgid : t.pid, "SIGINT");
    } catch {
      try {
        process.kill(t.pid, "SIGINT");
      } catch {
        /* already gone */
      }
    }
  }

  // Wait for every target to actually exit before sweeping docker — the sweep
  // is only safe once the teardown it backstops has had its chance to run.
  for (let i = 0; i < 40 && targets.some((t) => pidAlive(t.pid)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // WHAT THE STOP ACTUALLY DID, recorded before the handle is dropped. A stop
  // that signalled nothing and a stop that signalled three processes are
  // different events, and a stop whose targets are STILL ALIVE after twenty
  // seconds is a third — the docker sweep below then runs against a harness
  // that never died, which is the case most worth being able to look up
  // afterwards. A bare "stop requested" would have said none of it.
  const survivors = targets.filter((t) => pidAlive(t.pid)).length;
  await notice(logPath, "stop_signalled", {
    level: survivors > 0 ? "error" : "info",
    detail: {
      signalled: targets.length,
      own_launcher: targets.some((t) => t.own),
      still_alive: survivors,
    },
  });

  launcher = null;

  // ── THE MIRROR DIES WITH THE CELL ────────────────────────────────────────
  //
  // The TUI mirror is an `opencode attach` client the CONTROL PLANE spawns, so
  // nothing in the harness's own teardown owns it. Left alone it survives the
  // stop: the serve it attached to is gone, but the client keeps its pty, keeps
  // repainting its last screen, and keeps animating opencode's own spinner.
  //
  // `/api/tui` then reports `running: true, status: "live"` — because `running`
  // is `Boolean(this.child)`, a fact about the MIRROR, not about the session —
  // and the board draws a live terminal with a moving progress bar over a cell
  // that was stopped minutes ago. That is the board asserting motion in a
  // stopped cell, which is the one thing this surface must never do.
  //
  // Killed here rather than left for the poller to notice, because there is no
  // poller: the mirror only re-evaluates when read, and a closed drawer never
  // reads it.
  try {
    tui.shutdown();
  } catch (err) {
    // Never let mirror teardown block the cell teardown below — but a mirror
    // that refused to die leaves a phantom `opencode attach` child and a board
    // still drawing `live` over a stopped cell, so the failure is stated.
    console.error(`[stop] tui mirror teardown failed (stop proceeds): ${err?.message ?? err}`);
  }

  const run = (args) =>
    new Promise((resolve) => {
      execFile("docker", args, { timeout: 30000 }, (_err, stdout) => resolve(stdout ?? ""));
    });
  const cells = await run(["ps", "-aq", "--filter", "name=bench-cell-"]);
  // Must track harness/egress.py:egress_container_name. A stale prefix here does
  // not fail loudly — it silently leaves the sidecar running after a stop, and
  // the next cell then contends with a live egress container from the last one.
  const sidecars = await run(["ps", "-aq", "--filter", "name=okp-egress-"]);
  const ids = [cells, sidecars]
    .map((out) => String(out).trim())
    .flatMap((s) => (s ? s.split(/\s+/) : []))
    .filter(Boolean);
  if (ids.length) await run(["rm", "-f", ...ids]);
  const vols = await run(["volume", "ls", "-q", "--filter", "name=bench-cell-"]);
  const volIds = String(vols)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (volIds.length) await run(["volume", "rm", "-f", ...volIds]);
}

/**
 * MAY THE TREE BE RESET RIGHT NOW, and what exactly would that retire?
 *
 * ── THE ONE HARD REFUSAL: A CELL IN FLIGHT ──────────────────────────────────
 *
 * Rolling the tree forward mid-run would leave the running harness writing into
 * a tree no reader resolves into any more. The cell would keep burning hours,
 * the board would show an empty bench, and the measurement would be findable
 * only by someone who knew the old timestamp. That is a silent loss of exactly
 * the kind this tree exists to prevent, so it is refused rather than warned
 * about — the operator can reset the moment the cell lands.
 */
async function treeResetGate() {
  const run = await readRunState({ runsRoot: RUNS_ROOT, launcher });
  // A run in flight no longer hard-refuses a reset: the reset now STOPS it
  // first (see stopRun) so its partial data lands in the backup rather than
  // being moved out from under a live process. The operator is told, verbatim,
  // that a stop will happen before they confirm.
  const willStop = run.can_start !== true;

  const { moves, keeps } = await planReset(RUNS_ROOT);

  // THE TOKEN BINDS TO WHAT WILL ACTUALLY MOVE. If a run lands between the
  // confirmation appearing and the operator pressing continue, the list changes,
  // the token changes, and they are re-shown the new list instead of silently
  // backing up a measurement they never saw named.
  const token = ["reset-all", `items=${moves.length}`, `sig=${moves.join(",")}`].join("|");

  // PLAIN WORDS. This is the sentence an operator agrees to, and it is the one
  // place where precise-but-opaque costs the most.
  const restatement = [
    "Reset ALL benchmark data.",
    willStop
      ? `A benchmark run is still in progress (${run.state}) — resetting will STOP it first.`
      : null,
    moves.length
      ? `${moves.length} item${moves.length === 1 ? "" : "s"} will be moved to a backup folder: ${moves.join(", ")}`
      : "there is nothing to back up — the bench is already empty",
    "That clears results, baselines and run logs. The board goes back to zero.",
    "NOTHING IS DELETED. Everything moves into runs/backups/ and can be moved back.",
    // KEPT ITEMS ARE COUNTED, NOT LISTED. There are two dozen pytest and
    // redeploy logs down there, and printing them buried the one line that
    // decides whether this is safe to press. The live process files are named
    // because they are the ones an operator would worry about.
    keeps.length
      ? `Left alone: ${keeps.length} tooling/live file${keeps.length === 1 ? "" : "s"}` +
        (keeps.some((k) => k.startsWith("mcp4550.")) ? " (including the running bench MCP)" : "")
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return { ok: true, token, restatement, moves, keeps };
}

/**
 * MAY THIS BACKUP BE RESTORED RIGHT NOW, and what exactly would that do?
 *
 * Three refusals, in the order an operator would hit them: a run in flight, an
 * id that names nothing, and a backup that fails the conformance check. The
 * third is the one worth having — a malformed backup restores QUIETLY WRONG
 * rather than loudly, so it is caught before anything moves.
 */
async function restoreGate(id) {
  const run = await readRunState({ runsRoot: RUNS_ROOT, launcher });
  if (run.can_start !== true) {
    return refuse(
      "run_in_progress",
      `a benchmark run is still going — restoring now would move its results out from under it. ` +
        `Wait for it to finish, then restore. (${run.blocked_reason ?? "a run is in progress"})`,
    );
  }

  const dir = resolveBackupDir(RUNS_ROOT, id);
  if (!dir) return refuse("bad_backup_id", `${JSON.stringify(String(id ?? ""))} is not a backup id`);

  const summary = await describeBackup(RUNS_ROOT, id);
  if (!summary) return refuse("no_such_backup", `there is no backup ${JSON.stringify(String(id))}`);

  const check = await checkBackup(dir);
  if (!check.ok) {
    return refuse(
      "backup_failed_check",
      `this backup did not pass the check, so it was not restored: ${check.errors.join("; ")}`,
      { errors: check.errors, warnings: check.warnings },
    );
  }

  const { moves } = await planReset(RUNS_ROOT);

  // The token binds to the backup AND to what is about to be parked, so a cell
  // landing between preview and confirm re-shows the operator the new picture.
  const token = ["restore", `id=${summary.id}`, `items=${summary.counts.items}`, `park=${moves.length}`].join("|");

  const when = new Date(Number(summary.id) * 1000).toISOString().replace("T", " ").replace(/\..*/, " UTC");
  const restatement = [
    `Restore the benchmark data from ${when}.`,
    `${summary.counts.items} item(s) come back: ${summary.items.join(", ")}`,
    moves.length
      ? `The ${moves.length} item(s) on the bench right now are saved as a new backup first — nothing is overwritten.`
      : "The bench is empty right now, so nothing needs saving first.",
    check.warnings.length ? `Note: ${check.warnings.join("; ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return { ok: true, token, restatement, backup: summary, will_park: moves };
}

// ── routes ───────────────────────────────────────────────────────────────────

/**
 * Interleave the prompts into an agent transcript WITHOUT re-ordering it.
 *
 * ── WHY NOT JUST SORT BOTH BY `at` ─────────────────────────────────────────
 *
 * Because 201 of a 4,457-row transcript carry NO `at` at all — `file.edited`,
 * `session.idle`, `session.error`, `session.compacted` arrive without one. A
 * plain time sort reads those as timestamp 0 and files every one of them at the
 * TOP of the feed: a run whose first hundred and forty-five events are file
 * edits that actually happened throughout, and whose errors all appear before
 * the work that caused them.
 *
 * `agent-events.jsonl` is APPEND-ONLY IN ARRIVAL ORDER, which is the true order
 * and the one the live feed showed. So the transcript is left exactly as it lies
 * and the prompts are dropped into it — each one placed before the first agent
 * row that is stamped later than it. Untimed rows never move.
 */
function interleaveByArrival(agentRows, promptRows) {
  const prompts = [...(promptRows ?? [])].sort((a, b) => (Number(a?.at) || 0) - (Number(b?.at) || 0));
  const out = [];
  let pi = 0;
  for (const r of agentRows ?? []) {
    const at = Number(r?.at) || 0;
    // Only a STAMPED agent row can position a prompt; an untimed one says
    // nothing about when the prompt was sent and must not consume it.
    while (at > 0 && pi < prompts.length && (Number(prompts[pi]?.at) || 0) <= at) {
      out.push(prompts[pi]);
      pi += 1;
    }
    out.push(r);
  }
  // Anything later than every agent row lands at the end, in its own order.
  while (pi < prompts.length) { out.push(prompts[pi]); pi += 1; }
  return out;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  // CORS for the dashboard origin only. The board runs on :7717 and this
  // service on :7718, so a browser treats them as cross-origin.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  try {
    // ── GET /api/capabilities ────────────────────────────────────────────
    // What this service can actually DO. The board asks before rendering a
    // control, so it never shows a button for an absent capability.
    if (path === "/api/capabilities" && req.method === "GET") {
      sendJson(res, 200, {
        contract_version: CONTROL_CONTRACT_VERSION,
        start_run: true,
        // Permanently false — the harness has no mid-cell checkpoint.
        resume_run: false,
        resume: RESUME_UNSUPPORTED,
        events: true,
        select_context: true,
        // The GATE WALL surface. Advertised so the board can tell "this control
        // plane predates /api/wall" from "the wall has nothing to show".
        wall: true,
        wall_contract_version: WALL_CONTRACT_VERSION,
        // The verbatim graded text the model was handed as user turns.
        feedback: true,
        feedback_contract_version: FEEDBACK_CONTRACT_VERSION,
        // CLOUD BASELINES. Advertised as a capability of this SERVICE, which is
        // a different question from whether a cloud cell can start right now —
        // that needs a key, and the answer lives in /api/cloud beside the
        // catalogue it applies to. A board that read one for the other would
        // either hide a working feature or offer an unauthenticated launch.
        cloud_baselines: true,
        // ── DEV MODE, FOLDED IN SO THE BOARD LEARNS IT ON EVERY POLL ──────
        //
        // The topbar has to mark dev mode whether or not the settings drawer
        // was ever opened, and capabilities is the call the board already makes
        // first on every poll. Its failure is also the board's "control plane
        // unreachable" signal, which is what makes the marker TRI-STATE for
        // free: on, off, or unknown — never a silent off for a service that
        // simply did not answer.
        //
        // Resolved by the SAME function /api/devmode serves, so the two can
        // never disagree.
        dev_mode: await resolveDevMode({ benchRoot: BENCH_ROOT }),
        stall_threshold_s: STALL_THRESHOLD_S,
        bench_root: BENCH_ROOT,
        python_present: existsSync(PYTHON),
        run_script_present: existsSync(RUN_SCRIPT),
      });
      return;
    }

    // ── GET /api/cloud ───────────────────────────────────────────────────
    //
    // The cloud catalogue, the router, the spend ceiling, and WHETHER A KEY
    // RESOLVES — never the key. What comes back about the credential is
    // `{present, source, fingerprint}`: enough to tell an operator that a cloud
    // launch will authenticate and where the key came from, and worth nothing
    // to anyone who reads it off the wire.
    //
    // This route stays GET-only. Setting a credential lives on /api/routers/key
    // below — see the note there for why that route now exists, and what it does
    // about the risks this comment used to cite as reasons not to have one.
    if (path === "/api/cloud" && req.method === "GET") {
      sendJson(res, 200, await readCloud({ benchRoot: BENCH_ROOT }));
      return;
    }

    // ── GET /api/routers ─────────────────────────────────────────────────
    //
    // Every supported router and whether its key resolves — never the key.
    // OrcaRouter is the first and the pinned default; the registry is a row per
    // router so adding one is data, not a dispatcher branch.
    if (path === "/api/routers" && req.method === "GET") {
      sendJson(res, 200, await readRouters({ benchRoot: BENCH_ROOT }));
      return;
    }

    // ── POST /api/routers/key ────────────────────────────────────────────
    //
    // SET A ROUTER CREDENTIAL FROM THE BOARD.
    //
    // An earlier decision recorded here was that no such route should exist,
    // because it "would put a live credential in a browser, in a request body,
    // and in the browser's autofill store". Those risks are real, and they are
    // answered rather than dismissed:
    //
    //   browser        unavoidable if a human types a key into a page, and the
    //                  alternative measured in practice was worse: the board
    //                  rendered a dead button with no reason, and the operator
    //                  had to leave for a terminal to discover why. An operator
    //                  driven to a shell for one capability ends up driving
    //                  everything from there, which is how the board stopped
    //                  being the interface.
    //   request body   POST only, never a query string, so it cannot reach a
    //                  server log, a proxy log, or shell history. The service
    //                  binds 127.0.0.1 with no --host flag: the value does not
    //                  cross a network hop.
    //   autofill       the field is type=password with autocomplete="off" and is
    //                  never populated from the server, so there is nothing for
    //                  the browser to remember or re-offer.
    //
    // And the value is one-way: it goes in, it is written 0600 to a gitignored
    // file, and what comes back is a fingerprint. No route ever returns a key.
    if (path === "/api/routers/key" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const out = await writeRouterKey({
        benchRoot: BENCH_ROOT,
        routerId: body?.router,
        key: body?.key,
      });
      sendJson(res, out.ok ? 200 : 400, out);
      return;
    }

    // ── GET /api/snapshots ───────────────────────────────────────────────
    //
    // Every captured snapshot, with the armed selection alongside it so the
    // board never has to make two requests to draw one picker and never has to
    // decide which of two answers is current.
    //
    // `?model=` applies the same-model rule (§6) per row rather than filtering
    // the list: a snapshot an operator captured and cannot find teaches them
    // nothing by its absence, so the ineligible ones are listed and REFUSED,
    // each in its own words. Filtering is the board's choice to make, not this
    // endpoint's to impose.
    if (path === "/api/snapshots" && req.method === "GET") {
      const model = url.searchParams.get("model");
      const list = await listSnapshots(RUNS_ROOT);
      const dev = await resolveDevMode({ benchRoot: BENCH_ROOT });
      const armed = await resolveArmed({ benchRoot: BENCH_ROOT });
      const snapshots = list.snapshots.map((row) => {
        const s = model ? seedableBy(row, model) : { ok: row.eligible, reason: row.reason };
        return { ...row, seedable: s.ok, seedable_reason: s.reason, armed: armed.snapshot_id === row.id };
      });
      sendJson(res, 200, { ...list, model: model ?? null, snapshots, armed, dev_mode: dev });
      return;
    }

    // ── POST /api/snapshots/arm ──────────────────────────────────────────
    //
    // GATED ON DEV MODE, HERE. The board hides the picker when dev mode is off,
    // but a hidden control is not a closed door — a stale tab or a curl can
    // still post. The mode is read from this process, never from the payload,
    // for exactly the reason the confirmation-token design already states: the
    // server must not trust the browser's claim about what mode it is in.
    if (path === "/api/snapshots/arm" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const dev = await resolveDevMode({ benchRoot: BENCH_ROOT });
      if (!dev.enabled) {
        sendJson(res, 409, {
          ok: false,
          code: "dev_mode_off",
          reason:
            "seeding a run from a captured build is a development capability and dev mode is off. "
            + "Turn it on in SETTINGS first — a seeded cell is never a scorable floor.",
        });
        return;
      }
      const id = body?.snapshot_id ?? null;
      // DISARM IS ALWAYS ALLOWED and needs no snapshot to exist. Refusing to
      // disarm because the armed id has since been deleted would leave the
      // operator armed to something unreachable with no way to clear it.
      if (id !== null) {
        const row = await readSnapshot(RUNS_ROOT, String(id));
        const check = seedableBy(row, body?.model ?? row?.author_model ?? null);
        if (!check.ok) {
          sendJson(res, 409, { ok: false, code: "not_seedable", reason: check.reason });
          return;
        }
      }
      const out = await writeArmed({ benchRoot: BENCH_ROOT, snapshotId: id === null ? null : String(id) });
      sendJson(res, out.ok ? 200 : 409, out);
      return;
    }

    // ── GET /api/devmode ─────────────────────────────────────────────────
    //
    // The control plane's own mode. Also folded into /api/capabilities so the
    // board carries it on every poll without a second request — BOTH call
    // `resolveDevMode`, so there is one producer and two exposures rather than
    // two answers that can disagree.
    if (path === "/api/devmode" && req.method === "GET") {
      sendJson(res, 200, await readDevMode({ benchRoot: BENCH_ROOT }));
      return;
    }

    // ── POST /api/devmode ────────────────────────────────────────────────
    //
    // REFUSES when the environment pins the mode. Writing the file anyway would
    // return a success the next read contradicts, and the operator would have to
    // discover it by watching the toggle snap back.
    if (path === "/api/devmode" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const out = await writeDevMode({ benchRoot: BENCH_ROOT, enabled: body?.enabled });
      sendJson(res, out.ok ? 200 : 400, out);
      return;
    }

    // ── GET /api/roster ──────────────────────────────────────────────────
    if (path === "/api/roster" && req.method === "GET") {
      sendJson(res, 200, await readRoster({
        proxyUrl: args.proxyUrl,
        runtimeUrl: args.runtimeUrl,
      }));
      return;
    }

    // ── GET /api/run ─────────────────────────────────────────────────────
    if (path === "/api/run" && req.method === "GET") {
      sendJson(res, 200, await readRunState({ runsRoot: RUNS_ROOT, launcher }));
      return;
    }

    // ── GET /api/tui ─────────────────────────────────────────────────────
    // A frame of the operator's attached view, reconstructed from a read-only
    // pty capture. This route is the keepalive: the capture starts on the first
    // poll and stops itself when polling stops, so a closed drawer does not
    // leave a client attached to a live benchmark session.
    //
    // The session is resolved from run state rather than taken from the query
    // string — a caller-supplied session id would let the board attach a client
    // to an arbitrary session, and the mirror should only ever show the cell
    // that is actually running.
    if (path === "/api/tui" && req.method === "GET") {
      const run = await readRunState({ runsRoot: RUNS_ROOT, launcher });
      sendJson(res, 200, {
        ...tui.poll(run.session_id),
        // Stated on the surface: this is a second client, not a screen-share.
        note: "second attach client — same session, independent scroll position",
      });
      return;
    }

    if (path === "/api/tui/detach" && req.method === "POST") {
      tui.shutdown();
      sendJson(res, 200, { ok: true, reason: "tui mirror detached and closed" });
      return;
    }

    // ── GET /api/hold ────────────────────────────────────────────────────
    // null means no hold file exists. If the file vanishes while being read,
    // that is the release success path, not an error.
    if (path === "/api/hold" && req.method === "GET") {
      sendJson(res, 200, await readHold({ runsRoot: RUNS_ROOT }));
      return;
    }

    // ── POST /api/hold/release ───────────────────────────────────────────
    // Release means create release.path from hold-ui.json. It is idempotent;
    // posting when nothing is held is harmless and returns ok.
    if (path === "/api/hold/release" && req.method === "POST") {
      const result = await releaseHold({ runsRoot: RUNS_ROOT });
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    // ── GET /api/tree ────────────────────────────────────────────────────
    //
    // Which benchmark tree is live, when it was minted, what is in it, and what
    // it retired. The board's RESET control reads this to state — before the
    // operator commits — exactly what is about to become inert.
    if (path === "/api/tree" && req.method === "GET") {
      let pointer = null;
      let pointerError = null;
      try {
        pointer = await readTreePointer(RUNS_ROOT);
      } catch (err) {
        pointerError = String(err?.message ?? err);
      }
      const campaigns = await listCampaignDirs(RUNS_ROOT);
      const active = pointer?.active ?? null;
      // Reported SEPARATELY rather than summed: "what a reset retires" and
      // "what is on disk" are different numbers, and a single count would let
      // an operator read legacy campaigns as part of the live tree.
      const inTree = active ? campaigns.filter((c) => campaignTreeId(c.relative) === active) : [];
      sendJson(res, 200, {
        ok: true,
        active,
        created_at: pointer?.created_at ?? null,
        history: pointer?.history ?? [],
        pointer_error: pointerError,
        live_campaigns: inTree.map((c) => c.relative),
        total_campaigns_on_disk: campaigns.length,
      });
      return;
    }

    // ── POST /api/tree/reset/preview ─────────────────────────────────────
    //
    // The restatement the UI must show before RESET fires, composed SERVER-SIDE
    // for the same reason run preview is: the words the operator reads have to
    // be the words the server will act on.
    //
    // PREVIEW RUNS THE SAME REFUSAL AS THE COMMIT. A preview that green-lights a
    // reset the commit would refuse moves the refusal to after the operator has
    // committed — the defect already fixed once on the run path.
    // ── GET /api/preflight ───────────────────────────────────────────────
    //
    // THE SAME ANSWER THE CLI GIVES, ON THE BOARD.
    //
    // "Why can't I start" was previously answerable only by running
    // scripts/bench_preflight.py in a terminal — so the board could show a dead
    // control and had nothing to say about it. This runs that same script and
    // returns its checks, rather than re-deriving the rules here: two
    // implementations of "can I start" is exactly how a dashboard ends up
    // disagreeing with the CLI about why a button is dead.
    //
    // The script imports a library that greets on stdout, so the JSON is taken
    // from the LAST line that parses — the payload is printed last and alone.
    if (path === "/api/preflight" && req.method === "GET") {
      const model = url.searchParams.get("model") || "";
      // Ask preflight to prove the worker image wires the restored
      // marker-detection compaction plugin (self-compact.ts) when this run
      // will actually use it. opencode SWALLOWS plugin load errors, so a
      // stale image is otherwise silent right up until every chunk boundary
      // aborts the cell on no_compaction_evidence.
      const compact = url.searchParams.get("compact") === "1";
      const argv = [join(BENCH_ROOT, "scripts", "bench_preflight.py"), "--json"];
      if (model) argv.push("--model", model);
      if (compact) argv.push("--compact");
      const cloudProvider = url.searchParams.get("provider");
      if (cloudProvider) argv.push("--cloud", "--provider", cloudProvider);

      const out = await new Promise((done) => {
        execFile(PYTHON, argv, { cwd: BENCH_ROOT, timeout: 120000 }, (err, stdout, stderr) =>
          done({ err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
        );
      });

      let parsed = null;
      for (const line of out.stdout.split("\n").map((l) => l.trim()).reverse()) {
        if (!line.startsWith("{")) continue;
        try { parsed = JSON.parse(line); break; } catch { /* keep looking */ }
      }
      if (!parsed) {
        sendJson(res, 502, refuse(
          "preflight_unreadable",
          "preflight produced no readable verdict — its own output is included so the " +
            "failing layer is visible rather than guessed at",
          { stdout_tail: out.stdout.slice(-1500), stderr_tail: out.stderr.slice(-1500) },
        ));
        return;
      }
      // ── RESOLVE EACH FAILURE'S REMEDY TO AN ACTUAL BUTTON ──────────────
      //
      // Preflight names the tool that repairs a failure by ID and stops there;
      // this side owns the registry that turns an id into a button. See
      // `attachRemedies` in tools.mjs for why the split is where it is.
      attachRemedies(parsed?.checks, describeTools(BENCH_ROOT));

      // Exit 1 is a NO-GO, not a transport failure: the verdict travels in the
      // body and the HTTP status stays 200 so the board renders the reasons.
      sendJson(res, 200, parsed);
      return;
    }

    // ── POST /api/run/stop/preview ───────────────────────────────────────
    //
    // ABORT A LIVE CELL FROM THE BOARD.
    //
    // Preview then confirm, the same shape as a tree reset, because this is a
    // decision with a cost: the cell's work is discarded and its wall-clock and
    // spend are already spent. The restatement names what is actually running so
    // an operator cannot stop the wrong thing from a stale page.
    //
    // WHAT AN ABORTED CELL IS. `stopRun` sends SIGINT rather than SIGTERM
    // precisely so the harness runs its own teardown — the DockerCell context
    // manager removes the cell, the egress sidecar and the session-db volume,
    // and the reaper sweeps the remainder. A killed run therefore leaves no
    // `progress` on its session record, and a record without `progress` is
    // EXCLUDED from the convergence trend by construction
    // (ConvergencePoint.from_session_record returns None). An abort can never be
    // mistaken for a measurement.
    if (path === "/api/run/stop/preview" && req.method === "POST") {
      const state = await readRunState({ runsRoot: RUNS_ROOT, launcher });
      if (!state?.running) {
        sendJson(res, 409, refuse("no_run_in_flight", "there is no cell in flight to stop"));
        return;
      }
      const token = createHash("sha256")
        .update(`stop:${state.pid ?? "external"}:${state.log_name ?? ""}:${state.started_at ?? ""}`)
        .digest("hex")
        .slice(0, 12);
      // THE PID LINE MUST NOT UNDERSELL THE STOP. `state.pid` is null whenever
      // this process did not spawn the harness — a CLI launch, or a control
      // plane that restarted under a live run. It used to read "started
      // outside this service", which an operator reasonably takes to mean the
      // button will not reach it. It does: stopRun scans for the harness and
      // interrupts it either way (see stopRun, "WHOSE HARNESS IS IT"). Name
      // the pid we would actually signal, so the sentence describes the stop
      // that is about to happen rather than the bookkeeping behind it.
      let pidLine = state.pid ? String(state.pid) : null;
      if (pidLine === null) {
        const found = await findHarnessProcs({ runDir: state.run_dir });
        const adopt = found && (found.bound.length ? found.bound : found.other);
        if (adopt && adopt.length) {
          pidLine = `${adopt.map((p) => p.pid).join(", ")} (found by scan — not spawned by this service)`;
        } else if (found === null) {
          pidLine = "unknown — the process scan failed; the stop may find nothing to interrupt";
        } else {
          pidLine = "no harness process found — the stop will only sweep leftover containers";
        }
      }
      sendJson(res, 200, {
        ok: true,
        token,
        restatement:
          `STOP the cell in flight.\n\n` +
          `  model    ${state.model ?? "unobserved"}\n` +
          `  log      ${state.log_name ?? "unknown"}\n` +
          `  pid      ${pidLine}\n` +
          `  started  ${state.started_at ?? "unknown"}\n\n` +
          `The harness is interrupted so it tears its own cell down: the worker\n` +
          `container, the egress sidecar and the session-db volume are removed.\n` +
          `Anything this cell had measured is DISCARDED — a stopped cell writes no\n` +
          `progress, so it is excluded from the convergence trend and can never be\n` +
          `read as a result. Time and spend already incurred are not recoverable.`,
        run: { model: state.model ?? null, pid: state.pid ?? null, log_name: state.log_name ?? null },
      });
      return;
    }

    // ── POST /api/run/stop ───────────────────────────────────────────────
    if (path === "/api/run/stop" && req.method === "POST") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const state = await readRunState({ runsRoot: RUNS_ROOT, launcher });
      if (!state?.running) {
        sendJson(res, 409, refuse("no_run_in_flight", "there is no cell in flight to stop"));
        return;
      }
      const token = createHash("sha256")
        .update(`stop:${state.pid ?? "external"}:${state.log_name ?? ""}:${state.started_at ?? ""}`)
        .digest("hex")
        .slice(0, 12);
      if (payload?.confirm !== token) {
        sendJson(
          res,
          400,
          refuse(
            "bad_confirmation",
            "the confirmation did not match the run in flight — it changed after the " +
              "preview was shown. Review the restatement and confirm again.",
            { expected_token: token },
          ),
        );
        return;
      }
      await stopRun();
      const after = await readRunState({ runsRoot: RUNS_ROOT, launcher });
      sendJson(res, 200, {
        ok: true,
        stopped: true,
        // Reported from a re-read rather than assumed. "We sent a signal" is not
        // the same claim as "nothing is running", and only the second is useful.
        still_running: after?.running === true,
        note: after?.running
          ? "the interrupt was sent but a process is still alive — check the run log"
          : "cell stopped and its containers torn down",
      });
      return;
    }

    if (path === "/api/tree/reset/preview" && req.method === "POST") {
      const check = await treeResetGate();
      if (check.ok === false) {
        sendJson(res, 409, check);
        return;
      }
      sendJson(res, 200, {
        ok: true,
        token: check.token,
        restatement: check.restatement,
        moves: check.moves,
        keeps: check.keeps,
      });
      return;
    }

    // ── POST /api/tree/reset ─────────────────────────────────────────────
    //
    // Back EVERYTHING up and start a brand new tree. Results, baselines and
    // run logs all move to runs/backups/<ts>/ — see tree.mjs for
    // why the sweep is an allow list and what it deliberately leaves running.
    if (path === "/api/tree/reset" && req.method === "POST") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const check = await treeResetGate();
      if (check.ok === false) {
        sendJson(res, 409, check);
        return;
      }
      if (payload?.confirm !== check.token) {
        sendJson(
          res,
          400,
          refuse(
            "bad_confirmation",
            "the confirmation did not match the tree on disk — it changed after the " +
              "preview was shown. Review the restatement and confirm again.",
            { expected_token: check.token, restatement: check.restatement },
          ),
        );
        return;
      }
      try {
        // Stop any in-flight run BEFORE retiring the tree, so the harness's
        // teardown writes its final artifacts into a tree that still resolves,
        // and the backup captures them instead of stranding them mid-write.
        await stopRun();
        const done = await resetAll(RUNS_ROOT);

        // ARCHIVE THE RESULTS LEDGER into the same backup, then start a fresh
        // one. The ledger is derived data — the tree is authoritative — so a
        // ledger problem must never block a reset: this whole block fails OPEN,
        // and a failed archive is reported in the response, not thrown.
        let ledger_note;
        try {
          const ledgerSrc = join(BENCH_ROOT, "data", "results-ledger.jsonl");
          await rename(ledgerSrc, join(done.backup, "results-ledger.jsonl"));
          await writeFile(ledgerSrc, "", "utf8"); // fresh empty ledger for the next campaign
          ledger_note = "archived into the backup and restarted";
        } catch (err) {
          if (err?.code !== "ENOENT") {
            console.error(`[reset] results-ledger archive failed (reset proceeds): ${err?.message ?? err}`);
          }
          ledger_note = err?.code === "ENOENT" ? "no ledger yet — nothing to archive" : "archive failed — reset proceeded";
        }

        sendJson(res, 200, {
          ok: true,
          active: done.active,
          backup: done.backup,
          backup_id: done.backup_id,
          moved: done.moved,
          kept: done.kept,
          ledger: ledger_note,
          note: `nothing was deleted — ${done.moved.length} item(s) moved to runs/backups/${done.backup_id}/`,
        });
      } catch (err) {
        sendJson(res, 500, refuse("reset_failed", String(err?.message ?? err)));
      }
      return;
    }

    // ── GET /api/tools ───────────────────────────────────────────────────
    //
    // The registry, with each tool's status RESOLVED against its preconditions.
    // A tool whose reference MCP is unbuilt or whose identity is missing comes
    // back "blocked" WITH the reason, so the drawer can state it instead of
    // rendering a control that would fail on click.
    if (path === "/api/tools" && req.method === "GET") {
      sendJson(res, 200, { ok: true, tools: describeTools(BENCH_ROOT) });
      return;
    }

    // ── POST /api/tools/run ──────────────────────────────────────────────
    //
    // Invoke one tool. Every failure path is loud: unknown id, unknown handler,
    // missing argument, failed precondition, non-zero exit. The tool's own words
    // are forwarded rather than rewritten, so the operator can see WHICH layer
    // refused — the CLI, the hub, or this service.
    //
    // NOT GATED ON A CONFIRMATION TOKEN, deliberately: this is a single explicit
    // click on a named tool, not a parameterised run that spends hours or money.
    // The click is the act.
    if (path === "/api/tools/run" && req.method === "POST") {
      const payload = JSON.parse((await readBody(req)) || "{}");

      // A TOOL THAT CHANGES THE SUBSTRATE IS REFUSED WHILE A CELL IS IN FLIGHT.
      // Re-commissioning the MCP or rebuilding the worker image underneath a
      // running cell changes what is being measured mid-measurement, and the
      // result would look valid. The refusal names the run and the remedy —
      // stopping a cell is a button on the same board.
      const sensitive = describeTools(BENCH_ROOT).find(
        (t) => t.id === payload?.id && t.refuse_while_running,
      );
      if (sensitive) {
        const state = await readRunState({ runsRoot: RUNS_ROOT, launcher });
        if (state?.running) {
          sendJson(res, 409, refuse(
            "run_in_flight",
            `'${sensitive.name}' changes the substrate a running cell is being measured on, ` +
              `so it is refused while one is live. Stop the cell first — the run control has a ` +
              `STOP CELL button.`,
            { model: state.model ?? null, log_name: state.log_name ?? null, pid: state.pid ?? null },
          ));
          return;
        }
      }

      const out = await invokeTool(BENCH_ROOT, payload?.id, payload?.args ?? {});
      sendJson(res, out.ok ? 200 : 400, out);
      return;
    }

    // ── GET /api/backups ─────────────────────────────────────────────────
    //
    // Every reset the bench has ever taken, newest first, each summarised well
    // enough to choose between them WITHOUT opening a folder: when it was taken,
    // which models it holds, how many results it carries, and whether it would
    // pass the restore check.
    if (path === "/api/backups" && req.method === "GET") {
      sendJson(res, 200, { ok: true, backups: await listBackups(RUNS_ROOT) });
      return;
    }

    // ── POST /api/backups/restore/preview ────────────────────────────────
    //
    // Runs the SAME refusals the restore will run, so a preview can never
    // green-light a restore the commit would reject.
    if (path === "/api/backups/restore/preview" && req.method === "POST") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const check = await restoreGate(payload?.id);
      sendJson(res, check.ok === false ? 409 : 200, check);
      return;
    }

    // ── POST /api/backups/restore ────────────────────────────────────────
    //
    // Parks the live bench into its own backup, then moves the chosen one in.
    // No step overwrites anything — see backups.mjs.
    if (path === "/api/backups/restore" && req.method === "POST") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const check = await restoreGate(payload?.id);
      if (check.ok === false) {
        sendJson(res, 409, check);
        return;
      }
      if (payload?.confirm !== check.token) {
        sendJson(
          res,
          400,
          refuse(
            "bad_confirmation",
            "the confirmation did not match this backup — it changed after the preview was shown. " +
              "Review the restatement and confirm again.",
            { expected_token: check.token, restatement: check.restatement },
          ),
        );
        return;
      }
      try {
        const done = await restoreBackup(RUNS_ROOT, payload.id);
        sendJson(res, 200, {
          ok: true,
          restored: done.restored,
          parked_as: done.parked_as,
          parked_items: done.parked_items,
          warnings: done.warnings,
          note:
            `restored ${done.restored.length} item(s); the bench that was live is now ` +
            `backup ${done.parked_as} and can be restored the same way`,
        });
      } catch (err) {
        sendJson(res, 500, refuse("restore_failed", String(err?.message ?? err)));
      }
      return;
    }

    // ── POST /api/run/preview ────────────────────────────────────────────
    // The restatement the UI must show before START. The SERVER composes it so
    // the words the operator reads are the words the server will act on.
    if (path === "/api/run/preview" && req.method === "POST") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const roster = await readRoster({ proxyUrl: args.proxyUrl, runtimeUrl: args.runtimeUrl });

      // PREVIEW RUNS THE SAME VALIDATION AS START.
      // It previously minted a token for ANY payload, so an ON cell with no org
      // returned 200 and the UI armed a confirm button for a run the server
      // would then refuse. A preview that can green-light an impossible run is
      // worse than no preview: it moves the refusal to after the operator has
      // committed.
      //
      // The serial gate is deliberately EXCLUDED — `can_start` is a fact about
      // right now, not about these parameters, and an operator must be able to
      // review what they intend to run next while a cell is still in flight.
      const run = await readRunState({ runsRoot: RUNS_ROOT, launcher });
      // EVERY RULE IS CHECKED AT PREVIEW TOO. A preview that green-lights a cell
      // the start will refuse moves the refusal to after the operator has
      // committed — the same defect the org check was moved here to fix.
      const check = await validateStart(
        payload,
        roster,
        { ...run, can_start: true, blocked_reason: null },
        { requireConfirm: false, runsRoot: RUNS_ROOT },
      );
      if (check.ok === false) {
        sendJson(res, 400, check);
        return;
      }

      const { model, arm, org, context, kind, cloud, compact, requireTodos, recordAtChunkEnd, graderWorkerTarget, snapshotId } = check;
      sendJson(res, 200, {
        ok: true,
        token: confirmationToken({ model, arm, org, context, kind, compact, snapshotId }),
        restatement: restatement({ model, arm, org, context, kind, cloud, compact }),
        // THE RESOLVED ANSWER, RETURNED. The panel proposes a default; the
        // server decides. Echoing it back is what lets the confirmation frame
        // show the operator the value the token was actually minted for rather
        // than the one the panel guessed.
        compact: compact === true,
        requireTodos: requireTodos === true,
        recordAtChunkEnd: recordAtChunkEnd === true,
        graderWorkerTarget: graderWorkerTarget ?? null,
        // What the operator is committing to, in machine form beside the prose.
        // The confirmation card states the substrate and — for a cloud cell —
        // the vendor and the per-cell spend ceiling, and it must state the same
        // ones the token was minted for rather than the ones the form still has
        // on screen.
        kind,
        cloud: cloud ? { provider: cloud.provider, model: cloud.model, slug: cloud.slug, name: cloud.name } : null,
        // Stated so the UI can show the operator that the serial rule will
        // block this run, WITHOUT pretending the parameters are invalid.
        blocked_now: run.can_start === true ? null : (run.blocked_reason ?? "a cell is already in flight"),
      });
      return;
    }

    // ── POST /api/run/start ──────────────────────────────────────────────
    if (path === "/api/run/start" && req.method === "POST") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const roster = await readRoster({ proxyUrl: args.proxyUrl, runtimeUrl: args.runtimeUrl });

      if (!roster.proxy_ok) {
        sendJson(res, 503, refuse("upstream_unwired", roster.reason ?? "model proxy unreachable"));
        return;
      }

      const run = await readRunState({ runsRoot: RUNS_ROOT, launcher });

      const check = await validateStart(payload, roster, run, { runsRoot: RUNS_ROOT });
      if (!check.ok) {
        sendJson(res, 409, check);
        return;
      }

      const { model, arm, org, context, kind, cloud, compact, requireTodos, recordAtChunkEnd, graderWorkerTarget, snapshotId } = check;

      // ARGV ARRAY, NO SHELL. Main-parser flags MUST precede the subcommand —
      // argparse exits 2 otherwise (verified 2026-08-10). This ordering is the
      // documented RUNBOOK invocation, reproduced exactly.
      //
      // ── THE CLOUD INVOCATION IS THE HARNESS'S OWN, NOT A NEW ONE ──────────
      //
      // `--cloud --provider <vendor> --model <model>` is exactly what
      // `_compose_cloud_slug` in run_cumulative.py consumes: it joins them into
      // `{router}/{provider}/{model}` and refuses anything absent from the
      // OrcaRouter provider block. `--model` therefore carries the MODEL HALF of
      // the key on this path, not the whole key — passing `anthropic/claude-…`
      // to `--model` would compose `orcarouter/anthropic/anthropic/claude-…`
      // and be refused by the harness with a message about a model that is not
      // the one the operator picked.
      const argv = [RUN_SCRIPT];
      if (kind === "cloud") {
        argv.push("--cloud", "--provider", cloud.provider, "--model", cloud.model);
      } else {
        argv.push("--model", model);
      }
      if (org) argv.push("--org", org);
      // A cell writes to ITS MODEL'S campaign, not to whichever campaign the
      // default path happens to hold. Omitted when the default is already this
      // model's, so the live campaign's invocation is unchanged.
      //
      // The target is resolved BEFORE the spawn because it is also what the
      // response echoes back — which directory and which cell inside it this
      // launch is about to write.
      //
      // THE TREE IS ENSURED, NOT ASSUMED. A fresh checkout has no tree, and
      // requiring the operator to press reset before the first run would make
      // reset a precondition rather than a wipe. Non-fatal: a bench that cannot
      // mint one falls back to the legacy flat layout rather than refusing a run.
      let tree = null;
      let tree_error = null;
      try {
        tree = (await ensureTree(RUNS_ROOT)).active;
      } catch (err) {
        // The fallback is deliberate and stays. What was missing is the report:
        // a run filed flat in RUNS_ROOT is outside the tree a reset sweeps, so
        // an operator who is never told keeps a run nothing will ever clean.
        tree = null;
        tree_error = String(err?.message ?? err);
        console.error(`[run] tree could not be ensured; filing this run in the legacy flat layout: ${tree_error}`);
      }
      const target = await campaignTargetFor({ model, kind, cloud }, RUNS_ROOT);
      if (target.manifest_arg) argv.push("--manifest", target.manifest_arg);
      // `run` ACCEPTS EXACTLY --mode, --proxy-base-url, --proxy-token-file.
      // `--until-review` was removed from the harness by ba2947a (2026-08-14)
      // and kept here, so argparse rejected the whole invocation before the
      // harness did anything: the child exited on a usage error, the log held
      // nothing but that error, and the board — which infers "running" from the
      // log's existence — reported BUSY over a process that was already dead.
      // Every board-launched cell failed this way. Flags here must be checked
      // against the run subparser, not against memory.
      // ── COMPACTION IS PASSED EXPLICITLY, ALWAYS ─────────────────────────
      //
      // Both forms are sent, never just `--compact` when it is on. The harness
      // flag has no default of its own precisely so this decision is made in
      // exactly one place; passing nothing would hand it back to a default, and
      // the arm the operator confirmed would stop being the arm guaranteed to
      // run.
      // ── THE SEED, IF ONE IS ARMED ───────────────────────────────────────
      //
      // A MAIN-PARSER FLAG, so it goes before the `run` subcommand with the
      // others — argparse exits 2 otherwise. `snapshotId` is null unless dev
      // mode is on AND a seedable snapshot is armed; `validateStart` has
      // already refused the unseedable cases with a quotable reason, so
      // reaching here means the harness will accept it.
      //
      // The harness re-validates independently and may still refuse. That is
      // deliberate duplication, not redundancy: this check exists to refuse
      // before a container is spawned, and that one is the check that cannot
      // be raced by a snapshot deleted between preview and start.
      if (snapshotId) argv.push("--seed-snapshot", snapshotId);

      argv.push("run", "--mode", arm, compact ? "--compact" : "--no-compact");
      if (requireTodos) argv.push("--require-todos");
      if (recordAtChunkEnd) argv.push("--record-at-chunk-end");
      if (graderWorkerTarget != null) {
        argv.push("--grader-worker-target", String(graderWorkerTarget));
      }

      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "");
      // ── THE LOG GOES IN THE TREE ──────────────────────────────────────────
      //
      // It used to sit at the runs root, where it OUTLIVED every wipe: a stale
      // `off-cell-*.log` kept resolving as the live run, so a wiped bench
      // reported a run in progress until someone hand-deleted the file
      // (runstate.mjs:75). Inside the tree, retiring the tree retires the log,
      // and no cleanup step has to be remembered.
      const logDir = tree ? join(RUNS_ROOT, tree) : RUNS_ROOT;
      const logPath = join(logDir, `${arm}-cell-${stamp}.log`);

      // ── THE RUN'S ZERO IS TAKEN HERE, BEFORE THE HARNESS EXISTS ─────────
      //
      // Monotonic custom sources (the relay's loop-guard counter is the
      // founding one) count for the life of THEIR process, not of this run.
      // Snapshotting at queue time — ahead of the spawn, so the run cannot
      // contribute to its own zero — is what makes the footer's number this
      // run's number. This IS the reset the operator asks for by starting a
      // run; there is no separate button, because a zero that can be taken at
      // any other moment is a zero that can be taken at the wrong one.
      //
      // Never blocks a launch: see captureStatsBaseline.
      await captureStatsBaseline({ logPath });

      // THE FIRST THING THIS RUN'S NOTICE STREAM SAYS. Written before the spawn
      // so a launch that dies during startup still leaves a record that it was
      // attempted — the case where the operator most needs one and previously
      // got a refusal in an HTTP response and nothing on disk.
      await notice(logPath, "run_queued", {
        detail: { model: model ?? null, arm: arm ?? null, context: context ?? null },
      });

      let fh;
      try {
        fh = await open(logPath, "a");
      } catch (err) {
        sendJson(res, 500, refuse("launcher_failed", `cannot open log ${logPath}: ${err?.message ?? err}`));
        return;
      }

      const env = { ...process.env };
      // THE HARNESS'S OWN RUN-SCOPED NOTICE CHANNEL — the same file this
      // process writes, because both are run-scoped notices about the same run
      // in the same envelope, and a reader should not have to know which
      // process appended a line to read them in order. `source` says who spoke.
      // A CLI-launched harness has nobody to set this and runs identically
      // without it.
      env.BENCH_NOTICES = noticesPathFor(logPath);
      // Context is passed to the worker through the environment rather than a
      // CLI flag because the harness reads it there; `null` means "registry
      // default" and deliberately sets nothing.
      if (context !== null) env.BENCH_WORKER_NUM_CTX = String(context);

      let child;
      try {
        child = spawn(PYTHON, argv, {
          cwd: BENCH_ROOT,
          env,
          // stdin from /dev/null is MANDATORY, not cosmetic: without it the
          // process is suspended the instant it touches stdin, stranding a
          // half-built manifest and a live container. Same reason the RUNBOOK
          // requires `< /dev/null` on the shell launch.
          stdio: ["ignore", fh.fd, fh.fd],
          detached: true,
          shell: false,
        });
      } catch (err) {
        await fh.close().catch(() => {});
        sendJson(res, 500, refuse("launcher_failed", String(err?.message ?? err)));
        return;
      }

      child.unref();
      await fh.close().catch(() => {});

      // ── STARTUP LIVENESS CONFIRMATION ───────────────────────────────────
      // The spawn above returns a valid pid the instant the child exists, but
      // the harness can die seconds later — a usage error, an import error, or
      // the chunk-plan drift guard (WO-49: ~11s after spawn, after preflight).
      // Returning ok:true over a process that is already dead is the exact
      // failure that hid WO-49: the operator was told ok, and the dashboard —
      // which keys its run pulse on PROGRESS lines — rendered "no run
      // observed". Ask the kernel whether the process survived its startup
      // window before claiming the run started; if it died, surface the log
      // tail so the refusal names the real error instead of lying.
      const liveness = await confirmAlive(child.pid, { logPath });
      if (!liveness.ok) {
        sendJson(res, 500, refuse(
          "launch_crashed",
          `harness exited ${liveness.elapsed_ms}ms after launch (see log tail)`,
          { log_path: logPath, pid: child.pid, log_tail: liveness.log_tail },
        ));
        return;
      }

      launcher = {
        pid: child.pid,
        model,
        arm,
        org,
        context,
        kind,
        started_at: Date.now(),
        log_path: logPath,
      };

      sendJson(res, 200, {
        ok: true,
        pid: child.pid,
        log_path: logPath,
        model,
        arm,
        org,
        context,
        kind,
        cloud: cloud ? { provider: cloud.provider, model: cloud.model, slug: cloud.slug } : null,
        // Where this cell will land, echoed back. The operator can check it
        // against the row that appears on the board a tick later, and a
        // mismatch is then visible rather than being a silent misattribution.
        run_dir: target.run_dir,
        sequence_index: target.sequence_index,
        // NULL is the healthy state. Non-null means the tree could not be
        // ensured and this run is filed flat in RUNS_ROOT — outside what a
        // reset sweeps. Stated here so the operator learns it now, not when a
        // reset leaves the run behind.
        tree_error,
        restatement: restatement({ model, arm, org, context, kind, cloud }),
      });
      return;
    }

    // ── POST /api/run/resume ─────────────────────────────────────────────
    // ALWAYS REFUSES. The route exists so the refusal is discoverable and
    // carries its reason, rather than 404-ing as if the feature were forgotten.
    if (path === "/api/run/resume" && req.method === "POST") {
      sendJson(res, 501, refuse("resume_unsupported", RESUME_UNSUPPORTED.reason, {
        alternative: RESUME_UNSUPPORTED.alternative,
      }));
      return;
    }

    // ── GET /api/events ──────────────────────────────────────────────────
    // Polled snapshot of the mapped ring, OLDEST-FIRST (it is a transcript,
    // not a ticker). `cursor` lets the board fetch only what is new without
    // holding a second SSE connection open.
    //
    // HARNESS GRADING ROWS ARE MERGED IN HERE (WO-GRADE-VIS-1). They come from
    // a different source than every other row — the harness's own PROGRESS
    // lines in the run log, not the worker's SSE stream — because during
    // grading the worker is idle BY DESIGN and its stream says nothing. Without
    // them the feed goes silent for the length of a grade (measured at 32
    // minutes on 2026-08-12) and a working run is indistinguishable from a
    // wedged one.
    //
    // They are APPENDED rather than interleaved by timestamp: grading happens
    // between agent turns, so appending preserves true chronology, and the
    // harness's naive local timestamps cannot be compared against the worker's
    // epoch times without reintroducing the timezone defect documented at
    // contract.mjs STALL_THRESHOLD_S.
    if (path === "/api/events" && req.method === "GET") {
      const requestedRunDir = url.searchParams.get("run_dir");
      if (requestedRunDir) {
        // Persisted read for a past/selected run — agent events from disk, in the
        // SAME BoardEvent row shape the live ring serves (so the feed renderer is
        // reusable unchanged). Passing ?run_dir= always reads the persisted
        // transcript (never the live ring); omitting it keeps the live path.
        const since = Number(url.searchParams.get("since") ?? 0) || 0;
        const limitRaw = Number(url.searchParams.get("limit"));
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : null;
        const seqRaw = Number(url.searchParams.get("sequence_index"));
        const sequenceIndex = Number.isInteger(seqRaw) && seqRaw >= 0 ? seqRaw : null;
        // Parsed HERE rather than read from the live branch's own binding below:
        // that one is declared after this block, so reaching it from inside the
        // branch is a temporal-dead-zone throw, not a fallthrough. The board
        // filters client-side today, so this is normally null.
        const kindsRaw = url.searchParams.get("kinds");
        const kinds = kindsRaw ? kindsRaw.split(",").filter(Boolean) : null;
        // ── THE HISTORICAL READ IS THE SAME ASSEMBLY AS THE LIVE ONE ──────
        //
        // The live feed is not one source. It is the model's own stream PLUS
        // the verbatim prompts the harness handed it, rebuilt from
        // `worktree.user-events.jsonl` and admitted into the ring on every poll
        // (see the live branch below). This branch read only the agent
        // transcript, so a concluded run reported `user: 0` and showed every
        // tool the model called and NOTHING it was called on — the prompts sat
        // on disk, unread, while the card claimed the feed was complete.
        //
        // So it is rebuilt HERE THE SAME WAY: one EventRing, both sources
        // admitted, one snapshot. Same class, same serialization, same shape —
        // the two paths cannot drift into showing different things, because
        // below the sources they are one path.
        const persisted = await readAgentEvents({ runsRoot: RUNS_ROOT, runDir: requestedRunDir, since: 0, limit: null, sequenceIndex });

        // THE PROMPTS. Cell-scoped when a sequence_index was given, so a
        // multi-cell campaign does not fold another cell's prompts into this
        // one. A read failure degrades to the agent rows alone rather than
        // taking the whole feed down — additive instrumentation, same rule the
        // live branch applies.
        let promptRows = [];
        try {
          const cellName = sequenceIndex != null
            ? (await cellDirForRun(RUNS_ROOT, requestedRunDir, sequenceIndex))?.cellName ?? null
            : null;
          const fb = await readFeedback({ runsRoot: RUNS_ROOT, runDir: requestedRunDir, cell: cellName, limit: 0 });
          if (fb.ok) promptRows = feedbackRows(fb.messages, { runDir: fb.run_dir, cell: fb.cell });
        } catch {
          promptRows = [];
        }

        // ── ORDER IS RECONSTRUCTED BY TIME, NOT BY ADMISSION ─────────────────
        //
        // On a LIVE run these rows interleave correctly for free: each is
        // admitted at the moment it first appears in the files, so the ring's
        // own counter puts it in place. A rebuild has no such moment — admitting
        // every agent row and then every prompt would file all ten prompts at
        // the BOTTOM of a four-thousand-row transcript, which is not the feed
        // the operator watched. Both families carry `at`, so the merge sorts on
        // it and the ring numbers them in that order.
        const histRing = new EventRing(Number.MAX_SAFE_INTEGER);
        // TWO ADMISSION RULES, MATCHED TO HOW EACH SOURCE ARRIVES. Agent rows
        // are APPENDED — many legitimately share an id (a streaming part emits
        // `message.part.updated` repeatedly as it grows), and deduping them
        // collapsed a 4,312-row transcript to 2,116. Prompt rows are ADMITTED,
        // because that family is rebuilt from files and dedupes on identity.
        // This is exactly what the live path does; only the entry points differ.
        const promptIds = new Set(promptRows.map((r) => r.id));
        for (const r of interleaveByArrival(persisted.rows, promptRows)) {
          if (promptIds.has(r.id)) histRing.admit(r);
          else histRing.append(r);
        }

        // UNBOUNDED, DELIBERATELY. The live ring caps at EVENT_RING_MAX (2000)
        // because it is a window onto something still happening. A concluded
        // record is finite and complete, and trimming it here would silently
        // drop 2,312 rows of a 4,312-row run while the header went on reporting
        // the total.
        const snapshot = histRing.snapshot({ since, limit: limit ?? Number.MAX_SAFE_INTEGER, kinds });

        // Same tally the live branch performs: `snapshot.counts` initialises
        // only the five agent kinds, so the prompt rows are counted on top or
        // their filter chip reads 0 over rows it can actually select.
        const counts = { ...snapshot.counts };
        for (const r of histRing.items) {
          if (r.kind === "harness" || r.kind === "user") counts[r.kind] = (counts[r.kind] ?? 0) + 1;
        }

        sendJson(res, 200, {
          ok: true,
          // NOT a socket claim. This branch reads files; `connected` is what the
          // board reads to decide whether the counts on screen are live or
          // frozen, and a complete record is neither stale nor disconnected.
          // `source` and `run_dir` say what it actually is.
          connected: false,
          reason: "persisted",
          order: "oldest_first",
          events: snapshot.events,
          total: snapshot.total,
          mapped: snapshot.total,
          unmapped: 0,
          returned: snapshot.returned,
          retained: snapshot.retained,
          capped: false,
          windowed: false,
          hidden_by_filter: snapshot.hidden_by_filter ?? 0,
          max: 0,
          cursor: snapshot.cursor,
          counts,
          grading: null,
          run_dir: requestedRunDir,
          sequence_index: sequenceIndex,
          source: "agent-events.jsonl + worktree.user-events.jsonl",
          attached: persisted.attached,
          prompts: promptRows.length,
        });
        return;
      }
      const raw = Number(url.searchParams.get("limit") ?? EVENT_RENDER_CAP);
      const limit = Math.min(EVENT_RENDER_CAP, raw || EVENT_RENDER_CAP);
      const since = Number(url.searchParams.get("since") ?? 0) || 0;
      const kindsRaw = url.searchParams.get("kinds");
      const kinds = kindsRaw ? kindsRaw.split(",").filter(Boolean) : null;
      // THE RING IS SCOPED TO ONE RUN. Resolve the active run dir fresh on every
      // request; if it changed since the last poll, reset the ring BEFORE
      // admitting anything so the previous run's rows — pinned and never
      // evicted — are not served against this one. User/harness rows are rebuilt
      // from files and re-admitted in this same request, so a reset loses
      // nothing the files still hold.
      // WHETHER A CELL IS ACTUALLY RUNNING — the same fact /api/models-ledger
      // gates its launch buttons on (`can_start !== true`), read from the same
      // owner so the feed and the buttons cannot disagree about it.
      const liveRunState = await readRunState({ runsRoot: RUNS_ROOT, launcher });
      const currentRunDir = await activeRunDir();
      if (currentRunDir !== ringRunDir) {
        ring.reset();
        ringRunDir = currentRunDir;
      }
      // THE SNAPSHOT IS TAKEN BELOW, AFTER the out-of-ring rows are admitted —
      // otherwise a row admitted on this request would not appear until the
      // next poll, and `cursor` would advance past it in the meantime.

      // Never let a log-read failure take the agent feed down: grading rows are
      // additive instrumentation, and the feed must degrade to exactly its
      // previous behaviour if they are unavailable.
      let gate = { rows: [], status: null };
      try {
        gate = await readGateActivity(RUNS_ROOT);
      } catch (err) {
        gate = { rows: [], status: null, error: String(err?.message ?? err) };
      }

      // ── THE SCRAPED HARNESS ROWS NO LONGER ENTER THIS FEED ───────────────
      //
      // `gate.rows` is still read — `gate.status` drives the grading indicator
      // below — but the ROWS are not admitted any more (2026-09-07 ruling).
      //
      // The EVENT FEED is what the MODEL did and what the model was TOLD. The
      // four row types this reader produces (gate-attempt-start,
      // gate-phase-start, gate-phase-end, gate-timeout) are none of those: they
      // are what the HARNESS did to it, which is the BACKEND FEED.
      //
      // They were also broken here in a way that could not be fixed in place.
      // They are scraped from `PROGRESS step=…` log lines, which carry NO
      // TIMESTAMP, so every one of them rendered with a blank time column and
      // could not be ordered against anything. The identical events are already
      // in the cell's `live.jsonl` — `phase.start`, `gate.result`, `attempt.end`
      // — WITH times, which is what the backend feed reads. So this is the
      // removal of a timestamp-less duplicate, not the loss of a signal.

      // GRADED TEXT ROWS ARE MERGED IN TOO (WO-FEEDBACK-1). The harness renders
      // gate results into prose and hands it to the model AS A USER TURN. That
      // message is the single most consequential input the model receives and
      // it appeared nowhere in this feed — the worker's SSE stream shows only
      // what the model did with it, never what it was given.
      //
      // They carry `kind:"user"` deliberately: on this board they ARE user
      // turns, which is exactly the fiction under test. Labelling them
      // "harness" would quietly answer the question the operator opened the
      // feed to judge.
      //
      // ── ONLY WHILE A CELL IS ACTUALLY IN FLIGHT ──────────────────────────
      //
      // `activeRunDir()` resolves the NEWEST run directory on disk, running or
      // not. So on an idle bench this read reached into the last CONCLUDED run
      // and served its prompts as live rows — and the live card then reported
      // `tool 0 · file 0 · thinking 0 · error 0 · lifecycle 0 · user 10` under a
      // subtitle naming that finished cell.
      //
      // That is a misattribution, not a cosmetic one: the card claimed a
      // concluded run's prompts were the live session, so it read exactly like a
      // BROKEN HISTORICAL FEED — ten rows of a four-thousand-row run, with every
      // agent count at zero. An operator reasonably concluded the persisted
      // transcript was empty when it was 1.7MB on disk and served correctly by
      // the ?run_dir= path all along.
      //
      // A finished run's record is reachable — by SELECTING it, which is what
      // the DATA FEED card's baseline selector is for. The live feed's job is
      // the live cell, and when there is no live cell its honest answer is
      // nothing.
      const cellInFlight = liveRunState.can_start !== true;
      let feedback = { rows: [], error: null };
      if (cellInFlight) {
        try {
          const fb = await readFeedback({ runsRoot: RUNS_ROOT, runDir: currentRunDir, limit });
          feedback = { rows: fb.ok ? feedbackRows(fb.messages, { runDir: fb.run_dir, cell: fb.cell }) : [], error: null };
        } catch (err) {
          // Additive instrumentation: a read failure must degrade the feed to its
          // previous behaviour, never take the agent stream down with it.
          feedback = { rows: [], error: String(err?.message ?? err) };
        }
      }

      // ── ADMIT THE OUT-OF-RING ROWS ONCE, THEN LET THE RING DO EVERYTHING ───
      //
      // THE ORIGINAL DEFECT: gate rows and feedback rows are built OUTSIDE
      // EventRing, so they never passed through `push()` — the only thing that
      // assigns `seq`. They reached the client with `seq: undefined`, and the
      // renderer appends incrementally with
      //   rows.filter((e) => (e.seq ?? -1) > renderedSeq)     [live.js]
      // so every one of them scored -1 and NOTHING WAS EVER APPENDED.
      //
      // THE DEFECT THAT FIX INTRODUCED, AND THIS ONE CLOSES: numbering them at
      // request time from `snapshot.cursor` made the seq a function of a MOVING
      // base. These rows are rebuilt from files on every poll, so the same row
      // was re-sequenced every time, cleared the append gate again, and was
      // appended again. Measured on a live run: one `task chunk (attempt 1)`
      // came back as seq 706, then 713, then higher, and the operator saw it
      // repeated down the whole feed.
      //
      // Admitting each row ONCE, by identity, fixes both at the source: the row
      // takes a seq from the ring's own counter (so it cannot collide with a
      // real upstream seq), and `since` / `cursor` / `capped` need no special
      // case here at all. See EventRing.admit().
      //
      // Admission happens BEFORE the snapshot is taken, so a newly-admitted row
      // appears in this very response rather than one poll later.
      for (const r of feedback.rows) ring.admit(r);
      const snapshot = ring.snapshot({ since, limit, kinds });

      // Deliver grading rows that have aged out of the delta tail on a FRESH
      // connect (`since === 0`): the user/harness chips count the whole ring, so
      // the rows those chips count must actually be filterable on the board.
      // Grading rows are low-volume and admitted-once; the client pins them
      // against its own window trim after this first delivery.
      if (since === 0) snapshot.events = mergeGrading(snapshot.events, ring.items);

      // Counts must reflect what the operator can filter on, including the
      // grading rows — a chip whose count is always 0 reads as "never happens".
      // `snapshot.counts` initialises only the five agent kinds and skips any
      // others, so `harness` and `user` are still tallied here; they are counted
      // from the RING (not from the freshly-read files) so the number describes
      // the same population the filter chips actually select from.
      const counts = { ...snapshot.counts };
      for (const r of ring.items) {
        if (r.kind === "harness" || r.kind === "user") {
          counts[r.kind] = (counts[r.kind] ?? 0) + 1;
        }
      }

      sendJson(res, 200, {
        ...snapshot,
        counts,
        // WHETHER THERE IS A LIVE CELL AT ALL. `connected:false` alone cannot
        // answer this: the stream is equally unreachable when a run has crashed
        // and when the bench is simply idle, and those want opposite words on
        // screen — one is a fault, the other is the normal resting state. The
        // card reads this to tell them apart.
        cell_in_flight: cellInFlight,
        // The live grading verdict: which phase is open, how long it has been
        // silent, and whether that exceeds the alarm threshold.
        grading: gate.status,
      });
      return;
    }

    // ── GET /api/feedback ────────────────────────────────────────────────
    // The graded text, VERBATIM — exactly what the model was told a user sent.
    //
    // This is the surface for judging the fiction: the harness renders gate
    // results into prose and delivers it as a user turn, and until this existed
    // nobody could read those bytes. It does not summarise or re-render; a
    // surface that prettified the text would answer a different question than
    // the one an operator is asking when they open it.
    //
    //   ?run_dir=<name>   default: the ACTIVE run (see `activeRunDir`)
    //   ?cell=<name>      default: the most recently written cell
    //   ?limit=<n>        default 50, newest-last
    //   ?text=0           omit bodies (index only)
    if (path === "/api/feedback" && req.method === "GET") {
      const limitRaw = Number(url.searchParams.get("limit"));
      const result = await readFeedback({
        runsRoot: RUNS_ROOT,
        runDir: url.searchParams.get("run_dir") ?? (await activeRunDir()),
        cell: url.searchParams.get("cell"),
        limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50,
        includeText: url.searchParams.get("text") !== "0",
      });
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    // ── GET /api/wall ────────────────────────────────────────────────────
    // The GATE WALL's single source: the gate roster folded with the per-gate
    // outcomes of the last completed test run. The board must not stitch the
    // two artifacts together — a second implementation of this fold would
    // disagree with the first, and every disagreement shows up as a wrong
    // colour on a square.
    //
    // The server decides `state`; the board decides colour. Nothing here emits
    // colours, CSS, or presentation. NO LIVE SIGNAL AND NO PHASE: a square
    // carries a recorded verdict or it carries none.
    //
    // Never 500s on a missing roster: that is a real state (the run predates
    // the artifact), reported as ok:true + unwired + a reason.
    if (path === "/api/wall" && req.method === "GET") {
      // An explicit ?run_dir= always wins — that is how an operator inspects an
      // archived run. With none, the ACTIVE run is the answer, resolved from the
      // cell log rather than from a directory name this file would have to keep
      // in step with the campaign layout. See `activeRunDir`.
      const wall = await readWall({
        runsRoot: RUNS_ROOT,
        runDir: url.searchParams.get("run_dir") ?? (await activeRunDir()),
        benchRoot: BENCH_ROOT,
      });
      sendJson(res, wall.ok ? 200 : 400, wall);
      return;
    }


    // ── GET /api/baselines ───────────────────────────────────────────────
    // THE FLOOR, ON ITS OWN. Every model's baseline, resolved by the single
    // owner (baselines.mjs) and published to runs/baselines.json on the way
    // out. The ledger carries the same index inline, so a board needs no extra
    // call — this endpoint exists for everything that wants the floors WITHOUT
    // the launch gates: a script, a report, a second surface, an operator with
    // curl. One derivation, several readers, no second definition.
    if (path === "/api/baselines" && req.method === "GET") {
      const roster = await readRoster({ proxyUrl: args.proxyUrl, runtimeUrl: args.runtimeUrl });
      const out = await readBaselines({
        runsRoot: RUNS_ROOT,
        models: roster.ok ? (roster.bench_models ?? []) : [],
      });
      // A roster that could not be read is stated rather than silently yielding
      // an empty index — "no models answered" and "no model has a floor" are
      // different facts.
      sendJson(res, 200, {
        ...out,
        roster_ok: roster.ok,
        roster_reason: roster.ok ? null : roster.reason,
      });
      return;
    }

    // ── GET /api/backend-feed ────────────────────────────────────────────
    // WHAT THE MACHINERY IS DOING, merged from every process that writes a
    // record: the cell's own stream and the run-scoped notice stream. The
    // EVENT FEED beside it shows the AGENT, and goes correctly silent between
    // attempts — which is exactly when this one has the most to say.
    //
    // Run-scoped like every other read here, resolved by `activeRunDir` and
    // `readRunState` so it can never disagree with the board about which run is
    // on screen.
    if (path === "/api/backend-feed" && req.method === "GET") {
      const runState = await readRunState({ runsRoot: RUNS_ROOT, launcher });
      const requestedRunDir = url.searchParams.get("run_dir");
      // When a specific (possibly past) run is requested, resolve THAT run's
      // launch log so the notices half comes from the same run, not the active
      // one. No ?run_dir= → active run (existing behavior).
      const logPath = requestedRunDir
        ? await logPathForRunDir(RUNS_ROOT, requestedRunDir)
        : runState.log_path;
      const seqRaw = Number(url.searchParams.get("sequence_index"));
      const sequenceIndex = Number.isInteger(seqRaw) && seqRaw >= 0 ? seqRaw : null;
      sendJson(
        res,
        200,
        await readBackendFeed({
          runsRoot: RUNS_ROOT,
          runDir: requestedRunDir ?? (await activeRunDir()),
          logPath,
          sequenceIndex,
          // A ?run_dir= READ IS A REVIEW OF A FINISHED CELL, so it is complete.
          // The tail window and the row cap exist for the live path, where the
          // stream grows without bound and the recent end is what matters; on a
          // concluded cell they hide the START of the run — the build phases,
          // the cell's own opening — which is what a reviewer opened it for.
          complete: Boolean(requestedRunDir),
        }),
      );
      return;
    }

    // ── GET /api/stats ───────────────────────────────────────────────────
    // THE ONE NUMBERS SURFACE the ledger footer draws from: `bench` (native to
    // the benchmark, true for any clone) and `custom` (contributed through
    // BENCH_STATS_MANIFEST, readings off services the CONTRIBUTOR runs and
    // the bench does not ship). Two arrays, one entry shape, never merged —
    // see control/runstats.mjs for why the boundary is drawn there and not on
    // the board.
    //
    // MONOTONIC SOURCES ARE SCOPED TO THE RUN HERE. A `"mode": "delta"` stat is
    // reported against the zero snapshotted when THIS run was queued, resolved
    // from the same `readRunState` the rest of the board keys on — so the
    // number in the footer belongs to the run named above it. Absent a
    // baseline the stat reads `unavailable`; it never falls back to the
    // source's lifetime total, which is the bug this replaced.
    if (path === "/api/stats" && req.method === "GET") {
      const runState = await readRunState({ runsRoot: RUNS_ROOT, launcher });
      const baselines = await readStatsBaseline({ logPath: runState.log_path });
      // THE NATIVE READOUTS ARE RUN-SCOPED, so the run in view travels with the
      // request. Resolved by `activeRunDir` — the same resolver `/api/wall`
      // uses — rather than by a directory name this route would have to keep in
      // step with the campaign layout.
      sendJson(
        res,
        200,
        await watchExternalCounters(
          runState.log_path,
          await collectStats({
            baselines,
            runDir: await activeRunDir(),
            runsRoot: RUNS_ROOT,
            benchRoot: BENCH_ROOT,
          }),
        ),
      );
      return;
    }

    // ── GET /api/models-ledger ───────────────────────────────────────────
    // One row per bench-eligible model, one row per measured floor with the ON
    // runs nested inside it, and every launch gate already resolved. The board renders this and decides
    // nothing: a button's enabled state and the refusal /api/run/start would
    // actually apply are computed from the same place, so they cannot drift.
    if (path === "/api/models-ledger" && req.method === "GET") {
      const runState = await readRunState({ runsRoot: RUNS_ROOT, launcher });
      const roster = await readRoster({ proxyUrl: args.proxyUrl, runtimeUrl: args.runtimeUrl });
      const ledger = await readModelsLedger({
        runsRoot: RUNS_ROOT,
        benchModels: roster.ok ? (roster.bench_models ?? []) : [],
        runInFlight: runState.can_start !== true,
        blockedReason: runState.blocked_reason,
        // THE CLOUD HALF OF THE MODEL UNIVERSE. Passed in rather than read
        // inside the ledger so this route owns every I/O boundary it crosses,
        // and so the ledger stays a pure assembly over what it is handed —
        // which is what makes it testable against a fixture directory.
        cloud: await readCloud({ benchRoot: BENCH_ROOT }),
      });
      // The roster is the model universe; without it there are no rows to
      // draw, and saying so is not the same as saying "no models exist".
      if (!roster.ok) {
        sendJson(res, 200, {
          ...ledger,
          models: [],
          unwired: ["roster"],
          unwired_reason: roster.reason ?? "model proxy unreachable",
        });
        return;
      }
      sendJson(res, 200, ledger);
      return;
    }

    // ── GET /api/health ──────────────────────────────────────────────────
    if (path === "/api/health" && req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        contract_version: CONTROL_CONTRACT_VERSION,
        bench_root: BENCH_ROOT,
        runs_root: RUNS_ROOT,
        // ── WHEN THIS PROCESS LOADED ITS CODE ────────────────────────────────
        //
        // The control plane is a LONG-LIVED HOST PROCESS and `make control-start`
        // is a deliberate no-op when :7718 is already listening, so an edit to
        // control/ sits inert until someone restarts it by hand. That is exactly
        // how the 2026-09-02 compaction launch ran without --compact: the source
        // had the flag, the running process did not, and nothing said so.
        //
        // REPORTED, NOT INFERRED. Preflight compares this against the newest
        // mtime under control/ — the same discipline the worker-image check
        // uses. A process cannot be asked what version of a file it parsed, but
        // it CAN say when it started, and a start that predates the source is
        // proof enough that the source is not what is running.
        started_at: PROCESS_STARTED_AT,
        event_feed: { connected: ring.connected, reason: ring.reason, total: ring.total },
      });
      return;
    }

    // ── GET /api/history ─────────────────────────────────────────────────
    // Every cell of every era, most-recent tree first. Dev mode is measured
    // once here (the same readDevMode the /api/devmode branch serves) and
    // broadcast onto every entry by history.mjs — one producer, carried.
    if (path === "/api/history" && req.method === "GET") {
      const dm = await readDevMode({ benchRoot: BENCH_ROOT });
      const devMode = {
        enabled: dm?.dev_mode?.enabled ?? false,
        source: dm?.dev_mode?.source ?? "default",
        file: dm?.state_file ?? null,
      };
      const runs = await listRunCells(RUNS_ROOT, devMode);
      sendJson(res, 200, { ok: true, runs });
      return;
    }

    // ── GET /api/history/checkpoints ─────────────────────────────────────
    // The cell's checkpoint index + diffs. A run without checkpoint history
    // degrades to nulls inside ok:true — absence is a state, not a failure.
    if (path === "/api/history/checkpoints" && req.method === "GET") {
      const r = await readCheckpointIndex(
        RUNS_ROOT,
        url.searchParams.get("run"),
        url.searchParams.get("cell"),
      );
      if (r.ok) sendJson(res, 200, r);
      else sendJson(res, r.status, { ok: false, code: r.code, reason: r.reason });
      return;
    }

    // ── GET /api/history/diff ────────────────────────────────────────────
    // One checkpoint diff as raw text — a diff is read, not parsed, so it is
    // served verbatim rather than wrapped in JSON.
    if (path === "/api/history/diff" && req.method === "GET") {
      const r = await readDiffText(
        RUNS_ROOT,
        url.searchParams.get("run"),
        url.searchParams.get("cell"),
        url.searchParams.get("path"),
      );
      if (r.ok) sendText(res, 200, r.text, "text/plain; charset=utf-8");
      else sendJson(res, r.status, { ok: false, code: r.code, reason: r.reason });
      return;
    }

    // ── GET /api/history/transcript ──────────────────────────────────────
    // The cell's transcript.md as raw markdown, verbatim.
    if (path === "/api/history/transcript" && req.method === "GET") {
      const r = await readTranscriptText(
        RUNS_ROOT,
        url.searchParams.get("run"),
        url.searchParams.get("cell"),
      );
      if (r.ok) sendText(res, 200, r.text, "text/markdown; charset=utf-8");
      else sendJson(res, r.status, { ok: false, code: r.code, reason: r.reason });
      return;
    }

    // ── POST /api/history/delete/preview ─────────────────────────────────
    //
    // What deleting this run would remove, in plain words, plus the token that
    // binds the confirmation to what is actually on disk. Nothing is touched.
    if (path === "/api/history/delete/preview" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const run = await readRunState({ runsRoot: RUNS_ROOT, launcher });
      const r = await planRunDelete(RUNS_ROOT, body?.run, body?.cell, {
        runInFlight: run.can_start !== true,
      });
      if (r.ok) sendJson(res, 200, r);
      else sendJson(res, r.status ?? 400, { ok: false, code: r.code, reason: r.reason, ...r });
      return;
    }

    // ── POST /api/history/delete ─────────────────────────────────────────
    //
    // PERMANENT. Unlike /api/tree/reset — which MOVES everything into
    // runs/backups/ and can be undone — this removes bytes. It is gated on the
    // preview's token, refuses the live tree, refuses while a run is in flight,
    // and refuses any archive whose layout it does not recognise rather than
    // deleting on a guess.
    if (path === "/api/history/delete" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const run = await readRunState({ runsRoot: RUNS_ROOT, launcher });
      const r = await deleteRun(RUNS_ROOT, body?.run, body?.cell, body?.confirm, {
        runInFlight: run.can_start !== true,
      });
      if (r.ok) sendJson(res, 200, r);
      else sendJson(res, r.status ?? 400, { ok: false, code: r.code, reason: r.reason, ...r });
      return;
    }

    // ── GET /api/play ────────────────────────────────────────────────────
    // What is being played right now, or null. Read from the server registry,
    // never from a variable in this process: the control plane restarts and a
    // play server outlives it.
    if (path === "/api/play" && req.method === "GET") {
      sendJson(res, 200, { ok: true, playing: playStatus(BENCH_ROOT) });
      return;
    }

    // ── POST /api/play/start ─────────────────────────────────────────────
    //
    // Boot one built result so a person can play it. This is the operator's
    // own check on what the grading says — see play.mjs for why that matters.
    //
    // It does NOT refuse while a cell is in flight. It used to have to: with a
    // fixed port there was exactly one address and the grader owned it. The
    // artifact now takes its port from the environment, play assigns a free
    // one, and the two no longer want the same thing.
    if (path === "/api/play/start" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const r = await startPlay({
        runsRoot: RUNS_ROOT,
        benchRoot: BENCH_ROOT,
        run: body?.run,
        cell: body?.cell,
      });
      if (r.ok) sendJson(res, 200, r);
      else sendJson(res, r.status ?? 400, { ok: false, code: r.code, reason: r.reason });
      return;
    }

    // ── POST /api/play/stop ──────────────────────────────────────────────
    // Idempotent: "nothing was running" is a result, not an error.
    if (path === "/api/play/stop" && req.method === "POST") {
      sendJson(res, 200, await stopPlay(BENCH_ROOT));
      return;
    }

    sendJson(res, 404, refuse("upstream_unwired", `no route ${req.method} ${path}`));
  } catch (err) {
    // Never swallow. The reason reaches the operator verbatim.
    sendJson(res, 500, refuse("launcher_failed", String(err?.message ?? err)));
  }
});

// 127.0.0.1 ONLY. There is deliberately no flag to change this.
server.listen(args.port, "127.0.0.1", () => {
  console.log(`bench control plane → http://127.0.0.1:${args.port}`);
  console.log(`  bench root : ${BENCH_ROOT}`);
  console.log(`  python     : ${PYTHON}${existsSync(PYTHON) ? "" : "  (MISSING)"}`);
  console.log(`  proxy      : ${args.proxyUrl}`);
  console.log(`  runtime    : ${args.runtimeUrl}`);
  console.log(`  serve      : ${args.serveUrl}  (event stream)`);
});
