// HISTORY PAGE — /history: every run the control plane knows, its
// checkpoints, the files each changed and the stored diffs side by side.
// Nothing touches `document` or `fetch` at module load, so tests can import it
// under Node; boot() is called only by history.html.

/** Escape everything that reaches the DOM. Paths and reasons are data, not HTML. */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// ── module state ── mutated only by loaders and click handlers.

const runsUi = { runs: [], loading: false, error: null };
// Which row is booting, what is playing, the last refusal.
const playUi = { busy: null, playing: null, error: null };
// Delete is permanent and two-step: a preview restating what goes, then a
// confirm carrying the token bound to what is on disk.
const delUi = { plan: null, busy: null };
const cpsUi = { checkpoints: null, diffs: null, loading: false, error: null };
const diffUi = { diffText: null, diffPath: null, loading: false, error: null };
const selection = { run: null, cell: null, cp: null };

// ── toasts ── the view is standardised, never the data: every problem shows as
// a toast with a code, a reason and where it happened, plus a copy button.

const toasts = { items: [], seq: 0 };

/** The pasteable form. One block, no ceremony, everything needed to act on it. */
export function toastText(t) {
  const lines = [`[${t?.code ?? "error"}] ${t?.reason ?? ""}`];
  if (t?.where) lines.push(`where: ${t.where}`);
  if (t?.detail) lines.push(`detail: ${t.detail}`);
  lines.push(`at: ${t?.at ?? ""}`);
  return lines.join("\n");
}

/** One toast. `bad` styles it as a failure rather than a notice. */
export function renderToast(t) {
  return (
    `<div class="toast${t.bad === false ? "" : " bad"}" data-toast="${esc(t.id)}">` +
      `<div class="toast-head">` +
        `<span class="toast-code">${esc(t.code ?? "error")}</span>` +
        `<span class="toast-actions">` +
          `<button type="button" class="toast-btn" data-toast-copy="${esc(t.id)}">copy</button>` +
          `<button type="button" class="toast-btn" data-toast-close="${esc(t.id)}">dismiss</button>` +
        `</span>` +
      `</div>` +
      `<div class="toast-body">${esc(t.reason ?? "")}</div>` +
      (t.where ? `<div class="toast-where">${esc(t.where)}</div>` : "") +
    `</div>`
  );
}

export function renderToasts(state) {
  const items = Array.isArray(state?.items) ? state.items : [];
  return items.map(renderToast).join("");
}

function paintToasts() {
  if (typeof document === "undefined") return;
  const el = document.getElementById("toasts");
  if (el) el.innerHTML = renderToasts(toasts);
}

/** Raise a toast. Never dedupes: the same failure twice is two facts. */
export function toast({ code, reason, where = null, detail = null, bad = true }) {
  const item = {
    id: `t${++toasts.seq}`,
    code: code ?? "error",
    reason: String(reason ?? ""),
    where,
    detail,
    bad,
    at: new Date().toISOString(),
  };
  toasts.items = [...toasts.items, item].slice(-5);
  paintToasts();
  return item;
}

export function dismissToast(id) {
  toasts.items = toasts.items.filter((t) => t.id !== id);
  paintToasts();
}

/** Copy one toast's pasteable block. Falls back to a prompt-free no-op. */
export async function copyToast(id) {
  const item = toasts.items.find((t) => t.id === id);
  if (!item) return false;
  const text = toastText(item);
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard denied: fall through.
  }
  return false;
}

/** Exposed for tests: the live toast list. */
export function currentToasts() {
  return toasts.items;
}

// ── pure renderers ── HTML strings, no DOM, no fetch.

