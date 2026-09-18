// PHASE SPINE (1 BUILD + 4 GRADEs) and PROVISIONAL COUNTERS, rendered by the
// gate wall (panels/wall.js, via the live.js re-export): where the cell is, and
// what it has spent getting there. Pure: reads no panel state.

import { esc, nul, tok, dur } from "../../board.js";
import { odo } from "../tick.js";

// ── THE PHASE SPINE ──

// Same as control/board/contract.mjs PHASES_PER_CELL (config.py max_attempts 5).
const PHASES_PER_CELL = 5;

const PHASES = [
  { n: 1, name: "BUILD", label: "initial" },
  ...Array.from({ length: PHASES_PER_CELL - 1 }, (_, i) => ({
    n: i + 2,
    name: "GRADE",
    label: `verdict-pass-${i + 1}`,
  })),
];

/**
 * Map the harness phase string (initial, initial-chunk-N, feedback-N,
 * verdict-pass-N, optional -zero-tool-resume-M) onto 1..5: attempt N's
 * feedback/verdict is phase N+1.
 */
export function phaseIndex(phase) {
  const p = String(phase ?? "").toLowerCase();
  if (!p) return null;
  if (p.startsWith("initial")) return 1;
  const m = p.match(/^(?:feedback|verdict-pass)-(\d+)/);
  if (!m) return null;
  const idx = Number(m[1]) + 1;
  return idx >= 1 && idx <= PHASES_PER_CELL ? idx : null;
}

/** Chunk number out of `initial-chunk-4`. Meaningful in phase 1 ONLY. */
export function chunkOf(phase) {
  const m = String(phase ?? "").match(/chunk-(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * Where the cell is: board.live.phase (the harness's phase.start record) is
 * authoritative; board.run.phase (parsed from the launch log, which stops moving
 * when the build ends) is the fallback for runs with no stream or a tail that
 * scrolled past every phase.start.
 */
function activePhase(r, board) {
  const stated = board?.live?.phase ?? null;
  if (stated) {
    const idx = phaseIndex(stated);
    if (idx !== null) return { idx, stated: true };
  }
  const idx = phaseIndex(r.phase);
  return { idx, stated: false };
}

export function spine(r, board) {
  const { idx: active, stated } = activePhase(r, board);
  const stopped = r.state === "complete" || r.state === "aborted";

  if (active === null && !stopped) {
    return `<div class="spine"><div class="null">${esc("no phase observed — nothing has reported yet")}</div></div>`;
  }

  // Attempt verdicts come from attempt.end: a closed attempt never reads running.
  const verdicts = new Map();
  for (const a of board?.live?.attempts ?? []) {
    if (Number.isFinite(a?.attempt)) verdicts.set(a.attempt, a);
  }

  const ended = board?.live?.ended ?? null;
  return `<div class="spine">${PHASES.map((p) => {
    let state =
      active === null ? "pending" : p.n < active ? "done" : p.n === active ? (stopped ? "done" : "running") : "pending";
    // A stopped cell's unfinished phases are stopped or not run, never done.
    if (stopped && !verdicts.has(p.n)) state = p.n <= (active ?? 0) ? "stopped" : "notrun";
    return phaseRow(p, state, r, board, verdicts.get(p.n), stated, ended);
  }).join("")}</div>`;
}

const END_WORD = {
  context_exhausted: "CONTEXT EXHAUSTED",
  stopped: "STOPPED FROM THE BOARD",
  worker_died: "WORKER DIED",
  harness_error: "HARNESS ERROR",
};

function phaseRow(p, state, r, board, verdict, stated, ended) {
  const title = p.n === 1 ? `${p.n} — ${p.name}` : `${p.n} — ${p.name} · ${p.label}`;
  const word =
    state === "running" ? "RUNNING"
      : state === "done" ? "DONE"
        : state === "stopped" ? "STOPPED"
          : state === "notrun" ? "NOT RUN"
            : "PENDING";

  // Chunks are internal to phase 1 and are drawn ONLY while it is the phase.
  const ticks =
    p.n === 1 && state !== "pending" ? chunkTicks(r, board, state) : "";

  // The closed attempt's `failed` count, from attempt.end (one conformance
  // finding is now one gate, so this matches the wall).
  const outcome =
    verdict && state === "done"
      ? `<span class="ph-verdict ${verdict.verdict === "PASS" ? "good" : "bad"}"${
          Number.isFinite(verdict.failed)
            ? ` title="${esc(
                `${verdict.failed} gates failing at the close of attempt ${verdict.attempt}, `
                + "as the gate runner recorded it.",
              )}"`
            : ""
        }>${esc(
          `${verdict.verdict ?? "?"}${Number.isFinite(verdict.failed) ? ` · ${verdict.failed} failed` : ""}`,
        )}</span>${churn(verdict)}${stageChip(verdict)}`
      : state === "stopped"
        ? `<span class="ph-verdict bad" title="${esc(`the cell stopped (${ended?.terminal_reason ?? "reason not recorded"}) before this phase was graded`)}">${esc(
          `NOT GRADED${ended?.terminal_reason ? ` — ${END_WORD[ended.terminal_reason] ?? ended.terminal_reason}` : ""}`,
        )}</span>`
        : "";

  return `
    <div class="ph ${state}"${state === "running" && !stated ? ` title="phase recovered from the launch log — the harness's own phase.start record was not readable"` : ""}>
      <div class="ph-top"><span>${esc(title)}</span>${outcome ? `<span class="ph-out">${outcome}</span>` : ""}<span class="ph-state">${word}</span></div>
      ${ticks}
    </div>`;
}

/**
 * Player order: the stage this round reached; the model was told only that
 * stage's problems.
 */
function stageChip(v) {
  if (!Number.isFinite(v.stage)) return "";
  const past = Number.isFinite(v.withheld) && v.withheld ? ` · ${v.withheld} held back` : "";
  return `<span class="ph-stage" title="${esc(
    `the model was told only the problems of stage ${v.stage} (${v.stage_name ?? ""}); `
    + `${v.withheld ?? 0} failing checks in later stages were graded but not told`,
  )}">${esc(`stage ${v.stage}${v.stage_name ? ` · ${v.stage_name}` : ""}${past}`)}</span>`;
}

