// ─────────────────────────────────────────────────────────────────────────────
// CONTROL PLANE — START VALIDATION
//
// Split out of server.mjs (LI-14 phase 1), byte-verbatim: every precondition a
// start must satisfy, each with its own stated reason, plus the
// substrate-blind half (finishValidate) both substrates fall through and the
// one place the compaction default is written.
// ─────────────────────────────────────────────────────────────────────────────

import { confirmationToken, restatement, refuse } from "../contract.mjs";
import { CONTEXT_CHOICES } from "../roster.mjs";
import { baselineFor, collectOffCells } from "../baselines.mjs";
import {
  resolveCloudModel,
  readCloudKey,
  CLOUD_API_KEY_ENV,
  COMPACT_DEFAULT_CEILING,
} from "../cloud.mjs";
import { resolveDevMode } from "../devmode.mjs";
import { readSnapshot, seedableBy, resolveArmed } from "../snapshots.mjs";
import { args, BENCH_ROOT, RUNS_ROOT } from "../state.mjs";

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
export async function validateStart(
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
export function compactDefaultFor(entry) {
  const declared = Number(entry?.declared_context);
  const max = Number(entry?.max_context);
  const known = [declared, max].filter((n) => Number.isFinite(n) && n > 0);
  if (!known.length) return true;
  return Math.min(...known) < COMPACT_DEFAULT_CEILING;
}

export async function finishValidate(
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