/** One run row. Carries data-run + data-cell for the delegated click. */
export function renderRunRow(run, expanded = false) {
  const r = run ?? {};
  const dev = r.dev_mode_enabled
    ? `<span class="dev-on">enabled</span> <span class="dev-src">${esc(r.dev_mode_source ?? "")}</span>` +
      (r.dev_mode_file ? `<span class="hist-sub dev-file">${esc(r.dev_mode_file)}</span>` : "")
    : `<span class="dev-off">off</span>`;
  // The play control is a sibling of the row button (no button inside a button).
  const id = `${r.benchmark_id}::${r.cell}`;
  // Show tree_id: benchmark_id reads "backups" for every archived row.
  const treeId = r.tree_id ?? r.benchmark_id;
  const era = r.archived
    ? `<span class="hist-era">archived</span>`
    : `<span class="hist-era live">live tree</span>`;
  // An unrecognised layout is shown as such; no identity is invented.
  const idLabel = r.unreadable
    ? `<span class="hist-none">unrecognised</span>`
    : esc(treeId);
  const busy = playUi.busy === id;
  const live = playUi.playing && `${playUi.playing.run}::${playUi.playing.cell}` === id;
  const label = busy ? "starting…" : live ? "open ↗" : "view result";
  return (
    `<div class="hist-rowwrap">` +
      `<button type="button" class="hist-row run-row${expanded ? " on" : ""}" data-run="${esc(r.benchmark_id)}" data-cell="${esc(r.cell)}" aria-expanded="${expanded}"${expanded ? ' aria-controls="history-details"' : ""}>` +
        `<span class="c-id">${idLabel} ${era}</span>` +
        `<span class="c-dev">${dev}</span>` +
        `<span class="c-path">${r.checkpoints_dir ? esc(r.checkpoints_dir) : `<span class="hist-none">none</span>`}</span>` +
        `<span class="c-path">${r.transcript_file ? esc(r.transcript_file) : `<span class="hist-none">none</span>`}</span>` +
      `</button>` +
      `<button type="button" class="hist-play${live ? " on" : ""}" ` +
        `data-play-run="${esc(r.benchmark_id)}" data-play-cell="${esc(r.cell)}"` +
        `${busy ? " disabled" : ""}>${label}</button>` +
      `<button type="button" class="hist-del" title="delete this run permanently" ` +
        `data-del-run="${esc(r.benchmark_id)}" data-del-cell="${esc(r.cell)}"` +
        `${delUi.busy === id ? " disabled" : ""}>delete</button>` +
    `</div>`
  );
}

/** The runs table: loading / error / empty / rows — never a blank pane. */
export function renderRuns(state, selected = {}) {
  if (state?.loading) return `<div class="hist-note">reading history…</div>`;
  if (state?.error) return `<div class="hist-error" role="alert">${esc(state.error)}</div>`;
  const runs = Array.isArray(state?.runs) ? state.runs : [];
  if (runs.length === 0) return `<div class="hist-note">No runs yet</div>`;
  return (
    `<div class="hist-head run-row" aria-hidden="true">` +
      `<span>benchmark_id</span><span>dev_mode</span><span>checkpoints_dir</span><span>transcript_file</span>` +
    `</div>` +
    `<div class="hist-rows">${runs.map((r) => {
      const expanded = r.benchmark_id === selected.run && r.cell === selected.cell;
      return renderRunRow(r, expanded) + (expanded ? selected.details ?? "" : "");
    }).join("")}</div>`
  );
}

/** The check-point list for the selected run. Each row carries data-cp. */
export function renderCheckpoints(state) {
  if (state?.loading) return `<div class="hist-note">reading checkpoints…</div>`;
  if (state?.error) return `<div class="hist-error" role="alert">${esc(state.error)}</div>`;
  const cps = state?.checkpoints;
  if (!Array.isArray(cps) || cps.length === 0) {
    return `<div class="hist-note">not captured yet</div>`;
  }
  return cps.map((cp) => {
    const c = cp ?? {};
    const on = state?.selected != null && state.selected === c.id ? " on" : "";
    return (
      `<button type="button" class="hist-row cp-row${on}" data-cp="${esc(c.id)}">` +
        `<span class="c-id">${esc(c.id)}</span>` +
        `<span class="c-num">attempt ${esc(c.attempt)}</span>` +
        `<span>${esc(c.phase)}</span>` +
        `<span class="hist-sub c-hash">${esc(c.state_hash)}</span>` +
        `<span class="c-num">${esc(c.wall_ts)}</span>` +
      `</button>`
    );
  }).join("");
}

/**
 * The files changed at one checkpoint (the diff whose `to` is cpId); the first
 * checkpoint is the baseline. The change kind is an attribute, not a class.
 */
