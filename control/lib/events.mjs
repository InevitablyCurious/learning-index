// ─────────────────────────────────────────────────────────────────────────────
// CONTROL PLANE — TRANSCRIPT INTERLEAVE
//
// Split out of server.mjs (LI-14 phase 1), byte-verbatim. NOT the same module
// as ../events.mjs (the EventRing and its subscription): this file holds only
// the arrival-order merge the historical rebuild uses.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Interleave the prompts into an agent transcript WITHOUT re-ordering it.
 *
 * ── WHY NOT JUST SORT BOTH BY `at` ─────────────────────────────────────────
 *
 * Because 201 of a 4,457-row transcript carry NO `at` at all — `file.edited`,
 * `session.idle`, `session.error`, `session.compacted` arrive without one. A
 * plain time sort reads those as timestamp 0 and files every one of them at the
 * TOP of the feed: a run whose first hundred and forty-five events are file
 * edits that actually happened throughout, and whose errors all appear before
 * the work that caused them.
 *
 * `agent-events.jsonl` is APPEND-ONLY IN ARRIVAL ORDER, which is the true order
 * and the one the live feed showed. So the transcript is left exactly as it lies
 * and the prompts are dropped into it — each one placed before the first agent
 * row that is stamped later than it. Untimed rows never move.
 */
export function interleaveByArrival(agentRows, promptRows) {
  const prompts = [...(promptRows ?? [])].sort((a, b) => (Number(a?.at) || 0) - (Number(b?.at) || 0));
  const out = [];
  let pi = 0;
  for (const r of agentRows ?? []) {
    const at = Number(r?.at) || 0;
    // Only a STAMPED agent row can position a prompt; an untimed one says
    // nothing about when the prompt was sent and must not consume it.
    while (at > 0 && pi < prompts.length && (Number(prompts[pi]?.at) || 0) <= at) {
      out.push(prompts[pi]);
      pi += 1;
    }
    out.push(r);
  }
  // Anything later than every agent row lands at the end, in its own order.
  while (pi < prompts.length) { out.push(prompts[pi]); pi += 1; }
  return out;
}
