// SOURCE: gate-suite — the wall's suite and per-gate outcomes, fetched whole
// from GET /api/wall (control/wall.mjs) and passed through. Its own source so the
// wall and the TUI mirror don't share a fate, and so its absence is stated on its
// own row.

export const id = "gate-suite";
export const fields = ["suite"];
export function describe() {
  return "the gate roster and per-gate outcomes, folded by the control plane";
}

/** Long enough for a cold enumeration, short enough not to hold the board. */
const TIMEOUT_MS = 2500;

export async function read(ctx) {
  const base = ctx.config?.controlUrl ?? "http://127.0.0.1:8718";
  const url = `${base}/api/wall`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      return { ok: false, reason: `control plane answered ${res.status} for /api/wall` };
    }
    const data = await res.json();
    // ok:false is a stated absence (no roster yet), never a suite of zero.
    if (data?.ok !== true) {
      return { ok: false, reason: data?.reason ?? "the control plane has no gate suite to report yet" };
    }
    return { ok: true, patch: { suite: data }, provenance: { path: url, mtime: null, bytes: null } };
  } catch (err) {
    return { ok: false, reason: `gate suite unreadable — ${String(err?.message ?? err)}` };
  }
}