export function renderFiles(checkpoints, diffs, cpId) {
  const list = Array.isArray(diffs) ? diffs : [];
  const entry = list.find((d) => d && d.to === cpId);
  if (!entry) return `<div class="hist-note">baseline — no diff</div>`;
  const files = Array.isArray(entry.files) ? entry.files : [];
  if (files.length === 0) return `<div class="hist-note">no files changed</div>`;
  const cp = (Array.isArray(checkpoints) ? checkpoints : []).find((c) => c && c.id === cpId);
  const head = cp
    ? `<div class="hist-sub files-head">files @ ${esc(cp.id)} · attempt ${esc(cp.attempt)} · ${esc(cp.phase)}</div>`
    : "";
  return head + files.map((f) => {
    const file = f ?? {};
    return (
      `<button type="button" class="hist-row file-row" data-file="${esc(file.diff)}" data-change="${esc(file.change)}">` +
        `<span class="c-path">${esc(file.path)}</span>` +
        `<span class="c-chg">${esc(file.change)}</span>` +
      `</button>`
    );
  }).join("");
}

/** The diff pane, via the vendored diff2html; if it failed to load, say so. */
export function renderDiff(state) {
  if (state?.loading) return `<div class="hist-note">reading diff…</div>`;
  if (state?.error) return `<div class="hist-error" role="alert">${esc(state.error)}</div>`;
  if (state?.diffText == null) {
    return `<div class="hist-note">select a changed file to view its diff</div>`;
  }
  if (state.diffText === "") return `<div class="hist-note">empty diff</div>`;
  const d2h = globalThis.Diff2Html;
  if (!d2h || typeof d2h.html !== "function") {
    return `<div class="hist-error" role="alert">diff renderer unavailable</div>`;
  }
  const caption = state.diffPath ? `<div class="hist-sub diff-path">${esc(state.diffPath)}</div>` : "";
  // diff2html escapes the diff content itself; its output is trusted HTML.
  return caption + `<div class="hist-d2h">${d2h.html(state.diffText, { outputFormat: "side-by-side" })}</div>`;
}

// ── paint ──

/** The last "view result" refusal, verbatim. Never a spinner, never silence. */
export function renderPlayNote(state) {
  const s = state ?? {};
  if (s.error) return `<div class="hist-error" role="alert">${esc(s.error)}</div>`;
  if (s.playing) {
    const p = s.playing;
    // Answers /health but not /: seeded and not yet built. Say which.
    const bad = p.page_status != null && p.page_status !== 200;
    const unread = p.page_status == null && p.page_excerpt;
    const warn =
      bad || unread
        ? `<div class="hist-warn">the build is running, but its page ` +
          (bad
            ? `answered HTTP ${esc(p.page_status)}`
            : `could not be read`) +
          `${p.page_excerpt ? ` — <code>${esc(p.page_excerpt)}</code>` : ""}. ` +
          `It may still be building, or its server cannot serve its own page.</div>`
        : "";
    return (
      `<div class="hist-note">playing <span class="c-id">${esc(p.cell)}</span> at ` +
      `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a> ` +
      `<button type="button" class="hist-play" data-play-stop="1">stop</button></div>` +
      warn
    );
  }
  return "";
}

/** The delete confirmation: the server's own restatement, verbatim. */
export function renderDeleteConfirm(state) {
  const p = state?.plan;
  if (!p) return "";
  return (
    `<div class="hist-confirm" role="alertdialog">` +
      `<div class="hist-confirm-head">delete run ${esc(p.tree_id)} — permanent${p.snapshot_ids?.length ? " (+ produced snapshot)" : ""}</div>` +
      `<div class="hist-confirm-body">${esc(p.restatement)}</div>` +
      `<div class="hist-confirm-actions">` +
        `<button type="button" class="hist-play on" data-del-go="1">delete permanently</button>` +
        `<button type="button" class="hist-play" data-del-cancel="1">cancel</button>` +
      `</div>` +
    `</div>`
  );
}

function renderPage() {
  const files = selection.cp
    ? renderFiles(cpsUi.checkpoints, cpsUi.diffs, selection.cp)
    : `<div class="hist-note">select a check-point</div>`;
  const details = selection.run ?
    `<section class="hist-pane hist-details" id="history-details">` +
      `<h2 class="hist-h">checkpoints <span class="hist-sub">${esc(selection.run)}</span></h2>` +
      `<div class="hist-cps">${renderCheckpoints({ ...cpsUi, selected: selection.cp })}</div>` +
      `<h2 class="hist-h">files</h2>` +
      `<div class="hist-files">${files}</div>` +
      `<h2 class="hist-h">diff</h2>` +
      `<div class="hist-diff">${renderDiff(diffUi)}</div>` +
    `</section>` : "";
  return `<section class="hist-pane"><h2 class="hist-h">runs</h2>` +
    `<div class="hist-playnote">${renderPlayNote(playUi)}</div>` +
    `<div class="hist-confirm-slot">${renderDeleteConfirm(delUi)}</div>` +
    `<div class="hist-runs">${renderRuns(runsUi, { ...selection, details })}</div></section>`;
}

