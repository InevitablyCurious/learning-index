// PANEL: SEED FROM A BUILD SNAPSHOT — the dev-mode step of the baseline flow.
// Seeding skips the build (~5,600s, ~350 turns) and starts at the first
// troubleshooting round. A seeded cell is never a scorable floor, enforced
// independently in control/baselines.mjs and sources/stack-ledger.mjs. The
// control plane owns which snapshot is armed; this panel posts and re-reads.
// Every snapshot for the model is listed; ineligible ones carry their refusal.

import { esc, nul, tok, dur } from "../board.js";

/** The control plane's last answer; never the truth about what is armed. */
let state = { loaded: false, snapshots: [], armed: null, error: null, model: null };
let inFlight = false;
let lastAt = 0;
const MIN_INTERVAL_MS = 2000;

export function snapshotState() {
  return state;
}

/** The armed id or null (the confirm frame draws its caution from it). */
export function armedSnapshotId() {
  return state.armed?.snapshot_id ?? null;
}

/** The armed row, when the list has been read and carries it. */
export function armedSnapshot() {
  const id = armedSnapshotId();
  return id ? (state.snapshots.find((s) => s.id === id) ?? null) : null;
}

/**
 * Fire-and-forget, throttled, read on the next render. The model is sent
 * because the server decides seedability per row.
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
      // Unreachable is not empty: "we don't know" never reads as "none captured".
      state = { loaded: true, snapshots: [], armed: null, error: String(err?.message ?? err), model };
    })
    .finally(() => {
      inFlight = false;
      lastAt = Date.now();
    });
}

/** Arm or disarm, then re-read (the POST's answer isn't trusted as state). */
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

// ── THE FRAME BODY ──

/** The picker. Skipping is the default and always one click. */
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
 * The no-seed option, a peer of the snapshots: the normal way to run, and the
 * only one that produces a floor.
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
 * Corpus drift, shown and never disqualifying (seeded runs are dev-only); the
 * harness reports the same as a snapshot_validity_relaxed notice.
 */
function driftLine(s) {
  if (!s.source_commit) return "";
  return `<span class="sn-drift" data-note="drift">${esc(`built at ${String(s.source_commit).slice(0, 7)}`)}</span>`;
}

function refusedList(refused) {
  // Capped, with the count stated so the list is visibly partial.
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
 * The caution on the confirm frame (the .cwarn.override treatment): says this
 * is not a scorable floor, and what the seed saved.
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
