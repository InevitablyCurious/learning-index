// PANEL: LEARNING — the second tab of the transfer-curve card: how the model
// is learning, from board.learning (sources/learning.mjs).
//   MATRIX  gate × attempt, filling left to right as the cell runs
//   CLAIMS  the model's own account (trajectories, knowledge, evidence) beside
//           the code-derived edit ranges — two authors, kept visually apart
//   LIVE    capture bookkeeping and this host's session history
// Window labels come from learning-ledger.json; polarity is do / do-not, never
// pass/fail colours; the master's session goal is a placeholder (the real goal is
// the manifest's); OFF cells read unwired; a shrinking master is an anomaly.
// Read-only.

import { esc } from "../board.js";

const VIEWS = ["matrix", "claims", "live"];
let view = "matrix";

export function setLearningView(v) {
  if (VIEWS.includes(v)) view = v;
}
export function learningView() {
  return view;
}

/** Attempt 1 builds, attempts 2–5 repair. */
export const PHASES_PER_CELL = 5;

// Arm identity is carried by words and colour, like the rest of the board.
const C = {
  armA: "var(--arm-a)", // MEMORY ON
  armB: "var(--arm-b)", // CONTROL
  pass: "var(--check)",
  fail: "var(--danger)",
  pol: "var(--comment)",
  flip: "var(--type)",
};

/** The LEARNING tab body (rendered by panels/curve.js): MATRIX / CLAIMS / LIVE. */
export function renderLearningBody(board) {
  const L = board.learning ?? null;
  return `
    <div class="learn">
      <div class="learn-bar">
        <span class="learn-brand">LEARNING</span>
        <span class="learn-note">how this model is learning, in real time</span>
        <span class="spacer"></span>
        <span class="seg" data-seg="learnview">
          ${viewBtn("matrix", "MATRIX")}
          ${viewBtn("claims", "CLAIMS")}
          ${viewBtn("live", "LIVE")}
        </span>
      </div>
      <div class="learn-cellinfo">${cellInfo(L)}</div>
      ${view === "matrix" ? matrixView(L) : view === "claims" ? claimsView(L) : liveView(L, board)}
    </div>`;
}

function viewBtn(id, label) {
  return `<button class="${view === id ? "on" : ""}" data-learn-view="${id}">${label}</button>`;
}

/** The cell identity row: run/cell · arm · model · attempt · capture state. */
function cellInfo(L) {
  if (!L) return `<span class="learn-note">no active run yet</span>`;
  const mode = L.cell?.memory_mode;
  const arm = mode === "off" ? "memoryOFF · ARM B" : mode === "on" ? "memoryON · ARM A" : "arm unresolved";
  const armInk = mode === "off" ? C.armB : C.armA;
  const model = L.cell?.model ?? "model unknown";
  const attempt = `attempt ${L.attempt?.current ?? "–"} of ${L.attempt?.max ?? PHASES_PER_CELL}`;
  const outcomes = L.matrix?.counts?.outcomes_read;
  const seq =
    L.cell?.sequence_index !== null && L.cell?.sequence_index !== undefined
      ? ` · cell-${String(L.cell.sequence_index).padStart(4, "0")}`
      : "";
  return `
    <span class="learn-cell">run ${esc(L.run ?? "?")}${esc(seq)}</span>
    <span class="learn-arm" style="color:${armInk}">${esc(arm)}</span>
    <span class="learn-model">${esc(model)}</span>
    <span class="learn-note">${esc(attempt)}${outcomes !== undefined ? ` · ${outcomes} predicate outcomes read` : ""}</span>
    ${stateChip(L)}`;
}

function stateChip(L) {
  const s = L.capture_state;
  if (s === "captured") return `<span class="learn-state good">CAPTURED</span>`;
  if (s === "unwired") return `<span class="learn-state muted">UNWIRED</span>`;
  if (s === "anomaly") return `<span class="learn-state bad">ANOMALY</span>`;
  if (L.session_id) return `<span class="learn-state">RUNNING</span>`;
  return `<span class="learn-state muted">UNOBSERVED</span>`;
}

function countClaims(master) {
  if (!master) return null;
  let n = 0;
  for (const t of master.trajectories ?? []) n += (t.knowledge ?? []).length;
  return n;
}

