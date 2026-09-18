// PANEL: RUN START — now only the STOP flow for the cell in flight (starting a
// cell is panels/create.js). Stop is preview-then-confirm: the server mints the
// token and writes the restatement, and refusals render verbatim with their code.

/** Local UI state: what the operator is doing, which no poll can know. */
const ui = {
  // The stop flow: `stopArmed` holds the confirm token (preview, then confirm).
  stopArmed: null,
  stopRestatement: null,
  stopBusy: false,
  stopError: null,
};

/** A read-only snapshot of the stop state, for the top bar. */
export function stopState() {
  return { armed: ui.stopArmed !== null, restatement: ui.stopRestatement, busy: ui.stopBusy, error: ui.stopError };
}

export function disarmStop() {
  ui.stopArmed = null;
  ui.stopRestatement = null;
  ui.stopError = null;
}

/** Ask what stopping would do. Nothing is signalled until the answer is confirmed. */
export async function previewStop() {
  ui.stopBusy = true;
  ui.stopError = null;
  try {
    const res = await fetch(`/api/run/stop/preview`, { method: "POST" });
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
export async function commitStop() {
  if (!ui.stopArmed) return;
  ui.stopBusy = true;
  ui.stopError = null;
  try {
    const res = await fetch(`/api/run/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: ui.stopArmed }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      ui.stopError = data?.reason ?? `HTTP ${res.status}`;
    } else {
      disarmStop();
      // Reported by the server after re-reading run state.
      if (data.still_running) ui.stopError = data.note;
    }
  } catch (err) {
    ui.stopError = String(err?.message ?? err);
  } finally {
    ui.stopBusy = false;
  }
}

