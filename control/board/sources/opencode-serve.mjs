// SOURCE: opencode-serve — the live agent session API (the control plane's
// --serve-url, default http://127.0.0.1:8719): turn count and token burn while a
// chunk is still running. Unreachable = unwired; the board loses only this
// liveness. Read-only, GET /session only: counters, never the transcript (the
// model's raw output; everything on the board is public).
//
// The TUI's "context" figure is a different quantity (occupancy of the last
// message) and would need the per-message transcript, so the board doesn't show
// it and says so in words.

import { int, str } from "../contract.mjs";

export const id = "opencode-serve";
export const fields = ["run.tokens", "run.elapsed_s", "run.session_id"];
export function describe() {
  return "live agent session API — token burn + elapsed (opt-in, localhost only)";
}

export async function read(ctx) {
  const base = ctx.config?.opencodeServeUrl ?? "http://127.0.0.1:8719";

  let res;
  try {
    res = await fetch(`${base}/session`, {
      signal: AbortSignal.timeout(1500),
      headers: { accept: "application/json" },
    });
  } catch (err) {
    return { ok: false, reason: `agent serve unreachable at ${base}` };
  }

  if (!res.ok) return { ok: false, reason: `agent serve returned HTTP ${res.status}` };

  let sessions;
  try {
    sessions = await res.json();
  } catch {
    return { ok: false, reason: "agent serve returned non-JSON" };
  }
  if (!Array.isArray(sessions) || !sessions.length) {
    return { ok: false, reason: "agent serve has no sessions" };
  }

  // Newest by updated time.
  const s = sessions
    .slice()
    .sort((a, b) => (b?.time?.updated ?? 0) - (a?.time?.updated ?? 0))[0];

  const created = int(s?.time?.created);
  const updated = int(s?.time?.updated);

  return {
    ok: true,
    provenance: { path: `${base}/session`, mtime: updated, bytes: null },
    patch: {
      run: {
        session_id: str(s?.id),
        elapsed_s: created ? Math.round((Date.now() - created) / 1000) : null,
        idle_s: updated ? Math.round((Date.now() - updated) / 1000) : null,
        // All five categories. Reasoning is often most of the generation, and cache
        // read (~99% of tokens, billed) is where the cost of a bigger injected prompt
        // lands. The panel sums all five.
        tokens: {
          input: int(s?.tokens?.input),
          output: int(s?.tokens?.output),
          reasoning: int(s?.tokens?.reasoning),
          cache_read: int(s?.tokens?.cache?.read),
          cache_write: int(s?.tokens?.cache?.write),
        },
      },
    },
  };
}
