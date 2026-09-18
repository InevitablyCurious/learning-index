// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM TOOLS — the drawer behind the hamburger
//
// ── WHAT THIS SURFACE IS FOR ────────────────────────────────────────────────
//
// The benchmark is meant to be a composable service that any memory system can
// point at, not an Okp-specific harness. A "custom tool" is the unit of that
// adaptation: a small module that registers a command plus a config blob, and
// then either works or fails loudly. This drawer is where those tools become
// visible to an operator instead of living only in a CLI someone has to know
// about.
//
// ── WHY A DRAWER AND NOT A MODAL OR A PANEL ─────────────────────────────────
//
// A modal is for a DECISION — it takes the screen because it must be answered
// before anything else continues (reset, restore). This is not a decision; it is
// a place you go to look at what is available and act on one thing. A board
// panel is wrong for the opposite reason: the board's argument is a fixed layout
// the eye learns, and a tool list that grows with every integration would push
// the measurement surfaces around. A drawer stays out of the layout entirely,
// opens over the right edge, and leaves the board exactly where it was.
//
// ── THE REGISTRY IS SERVED, NOT HELD HERE ───────────────────────────────────
//
// The harness owns the list — it is what knows which tools are registered and
// whether each one's preconditions hold. This module renders `GET /api/tools`
// and nothing else. A UI keeping its own copy is a second source of truth that
// would eventually offer a tool that does not exist.
//
// ── THE RESULT IS THE TOOL'S OWN WORDS ──────────────────────────────────────
//
// On success and on failure alike, what comes back from the server is shown as
// it arrived. Rewriting it would hide which layer refused — the CLI, the hub, or
// the control plane — which is the first thing anyone debugging a join needs.
// ─────────────────────────────────────────────────────────────────────────────

import { esc } from "../board.js";
// Credentials live in this same drawer — see renderToolsDrawer.
import { renderRoutersSection } from "./routers.js";
// So does the dev-mode toggle. It takes `board` because the mode is SERVER
// state carried on the poll, never a copy this drawer keeps.
import { renderDevModeSection } from "./devmode.js";
// The require-todos switch is a LAUNCH PREFERENCE for this browser, not server
// state — see switches.js for why only one of these two persists locally.
import {
  GRADER_TARGET_CHOICES,
  graderWorkerTarget,
  renderSwitch,
  requireTodosOn,
  setGraderWorkerTarget,
} from "./switches.js";

const ui = {
  open: false,
  closing: false,
  expanded: null,
  loading: false,
  tools: null,
  error: null,
  // Per-tool argument values, keyed by tool id. Prefilled from the server's
  // declared defaults so the common case is one click.
  args: {},
  // Per-tool in-flight + outcome, so one tool running never blanks another.
  busy: {},
  results: {},
  // ── ARRIVED HERE FROM A REFUSAL ────────────────────────────────────────
  //
  // When preflight refuses a launch it now names the tool that repairs it, and
  // that button opens this drawer pointed AT that tool. The drawer is long
  // enough that "it is in here somewhere" is not routing — so the row is
  // highlighted, told why it is highlighted, and scrolled to.
  //
  // `focusScrolled` makes the scroll happen ONCE. The board re-renders twice a
  // second; scrolling on every pass would pin the drawer to that row and the
  // operator could not read anything else.
  focus: null,
  focusReason: null,
  focusScrolled: false,
};

export function isToolsOpen() {
  return ui.open === true;
}

/**
 * Open the drawer.
 *
 * `focus` optionally names a tool to point at — the id preflight named as the
 * remedy for a failed check — and `reason` is the check that sent us here, so
 * the highlighted row can say why rather than just glowing.
 */
export function openTools({ focus = null, reason = null } = {}) {
  ui.open = true;
  ui.closing = false;
  ui.focus = focus ? String(focus) : null;
  ui.focusReason = focus ? reason : null;
  ui.focusScrolled = false;
}

/**
 * Scroll the focused row into view, once, AFTER the drawer is in the DOM.
 *
 * Called by the overlay because only it knows when the patch has landed; a
 * render that returns a string cannot scroll to something that does not exist
 * yet.
 */
export function settleToolsFocus() {
  if (!ui.open || !ui.focus || ui.focusScrolled) return;
  const el = document.querySelector(`[data-tool-focus="${CSS.escape(ui.focus)}"]`);
  if (!el) return;
  ui.focusScrolled = true;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
}