// ── MATRIX ───────────────────────────────────────────────────────────────────

function matrixView(L) {
  if (!L?.matrix) {
    return frame(
      "UNOBSERVED — NO OUTCOMES YET",
      "The predicate-outcomes stream is empty for this run. Nothing has been graded.",
      "predicate-outcomes.jsonl is appended per (gate, attempt). The matrix fills left→right as the cell runs.",
    );
  }
  const m = L.matrix;
  const phases = m.phases ?? ["conformance", "backend", "frontend"];

  const gates = m.gates ?? [];
  const byPhase = new Map();
  for (const g of gates) {
    if (!byPhase.has(g.phase)) byPhase.set(g.phase, []);
    byPhase.get(g.phase).push(g);
  }

  const rows = [];
  for (const ph of phases) {
    const group = byPhase.get(ph) ?? [];
    rows.push(
      `<div class="lm-row lm-phase"><span class="lm-label">${esc(ph.toUpperCase())}</span>${"<span></span>".repeat(PHASES_PER_CELL)}</div>`,
    );
    for (const g of group) {
      const cells = (g.outcomes ?? []).map((o, i) => {
        const prev = i ? g.outcomes[i - 1] : null;
        const flipped = o !== null && prev !== null && o !== prev;
        if (o === "pass") return `<span class="lm-cell pass${flipped ? " flip" : ""}" title="${esc(g.id + " · pass")}"></span>`;
        if (o === "fail") return `<span class="lm-cell fail${flipped ? " flip" : ""}" title="${esc(g.id + " · fail")}"></span>`;
        return `<span class="lm-cell none" title="${esc(g.id + " · not yet run")}"></span>`;
      });
      rows.push(`<div class="lm-row"><span class="lm-label" title="${esc(g.id)}">${esc(g.title ?? g.id)}</span>${cells.join("")}</div>`);
    }
  }

  const c = m.counts ?? {};
  const totalTxt = m.total === null ? "denominator unknown — no roster" : `${m.total} GATES`;
  const head = `${totalTxt} × ${m.attempts ?? PHASES_PER_CELL} ATTEMPTS · ${c.outcomes_read ?? 0} OUTCOMES READ · ${c.passing_total ?? 0} PASSING`;

  const attemptHeads = Array.from({ length: PHASES_PER_CELL }, (_, i) => {
    const n = i + 1;
    const tag = n === 1 ? "BUILD" : "REPAIR";
    const ink = n === (c.newest_attempt ?? null) ? "var(--type)" : "var(--dim)";
    return `<span class="lm-ah" style="color:${ink}">${n}<i>${tag}</i></span>`;
  });

  const windows = windowChips(L);
  const dist = distributionChips(L);

  return `
    <div class="learn">
      <div class="learn-head">
        <span class="learn-kick">GATE × ATTEMPT — ${esc(head)}</span>
        <span class="learn-note">roster is task-defined · attempt 1 builds, attempts 2–5 repair · outcomes append as predicate-outcomes.jsonl grows</span>
      </div>

      <div class="lm" style="--cols:${PHASES_PER_CELL}">
        <div class="lm-row lm-hdr"><span class="lm-label">GATE</span>${attemptHeads.map((h) => `<span class="lm-ahwrap">${h}</span>`).join("")}</div>
        <div class="lm-scroll">${rows.join("")}</div>
      </div>

      <div class="learn-legend">
        <span><i class="lm-key pass"></i> pass</span>
        <span><i class="lm-key fail"></i> fail</span>
        <span><i class="lm-key none"></i> not yet run — never styled as fail</span>
        <span><i class="lm-key flipk"></i> flip marker — state changed at this attempt</span>
        <span class="learn-note">verdict colours are gate outcomes only; they never carry arm identity</span>
      </div>

      <div class="learn-block">
        <div class="learn-kick">ATTEMPT WINDOWS — LABELS COME FROM learning-ledger.json, NEVER COMPUTED HERE</div>
        <div class="learn-windows">${windows}</div>
      </div>

      <div class="learn-block">
        <div class="learn-kick">CLAIM DISTRIBUTION</div>
        <div class="learn-dist">${dist}</div>
        <div class="learn-note">${esc(distNote(L))}</div>
      </div>
    </div>`;
}