/**
 * What a closed attempt changed against the one before (fixed/broke), so a
 * round that fixed two and broke two doesn't look like nothing moved.
 */
function churn(v) {
  if (!Number.isFinite(v.fixed) || !Number.isFinite(v.broke)) return "";
  if (!v.fixed && !v.broke) return `<span class="ph-churn">no change</span>`;
  const bits = [];
  if (v.fixed) bits.push(`<span class="ph-churn good">${esc(`${v.fixed} fixed`)}</span>`);
  if (v.broke) bits.push(`<span class="ph-churn bad">${esc(`${v.broke} broke`)}</span>`);
  return bits.join("");
}

/**
 * The work orders inside phase 1. When the phase is done every tick is done: a
 * finished build has no current chunk (it must not keep pulsing).
 */
function chunkTicks(r, board, phaseState) {
  const total = r.chunk?.total ?? 6;
  const cur = r.chunk?.current ?? chunkOf(r.phase);
  const finished = phaseState === "done";

  if (!cur) {
    return `<div class="ph-note">${esc(`${total} work orders — none reported yet`)}</div>`;
  }
  const ticks = Array.from({ length: total }, (_, i) => {
    const n = i + 1;
    const cls = finished ? "done" : n < cur ? "done" : n === cur ? "now" : "todo";
    return `<span class="tick ${cls}"></span>`;
  }).join("");
  const note = finished
    ? `all ${total} work orders complete — chunks are internal to phase 1`
    : `work order ${cur} of ${total} — chunks are internal to phase 1`;
  return `
    <div class="ticks">${ticks}</div>
    <div class="ph-note">${esc(note)}</div>`;
}

/**
 * PROVISIONAL COUNTERS — every token category, labelled, all five summed into
 * one total (rendered on the gate wall: correctness and cost for one cell).
 *
 * Cache read is in the total: it is billed, and injected memory grows the prompt
 * that is re-read every turn, so memory's cost lands there (often ~99% of
 * tokens). When only 2 of 5 categories are observed (opencode-serve unwired) the
 * total is marked partial and names what is missing. Zero is an observation. The
 * label ellipsises before a figure ever clips.
 */
