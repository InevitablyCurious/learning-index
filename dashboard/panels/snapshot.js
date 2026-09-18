// ─────────────────────────────────────────────────────────────────────────────
// PANEL: SEED FROM A BUILD SNAPSHOT — the dev-mode step of the baseline branch
//
// A snapshot is a captured worktree, taken automatically at the attempt-1 grade
// boundary of every baseline. Seeding a cell from one skips the build phase —
// measured at ~5,600 wall-seconds and ~350 turns on this bench — so the run
// starts at the first troubleshooting round, which is what the benchmark is
// actually trying to measure.
//
// ── IT IS A DEVELOPMENT FEATURE, AND THE BOARD SAYS SO EVERYWHERE ───────────
// A seeded cell is NEVER a scorable floor (dev-benchmark-snapshot.md §5). Its
// turns, tokens and wall time sit on a scale no unseeded cell shares, so a delta
// measured against it measures the absence of a build rather than the presence
// of memory. That safety property is enforced in TWO folds that do not know
// about each other — `control/baselines.mjs` for the ledger and
// `dashboard/sources/stack-ledger.mjs` for the transfer curve — and never
// depends on the operator having read anything here.
//
// ── THE SERVER OWNS THE SELECTION ───────────────────────────────────────────
// Arming POSTs to the control plane and this panel re-reads the answer; the
// armed id is never held here as truth. Same argument dev mode itself is built
// on: a seed carried by the browser would mean the control plane trusts the
// browser's claim about what run it is starting. `/api/run/start` reads the
// armed snapshot from its own state, so what is confirmed and what is run are
// the same value from the same read.
//
// ── INELIGIBLE SNAPSHOTS ARE LISTED, NOT HIDDEN ─────────────────────────────
// A snapshot an operator captured and then cannot find in this list teaches
// them nothing by its absence — "why is it not here" is precisely the question
// a filtered list cannot answer. So every snapshot for this model is shown, and
// the ones that cannot seed carry their producer's own refusal sentence.
// ─────────────────────────────────────────────────────────────────────────────

import { esc, nul, tok, dur } from "../board.js";

/**
 * Server state, read on demand. Never the source of truth for what is armed —
 * that is the control plane, and this is the last answer it gave.
 */
let state = { loaded: false, snapshots: [], armed: null, error: null, model: null };
let inFlight = false;
let lastAt = 0;
const MIN_INTERVAL_MS = 2000;

export function snapshotState() {
  return state;
}

/** The armed id, or null. Read by the confirm frame to draw its caution. */
export function armedSnapshotId() {
  return state.armed?.snapshot_id ?? null;
}

/** The armed row, when the list has been read and carries it. */
export function armedSnapshot() {
  const id = armedSnapshotId();
  return id ? (state.snapshots.find((s) => s.id === id) ?? null) : null;
}

/**
 * Fire-and-forget refresh, throttled, read on the NEXT render.
 *
 * Render stays synchronous: the frame draws from whatever is known and the
 * board re-renders on its own poll, so a reading taken now appears a beat
 * later. The model is part of the request because the same-model rule is
 * applied per row by the server — this panel never decides seedability itself.
 */
export function refreshSnapshots(model) {
  if (inFlight) return;
  const now = Date.now();
  if (state.loaded && state.model === model && now - lastAt < MIN_INTERVAL_MS) return;
  inFlight = true;
  const url = `/api/snapshots${model ? `?model=${encodeURIComponent(model)}` : ""}`;
  fetch(url)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((body) => {
      state = {
        loaded: true,
        snapshots: Array.isArray(body?.snapshots) ? body.snapshots : [],
        armed: body?.armed ?? null,
        error: null,
        model,
      };
    })
    .catch((err) => {
      // UNREACHABLE IS NOT EMPTY. An empty list means nothing was captured; a
      // failed read means we do not know. Rendering the first as the second
      // would tell an operator their snapshots are gone.
      state = { loaded: true, snapshots: [], armed: null, error: String(err?.message ?? err), model };
    })
    .finally(() => {
      inFlight = false;
      lastAt = Date.now();
    });
}