function windowChips(L) {
  const ledger = L?.ledger;
  const windows = Array.isArray(ledger?.windows) ? ledger.windows : null;
  const labels = new Map();
  if (windows) for (const w of windows) labels.set(int(w.window), str(w.label));

  return Array.from({ length: PHASES_PER_CELL }, (_, i) => {
    const n = i + 1;
    const label = labels.get(n) ?? null;
    if (label === null) {
      return `<div class="lw"><span class="lw-num">W${n}</span><span class="lw-label dim">unobserved</span></div>`;
    }
    const regressed = label === "regressed" || label === "trade-off";
    return `<div class="lw${regressed ? " bad" : ""}"><span class="lw-num">W${n}</span><span class="lw-label">${esc(label)}</span></div>`;
  }).join("");
}

function distributionChips(L) {
  const d = L?.ledger?.claim_distribution;
  if (!d || typeof d !== "object") {
    return `<span class="ld-chip dim">ledger unobserved — produced by the harness at cell end</span>`;
  }
  const order = ["fixed", "held-green-but-unsealed", "trade-off", "regressed", "attempted", "unmapped"];
  return order
    .map((label) => {
      const n = d[label];
      if (n === undefined) return "";
      const zero = Number(n) === 0;
      return `<span class="ld-chip"><span class="ld-label">${esc(label)}</span><span class="ld-n${zero ? " zero" : ""}">${esc(String(n))}</span></span>`;
    })
    .join("");
}

function distNote(L) {
  if (L?.ledger?.claim_distribution) {
    return "fixed is licensed only by a full-green run — 0 failing gates at the final attempt. A claim is judged by the window it first appeared in, never by which gate it names.";
  }
  return "The ledger is produced by the harness at cell end. Until it lands there are no windows and no labels — this is unobserved, not \u201cno windows\u201d, and never computed here to fill the gap.";
}

// ── CLAIMS ───────────────────────────────────────────────────────────────────

function claimsView(L) {
  const m = L?.master;
  const goal = L?.cell?.task ?? null;

  const goalRow = `
    <div class="lc-goal">
      <span class="learn-kick">SESSION GOAL</span>
      <span class="lc-goal-text">${esc(goal ?? "read from the task manifest")} — the master's <span class="dim">session_goal.text</span> is a mocked placeholder and is never shown as the goal.</span>
    </div>`;

  if (!m) {
    return `
      <div class="learn">
        ${goalRow}
        ${frame(
          "UNOBSERVED — MASTER HAS NOT LANDED",
          "The capture protocol directs emission in the model's final message, so the in-session master typically lands at cell end. The insession directory is armed and empty.",
          `watching runs/${esc(L?.run ?? "?")} · poll 2s · no intra-attempt growth is expected`,
        )}
      </div>`;
  }

  const head = `THE MODEL\u2019S OWN ACCOUNT — ${m.trajectories.length} TRAJECTORIES · ${countClaims(m) ?? 0} RECORDS`;
  const blocks = (m.trajectories ?? [])
    .map((tj) => trajectoryBlock(tj, L))
    .join("");

  return `
    <div class="learn">
      <div class="learn-head"><span class="learn-kick">${esc(head)}</span><span class="learn-note">trajectories in first-seen order — the master's order is choreographed and preserved</span></div>
      ${goalRow}
      ${m.validation_errors?.length ? validationBanner(m) : ""}
      ${blocks || frame("NO TRAJECTORIES", "The master is present but carries no trajectories.", "A mark with no durable knowledge emits trajectories: [] — measured, not missing.")}
      <div class="learn-foot2">
        <span>Evidence is the model's own summarized basis, accumulated across marks with no dedup — recurrence is meaningful. Edit ranges are stamped from the session edit log and never validated against anything the model said.</span>
        <span>Polarity is do-this / do-not-do, not a verdict — it never takes pass or fail colours. Near-duplicate labels slug differently and stay in separate blocks by design; the join is exact-slug only.</span>
      </div>
    </div>`;
}

