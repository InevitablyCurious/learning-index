// PANEL: CONTINUOUS MODE — the chain's banner, under the topbar. While a chain
// runs: which run, what it started from, and END AFTER THIS RUN. Once it ends:
// why. The server's chain (board.continuous, control/continuous.mjs) is the only
// truth; this panel keeps nothing but the last refusal of its own button, shown
// where the click happened.

import { esc } from "../board.js";

let refusal = null;

/** A refused END, shown in the banner until the next click. */
export function setContinuousRefusal(text) {
  refusal = text;
}

export function renderContinuous(board) {
  const c = board?.continuous;
  // No chain was ever started: nothing at all.
  if (!c) return "";
  const links = Array.isArray(c.links) ? c.links : [];
  const last = links[links.length - 1] ?? null;
  const n = last?.n ?? links.length;
  const model = c.payload?.model ?? "";

  if (c.active) {
    const from = last?.seeded_from ? `from snapshot ${last.seeded_from}` : "as a fresh build";
    return `
      <section class="cont">
        <div class="phead">
          <span class="ttl">CONTINUOUS · RUN ${esc(String(n))}</span>
          <span class="sub">${esc(model)}</span>
        </div>
        <div class="cont-line">Run ${esc(String(n))} started ${esc(from)}. When it ends, the next run starts from its end snapshot, until the model passes everything.</div>
        ${c.waiting ? `<div class="cont-line cont-wait">${esc(c.waiting)}</div>` : ""}
        <div class="cont-actions">
          <button class="btn" data-continuous-end="1">END AFTER THIS RUN</button>
          <span class="note">run ${esc(String(n))} finishes and is recorded; no next run starts</span>
        </div>
        ${refusal ? `<div class="cont-refusal" role="alert">${esc(refusal)}</div>` : ""}
      </section>`;
  }

  const ended = c.ended ?? {};
  return `
    <section class="cont ended${ended.code === "passed" ? " passed" : ""}">
      <div class="phead">
        <span class="ttl">CONTINUOUS ENDED · ${esc(String(n))} RUN${n === 1 ? "" : "S"}</span>
        <span class="sub">${esc(model)}</span>
      </div>
      <div class="cont-line">${esc(ended.reason ?? "no reason was recorded")}</div>
    </section>`;
}
