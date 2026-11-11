// CONTROL PLANE — START VALIDATION: every precondition a start must satisfy,
// each with its own reason; finishValidate is the substrate-blind half both
// substrates share, and the one place the compaction default is resolved.

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { findChallenge } from "../challenges.mjs";
import { confirmationToken, restatement, refuse } from "../contract.mjs";
import {
  resolveCloudModel,
  readCloudKey,
  CLOUD_API_KEY_ENV,
  COMPACT_DEFAULT_CEILING,
} from "../cloud.mjs";
import { substrateRefreshInFlight } from "../tooljobs.mjs";
// The serial gate's one source of in-flight truth: the N-slot run ledger.
import { inFlightModels } from "../run-ledger.mjs";
import { args, BENCH_ROOT } from "../state.mjs";

/**
 * Validate a start request. Preview runs every parameter check but cannot
 * require the confirmation token (minting it is what preview is for); start
 * requires it. `devPause` is the SERVER's dev mode (devmode.mjs), resolved by
 * the route: it is not a request field, and it is bound into the token so a
 * preview shown in one mode cannot start a run in the other.
 */
export async function validateStart(
  payload,
  roster,
  run,
  { requireConfirm = true, runsRoot = null, allowRefresh = false, devPause = false } = {},
) {
  const model = typeof payload?.model === "string" ? payload.model.trim() : "";
  const arm = payload?.arm === "on" || payload?.arm === "off" ? payload.arm : null;
  const org = typeof payload?.org === "string" && payload.org.trim() ? payload.org.trim() : null;
  // Tri-state: true/false are the operator's choice; undefined means the model's
  // context window decides (in finishValidate). Never coerced to false.
  const compactRequested =
    payload?.compact === true ? true : payload?.compact === false ? false : null;
  // Plain boolean: no server default, so absent means off.
  const requireTodos = payload?.requireTodos === true;
  // Absent = the installation's default challenge. Named, it must exist and be
  // runnable.
  const challengeId = typeof payload?.challenge === "string" ? payload.challenge.trim() : "";
  // Grading machine share, validated here; absent = the container's default.
  const rawTarget = Number(payload?.graderWorkerTarget);
  const graderWorkerTarget =
    Number.isFinite(rawTarget) && rawTarget > 0 && rawTarget <= 1 ? rawTarget : null;
  // The substrate is declared (`kind`), never sniffed from the model id.
  // Defaults to local; anything else is refused by name.
  const kind = payload?.kind === "cloud" ? "cloud" : payload?.kind === "local" || payload?.kind === undefined || payload?.kind === null ? "local" : String(payload.kind);

  // ── THE SERIAL GATE ── PER MODEL, from the run ledger (run-ledger.mjs):
  // a model with a cell in flight is serial until that cell closes, because a
  // second concurrent cell on it contends for its single resident slot and
  // corrupts the timing evidence of both. Different models may run
  // concurrently — another model's cell never blocks this start.
  // `run.can_start` is the caller's now-fact channel, not a second in-flight
  // source: preview passes can_start:true to skip the gate (reviewing stays
  // possible while a cell is in flight; the advisory rides the preview answer
  // — routes/run.mjs), and a run state that sees nothing live skips it too,
  // so a ledger slot whose process AND log are both gone never wedges the
  // model shut.
  if (run?.can_start !== true && inFlightModels().has(model)) {
    return refuse("run_in_flight", `a cell for ${model} is already in flight — this model is serial`);
  }
  // The symmetric guard: a substrate-changing refresh (refuse_while_running)
  // may not overlap a cell, and a cell may not launch onto a moving substrate.
  // Preview skips it like the serial gate — reviewing stays possible; the
  // advisory rides the preview answer (routes/run.mjs).
  if (!allowRefresh) {
    const refresh = substrateRefreshInFlight(BENCH_ROOT);
    if (refresh) {
      return refuse(
        "refresh_in_flight",
        `'${refresh.tool_name}' is running and changes what a cell would be measured ` +
          `against — launching now would contaminate the measurement. Wait for it to ` +
          `finish; the ☰ menu shows it live.`,
        { tool_id: refresh.tool_id, job_id: refresh.id },
      );
    }
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

  // Cloud differs only in the identity checks (it isn't on the local roster).
  // It returns an `entry` in the roster's shape so everything after — org rule,
  // baseline gate, token — is shared, with one copy of the baseline gate.
  if (kind === "cloud") {
    const cloud = resolveCloudModel(model);
    if (!cloud.ok) return refuse(cloud.code, cloud.reason);

    // The key is checked here, before a campaign folder is built.
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
      { model, arm, org, kind, entry: cloudEntry, cloud, compactRequested, requireTodos, graderWorkerTarget, challengeId },
      { requireConfirm, runsRoot, payload, devPause },
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
    // A retired alias and an interactive slot are refused with different reasons.
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
    { model, arm, org, kind, entry, cloud: null, compactRequested, requireTodos, challengeId },
    { requireConfirm, runsRoot, payload, devPause },
  );
}

/**
 * Every rule blind to the substrate, i.e. everything but identity. One copy
 * of the baseline gate for both substrates. `entry` is the roster row, or a
 * synthesised row of the same shape for cloud.
 */
/**
 * Where compaction defaults on — the only place this rule lives. Below
 * COMPACT_DEFAULT_CEILING the build crowds out the repair phase, so it starts
 * on. Reads the smaller of the declared and runtime windows; an unknown window
 * defaults on (six turns is cheap next to running out of room).
 */
export function compactDefaultFor(entry) {
  const declared = Number(entry?.declared_context);
  const max = Number(entry?.max_context);
  const known = [declared, max].filter((n) => Number.isFinite(n) && n > 0);
  if (!known.length) return true;
  return Math.min(...known) < COMPACT_DEFAULT_CEILING;
}

/**
 * RESUME FROM A CHECK-POINT (dev loop step 6). `payload.resume` is
 * `{ checkpoint, phase? }`: a `cp-NN` directory under the runs root (relative to
 * it, or absolute inside it) and, for a check-point recorded before it carried
 * its build phase, the phase-plan index it was graded at. Dev mode only — a
 * resumed cell skips the work before its check-point and is never a
 * measurement. Returns `{ resume }` (null when absent) or `{ refused }`.
 */
export async function resolveResume(raw, { runsRoot, devPause }) {
  if (raw === undefined || raw === null) return { resume: null };
  if (!devPause) {
    return { refused: refuse("resume_needs_dev_mode",
      "resuming from a check-point is a dev-mode run — turn dev mode on first") };
  }
  const given = typeof raw?.checkpoint === "string" ? raw.checkpoint.trim() : "";
  if (!given || !runsRoot) {
    return { refused: refuse("resume_checkpoint_missing", "name the check-point directory (…/checkpoints/cp-NN)") };
  }
  const abs = isAbsolute(given) ? resolve(given) : resolve(runsRoot, given);
  const rel = relative(resolve(runsRoot), abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return { refused: refuse("resume_checkpoint_outside", `${given} is not under the runs root`) };
  }
  let meta = null;
  try {
    const tree = await stat(join(abs, "tree"));
    if (!tree.isDirectory()) throw new Error("tree is not a directory");
    meta = JSON.parse(await readFile(join(abs, "cp.json"), "utf8"));
  } catch (err) {
    return { refused: refuse("resume_checkpoint_invalid",
      `${rel} is not a check-point (needs cp.json and tree/): ${err?.message ?? err}`) };
  }
  const asked = raw?.phase === undefined || raw?.phase === null ? null : Number(raw.phase);
  if (asked !== null && !(Number.isInteger(asked) && asked > 0)) {
    return { refused: refuse("resume_phase_invalid", "phase must be a positive whole number") };
  }
  const recorded = Number.isInteger(meta?.build_phase) ? meta.build_phase : null;
  if (asked !== null && recorded !== null && asked !== recorded) {
    return { refused: refuse("resume_phase_conflict",
      `${rel} was graded at phase ${recorded}, not ${asked}`) };
  }
  const phase = asked ?? recorded;
  if (phase === null) {
    return { refused: refuse("resume_phase_unknown",
      `${rel} records no build phase — pass the phase it was graded at`) };
  }
  return { resume: { checkpoint: abs, rel, phase, attempt: meta?.attempt ?? null } };
}

export async function finishValidate(
  { model, arm, org, kind, entry, cloud, compactRequested = null, requireTodos = false, graderWorkerTarget = null, challengeId = "" },
  { requireConfirm, runsRoot, payload, devPause = false },
) {
  // The org is an optional label on an ON cell (the memory system's own settings
  // say where its memory lives); a CONTROL cell must not carry one.
  if (arm === "off" && org) {
    return refuse("org_forbidden", "a CONTROL cell must not carry an org — it writes no memories");
  }

  // ── NO BASELINE GATE ── an ON cell launches standalone. There is no floor to
  // pick and none to require: its Δ is read afterwards against the average of
  // every baseline sharing its fingerprint (models-ledger.mjs `deltaOf`), and it
  // states "no baselines on this fingerprint" rather than inventing a zero. A
  // missing baseline is therefore a fact about the history, never a lock on the
  // launch — the only gates left are capacity (the N-slot ledger) and the
  // roster's own eligibility.

  // The operator's explicit choice wins; otherwise the model's window decides.
  const compact = compactRequested ?? compactDefaultFor(entry);

  const resumed = await resolveResume(payload?.resume, { runsRoot, devPause });
  if (resumed.refused) return resumed.refused;
  const resume = resumed.resume;

  // The pause after each grade is the server's dev mode (devmode.mjs), derived
  // by the route and passed in: it halts the run for a human every grade, which
  // is not a scorable automated measurement, and no request field can turn it on.
  const expected = confirmationToken({ model, arm, org, kind, compact, devPause, resume });
  if (requireConfirm && payload?.confirm !== expected) {
    return refuse(
      "bad_confirmation",
      "the confirmation did not match these parameters — they changed after the " +
        "preview was shown. Review the restatement and confirm again.",
      {
        expected_token: expected,
        restatement: restatement({ model, arm, org, kind, cloud, compact, devPause, resume }),
      },
    );
  }

  let challenge = null;
  if (challengeId) {
    challenge = await findChallenge(BENCH_ROOT, challengeId);
    if (!challenge) {
      return refuse("challenge_unknown",
        `no challenge '${challengeId}' — clone it into challenges/ or pick one the board lists`);
    }
    if (!challenge.ready) {
      return refuse("challenge_not_runnable",
        `'${challengeId}' cannot be run: ${challenge.blocked_reason}`);
    }
  }

  return { ok: true, model, arm, org, kind, entry, cloud, compact, requireTodos, graderWorkerTarget, challenge, resume };
}
