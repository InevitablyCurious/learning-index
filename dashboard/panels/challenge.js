// ─────────────────────────────────────────────────────────────────────────────
// THE CHALLENGE STEP — what this baseline is measured on
//
// A challenge is what the cell builds and what the gates grade. Backgammon is
// the one that ships; anything cloned into `challenges/` appears here beside it.
//
// PINNED AT THE BASELINE. The choice is made once, on the first cell. Every
// later cell of that baseline builds the same thing, so the step never returns
// — a baseline whose cells built different challenges would produce a delta
// measuring the challenge rather than the model.
//
// SERVER STATE, FETCHED. The list comes from the control plane, which reads the
// manifests on disk. A challenge that cannot run is still listed, with the
// reason, because a picker that hides what the operator just cloned sends them
// hunting through directories.
// ─────────────────────────────────────────────────────────────────────────────

import { esc } from "../board.js";

const MIN_INTERVAL_MS = 5000;

let state = { loaded: false, challenges: [], error: null };
let inFlight = false;
let lastAt = 0;

/** Fire-and-forget, read on the next render — the seed step's shape. */
export function refreshChallenges() {
  if (inFlight) return;
  const now = Date.now();
  if (state.loaded && now - lastAt < MIN_INTERVAL_MS) return;
  inFlight = true;
  fetch(`/api/challenges`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((body) => {
      state = {
        loaded: true,
        challenges: Array.isArray(body?.challenges) ? body.challenges : [],
        error: null,
      };
    })
    .catch((err) => {
      state = { loaded: true, challenges: [], error: String(err?.message ?? err) };
    })
    .finally(() => {
      inFlight = false;
      lastAt = Date.now();
    });
}

export function challengeState() {
  return state;
}

/** The one to start on: the only ready challenge, when there is exactly one. */
export function soleReadyChallenge() {
  const ready = state.challenges.filter((c) => c.ready);
  return ready.length === 1 ? ready[0].id : null;
}

export function challengeById(id) {
  return state.challenges.find((c) => c.id === id) ?? null;
}

/** The list, as rows. Unrunnable ones are shown with their reason, never hidden. */
export function renderChallengeList(selected) {
  if (!state.loaded) return `<div class="cl-note">reading challenges…</div>`;
  if (state.error) {
    return `<div class="cl-note bad">the control plane could not list challenges — ${esc(state.error)}</div>`;
  }
  if (!state.challenges.length) {
    return `<div class="cl-note bad">no challenges found. The example lives in task/, and your own go in challenges/.</div>`;
  }
  return state.challenges
    .map((c) => {
      const on = c.id === selected;
      const attr = c.ready ? ` data-create-challenge="${esc(c.id)}"` : "";
      return `
        <div class="cl-row ${c.ready ? "" : "blocked"}${on ? " on" : ""}"${attr} role="button" tabindex="${c.ready ? 0 : -1}">
          <span class="cl-dot">${on ? "◉" : c.ready ? "○" : "✗"}</span>
          <span class="cl-body">
            <span class="cl-name">${esc(c.name)}${c.bundled ? ` <span class="cl-tag">example</span>` : ""}</span>
            <span class="cl-meta">${esc(c.ready ? c.summary : c.blocked_reason ?? "cannot be run")}</span>
          </span>
        </div>`;
    })
    .join("");
}
