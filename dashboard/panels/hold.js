// PANEL: HOLD / PAUSE — a run pauses after a grade (or at the final grade) and
// the control plane holds it. The operator plays the game, reads the exact
// message the model is about to be told, leaves a note, then Continues or
// Stops. The control plane publishes only schema_version 2 holds (kind
// "round" | "final"); anything it cannot read arrives as invalid_schema and is
// said plainly, with Stop.
//   no hold file          render nothing
//   invalid_schema        the pause cannot be shown — the reason, and Stop
//   released              the hold vanished — released, the run continues
//   kind "round"          play the game, see told_text + grade, note, Continue/Stop
//   kind "final"          last grade; play it, note it; Continue ends the run
//   ui_healthy false      the game never came up — boot detail + log path, still
//                         Continue/Stop
//   bind.lan_reachable    the normal pause panel plus one quiet LAN line (never a
//                         failure band)
// Everything the server publishes (told_text, boot_detail, server_log, grade
// gate names, the LAN address) is model/operator-facing text and is escaped —
// rendered as text, never as HTML.

import { esc, nul, dur } from "../board.js";

// The pause panel's LOCAL UI — the note the operator types, which a poll must
// never erase, and the last release attempt's outcome. Reset when a NEW pause
// appears. Every pause of a cell reuses the same hold file, so a pause is
// identified by its path, kind, attempt and start time together.
const ui = { note: "", error: null, busy: false, seenPause: null };

function pauseKey(h) {
  if (!h) return null;
  return [h.hold_path ?? h.release?.path ?? "", h.kind ?? "", h.attempt ?? "", h.started_at ?? ""].join("|");
}

/** Note/error are tied to one pause; a new pause clears them. */
export function resetHoldUi(h) {
  const key = pauseKey(h);
  if (key !== ui.seenPause) {
    ui.note = "";
    ui.error = null;
    ui.busy = false;
    ui.seenPause = key;
  }
}

/** The operator's note. Clears any stale release error. */
export function setHoldNote(v) {
  ui.note = String(v ?? "");
  ui.error = null;
}

export function setHoldError(e) {
  ui.error = e ?? null;
}

export function setHoldBusy(b) {
  ui.busy = Boolean(b);
}

/** The current note, read by the release action at send time. */
export function holdNoteValue() {
  return ui.note;
}

export function renderHold(board) {
  const h = board.hold;
  // No hold: nothing at all.
  if (!h) return "";
  resetHoldUi(h);

  if (h.released) {
    // The hold vanished between poll and render: released.
    return band("released", "RELEASED", [`<div class="hold-line">Released. The run carries on from where it stopped.</div>`]);
  }

  if (h.invalid_schema || (h.kind !== "round" && h.kind !== "final")) {
    return band("error", "PAUSED — BUT THIS PAUSE CAN'T BE SHOWN", [
      `<div class="hold-line">The run is waiting, but the board can't read what it published: ${esc(h.reason ?? `unknown pause kind ${String(h.kind)}`)}</div>`,
      h.hold_path ? `<div class="note">${esc(h.hold_path)}</div>` : "",
      `<div class="hold-actions"><button class="btn destroy" data-stop-open="1">Stop the run</button></div>`,
    ]);
  }

  return renderPause(h);
}

// ── THE PAUSE PANEL ──────────────────────────────────────────────────────────

function renderPause(h) {
  const final = h.kind === "final";
  const attempt = h.attempt ?? "?";
  const max = h.max_attempts ?? "?";
  const healthy = h.ui_healthy === true;
  const lan = h.bind?.lan_reachable === true;

  const title = final
    ? `PAUSED — final grade (${attempt} of ${max})`
    : `PAUSED — round ${attempt} of ${max} graded`;

  const parts = [];

  parts.push(
    final
      ? `<div class="hold-line">This was the last grade; nothing more will be sent.</div>`
      : `<div class="hold-line">Nothing has been sent to the model yet. It is waiting for you.</div>`,
  );

  if (Number.isFinite(h.held_seconds)) {
    parts.push(`<div class="hold-line">Paused for <span class="bright">${esc(dur(h.held_seconds))}</span>.</div>`);
  }

  parts.push(gradeLine(h.grade));

  parts.push(playBox(h, healthy));

  if (!final) parts.push(toldBlock(h));

  parts.push(noteBox(final));

  if (lan) parts.push(lanLine(h));

  parts.push(actionsRow(final));

  return band("paused", title, parts);
}