export function provisional(r, running) {
  const t = r.tokens ?? {};
  const mark = running ? " <span class='muted'>\u203a</span>" : "";

  // Prompt side first, then generation. All five are billed and summed.
  const parts = [
    { label: "input", v: numOrNull(t.input) },
    { label: "cache read", v: numOrNull(t.cache_read) },
    { label: "cache write", v: numOrNull(t.cache_write) },
    { label: "output", v: numOrNull(t.output) },
    { label: "reasoning", v: numOrNull(t.reasoning) },
  ];
  const seen = parts.filter((p) => p.v !== null);
  const missing = parts.filter((p) => p.v === null);
  const total = seen.length ? seen.reduce((a, p) => a + p.v, 0) : null;
  const partial = total !== null && missing.length > 0;

  return `
    <div class="prov-tot">
      <span class="kick">${running ? "PROVISIONAL — RUNNING TOTALS, NOT FINAL" : "CELL TOTALS"}</span>
      <div class="big">
        <span>${r.turns === null || r.turns === undefined ? nul("turns unobserved") : `${odo(r.turns, { float: true }) ?? esc(String(r.turns))} turns${mark}`}</span>
        <span class="${partial ? "tkpartial" : ""}">${total === null ? nul("tokens unobserved") : `${odo(total, { fmt: "tok" }) ?? esc(tok(total))}${mark}`}</span>
        <span>${r.elapsed_s === null || r.elapsed_s === undefined ? nul("time unobserved") : `${esc(dur(r.elapsed_s))}${mark}`}</span>
      </div>

      <div class="tkbl">
        <span class="kick tkhead">TOKENS</span>
        ${parts.map((p) => tokRow(p.label, p.v)).join("")}
        ${sumRow(partial ? "total · partial" : "total", total, r.turns, partial)}
        ${cacheHitRow(t)}
      </div>

      ${partial ? `<div class="tknote">${esc(`total sums ${seen.length} of 5 — ${missing.map((m) => m.label).join(", ")} unobserved (agent serve source is off or unreachable)`)}</div>` : ""}
    </div>`;
}

/** null-safe passthrough — 0 is a real observation and must not become null. */
function numOrNull(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

/** Exact digits: a breakdown must reconcile against the rounded headline. */
function exact(n) {
  return Number(n).toLocaleString("en-US");
}

/**
 * CACHE HIT RATE = cache read / (input + cache read + cache write): the share
 * of prompt tokens that arrived cached. Memory that writes early into the prompt
 * breaks the cached prefix and multiplies cost without moving the token count; a
 * lower rate on the memory arm shows that. Not shown unless all three
 * categories are observed.
 */
function cacheHitRow(t) {
  const input = numOrNull(t.input);
  const read = numOrNull(t.cache_read);
  const write = numOrNull(t.cache_write);
  if (input === null || read === null || write === null) {
    return `
      <div class="tkrow tkrate">
        <span class="tkl">cache hit</span>
        <span class="tkv">${nul("unobserved")}</span>
      </div>`;
  }
  const prompt = input + read + write;
  if (prompt <= 0) {
    return `
      <div class="tkrow tkrate">
        <span class="tkl">cache hit</span>
        <span class="tkl">${esc("no prompt tokens yet")}</span>
      </div>`;
  }
  const hit = (read / prompt) * 100;
  // Two decimals (99.4% vs 99.9% is ~8× the uncached tokens). The rate animates
  // but floats no delta: it is not a spend.
  return `
    <div class="tkrow tkrate">
      <span class="tkl">cache hit</span>
      <span class="tkv">${odo(hit, { fmt: "pct" }) ?? `${esc(hit.toFixed(2))}%`}</span>
    </div>
    <div class="tkrow tkrate tksubrow">
      <span class="tkl">uncached prompt</span>
      <span class="tkv">${odo(input + write, { float: true }) ?? esc(exact(input + write))}</span>
    </div>`;
}

/**
 * The bottom row: the total and the turn count, side by side and never
 * multiplied (context grows every turn, so turns × context computes nothing
 * useful). The unit word rides on the turn count.
 */
function sumRow(label, total, turns, partial) {
  const turnTxt =
    turns === null || turns === undefined || !Number.isFinite(turns)
      ? nul("turns unobserved")
      : `${odo(turns) ?? esc(exact(turns))} turns`;
  return `
    <div class="tkrow tksum ${partial ? "tkpartial" : ""}">
      <span class="tkl">${esc(label)}</span>
      <span class="tkv">${total === null ? nul("unobserved") : (odo(total, { float: true }) ?? esc(exact(total)))}<span class="tkbar">|</span><span class="tkturns">${turnTxt}</span></span>
    </div>`;
}

function tokRow(label, v, cls = "") {
  // Every category floats its delta, so it is visible which line moved.
  return `
    <div class="tkrow ${cls}">
      <span class="tkl">${esc(label)}</span>
      <span class="tkv">${v === null ? nul("unobserved") : (odo(v, { float: true }) ?? esc(exact(v)))}</span>
    </div>`;
}