function validationBanner(m) {
  return `
    <div class="lc-invalid">
      <span class="learn-kick danger">VALIDATION FAILED — ${m.validation_errors.length} ERRORS</span>
      <span class="learn-note">${esc(m.validation_errors.join(" · "))} — a disagreement with the plugin's own log is surfaced, not smoothed.</span>
    </div>`;
}

function trajectoryBlock(tj, L) {
  const records = (tj.knowledge ?? [])
    .map((k) => knowledgeRecord(k, tj, L))
    .join("");
  const parent = tj.parent_traj_label
    ? `refines ${esc(tj.parent_traj_label)}`
    : "refines traj0 — the session goal";
  return `
    <div class="lc-traj">
      <div class="lc-traj-head">
        <span class="lc-traj-label">${esc(tj.traj_label)}</span>
        <span class="learn-note">first seen · mark ${esc(String(tj.first_seen_mark ?? "?"))}</span>
        <span class="spacer"></span>
        <span class="learn-note">${esc(parent)}</span>
        <span class="lc-count">${(tj.knowledge ?? []).length} records</span>
      </div>
      ${records}
    </div>`;
}

function knowledgeRecord(k, tj, L) {
  const pol = k.polarity === "negative" ? "NEG" : k.polarity === "positive" ? "POS" : "?";
  const neg = k.polarity === "negative";
  const win = windowLabelFor(k, tj, L);
  const evidence = (k.evidence ?? [])
    .map((e) => `<span class="lc-ev"><i>· </i>${esc(e)}</span>`)
    .join("");
  const lines = (k.changed_lines ?? [])
    .map((r) => `<span class="lc-line">${esc(`${r.file}:${r.start}${r.end !== r.start ? `–${r.end}` : ""}`)}</span>`)
    .join("");
  const lineNote =
    (k.changed_lines ?? []).length === 0
      ? "0 ranges — this mark's work landed in a file the edit log never recorded"
      : `${(k.changed_lines ?? []).length} range${(k.changed_lines ?? []).length === 1 ? "" : "s"} · stamped from the session edit log`;

  return `
    <div class="lc-rec">
      <div class="lc-rec-top">
        <span class="lc-pol${neg ? " neg" : ""}">${pol}</span>
        <span class="lc-statement">${esc(k.statement)}</span>
        ${win ? `<span class="lc-win${win.bad ? " bad" : ""}">${esc(win.text)}</span>` : ""}
      </div>
      <div class="lc-cols">
        <div class="lc-col">
          <span class="learn-kick">THE MODEL\u2019S ACCOUNT</span>
          <span class="lc-w"><i>what · </i>${esc(k.did_what_and_for_why?.what ?? "")}</span>
          <span class="lc-w"><i>why · </i>${esc(k.did_what_and_for_why?.why ?? "")}</span>
          ${evidence ? `<div class="lc-evs">${evidence}</div>` : ""}
        </div>
        <div class="lc-col">
          <span class="learn-kick">WHAT THE TOOLS DID — CODE-DERIVED</span>
          <div class="lc-lines">${lines || `<span class="learn-note">no edit ranges recorded</span>`}</div>
          <span class="learn-note">${esc(lineNote)}</span>
        </div>
      </div>
    </div>`;
}

/** The window label for a claim, joined against the ledger's claim list. */
function windowLabelFor(k, tj, L) {
  const claims = Array.isArray(L?.ledger?.claims) ? L.ledger.claims : null;
  if (!claims) return null;
  const hit = claims.find(
    (c) =>
      str(c.statement) === str(k.statement) &&
      str(c.polarity) === str(k.polarity) &&
      str(c.traj_label) === str(tj.traj_label),
  );
  if (!hit || !str(hit.label)) return null;
  const label = str(hit.label);
  const bad = label === "regressed" || label === "trade-off";
  const w = int(hit.window);
  return { text: (w ? `W${w} · ` : "") + label.toUpperCase(), bad };
}


/**
 * BACKEND TELEMETRY — whatever namespaces appear on the live stream, including
 * unknown ones, drawn generically with `data` treated as opaque. An unknown
 * backend is visibly alive with its counts and newest payload, so an integrator
 * can tell a broken pipe from an unsupported one.
 */