/** Apply state to the page. A no-op under Node (no document) so loaders stay testable. */
function paint() {
  if (typeof document === "undefined") return;
  const root = document.getElementById("history-root");
  if (!root) return;
  root.innerHTML = renderPage();
}

// ── loaders ── same-origin requests (the dashboard relays them); errors show
// the server's reason.

/** GET /api/history → the run list, most-recent-first. */
export async function loadRuns() {
  runsUi.loading = true;
  runsUi.error = null;
  paint();
  try {
    const res = await fetch(`/api/history`);
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      runsUi.error = data?.reason ?? `HTTP ${res.status}`;
      runsUi.runs = [];
      toast({ code: data?.code ?? "history_unreadable", reason: runsUi.error, where: "GET /api/history" });
    } else {
      runsUi.runs = Array.isArray(data?.runs) ? data.runs : [];
    }
  } catch (err) {
    runsUi.error = String(err?.message ?? err);
    runsUi.runs = [];
    toast({ code: "history_unreachable", reason: runsUi.error, where: "GET /api/history" });
  } finally {
    runsUi.loading = false;
  }
  paint();
}

/** GET /api/history/checkpoints → check-points + stored diffs for one run's cell. */
export async function loadCheckpoints(run, cell) {
  cpsUi.loading = true;
  cpsUi.error = null;
  cpsUi.checkpoints = null;
  cpsUi.diffs = null;
  paint();
  try {
    const url = `/api/history/checkpoints?run=${encodeURIComponent(run)}&cell=${encodeURIComponent(cell)}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      cpsUi.error = data?.reason ?? `HTTP ${res.status}`;
      toast({
        code: data?.code ?? "checkpoints_unreadable",
        reason: cpsUi.error,
        where: `GET /api/history/checkpoints · ${run} · ${cell}`,
      });
    } else {
      // null when nothing was captured.
      cpsUi.checkpoints = Array.isArray(data?.checkpoints) ? data.checkpoints : null;
      cpsUi.diffs = Array.isArray(data?.diffs) ? data.diffs : null;
    }
  } catch (err) {
    cpsUi.error = String(err?.message ?? err);
  } finally {
    cpsUi.loading = false;
  }
  paint();
}

/** GET /api/history/diff → raw unified-diff text for one stored diff file. */
export async function loadDiff(run, cell, diffPath) {
  diffUi.loading = true;
  diffUi.error = null;
  diffUi.diffText = null;
  diffUi.diffPath = diffPath;
  paint();
  try {
    const url = `/api/history/diff?run=${encodeURIComponent(run)}&cell=${encodeURIComponent(cell)}&path=${encodeURIComponent(diffPath)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      diffUi.error = data?.reason ?? `HTTP ${res.status}`;
      toast({
        code: data?.code ?? "diff_unreadable",
        reason: diffUi.error,
        where: `GET /api/history/diff · ${run} · ${cell} · ${diffPath}`,
      });
    } else {
      diffUi.diffText = await res.text();
    }
  } catch (err) {
    diffUi.error = String(err?.message ?? err);
  } finally {
    diffUi.loading = false;
  }
  paint();
}

/**
 * The address this device can open: the spawner reports localhost, so keep its
 * port and swap in the host this page was served from. Falls back to the
 * spawner's url when there is no port or no hostname.
 */
export function playUrl(port, serverUrl) {
  const hostname = globalThis.location?.hostname;
  const p = Number(port);
  if (!hostname || !Number.isInteger(p) || p < 1 || p > 65535) return serverUrl;
  // IPv6 hosts need brackets before a port.
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return `http://${host}:${p}/`;
}

/** GET /api/play → what is being played right now, or null. Same-origin proxy. */
export async function loadPlaying() {
  try {
    const res = await fetch(`/api/play`);
    const data = await res.json().catch(() => null);
    const playing = data?.playing ?? null;
    // Same port, this browser's host (see playUrl).
    playUi.playing = playing ? { ...playing, url: playUrl(playing.port, playing.url) } : null;
  } catch {
    playUi.playing = null;
  }
  paint();
  return playUi.playing;
}

/**
 * Boot one built result and open it (through the relay). The port comes from
 * the spawner, the host from this page.
 */
