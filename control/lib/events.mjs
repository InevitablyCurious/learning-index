// CONTROL PLANE — TRANSCRIPT INTERLEAVE (not ../events.mjs, the EventRing):
// the arrival-order merge used when rebuilding a past run's feed.

/**
 * Slot the prompts into an agent transcript without reordering it: each
 * prompt goes before the first agent row stamped later than it. Not a time sort,
 * because many agent rows (file.edited, session.idle …) carry no time and would
 * all jump to the top; agent-events.jsonl is already in true arrival order.
 */
export function interleaveByArrival(agentRows, promptRows) {
  const prompts = [...(promptRows ?? [])].sort((a, b) => (Number(a?.at) || 0) - (Number(b?.at) || 0));
  const out = [];
  let pi = 0;
  for (const r of agentRows ?? []) {
    const at = Number(r?.at) || 0;
    // Only a stamped agent row can place a prompt.
    while (at > 0 && pi < prompts.length && (Number(prompts[pi]?.at) || 0) <= at) {
      out.push(prompts[pi]);
      pi += 1;
    }
    out.push(r);
  }
  // Prompts later than every agent row go at the end, in order.
  while (pi < prompts.length) { out.push(prompts[pi]); pi += 1; }
  return out;
}