/** Arm or disarm, then re-read. The POST's own answer is not trusted as state. */
export function armSnapshot(id, model) {
  fetch(`/api/snapshots/arm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshot_id: id, model }),
  })
    .then((r) => r.json().then((b) => ({ ok: r.ok, b })))
    .then(({ ok, b }) => {
      if (!ok) state = { ...state, error: b?.reason ?? "the control plane refused the selection" };
      lastAt = 0; // force the next refresh
      refreshSnapshots(model);
    })
    .catch((err) => {
      state = { ...state, error: String(err?.message ?? err) };
    });
}

// ── THE FRAME BODY ──────────────────────────────────────────────────────────

/**
 * The picker, as the baseline branch's dev-mode step.
 *
 * SKIPPING IS THE DEFAULT AND IS ALWAYS ONE CLICK. The step exists to offer a
 * shortcut, so "no snapshot" must never be harder to choose than a snapshot —
 * an operator who opened this step by accident has to be able to leave it in
 * the state they arrived in.
 */
export function renderSeedFrame(model) {
  const rows = state.snapshots;
  const seedable = rows.filter((s) => s.seedable);
  const refused = rows.filter((s) => !s.seedable);
  const armed = armedSnapshotId();

  if (state.error) {
    return `
      <div class="cwarn override" role="note">
        <span class="cwarn-head">SNAPSHOTS COULD NOT BE READ</span>
        <span class="cwarn-body">${esc(state.error)}</span>
        <span class="cwarn-body">${esc(
          "This is not an empty list — the control plane did not answer, so what has been captured is unknown. Continue without a seed, or fix the control plane and come back.",
        )}</span>
      </div>
      ${skipRow(armed)}`;
  }

  if (!state.loaded) {
    return `<div class="sn-empty">${esc("reading captured snapshots…")}</div>${skipRow(armed)}`;
  }

  if (!seedable.length) {
    return `
      <div class="sn-empty">
        ${esc(
          rows.length
            ? `nothing captured by ${model ?? "this model"} can seed a run — seeding is same-model only, and every snapshot below was built by another model or by a cell that failed.`
            : "no build snapshots have been captured yet. One is written automatically at the end of every baseline's first grade.",
        )}
      </div>
      ${skipRow(armed)}
      ${refused.length ? refusedList(refused) : ""}`;
  }

  return `
    ${skipRow(armed)}
    <div class="sn-list">${seedable.map((s) => seedRow(s, armed)).join("")}</div>
    ${refused.length ? refusedList(refused) : ""}`;
}

/**
 * The no-seed option, drawn as a peer of the snapshots rather than as an
 * absence. It is the normal way to run a baseline and the only one that
 * produces a floor, so it reads as a choice, not as a cancel.
 */
function skipRow(armed) {
  const on = !armed;
  return `
    <button class="sn-row sn-skip${on ? " on" : ""}" data-seed-pick="" aria-pressed="${on}">
      <span class="sn-mark">${on ? "✓" : "○"}</span>
      <span class="sn-main">
        <span class="sn-id">BUILD FROM SCRATCH — no seed</span>
        <span class="sn-meta">${esc("the normal baseline. Runs the six build chunks, and is the only kind of cell that can become a floor.")}</span>
      </span>
    </button>`;
}

function seedRow(s, armed) {
  const on = s.id === armed;
  const g = s.gate_totals ?? {};
  const c = s.build_cost ?? {};
  const gates =
    Number.isFinite(g.pass) && Number.isFinite(g.total)
      ? `${g.pass}/${g.total} gates passing`
      : nul("gate tally unobserved");
  const skipped = [
    Number.isFinite(c.turns) ? `${c.turns} turns` : null,
    Number.isFinite(c.total_tokens) ? (tok(c.total_tokens) ?? null) : null,
    Number.isFinite(c.wall_seconds) ? (dur(Math.round(c.wall_seconds)) ?? null) : null,
  ].filter(Boolean);

  return `
    <button class="sn-row${on ? " on" : ""}" data-seed-pick="${esc(s.id)}" aria-pressed="${on}">
      <span class="sn-mark">${on ? "✓" : "○"}</span>
      <span class="sn-main">
        <span class="sn-id">${esc(s.id)}<span class="sn-when">${esc(s.created_at ? String(s.created_at).slice(0, 16).replace("T", " ") : "")}</span></span>
        <span class="sn-meta">${gates}${skipped.length ? ` · skips ${esc(skipped.join(" · "))}` : ""}</span>
        ${driftLine(s)}
      </span>
    </button>`;
}

/**
 * Corpus drift, shown and never used to disqualify.
 *
 * D-SNAP-DEVMODE-EXCEPTIONS (Jerry, 2026-09-05): dev mode is the operator's own
 * fast-iteration tool and a seeded run is not a publicly defendable data point,
 * so `source_commit` and corpus-identity drift warn and proceed. The harness
 * emits the same fact as a `snapshot_validity_relaxed` notice when the run
 * starts, so what is shown here and what the run reports agree.
 */
function driftLine(s) {
  if (!s.source_commit) return "";
  return `<span class="sn-drift" data-note="drift">${esc(`built at ${String(s.source_commit).slice(0, 7)}`)}</span>`;
}

function refusedList(refused) {
  // Capped: the store accumulates a snapshot per test run, and a wall of
  // refusals nobody can act on is noise. The count is stated so the list is
  // visibly partial rather than quietly truncated.
  const SHOW = 4;
  const shown = refused.slice(0, SHOW);
  return `
    <div class="sn-refused">
      <span class="sn-refused-head">${esc(
        `${refused.length} snapshot${refused.length === 1 ? "" : "s"} cannot seed this run`,
      )}</span>
      ${shown
        .map(
          (s) => `<span class="sn-refused-row"><b>${esc(s.id)}</b> ${esc(s.seedable_reason ?? "refused")}</span>`,
        )
        .join("")}
      ${refused.length > SHOW ? `<span class="sn-refused-row">${esc(`…and ${refused.length - SHOW} more`)}</span>` : ""}
    </div>`;
}

/**
 * THE CAUTION ON THE CONFIRM FRAME.
 *
 * Reuses the `.cwarn.override` treatment the compaction-off warning already
 * uses, because it is the same class of statement: the operator has actively
 * chosen something that changes what the cell measures, and the consequence is
 * invisible until hours later.
 *
 * It must say the load-bearing thing — that this is NOT a scorable floor — and
 * it must say what was bought, so the trade is legible rather than implied.
 */
export function seedWarning() {
  const s = armedSnapshot();
  const id = armedSnapshotId();
  if (!id) return "";
  const c = s?.build_cost ?? {};
  const g = s?.gate_totals ?? {};
  const bought = [
    Number.isFinite(c.turns) ? `${c.turns} turns` : null,
    Number.isFinite(c.total_tokens) ? (tok(c.total_tokens) ?? null) : null,
    Number.isFinite(c.wall_seconds) ? (dur(Math.round(c.wall_seconds)) ?? null) : null,
  ].filter(Boolean);

  return `
    <div class="cwarn override" role="note">
      <span class="cwarn-head">SEEDED FROM A BUILD SNAPSHOT — NOT A SCORABLE FLOOR</span>
      <span class="cwarn-body">${esc(
        `This cell starts from snapshot ${id}${s?.author_model ? `, built by ${s.author_model}` : ""}${
          Number.isFinite(g.fail) ? ` at ${g.fail} failing gates` : ""
        }, instead of building the scaffold. It runs no build chunks and begins at the first troubleshooting round.`,
      )}</span>
      <span class="cwarn-body">${esc(
        bought.length
          ? `It skips the ${bought.join(" · ")} that build cost — which is also why it can never be a floor: its totals sit on a different scale from every unseeded cell, so no delta measured against it would mean anything.`
          : "It can never be a floor: its totals sit on a different scale from every unseeded cell, so no delta measured against it would mean anything.",
      )}</span>
      <span class="cwarn-body">${esc(
        "The board enforces this — a seeded cell is excluded from the ledger's floors and from the transfer curve's baseline, whether or not anyone reads this warning.",
      )}</span>
    </div>`;
}