function backendsBlock(board) {
  const live = board?.live ?? null;
  const ext = live?.ext ?? [];
  const declared = live?.backends ?? [];

  if (!ext.length && !declared.length) {
    return `
      <div class="learn-block">
        <span class="learn-kick">BACKEND TELEMETRY</span>
        <span class="learn-note">${esc(
          "no backend has written to the live stream on this run. A backend joins by appending to $BENCH_LIVE_STREAM — see LIVE-STREAM.md. Absence here means nothing was sent, not that something failed.",
        )}</span>
      </div>`;
  }

  const named = new Map(declared.map((b) => [b.ns, b]));
  const rows = ext
    .map((e) => {
      const meta = named.get(e.ns) ?? null;
      const title = meta?.name ? `${meta.name}${meta.version ? ` v${meta.version}` : ""}` : "undeclared backend";
      const types = e.types.map((t) => `${t.type} ×${t.n}`).join(" · ");
      const newest = e.recent?.[e.recent.length - 1] ?? null;
      return `
        <div class="bkrow">
          <div class="bkhead">
            <span class="bkns">${esc(e.ns)}</span>
            <span class="bkname">${esc(title)}</span>
            <span class="bkn">${esc(String(e.count))} records</span>
          </div>
          <div class="bktypes">${esc(types || "no typed records")}</div>
          ${newest ? `<div class="bkdata">${opaque(newest.data)}</div>` : ""}
        </div>`;
    })
    .join("");

  // A backend that announced itself but sent nothing yet is still listed.
  const silent = declared
    .filter((b) => !ext.some((e) => e.ns === b.ns))
    .map(
      (b) => `<div class="bkrow"><div class="bkhead">
          <span class="bkns">${esc(b.ns)}</span>
          <span class="bkname">${esc(b.name ?? "declared")}</span>
          <span class="bkn">announced · no records</span></div></div>`,
    )
    .join("");

  return `
    <div class="learn-block">
      <span class="learn-kick">BACKEND TELEMETRY — ${esc(String(ext.length + (silent ? 1 : 0)))} NAMESPACE(S)</span>
      <span class="learn-note">${esc(
        "payloads are opaque to this board by contract — rendered as sent, never interpreted",
      )}</span>
      <div class="bklist">${rows}${silent}</div>
    </div>`;
}

/**
 * An unknown payload: flat scalars as labelled rows, nested values as compact
 * JSON, a clipped value marked with an ellipsis.
 */
function opaque(data) {
  if (data === null || data === undefined) return `<span class="learn-note">no payload</span>`;
  if (typeof data !== "object" || Array.isArray(data)) {
    return `<span class="bkv">${esc(clipStr(JSON.stringify(data)))}</span>`;
  }
  const entries = Object.entries(data).slice(0, 8);
  if (!entries.length) return `<span class="learn-note">empty payload</span>`;
  return entries
    .map(([k, v]) => {
      const flat = v === null || ["string", "number", "boolean"].includes(typeof v);
      return `<span class="bkkv"><span class="bkk">${esc(k)}</span><span class="bkv">${esc(
        clipStr(flat ? String(v) : JSON.stringify(v)),
      )}</span></span>`;
    })
    .join("");
}

function clipStr(v) {
  const t = String(v ?? "");
  return t.length > 64 ? `${t.slice(0, 63)}…` : t;
}

// ── LIVE ─────────────────────────────────────────────────────────────────────

