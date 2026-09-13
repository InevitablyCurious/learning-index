// ─────────────────────────────────────────────────────────────────────────────
// SOURCE: opencode-serve  [OPT-IN — network]
//
// The live agent session API (default http://127.0.0.1:4096). This is the
// fastest-moving truth on the board: turn count and token burn update while a
// chunk is still running, long before the status stream records anything.
//
// OPT-IN because it is the only source that makes a network call. Enable it in
// dashboard.config.json. If the port is closed, this module reports unwired and
// the board loses nothing but liveness.
//
// READ-ONLY: GET /session only. This module never posts, never mutates a
// session, and never touches the agent's message content — only the counters.
// The transcript is deliberately NOT read: it contains the model's raw working
// output, and everything rendered on this board is public forever.
//
// ── WHY THE BOARD CANNOT SHOW THE TUI'S "CONTEXT" NUMBER ────────────────────
// opencode's TUI status line shows a DIFFERENT quantity: the context-window
// occupancy of the LAST assistant message —
//   msg.tokens.input + output + reasoning + cache.read + cache.write
// — which is a stock ("how full is the window right now"), not the cumulative
// flow this session object carries. Reproducing it needs per-message data from
// GET /session/{id}/message, and that payload carries the transcript. The rule
// above wins: the board does not fetch it. The panel names the difference in
// words instead, so the two surfaces reconcile without the board reading
// content it must never render.
// ─────────────────────────────────────────────────────────────────────────────

import { int, str } from "../contract.mjs";

export const id = "opencode-serve";
export const fields = ["run.tokens", "run.elapsed_s", "run.session_id"];
export function describe() {
  return "live agent session API — token burn + elapsed (opt-in, localhost only)";
}

export async function read(ctx) {
  const base = ctx.config?.opencodeServeUrl ?? "http://127.0.0.1:4096";

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

  // newest by updated time
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
        // ALL FIVE CATEGORIES, NEVER JUST input+output.
        //
        // This source used to read `input` and `output` alone and the board
        // summed those two into one figure labelled as the cell's tokens. Two
        // categories were silently on the floor, and both matter:
        //
        //   `reasoning`  On a reasoning model this is not a rounding error, it
        //                is most of the generation. A live deepseek-v4-flash
        //                cell carried input 87,567 · output 114,201 ·
        //                reasoning 239,381 — the omitted category was larger
        //                than the two that were shown.
        //
        //   `cache.read` 41.5M on that same cell, ~99% of everything the run
        //                put through the provider. It is BILLED, and it is
        //                where the cost of a larger injected prompt lands:
        //                memory makes the prompt bigger and the prompt is
        //                re-read every turn. A token total that excludes it
        //                cannot answer whether memory saved tokens, which is
        //                the only question this bench exists to answer.
        //
        // The panel sums all five and dims none of them.
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
