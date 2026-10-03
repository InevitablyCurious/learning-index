// PANEL: LIVE BUILD — splits the grader's feedback message into its problem
// lists, VERBATIM. The operator needs to see exactly what the model was told,
// so nothing here rewrites, shortens or paraphrases a line: a list item is the
// harness's own "N) text" line, a group heading is the harness's own lead-in.
//
// The message is paragraphs separated by blank lines. A paragraph whose first
// line is "N) " is a LIST; the paragraph right before it is that list's
// LEAD-IN. Every other paragraph is boilerplate the model is given around the
// problems (the run-from-scratch preamble, the team-spec note, the "don't
// rename" contract) and is held back behind the full-prompt toggle — never
// dropped. The split is by SHAPE, not by phrase, so a reworded prompt pack
// still parses; only the colour of a group (below) reads the lead-in's words.

const ITEM = /^\d+\)\s/;

/**
 * Group kind from the lead-in's own words; cosmetic only (colour + label). An
 * unrecognised lead-in is "other" and is still shown, with its own words.
 */
export function groupKind(lead) {
  const s = String(lead ?? "").toLowerCase();
  const team = /\bteam\b/.test(s);
  if (/that fixed it/.test(s)) return "fixed";
  if (/broken now/.test(s)) return team ? "team-regressed" : "regressed";
  if (team) return "team";
  if (/\bissues? that i'?ve encountered|still seeing/.test(s)) return "new";
  return "other";
}

export const KIND_LABEL = {
  fixed: "FIXED",
  regressed: "REGRESSED",
  new: "NEW",
  team: "INTEGRATION",
  "team-regressed": "INTEGRATION · REGRESSED",
  other: "PROBLEMS",
};

/**
 * @param {string} text the feedback message, as the model received it
 * @returns {{groups: {kind:string, lead:string, items:string[], note:string}[], held: string[]}}
 *   held = the paragraphs that are not a list or a lead-in, in order.
 */
export function parseFeedback(text) {
  const paras = String(text ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const groups = [];
  const held = [];
  for (let i = 0; i < paras.length; i += 1) {
    const p = paras[i];
    const next = paras[i + 1];
    if (ITEM.test(p)) {
      // A list whose lead-in was consumed already, or that has none.
      groups.push({ kind: "other", lead: "", items: itemsOf(p), note: "" });
    } else if (next && ITEM.test(next)) {
      groups.push({ kind: groupKind(p), lead: p, items: itemsOf(next), note: "" });
      i += 1;
    } else if (/^\(.*\)$/s.test(p) && groups.length) {
      // "(3 other things I mentioned look fine now too.)" belongs to its list.
      groups[groups.length - 1].note = p;
    } else {
      held.push(p);
    }
  }
  return { groups, held };
}

function itemsOf(para) {
  return para.split("\n").filter((l) => l.trim());
}

/**
 * Which prompt a tab shows. The attempt-N tab is the board the grader captured
 * at the end of attempt N, so it shows the prompt that grading PRODUCED: the
 * message delivered into attempt N+1. "live" shows the newest message. Absence
 * is a stated state, never another tab's prompt. Pure; exported for tests.
 *
 * @param {{attempt?:number, at?:number, text?:string}[]} msgs feedback messages
 * @param {string} tab "live" or an attempt number as a string
 * @param {{completed:number, max:number}} ctx attempts graded so far, and the cap
 * @returns {{text:string, meta:string} | {empty:string, meta?:string}}
 */
export function promptForTab(msgs, tab, { completed, max }) {
  const clock = (m) => (Number.isFinite(Number(m?.at)) ? ` · ${new Date(Number(m.at)).toTimeString().slice(0, 8)}` : "");
  // A message missing its attempt number takes its place in order: the first
  // is the one delivered into attempt 2.
  const into = (m, i) => (m?.attempt != null && Number.isFinite(Number(m.attempt)) ? Number(m.attempt) : i + 2);
  const list = msgs.map((m, i) => ({ m, a: into(m, i) }));
  if (tab === "live") {
    if (!list.length) {
      return { empty: completed < 1
        ? "No prompt yet — the first attempt has not been graded, so the model has been told nothing."
        : "No prompt was sent — grading found nothing to report back." };
    }
    const last = list[list.length - 1];
    return { text: String(last.m.text ?? ""), meta: `newest prompt · sent into attempt ${last.a}, after grading attempt ${last.a - 1}${clock(last.m)}` };
  }
  const n = Number(tab);
  const hit = list.find((x) => x.a === n + 1);
  if (hit) return { text: String(hit.m.text ?? ""), meta: `attempt ${n}'s grading → prompt sent into attempt ${n + 1}${clock(hit.m)}` };
  if (n >= max) return { empty: `Attempt ${n} was the last attempt, so no prompt followed it.` };
  if (n >= completed) return { empty: `Attempt ${n} has not been graded yet, so no prompt exists for it.` };
  return { empty: `No prompt followed attempt ${n} — nothing was reported back to the model.` };
}

/**
 * Paint the parsed message into `el`. DOM built with createElement/textContent
 * — the lines come from model interactions and may contain < and >. `full` is
 * the untouched message, shown behind the toggle.
 */
export function paintWrong(el, shown) {
  const { text = null, meta = "", empty = "" } = shown ?? {};
  const doc = el.ownerDocument;
  const mk = (tag, cls, txt) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };
  // The full prompt stays open across the 2s repaints.
  const wasOpen = el.querySelector(".bw-full")?.classList.contains("open") === true;
  el.replaceChildren();

  if (text === null) {
    // The designed empty state: the benchmark has not got that far (or nothing
    // was sent). Stated in words, never a blank card and never another tab's list.
    if (meta) el.append(mk("div", "bw-meta", meta));
    el.append(mk("div", "bw-empty", empty || "nothing here"));
    return;
  }
  if (meta) el.append(mk("div", "bw-meta", meta));
  const { groups, held } = parseFeedback(text);
  if (!groups.length) {
    el.append(mk("div", "bw-empty", "no problem list in this message"));
  }
  const sums = mk("div", "bw-sums");
  const cols = mk("div", "bw-cols");
  for (const g of groups) {
    const box = mk("div", `bw-grp ${g.kind}`);
    const head = mk("div", "bw-gh");
    head.append(mk("span", null, KIND_LABEL[g.kind]), mk("small", null, String(g.items.length)));
    box.append(head);
    if (g.lead) box.append(mk("div", "bw-lead", g.lead));
    for (const line of g.items) {
      const m = /^(\d+\))\s+(.*)$/s.exec(line);
      const it = mk("div", "bw-it");
      it.append(mk("i", null, m ? m[1] : ""), mk("span", null, m ? m[2] : line));
      box.append(it);
    }
    if (g.note) box.append(mk("div", "bw-lead", g.note));
    cols.append(box);
    const chip = mk("span", `bw-sum ${g.kind}`);
    chip.append(mk("b", null, String(g.items.length)), doc.createTextNode(` ${KIND_LABEL[g.kind].toLowerCase()}`));
    sums.append(chip);
  }
  if (groups.length) el.append(sums, cols);

  const foot = mk("div", "bw-foot");
  const held_ = held.length;
  foot.append(
    mk("span", null, `${held_} boilerplate paragraph${held_ === 1 ? "" : "s"} the model also receives, not shown above`),
    mk("span", "bw-sp"),
  );
  const btn = mk("button", "bw-btn", wasOpen ? "hide full prompt" : "show full prompt");
  btn.type = "button";
  btn.setAttribute("data-build-fullprompt", "1");
  foot.append(btn);
  const full = mk("pre", `bw-full${wasOpen ? " open" : ""}`, String(text ?? ""));
  el.append(foot, full);
}