function liveView(L, board) {
  const m = L?.master;

  // The session id, freshest source first and named on screen: live.jsonl
  // cell.start, the running opencode session, then predicate-outcomes.jsonl
  // (written only after the campaign ends).
  const resolved =
    (board?.live?.session_id && { id: board.live.session_id, from: "live.jsonl · cell.start" }) ||
    (board?.run?.session_id && { id: board.run.session_id, from: "agent session · live" }) ||
    (L?.session_id && { id: L.session_id, from: "predicate-outcomes.jsonl · newest line" }) ||
    null;

  const book = [];
  book.push({ k: "session_id", v: resolved?.id ?? "unresolved", ink: "var(--type)" });
  book.push({
    k: "resolved from",
    v: resolved?.from ?? "no source has published one yet",
    ink: resolved ? "var(--fg)" : "var(--dim)",
  });
  book.push({
    k: "capture_state",
    v: CAPTURE_WORD[L?.capture_state ?? "unobserved"],
    ink: L?.capture_state === "captured" ? "var(--check)" : "var(--dim)",
  });
  book.push({
    k: "master",
    v: m ? `master.json · ${(m.bytes ?? 0) >= 1024 ? `${(m.bytes / 1024).toFixed(1)} KB` : `${m.bytes ?? 0} B`} · mtime ${new Date(m.mtime_ms ?? 0).toISOString().slice(11, 19)}` : "not present",
    ink: m ? "var(--fg)" : "var(--dim)",
  });
  if (m) {
    const mm = m.merge ?? {};
    const mismatches = Array.isArray(mm.mark_index_mismatches) ? mm.mark_index_mismatches.length : 0;
    book.push({
      k: "index mismatches",
      v: mismatches ? `${mismatches} — the model mis-reported its own position` : "0",
      ink: mismatches ? "var(--comment)" : "var(--fg)",
    });
    book.push({
      k: "validation",
      v: m.valid ? "valid · slugs unique, parents resolve, no cycle" : `${(m.validation_errors ?? []).length} errors`,
      ink: m.valid ? "var(--check)" : "var(--danger)",
    });
    let pos = 0;
    let neg = 0;
    for (const t of m.trajectories ?? []) for (const k of t.knowledge ?? []) k.polarity === "negative" ? neg++ : pos++;
    book.push({ k: "pos / neg", v: `${pos} positive · ${neg} negative`, ink: "var(--fg)" });
  } else {
    book.push({ k: "index mismatches", v: "unobserved", ink: "var(--dim)" });
    book.push({ k: "validation", v: "unobserved — nothing to validate yet", ink: "var(--dim)" });
    book.push({ k: "pos / neg", v: "unobserved", ink: "var(--dim)" });
  }
  const cl = L?.changed_lines;
  book.push({
    k: "changed-lines",
    v: cl ? `${cl.count} ranges across ${cl.files.length} files` : "unobserved",
    ink: cl ? "var(--fg)" : "var(--dim)",
  });
  book.push({ k: "poll", v: "2s · mtime + bytes provenance on every read", ink: "var(--fg)" });

  const mm = m?.merge ?? {};
  const marksSeen = Array.isArray(mm.marks_seen) ? mm.marks_seen : [];
  const totalMarks = mm.total_marks ?? PHASES_PER_CELL;
  const seenSet = new Set(marksSeen.map(Number));
  const pips = Array.from({ length: Math.max(totalMarks, marksSeen.length, 1) }, (_, i) => {
    const n = i + 1;
    if (seenSet.has(n)) return `<span class="lp-pip on"></span>`;
    const isGap = marksSeen.length > 0 && n < Math.max(...marksSeen.map(Number));
    return `<span class="lp-pip${isGap ? " gap" : ""}"></span>`;
  }).join("");

  const sessions = (L?.sessions ?? []).map((s) => {
    const armInk = s.arm === "on" ? C.armA : s.arm === "off" ? C.armB : "var(--dim)";
    const tally =
      s.arm === "off"
        ? "unwired — not persisted to host"
        : s.masterPath
          ? `${s.marks_seen ?? 0} of ${s.total_marks ?? "?"} marks · ${s.trajectories ?? 0} traj · ${s.claims ?? 0} claims`
          : "0 marks · master pending";
    const bytes = s.bytes === null || s.bytes === undefined ? "—" : `${(s.bytes / 1024).toFixed(1)} KB`;
    return `
      <div class="ls-row">
        <span class="ls-id">${esc(s.session_id ?? "?")}</span>
        <span style="color:${armInk}">${s.arm === "on" ? "MEMORY ON" : s.arm === "off" ? "CONTROL" : "—"}</span>
        <span class="ls-tally" style="color:${s.arm === "off" ? "var(--dim)" : "var(--fg)"}">${esc(tally)}</span>
        <span>${s.pos ?? "—"} / ${s.neg ?? "—"}</span>
        <span class="ls-bytes">${esc(bytes)}</span>
      </div>`;
  }).join("");

  const states = CAPTURE_STATES.map((s) => {
    const st = CAPTURE_STATE_DEFS[s];
    const on = (L?.capture_state ?? "unobserved") === s;
    return `
      <div class="lcs${on ? " on" : ""}">
        <span class="lcs-label" style="color:${st.ink}">${s.toUpperCase()}</span>
        <span class="lcs-body">${esc(st.body)}</span>
      </div>`;
  }).join("");

  return `
    <div class="learn">
      <div class="lv-cols">
        <div class="lv-col">
          <span class="learn-kick">ACTIVE SESSION</span>
          <div class="lbook">
            ${book.map((b) => `<div class="lbook-row"><span class="lbook-k">${esc(b.k)}</span><span class="lbook-v" style="color:${b.ink}">${esc(b.v)}</span></div>`).join("")}
          </div>
          <div class="learn-block">
            <span class="learn-kick">MARKS SEEN — ${marksSeen.length ? `${marksSeen.length} OF ${totalMarks}` : "NONE YET"}</span>
            <div class="lp-pips">${pips}</div>
            <span class="learn-note">${marksSeen.length ? "a gap is a give-up mark — nudge budget exhausted. Drawn hollow, never interpolated." : "no marks emitted yet"}</span>
          </div>
          <div class="learn-block">
            <span class="learn-kick">CAPTURE STATE — ALL FOUR, IN WORDS</span>
            <div class="lcs-list">${states}</div>
          </div>
          ${backendsBlock(board)}
        </div>
        <div class="lv-col">
          <div class="learn-head"><span class="learn-kick">IN-SESSION CAPTURES ON THIS HOST</span><span class="learn-note">newest first · capped at 20</span></div>
          <div class="ls">
            <div class="ls-row ls-hdr"><span>SESSION</span><span>ARM</span><span>MARKS · TRAJ · CLAIMS</span><span>POS / NEG</span><span>BYTES</span></div>
            ${sessions || `<div class="learn-note" style="padding:8px 0">no in-session captures on this host yet</div>`}
          </div>
          <div class="learn-block warn">
            <span class="learn-kick danger">OFF-CELL CAPTURE IS NOT PERSISTED YET</span>
            <span class="learn-note">The control worktree is deliberately unbound for arm comparability, so plugin state routes to an ephemeral tmpfs and never reaches the host mount. OFF rows above read <span class="dim">unwired</span> with that reason. No OFF master is ever synthesised from another artifact.</span>
          </div>
          <div class="learn-block">
            <span class="learn-kick">WHAT NEVER REACHES THIS BOARD</span>
            <span class="learn-note">Raw session transcripts, memory corpus bodies, and any key material. Claims, evidence, and edit ranges do render — on a host-only port by default. LAN exposure is a deliberate operator act and makes this content public.</span>
          </div>
        </div>
      </div>
    </div>`;
}