export async function startPlay(run, cell, openTab) {
  playUi.error = null;
  playUi.busy = `${run}::${cell}`;
  paint();
  try {
    const res = await fetch(`/api/play/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run, cell }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      playUi.error = data?.reason ?? `HTTP ${res.status}`;
      playUi.playing = null;
      // Named refusals (no_build, no_entrypoint, port_ignored, boot_failed,
      // invalid_run) reach the operator verbatim, with their row.
      toast({
        code: data?.code ?? `http_${res.status}`,
        reason: playUi.error,
        where: `POST /api/play/start · ${run} · ${cell}`,
      });
      return null;
    }
    // One rewritten url for the state, the toast and the tab.
    const url = playUrl(data.port, data.url);
    playUi.playing = {
      run,
      cell,
      url,
      port: data.port,
      pid: data.pid,
      page_status: data.page_status ?? null,
      page_excerpt: data.page_excerpt ?? null,
      debug_seam_open: data.debug_seam_open ?? null,
    };
    // The shipped configuration must 404 the debug routes (REQ-DEBUG); gates always
    // boot with the seam on, so playing it is the only place to see that.
    if (data.debug_seam_open === true) {
      toast({
        code: "debug_seam_open",
        reason:
          "this build serves its debug routes with DEBUG_API unset — they are supposed to " +
          `behave as unknown endpoints, and /api/debug/state answered HTTP ${data.debug_seam_status}. ` +
          "No gate checks this; playing the build is the only place it shows up.",
        where: `${run} · ${cell}`,
      });
    }
    if (data.page_status !== 200) {
      toast({
        code: "page_not_served",
        reason:
          data.page_status == null
            ? `the build is running at ${url} but its page could not be read`
            : `the build is running at ${url} but its page answered HTTP ${data.page_status}`,
        where: `${run} · ${cell}`,
        detail: data.page_excerpt ?? null,
      });
    }
    if (typeof openTab === "function") openTab(url);
    return data;
  } catch (err) {
    playUi.error = String(err?.message ?? err);
    toast({
      code: "play_unreachable",
      reason: playUi.error,
      where: `POST /api/play/start · ${run} · ${cell}`,
    });
    return null;
  } finally {
    playUi.busy = null;
    paint();
  }
}

/** Stop whatever is playing. "Nothing was running" is a result, not an error. */
export async function stopPlay() {
  playUi.error = null;
  try {
    await fetch(`/api/play/stop`, { method: "POST" });
    playUi.playing = null;
  } catch (err) {
    playUi.error = String(err?.message ?? err);
  }
  paint();
}

/**
 * Step one: ask what would go; nothing is removed. A refusal is toasted and
 * no confirmation offered; there is no force.
 */
export async function previewDelete(run, cell) {
  delUi.plan = null;
  delUi.busy = `${run}::${cell}`;
  paint();
  try {
    const res = await fetch(`/api/history/delete/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run, cell }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      toast({
        code: data?.code ?? `http_${res.status}`,
        reason: data?.reason ?? `HTTP ${res.status}`,
        where: `POST /api/history/delete/preview · ${run} · ${cell}`,
        detail: Array.isArray(data?.found) ? `found: ${data.found.join(", ")}` : null,
      });
      return null;
    }
    delUi.plan = { ...data, run, cell };
    return data;
  } catch (err) {
    toast({
      code: "delete_preview_unreachable",
      reason: String(err?.message ?? err),
      where: `POST /api/history/delete/preview · ${run} · ${cell}`,
    });
    return null;
  } finally {
    delUi.busy = null;
    paint();
  }
}