/** The grade as one line: problems, failing checks, and the first few gate names. */
function gradeLine(g) {
  if (!g) return `<div class="hold-line">${nul("no grade published")}</div>`;
  const n = g.n_problems ?? "?";
  const failing = Array.isArray(g.failed_gates) ? g.failed_gates.length : 0;
  const verdict = g.verdict;
  const checkWord = verdict === "PASS" ? "every check passes" : `${failing} check${failing === 1 ? "" : "s"} failing`;
  const names = verdict === "PASS" ? [] : (g.failed_gates ?? []).slice(0, 3);
  const nameText = names.length ? ` — ${names.map((x) => esc(x)).join(", ")}` : "";
  return `
    <div class="hold-line">
      <span class="bright">${esc(`${n} problems`)}</span>; ${esc(checkWord)}${nameText}
    </div>`;
}

/** Play the game. If the game never came up, say so and show the boot detail. */
function playBox(h, healthy) {
  if (!healthy) {
    return `
      <div class="hold-line">The game did not start.</div>
      ${diag(h)}
      <div class="note">It is paused all the same — you can stop it or continue. The model is waiting either way.</div>`;
  }
  const url = h.url;
  if (!url) return `<div class="hold-line">${nul("no play url")}</div>`;
  return `
    <div class="hold-actions">
      <a class="btn primary" href="${esc(url)}" target="_blank" rel="noreferrer noopener">▶ Play the game as it is now</a>
      <span class="note">opens in a new tab</span>
    </div>`;
}

/** The exact message about to be sent — escaped, in a readable pre-wrapped block. */
function toldBlock(h) {
  const text = h.told_text;
  const kick = `<span class="kick">What the model will be told next:</span>`;
  if (text === null || text === undefined) {
    return `
      <div class="hold-told">
        ${kick}
        <div class="null">${nul("no message pending")}</div>
      </div>`;
  }
  return `
    <div class="hold-told">
      ${kick}
      <pre class="hold-pre">${esc(text)}</pre>
    </div>`;
}

/** The note box: 4000-char limit, live count, error surfaced right here. */
function noteBox(final) {
  const note = ui.note;
  const over = note.length > 4000;
  const label = final
    ? "Your note on the final build (saved for Claude, never sent to the model)"
    : "Your note for this round (saved for Claude, never sent to the model)";
  return `
    <div class="hold-note">
      <label class="kick" for="hold-note">${esc(label)}</label>
      <textarea id="hold-note" class="hold-note-ta" data-hold-note="1" rows="3" maxlength="4000" aria-label="${esc(label)}">${esc(note)}</textarea>
      <span class="note ${over ? "danger" : ""}">${esc(`${note.length} / 4000`)}</span>
      ${ui.error ? `<div class="hold-err" role="alert">${esc(ui.error)}</div>` : ""}
    </div>`;
}

/** Continue sends the message (plus the note, if any); Stop uses the STOP flow. */
function actionsRow(final) {
  const label = final ? "Continue — end the run" : "Continue — send this to the model";
  return `
    <div class="hold-actions">
      <button class="btn primary" data-hold-continue="1" ${ui.busy ? "disabled" : ""}>${esc(label)}</button>
      <button class="btn destroy" data-stop-open="1">Stop the run</button>
    </div>`;
}

/** One quiet LAN line — a network-visible game, never a failure band. */
function lanLine(h) {
  return `<div class="note">While paused, this game can also be reached from other devices on your network (${esc(h.bind?.lan_address ?? "your LAN")}).</div>`;
}

function band(kind, title, parts) {
  return `
    <section class="hold ${kind}">
      <div class="phead">
        <span class="ttl ${kind === "error" ? "danger" : ""}">${esc(title)}</span>
      </div>
      ${parts.join("")}
    </section>`;
}

/** Verbatim boot failure. Model/tool output — escaped, never interpreted. */
function diag(h) {
  const boot = h.boot_detail;
  const log = h.server_log;
  return `
    <div class="hold-diag">
      <span class="kick">boot_detail</span>
      <span>${boot ? esc(boot) : nul("not captured")}</span>
      <span class="kick">server_log</span>
      <span>${log ? esc(Array.isArray(log) ? log.join("\n") : log) : nul("not captured")}</span>
    </div>`;
}