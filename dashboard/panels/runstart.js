// ─────────────────────────────────────────────────────────────────────────────
// PANEL: RUN START — the only surface that can begin a benchmark cell
//
// ── PROVENANCE: PORTED, NOT REWRITTEN ───────────────────────────────────────
//
// The arm→confirm protocol here is carried over from the previous drawer
// implementation, which was fully dead code: `panels/drawer.js` was served by
// server.mjs but imported by nothing, its CSS had been dropped, and it was
// therefore the ONLY run-start UI in the tree while being unreachable from the
// board. That file is deleted; this is where its logic now lives.
//
// Every behaviour below exists because its absence was a real defect, so none
// of it was re-derived:
//
//   · THE TOKEN IS MINTED BY THE SERVER, NEVER THE BROWSER. A client-generated
//     confirmation confirms nothing the server can trust. PREVIEW returns both
//     the token and the restatement, and the token is echoed back verbatim.
//   · THE RESTATEMENT IS THE SERVER'S WORDS. The words the operator reads are
//     the words the server will act on; a client-composed summary can drift
//     from the payload it claims to describe.
//   · ANY PARAMETER CHANGE DISARMS. The token fingerprints the parameters, so
//     silently reusing it would start a run the operator never agreed to.
//   · ON NEEDS AN ORG, OFF FORBIDS ONE. Enforced in the form so the operator
//     learns the rule before the refusal rather than after committing.
//   · REFUSALS RENDER VERBATIM WITH THEIR CODE. Every refusal reason in the
//     control plane was written for a human reading a stream; paraphrasing
//     strips exactly the detail needed to fix the cause.
//   · RESUME IS REFUSED IN THE UI, WITH ITS REASON. The harness has no mid-cell
//     checkpoint. A button that always 501s implies a capability that does not
//     exist.
//
// ── THE FOUR STATES (design 5b) ─────────────────────────────────────────────
//
//   IDLE       single press arms the confirm step
//   BLOCKED    disabled WITH THE REASON ON THE CONTROL, never a tooltip — a
//              control disabled without saying why is indistinguishable from a
//              broken one, and nobody on a stream can hover
//   LIVE       a cell is already running: "ARE YOU SURE?" naming what is lost
//   STARTING   an elapsed counter runs so the wait is visibly bounded, not hung
//
// ── THE CONFIRMATION IS NOT DECORATIVE ──────────────────────────────────────
// Starting a run while a cell is live ABANDONS that cell. The campaign is
// strictly serial — one resident local model, one slot — so there is no queue
// to fall back on, and a partial cell is never graded and never enters the
// curve. A benchmark cell costs hours, so the second click is the cheapest
// insurance on the board.
// ─────────────────────────────────────────────────────────────────────────────

import { esc, clip, dur } from "../board.js";

/**
 * Local UI state. Never derived from the board payload — it describes what the
 * OPERATOR is doing, which no poll can know.
 */
const ui = {
  // `arm` has NO default on purpose. It decides whether an org is required (ON)
  // or forbidden (OFF), so guessing it would either mint a run against the
  // wrong arm or produce a restatement reading "UNKNOWN ARM".
  //
  // `kind` DOES default to local, and that asymmetry is deliberate: local is
  // what every cell before cloud routing existed was, so it is the state of the
  // world rather than a guess, and the failure mode of getting it wrong is
  // one-directional — a cloud cell mislabelled local is refused by the roster
  // lookup, while a local cell mislabelled cloud would be billed.
  sel: { model: "", arm: "", org: "", kind: "local" },
  pending: false,
  refusal: null,
  // The stop flow: armed holds the confirm token, so a stop is preview-then-
  // confirm exactly like a start. A one-click abort of a paid, hours-long cell
  // is not a button anyone should have.
  stopArmed: null,
  stopRestatement: null,
  stopBusy: false,
  stopError: null,

  // Set when START fires, cleared once run state reports a live cell. Drives
  // the STARTING counter.
  startedAt: null,
};

/**
 * PRESET FROM THE LEDGER. [+ BASELINE] and a baseline row's [+ run]
 * both land here.
 *
 * IT PREFILLS AND ARMS — IT DOES NOT LAUNCH. A benchmark cell costs ~3 hours
 * and starting one while another is live abandons that cell, so the second
 * click is the cheapest insurance on the board (see the header). Wiring the
 * ledger buttons straight to `startRun` would delete exactly that protection
 * for the two paths most likely to be clicked by reflex.
 *
 * The org is deliberately NOT guessed for an ON cell: the server refuses an ON
 * cell with no org, and inventing one would either target the wrong corpus or
 * produce a restatement the operator cannot check.
 */