/**
 * Close with the exit animation.
 *
 * The drawer is kept in the DOM for the length of the slide-out and only then
 * removed. Dropping the node immediately would make close a POP while open is a
 * slide — an asymmetry that reads as a glitch rather than a transition.
 */
export function closeTools(onDone) {
  if (!ui.open || ui.closing) return;
  ui.closing = true;
  setTimeout(() => {
    ui.open = false;
    ui.closing = false;
    ui.expanded = null;
    ui.focus = null;
    ui.focusReason = null;
    ui.focusScrolled = false;
    if (typeof onDone === "function") onDone();
  }, 180);
}

export function toggleToolDetail(id) {
  ui.expanded = ui.expanded === String(id) ? null : String(id);
}


/** Load the registry. Called on open, so the drawer is never stale on screen. */
export async function loadTools() {
  ui.loading = true;
  ui.error = null;
  try {
    const res = await fetch(`/api/tools`);
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      ui.error = data?.reason ?? `HTTP ${res.status}`;
      // KEEP WHAT IS ON SCREEN. A refresh that fails is not evidence the tools
      // went away, and blanking the list would also take every result card with
      // it — including the one whose run just restarted the control plane.
      ui.tools = ui.tools ?? [];
    } else {
      ui.tools = Array.isArray(data?.tools) ? data.tools : [];
      // Prefill from the SERVER's declared defaults, without clobbering
      // anything the operator has already typed.
      for (const t of ui.tools) {
        ui.args[t.id] = ui.args[t.id] ?? {};
        for (const a of t.args ?? []) {
          if (ui.args[t.id][a.name] === undefined) ui.args[t.id][a.name] = a.default ?? "";
        }
      }
    }
  } catch (err) {
    ui.error = String(err?.message ?? err);
    ui.tools = ui.tools ?? [];
  } finally {
    ui.loading = false;
  }
}

export function setToolArg(id, name, value) {
  ui.args[id] = ui.args[id] ?? {};
  ui.args[id][name] = value;
}