const CAPTURE_WORD = {
  unwired: "unwired — no insession directory (OFF-cell gap, or mount absent)",
  unobserved: "unobserved — master lands at cell end",
  captured: "captured",
  anomaly: "anomaly — master shrank across polls",
};

const CAPTURE_STATES = ["unwired", "unobserved", "captured", "anomaly"];

const CAPTURE_STATE_DEFS = {
  unwired: {
    ink: "var(--dim)",
    body: "No insession directory for this session — the OFF-cell persistence gap, or the mount is absent. Carries its reason; never an error.",
  },
  unobserved: {
    ink: "var(--dim)",
    body: "Armed and empty. The master lands at cell end; no intra-attempt growth is promised.",
  },
  captured: {
    ink: "var(--check)",
    body: "Master present, validated here against the same three checks the plugin runs. A disagreement is surfaced, not smoothed.",
  },
  anomaly: {
    ink: "var(--danger)",
    body: "A poll showed the master shrink. It is append-only in effect, so this is a capture defect and is said in words — never silently re-baselined.",
  },
};

function frame(head, body, note) {
  return `
    <div class="learn-frame">
      <span class="learn-frame-head">${esc(head)}</span>
      <span class="learn-frame-body">${esc(body)}</span>
      <span class="learn-frame-note">${esc(note)}</span>
    </div>`;
}

// ── tiny local coercions (keeps contract.mjs out of the browser) ──
function int(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function str(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}