/** Step two: confirm with the token the preview issued. */
export async function confirmDelete() {
  const plan = delUi.plan;
  if (!plan) return null;
  delUi.busy = `${plan.run}::${plan.cell}`;
  paint();
  try {
    const res = await fetch(`/api/history/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run: plan.run, cell: plan.cell, confirm: plan.token }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      toast({
        code: data?.code ?? `http_${res.status}`,
        reason: data?.reason ?? `HTTP ${res.status}`,
        where: `POST /api/history/delete · ${plan.run} · ${plan.cell}`,
      });
      return null;
    }
    toast({
      code: "deleted",
      reason: `run ${data.tree_id} deleted — ${data.files} files (${data.bytes_human}) removed from ${data.deleted}`,
      where: null,
      bad: false,
    });
    delUi.plan = null;
    await loadRuns();
    return data;
  } catch (err) {
    toast({
      code: "delete_unreachable",
      reason: String(err?.message ?? err),
      where: `POST /api/history/delete · ${plan.run} · ${plan.cell}`,
    });
    return null;
  } finally {
    delUi.busy = null;
    paint();
  }
}

export function cancelDelete() {
  delUi.plan = null;
  paint();
}

// ── click handling ──

/** Open the played game. Separate so tests can drive startPlay without a window. */
function openInTab(url) {
  if (typeof window === "undefined" || typeof window.open !== "function") return;
  window.open(url, "_blank", "noopener");
}

function clearDiff() {
  diffUi.diffText = null;
  diffUi.diffPath = null;
  diffUi.error = null;
  diffUi.loading = false;
}

function onRunClick(run, cell) {
  if (!run) return;
  if (selection.run === run && selection.cell === (cell ?? "")) {
    selection.run = null;
    selection.cell = "";
    selection.cp = null;
    clearDiff();
    paint();
    return;
  }
  selection.run = run;
  selection.cell = cell ?? "";
  selection.cp = null;
  clearDiff();
  // loadCheckpoints paints the loading state (and the cleared diff pane) first.
  loadCheckpoints(selection.run, selection.cell);
}

function onCpClick(cpId) {
  if (!cpId) return;
  selection.cp = cpId;
  clearDiff();
  paint();
}

function onFileClick(diffPath) {
  if (!diffPath || !selection.run) return;
  loadDiff(selection.run, selection.cell, diffPath);
}

/**
 * One delegated click listener on the page root, innermost first:
 * [data-file] → [data-cp] → [data-run].
 */
export function boot() {
  if (typeof document === "undefined") return;
  const root = document.getElementById("history-root");
  if (!root) return;
  root.addEventListener("click", (event) => {
    const el = event.target && typeof event.target.closest === "function" ? event.target : null;
    if (!el) return;
    // Play controls first, so they never also select the row.
    const copyEl = el.closest("[data-toast-copy]");
    if (copyEl) { copyToast(copyEl.getAttribute("data-toast-copy")); return; }
    const closeEl = el.closest("[data-toast-close]");
    if (closeEl) { dismissToast(closeEl.getAttribute("data-toast-close")); return; }
    const stopEl = el.closest("[data-play-stop]");
    if (stopEl) { stopPlay(); return; }
    // Delete controls also before the row branch.
    if (el.closest("[data-del-go]")) { confirmDelete(); return; }
    if (el.closest("[data-del-cancel]")) { cancelDelete(); return; }
    const delEl = el.closest("[data-del-run]");
    if (delEl) {
      previewDelete(delEl.getAttribute("data-del-run"), delEl.getAttribute("data-del-cell"));
      return;
    }
    const playEl = el.closest("[data-play-run]");
    if (playEl) {
      const run = playEl.getAttribute("data-play-run");
      const cell = playEl.getAttribute("data-play-cell");
      const live = playUi.playing && `${playUi.playing.run}::${playUi.playing.cell}` === `${run}::${cell}`;
      // Already up: reopen it (re-spawning would kill the game in progress).
      if (live && playUi.playing.url) { openInTab(playUi.playing.url); return; }
      startPlay(run, cell, openInTab);
      return;
    }
    const fileEl = el.closest("[data-file]");
    if (fileEl) { onFileClick(fileEl.getAttribute("data-file")); return; }
    const cpEl = el.closest("[data-cp]");
    if (cpEl) { onCpClick(cpEl.getAttribute("data-cp")); return; }
    const runEl = el.closest("[data-run]");
    if (runEl) { onRunClick(runEl.getAttribute("data-run"), runEl.getAttribute("data-cell")); }
  });
  // Toasts sit outside #history-root, so they get their own listener.
  const toastRoot = document.getElementById("toasts");
  if (toastRoot) {
    toastRoot.addEventListener("click", (event) => {
      const el = event.target && typeof event.target.closest === "function" ? event.target : null;
      if (!el) return;
      const copyEl = el.closest("[data-toast-copy]");
      if (copyEl) { copyToast(copyEl.getAttribute("data-toast-copy")); return; }
      const closeEl = el.closest("[data-toast-close]");
      if (closeEl) { dismissToast(closeEl.getAttribute("data-toast-close")); }
    });
  }

  loadRuns();
  loadPlaying();
}