/** Fire one tool. The result — success or failure — is kept on its card. */
export async function runTool(id) {
  ui.busy[id] = true;
  ui.results[id] = null;
  try {
    const res = await fetch(`/api/tools/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, args: ui.args[id] ?? {} }),
    });
    const data = await res.json().catch(() => null);
    ui.results[id] =
      data ?? { ok: false, code: `HTTP ${res.status}`, reason: "the control plane returned nothing readable" };
  } catch (err) {
    // THE COMMON CAUSE IS A RESTART, NOT A BREAKAGE. `bench-ready` converges the
    // control plane last, so for a few seconds there is nothing on :8718 to
    // answer — and a bare "Failed to fetch" reads like the tool is broken.
    ui.results[id] = {
      ok: false,
      code: "unreachable",
      reason:
        `${String(err?.message ?? err)} — the control plane did not answer. ` +
        `If a tool just restarted it, give it a few seconds and press run again.`,
    };
  } finally {
    ui.busy[id] = false;
  }
}

// ── render ───────────────────────────────────────────────────────────────────

/** The hamburger. Lives at the far right of the top bar. */
export function renderToolsButton() {
  return `<button class="hamburger" data-tools-open="1" aria-label="Custom tools"
    aria-expanded="${ui.open ? "true" : "false"}"><span></span><span></span><span></span></button>`;
}

export function renderToolsDrawer(board) {
  if (!ui.open) return "";

  return `
    <div class="drawer-scrim${ui.closing ? " out" : ""}" data-tools-scrim="1"></div>
      <aside class="drawer${ui.closing ? " out" : ""}" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="dw-head">
          <div class="dw-titles">
            <span class="dw-title">SETTINGS</span>
            <span class="dw-sub">mode, credentials and custom tools — everything you configure, in one place</span>
          </div>
          <button class="dw-x" data-tools-close="1" aria-label="Close">✕</button>
        </div>

        <div class="dw-body">
          ${renderGradingSection()}

          <section class="mn-sec">
            <span class="mn-h">MODES</span>
            <p class="dw-lede">
              How the board behaves. These are states, not actions — they stay as you leave
              them, and they change what every run below them does.
            </p>

            ${renderDevModeSection(board)}

            ${renderSwitch({
              name: "REQUIRE TODOS",
              desc:
                "Refuse edits, writes and shell until the agent has written a todo list. " +
                "Reading stays open. Needs a memory plugin that honours it — the benchmark " +
                "declares the condition, a plugin enforces it.",
              state: requireTodosOn() ? "on" : "off",
              attr: "data-requiretodos-set",
              warn: requireTodosOn()
                ? "This changes what the agent does, so it is a measurement variable. A run with it on and a run with it off are not comparable — re-establish the OFF floor after switching."
                : null,
            })}

          </section>

          ${renderRoutersSection()}

          <section class="mn-sec">
            <span class="mn-h">CUSTOM TOOLS</span>
            <p class="dw-lede">
              One-click operations on the bench itself. Each shows exactly what it did —
              the command's own output — and fails loudly rather than quietly doing nothing.
            </p>

            ${body()}
          </section>
        </div>

        <div class="dw-foot">
          <span class="dw-note">${
            ui.tools === null ? "reading registry…" : `${ui.tools.length} tool${ui.tools.length === 1 ? "" : "s"} registered`
          }</span>
        </div>
      </aside>`;
}

/**
 * GRADING — how much of the machine the grading pass may use.
 *
 * ── WHY IT IS FIRST, AND WHY IT IS NOT A "MODE" ─────────────────────────────
 *
 * Everything under MODES changes WHAT THE AGENT DOES, which makes each one a
 * measurement variable: a run with it on and a run with it off are not
 * comparable. This changes nothing about the run. It sets how many test workers
 * the GRADING container starts, after the model has finished, and the gates and
 * their verdicts are identical either way.
 *
 * That is a claim, so it is checked rather than asserted:
 * `scripts/verify_worker_parity.py` grades the golden at one worker and at the
 * maximum and requires agreement gate for gate. If that ever fails, this stops
 * being a preference and becomes a defect.
 *
 * ── WHY A FRACTION AND NOT A WORKER COUNT ───────────────────────────────────
 *
 * A count would be a number tuned to whoever typed it. The container reads its
 * OWN limits and works out how many workers fit; this only says what share of
 * them to take. The same setting therefore means the same thing on a laptop and
 * on a build server, and nobody's hardware is written into the code.
 *
 * The share is of what is FREE at grading time, not of what exists — the
 * operator may already have containers running, and sizing against the total
 * would start browsers into memory that is already spoken for and let the OOM
 * killer decide which gate fails.
 */
function renderGradingSection() {
  const current = graderWorkerTarget();
  const choices = GRADER_TARGET_CHOICES.map((f) => {
    const on = Math.abs(f - current) < 1e-9;
    return (
      `<button class="gt-opt${on ? " on" : ""}" data-gradertarget-set="${f}" ` +
      `aria-pressed="${on}">${Math.round(f * 100)}%</button>`
    );
  }).join("");

  return `
    <section class="mn-sec">
      <span class="mn-h">GRADING</span>
      <p class="dw-lede">
        How much of this machine grading may use. It changes how LONG grading takes and
        never what it reports — the golden is checked at one worker and at the maximum,
        and they must agree gate for gate.
      </p>
      <div class="sw-row">
        <div class="sw-text">
          <span class="sw-name">MACHINE SHARE</span>
          <span class="sw-desc">Share of FREE CPU and memory the grading container may take.
            It works out its own worker count from that, so the same setting fits a laptop
            and a build server without being told about either.</span>
        </div>
        <div class="gt-opts" role="group" aria-label="Machine share">${choices}</div>
      </div>
    </section>`;
}

function body() {
  if (ui.loading && ui.tools === null) return `<div class="dw-empty">reading registry…</div>`;
  // ABOVE the list, never instead of it. What is on screen may be a registry
  // read before a restart — stale, and it must SAY so rather than silently
  // offering rows the server may no longer serve.
  const banner = ui.error
    ? `<div class="tool-result bad"><span class="tr-code">registry unavailable</span>` +
      `<span class="tr-lines">${esc(ui.error)}</span>` +
      `<span class="tr-note">${
        ui.tools && ui.tools.length
          ? "the tools below are the last list read and may be out of date — close and reopen this drawer to re-read it"
          : "close and reopen this drawer to try again"
      }</span></div>`
    : "";
  if (!ui.tools || !ui.tools.length) {
    return (
      banner ||
      `<div class="dw-empty">No tools are registered. A tool is a row in the harness registry — see control/tools.mjs.</div>`
    );
  }
  return `${banner}<div class="dw-list">${ui.tools.map(toolCard).join("")}</div>`;
}

function toolCard(t) {
  const wired = t.status === "wired";
  const open = ui.expanded === t.id;
  const busy = ui.busy[t.id] === true;
  const result = ui.results[t.id] ?? null;
  const focused = ui.focus === t.id;

  return `
    <div class="tool${wired ? "" : " unwired"}${focused ? " tool-focused" : ""}"${
      focused ? ` data-tool-focus="${esc(t.id)}"` : ""
    }>
      ${
        focused
          ? `<div class="tool-why">${esc(
              ui.focusReason
                ? `Preflight refused the launch — ${ui.focusReason}. This is the tool that repairs it.`
                : "Preflight refused the launch. This is the tool that repairs it.",
            )}</div>`
          : ""
      }
      <div class="tool-row1">
        <span class="tool-name">${esc(t.name)}</span>
        ${t.external
          ? `<span class="tool-badge local" title="${esc("Contributed by this installation, not part of the bench repo")}">LOCAL</span>`
          : ""}
        <span class="tool-badge ${wired ? "ok" : "off"}">${wired ? "READY" : "BLOCKED"}</span>
      </div>
      <div class="tool-blurb">${esc(t.blurb)}</div>

      ${
        wired
          ? ""
          : `<div class="tool-missing">${esc(t.blocked_reason ?? "not available from this board yet")}</div>`
      }

      ${wired ? (t.args ?? []).map((a) => argField(t, a)).join("") : ""}

      <div class="tool-row2">
        <span class="tool-id">${esc(t.id)}</span>
        <button class="btn sm tool-detail" data-tool-detail="${esc(t.id)}">${open ? "hide steps" : "steps"}</button>
        <button class="btn sm primary" data-tool-run="${esc(t.id)}" ${wired && !busy ? "" : "disabled"}>${
          busy ? "running…" : "run"
        }</button>
      </div>

      ${
        open && Array.isArray(t.seams) && t.seams.length
          ? `<ol class="tool-seams">${t.seams.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`
          : ""
      }

      ${
        busy
          ? `<div class="tool-result">
               <span class="tr-code">RUNNING</span>
               <span class="tr-lines">no output until it finishes — a rebuild can take several minutes</span>
             </div>`
          : ""
      }

      ${result && !busy ? resultBlock(t, result) : ""}
    </div>`;
}

function argField(t, a) {
  const v = ui.args[t.id]?.[a.name] ?? "";
  return `
    <label class="tool-arg">
      <span class="ta-label">${esc(a.label ?? a.name)}${a.required ? "" : " (optional)"}</span>
      <input class="ta-input" type="text" data-tool-arg="${esc(t.id)}" data-arg-name="${esc(a.name)}"
        value="${esc(String(v))}" spellcheck="false" />
      ${a.help ? `<span class="ta-help">${esc(a.help)}</span>` : ""}
    </label>`;
}

/**
 * The outcome — the TOOL's, not a template's.
 *
 * WHAT WAS WRONG HERE. This block hardcoded one tool's vocabulary, so every
 * tool that succeeded reported SENT and a caveat about an org leader approving
 * it. A worker-image rebuild that ran a real docker build for ten seconds said
 * it was waiting on a human, and the build log — which the control plane
 * returns in full — was thrown away. From the board, a working button was
 * indistinguishable from a dead one.
 *
 * So: the verdict is generic, the caveat is the tool's own `success_note`, and
 * the command's output is shown verbatim. Rewriting output would hide which
 * layer refused, which is the first thing anyone debugging needs.
 */
function resultBlock(t, r) {
  const out = [r.stdout, r.stderr].filter((x) => String(x ?? "").trim()).join("\n").trim();
  const log = out ? `<pre class="tool-log">${esc(out)}</pre>` : "";

  if (r.ok) {
    // Structured fields, when the tool returned any (a custom tool may return a
    // structured `result`; a built-in script does not).
    const res = r.result && typeof r.result === "object" ? r.result : {};
    const lines = Object.entries(res)
      .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
      .map(([k, v]) => `${k} ${v}`);
    return `
      <div class="tool-result ok">
        <span class="tr-code">DONE</span>
        ${lines.length ? `<span class="tr-lines">${esc(lines.join(" · "))}</span>` : ""}
        ${t.success_note ? `<span class="tr-note">${esc(t.success_note)}</span>` : ""}
        ${log}
      </div>`;
  }
  return `
    <div class="tool-result bad">
      <span class="tr-code">${esc(r.code ?? "failed")}</span>
      <span class="tr-lines">${esc(r.reason ?? "no reason given")}</span>
      ${log}
    </div>`;
}