/**
 * THE LIFECYCLE, PUBLISHED FOR THE STARTUP FEED.
 *
 * `ui` is module-private on purpose, but its state WAS the operator's blind
 * spot: an armed-and-unconfirmed run and a refused preview both lived here and
 * were painted by exactly one surface (`renderRunControl`), which was reachable
 * only through the profile inspector — a dialog that opened only when a profile
 * existed. When it was not on screen the failure existed and was invisible. The
 * inspector is gone; the run control is raised on its own (overlay.js) the
 * moment there is something to confirm or a refusal to read.
 *
 * A READ-ONLY SNAPSHOT, NOT THE OBJECT. Handing out `ui` would let any consumer
 * mutate run-start state from outside the panel that owns it; the copy makes
 * this a report, which is all the feed is entitled to.
 */

export function stopState() {
  return { armed: ui.stopArmed !== null, restatement: ui.stopRestatement, busy: ui.stopBusy, error: ui.stopError };
}

export function disarmStop() {
  ui.stopArmed = null;
  ui.stopRestatement = null;
  ui.stopError = null;
}

/** Ask what stopping would do. Nothing is signalled until the answer is confirmed. */
export async function previewStop(base) {
  ui.stopBusy = true;
  ui.stopError = null;
  try {
    const res = await fetch(`${base}/api/run/stop/preview`, { method: "POST" });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      ui.stopError = data?.reason ?? `HTTP ${res.status}`;
      ui.stopArmed = null;
      ui.stopRestatement = null;
    } else {
      ui.stopArmed = data.token;
      ui.stopRestatement = data.restatement;
    }
  } catch (err) {
    ui.stopError = String(err?.message ?? err);
  } finally {
    ui.stopBusy = false;
  }
}

/** Send the interrupt. The server reports whether anything is still alive. */
export async function commitStop(base) {
  if (!ui.stopArmed) return;
  ui.stopBusy = true;
  ui.stopError = null;
  try {
    const res = await fetch(`${base}/api/run/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: ui.stopArmed }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      ui.stopError = data?.reason ?? `HTTP ${res.status}`;
    } else {
      disarmStop();
      // Reported, not assumed — the server re-reads run state after the signal.
      if (data.still_running) ui.stopError = data.note;
    }
  } catch (err) {
    ui.stopError = String(err?.message ?? err);
  } finally {
    ui.stopBusy = false;
  }
}

/**
 * ARM. Asks the server to validate the parameters and mint a token.
 *
 * The server runs the SAME validation it will run at start, minus the serial
 * gate — so preview can never green-light a run that start would refuse, which
 * would move the refusal to after the operator has committed.
 */

/**
 * CONFIRM. Sends the SAME parameters that were previewed, carrying the token.
 * Any divergence is rejected by the server rather than quietly starting a
 * different run.
 */

function payload() {
  return {
    model: ui.sel.model,
    arm: ui.sel.arm || undefined,
    // DECLARED, NEVER SNIFFED. The server refuses an unknown substrate by name
    // rather than inferring one from the model id's shape — see validateStart.
    kind: ui.sel.kind,
    org: ui.sel.arm === "on" ? ui.sel.org.trim() || undefined : undefined,
    // NO `context` KEY. The server treats an absent context as "use the
    // registry default" (server.mjs:314 gates on `context !== null`, and
    // :650 only sets BENCH_WORKER_NUM_CTX when one was supplied), which
    // is exactly the pinned ceiling every bench alias already carries.
  };
}

// ── RENDER ───────────────────────────────────────────────────────────────────

// ── THE BASELINE CONFIRM MODAL IS GONE, AND WAS NOT REPLACED IN KIND ────────
//
// A one-card "are you sure you want to start a benchmark with <model>?" used to
// live here, raised by [+ baseline] on a model row. Its job — make the operator
// commit deliberately to a multi-hour cell rather than starting one by reflex —
// is now frame BASELINE·3 of panels/create.js, at the end of a three-step
// sequence that also establishes WHICH model and WHICH substrate.
//
// It is deleted rather than kept beside the new flow because two dialogs that
// both mean "confirm this baseline" would eventually diverge on what they warn
// about, and the operator would learn to dismiss whichever one they saw more
// often. The arm→confirm protocol below is untouched: CONTINUE on that frame
// calls armRun() exactly as CONTINUE here did.

/**
 * THE SUBSTRATE, ON THE CONTROL THAT STARTS THE CELL.
 *
 * A cloud cell is billed and a local one is not, and that is the single largest
 * difference between two runs that are otherwise identical in every field on
 * this form. The server states it in its own restatement too; this states it
 * BEFORE the arm, so the operator is not relying on reading the restatement
 * carefully at the moment they have already decided to click.
 */

/**
 * The abandonment warning. Named explicitly because "are you sure" without
 * saying WHAT is lost is not informed consent — the operator needs to know the
 * live cell is kept, marked ABANDONED, never graded, and never enters the curve.
 */

