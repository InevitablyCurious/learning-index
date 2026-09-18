// THE RECALL MOMENT. The gate-mode label is permanent and derived from the
// recorded lever ("unobserved" if it wasn't seen). The chosen memory shows as
// four labelled fields (implement / context / dnd / stack), never one blob.
// Outcome is tri-state; unobserved is not a failure; a serve is delivery, not a
// win. Motion: one 200ms settle, then still.

import { esc, nul, clip, shortCid } from "../board.js";

export function renderRecall(board) {
  const rm = board.recall_moment;
  const gateMode = board.provenance?.gate_mode;
  const gateSrc = board.provenance?.gate_mode_source;

  // Present in both resting and fired states.
  const gateLabel =
    gateMode === null || gateMode === undefined
      ? `<span class="label">gate: ${nul("mode unobserved")}</span>`
      : gateMode === "auto-approve"
        ? `<span class="label" style="color:var(--arm-b)">gate: AUTO-APPROVE (benchmark)</span>`
        : `<span class="label">gate: HUMAN</span>`;

  if (!rm) return resting(board, gateLabel, gateSrc);

  const fresh = rm.fired_at && Date.now() - rm.fired_at < 6000;

  return `
  <div class="panel ${fresh ? "takeover settle" : ""}">
    <div class="phead">
      <span class="label">Recall moment</span>
      <span class="label" style="color:var(--arm-a)">${fresh ? "TAKEOVER" : "SETTLED"} · ${esc(rm.failure_key ?? "")}</span>
    </div>
    <div class="pbody">
      ${errorLine(rm)}
      ${metaRow(rm)}
      ${candidates(rm)}
      ${atomic(rm.chosen)}
      ${outcome(rm)}
    </div>
    <div style="padding:6px 14px;border-top:1px solid var(--rule)">${gateLabel}</div>
  </div>`;
}

function resting(board, gateLabel, gateSrc) {
  const armed = (board.episodes ?? []).filter((e) => e.state === "red-again").length;
  const isControl = board.run?.arm === "off";

  // `safe center`: plain `center` pushes overflow past the top, unreachable.
  return `
  <div class="panel">
    <div class="phead">
      <span class="label">Recall moment</span>
      <span class="label">RESTING</span>
    </div>
    <div class="pbody" style="display:flex;align-items:safe center;justify-content:center">
      <div style="text-align:center;max-width:460px">
        <div class="collect">${isControl ? "CONTROL ARM" : "NO TRIGGER YET"}</div>
        <div class="label" style="margin-top:8px">${armed} episode${armed === 1 ? "" : "s"} armed</div>
        <div class="null" style="margin-top:12px;line-height:1.6;font-size:var(--fs-label)">
          ${isControl
            ? "no recall on a control cell — by construction, not by failure. this is the arm the memory is withheld from."
            : "recall fires only on a second failure under the same key, with a file edit between the two."}
        </div>
      </div>
    </div>
    <div style="padding:6px 14px;border-top:1px solid var(--rule)">
      ${gateLabel}${gateSrc ? ` <span class="null">· ${esc(gateSrc)}</span>` : ""}
    </div>
  </div>`;
}

function errorLine(rm) {
  if (!rm.error) return `<div>${nul("error string unobserved")}</div>`;
  return `<div class="fail" style="font-size:var(--fs-ident);line-height:1.4;margin-bottom:8px">${esc(clip(rm.error, 140))}</div>`;
}

function metaRow(rm) {
  const bits = [];
  bits.push(rm.latency_ms !== null && rm.latency_ms !== undefined
    ? `<span class="label">latency</span> ${rm.latency_ms}ms`
    : `<span class="label">latency</span> ${nul("unmeasured")}`);
  bits.push(rm.gate_decision_ms !== null && rm.gate_decision_ms !== undefined
    ? `<span class="label">gate decided</span> ${rm.gate_decision_ms}ms`
    : `<span class="label">gate decided</span> ${nul("unobserved")}`);

  // "Scanned, found nothing" is a result only if the scan ran.
  const g = rm.guard;
  bits.push(
    !g
      ? `<span class="label">guard</span> ${nul("unobserved")}`
      : g.scanned
        ? `<span class="label">guard</span> scanned · ${(g.detections ?? []).length} detections`
        : `<span class="label">guard</span> ${nul("did not run")}`,
  );

  return `<div style="display:flex;gap:18px;font-size:var(--fs-label);margin-bottom:10px;flex-wrap:wrap">${bits.join("")}</div>`;
}

function candidates(rm) {
  const cands = rm.candidates ?? [];
  if (!cands.length) {
    return `<div class="label" style="margin-bottom:8px">candidates ${nul("unobserved")}</div>`;
  }

  const rows = cands
    .map((c) => {
      const dispColor =
        c.disposition === "returned" ? "var(--pass)"
        : c.disposition === "below_floor" ? "var(--null)"
        : "var(--arm-b)";
      return `
      <div class="cand">
        <span class="ident">${esc(shortCid(c.cid))}</span>
        <span>${c.relevance === null || c.relevance === undefined ? nul("—") : `rel ${c.relevance.toFixed(2)}`}</span>
        <span>${c.standing_bps === null || c.standing_bps === undefined ? nul("—") : `${c.standing_bps}bps`}</span>
        <span class="disp" style="color:${dispColor}">${esc(c.disposition ?? "—")}</span>
      </div>`;
    })
    .join("");

  return `
  <div class="label" style="margin-bottom:4px">candidates · relevance / standing / disposition</div>
  ${rows}`;
}

/** The four fields; a null dnd is shown, not hidden. */
function atomic(chosen) {
  if (!chosen) {
    return `<div class="label" style="margin-top:10px">chosen memory ${nul("none")}</div>`;
  }

  const field = (k, v) => `
    <span class="label" style="color:var(--arm-a)">${k}</span>
    <span>${v === null || v === undefined ? nul("null") : esc(clip(v, 190))}</span>`;

  return `
  <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--rule)">
    <div class="label" style="margin-bottom:6px">chosen memory · ${esc(shortCid(chosen.cid))}</div>
    <div class="atomic">
      ${field("implement", chosen.implement)}
      ${field("context", chosen.context)}
      ${field("dnd", chosen.dnd)}
      ${field("stack", chosen.stack)}
    </div>
  </div>`;
}

/** Tri-state outcome; unobserved gets a neutral treatment. */
function outcome(rm) {
  const o = rm.outcome;
  const map = {
    worked: { text: "RESOLVED — worked", color: "var(--pass)" },
    didnt_work: { text: "DID NOT RESOLVE", color: "var(--fail)" },
    unobserved: { text: "UNOBSERVED — neither positive nor negative", color: "var(--null)" },
  };
  const style = map[o] ?? { text: "OUTCOME PENDING", color: "var(--dim)" };

  return `
  <div style="margin-top:12px;padding-top:8px;border-top:1px solid var(--rule)">
    <span class="label">outcome</span>
    <span class="state" style="color:${style.color};margin-left:8px">${style.text}</span>
    <div class="null" style="font-size:12px;margin-top:4px">
      a serve is delivery. the outcome is resolution. neither claims the memory caused it.
    </div>
  </div>`;
}
