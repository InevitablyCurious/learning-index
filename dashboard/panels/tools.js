// SETTINGS — the drawer behind the hamburger. It holds the four REFRESH buttons
// (the benchmark's own tools, one per part that keeps running old code after an
// edit), the modes, the router keys and any custom tools a memory system adds.
// The registry is served by GET /api/tools, never held here, and results are
// shown in the tool's own words.

import { esc } from "../board.js";
// Credentials live in this drawer too.
import { renderRoutersSection } from "./routers.js";
// So does dev mode (server state, read from the board).
import { renderDevModeSection } from "./devmode.js";
// Require-todos is a local launch preference (see switches.js).
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
  // Per-tool argument values, prefilled from the server's declared defaults.
  args: {},
  // Per-tool in-flight state and outcome.
  busy: {},
  results: {},
  // Arrived from a refusal: preflight named this tool as the fix, so its row is
  // highlighted, explained and scrolled to — once (focusScrolled), or the
  // re-render would pin the drawer there.
  focus: null,
  focusReason: null,
  focusScrolled: false,
};

export function isToolsOpen() {
  return ui.open === true;
}

/**
 * Open the drawer, optionally pointed at the tool preflight named (`reason` is
 * the check that sent us here).
 */
export function openTools({ focus = null, reason = null } = {}) {
  ui.open = true;
  ui.closing = false;
  ui.focus = focus ? String(focus) : null;
  ui.focusReason = focus ? reason : null;
  ui.focusScrolled = false;
}

/**
 * Scroll the focused row into view once, after the drawer is in the DOM (the
 * overlay knows when that is).
 */
export function settleToolsFocus() {
  if (!ui.open || !ui.focus || ui.focusScrolled) return;
  const el = document.querySelector(`[data-tool-focus="${CSS.escape(ui.focus)}"]`);
  if (!el) return;
  ui.focusScrolled = true;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
}

/** Close with the slide-out, then remove the node. */
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
      // A failed refresh keeps the list (and its result cards) on screen.
      ui.tools = ui.tools ?? [];
    } else {
      ui.tools = Array.isArray(data?.tools) ? data.tools : [];
      // Prefill from the server's defaults without clobbering typed values.
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
    if (data?.ok && ui.tools?.find((t) => t.id === id)?.reload_page) reloadWhenReplaced();
  } catch (err) {
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

/**
 * Refresh board swaps the container serving this page. Wait for the new one
 * (a different start time on /api/health), then reload onto its files.
 */
async function reloadWhenReplaced() {
  const startedAt = async () => {
    try {
      return (await (await fetch("/api/health", { cache: "no-store" })).json())?.started_at ?? null;
    } catch {
      return null;
    }
  };
  const before = await startedAt();
  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = await startedAt();
    if (now && now !== before) {
      location.reload();
      return;
    }
  }
}

// ── render ──

/** The hamburger. Lives at the far right of the top bar. */
export function renderToolsButton() {
  return `<button class="hamburger" data-tools-open="1" aria-label="Settings"
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
            <span class="dw-sub">refresh buttons, modes, credentials and custom tools</span>
          </div>
          <button class="dw-x" data-tools-close="1" aria-label="Close">✕</button>
        </div>

        <div class="dw-body">
          <section class="mn-sec">
            <span class="mn-h">REFRESH</span>
            <p class="dw-lede">
              After code changes, press the button for the part that changed. Preflight names
              the one you need when a run is refused. Everything else — harness, prompts,
              challenges, scripts — picks up changes by itself at the next run.
            </p>
            ${body((t) => !t.external)}
          </section>

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
              Added by this installation for its memory system, not part of the benchmark.
            </p>

            ${body((t) => t.external)}
          </section>
        </div>

        <div class="dw-foot">
          <span class="dw-note">${ui.tools === null ? "reading tools…" : ""}</span>
        </div>
      </aside>`;
}

/**
 * GRADING — how much of the machine the grading pass may use. Not a mode: it
 * changes how long grading takes, never the verdicts (scripts/
 * verify_worker_parity.py checks this). A share of what is free at grading time,
 * not a worker count, so it means the same on any hardware and never starts
 * browsers into memory already in use.
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

function body(keep) {
  if (ui.loading && ui.tools === null) return `<div class="dw-empty">reading registry…</div>`;
  // Above the list, never instead of it: a stale list says it is stale.
  const banner = ui.error
    ? `<div class="tool-result bad"><span class="tr-code">registry unavailable</span>` +
      `<span class="tr-lines">${esc(ui.error)}</span>` +
      `<span class="tr-note">${
        ui.tools && ui.tools.length
          ? "the tools below are the last list read and may be out of date — close and reopen this drawer to re-read it"
          : "close and reopen this drawer to try again"
      }</span></div>`
    : "";
  const tools = (ui.tools ?? []).filter(keep);
  if (!tools.length) return banner || `<div class="dw-empty">none</div>`;
  return `${banner}<div class="dw-list">${tools.map(toolCard).join("")}</div>`;
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
               <span class="tr-lines">no output until it finishes — a refresh can take several minutes</span>
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
 * The outcome in the tool's own terms: a generic verdict, the tool's own
 * success_note, and the command output verbatim.
 */
function resultBlock(t, r) {
  const out = [r.stdout, r.stderr].filter((x) => String(x ?? "").trim()).join("\n").trim();
  const log = out ? `<pre class="tool-log">${esc(out)}</pre>` : "";

  if (r.ok) {
    // Structured fields, when a custom tool returned any.
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
