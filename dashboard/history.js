// ─────────────────────────────────────────────────────────────────────────────
// HISTORY PAGE — standalone /history for the bench board.
//
// The board (:8717) shows the live run; this page shows the RECORD: every
// benchmark run the control plane (:8718) knows about, its check-points, the
// files each check-point changed, and the stored unified diffs rendered
// side-by-side. All data arrives over plain fetch() from the control plane —
// there is no shared sources/ module (those are server-side only).
//
// HOUSE RULE: nothing in this module touches `document` or `fetch` at the top
// level, so `import "./history.js"` under Node is side-effect-free and tests
// can exercise the pure renderers and the loaders (with a stubbed fetch).
// The ONLY caller of boot() is the inline module script in history.html.
// ─────────────────────────────────────────────────────────────────────────────

/** Escape everything that reaches the DOM. Paths and reasons are data, not HTML. */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// ── module state ────────────────────────────────────────────────────────────
// Mutated ONLY by the loaders and the click handlers below; read by paint().

const runsUi = { runs: [], loading: false, error: null };
// "view result": which row is booting, what is playing, and the last refusal.
const playUi = { busy: null, playing: null, error: null };
// Delete is PERMANENT and is two steps: a preview that restates exactly what
// goes, and a confirm carrying the token that binds to what is on disk. `plan`
// holds the pending preview; nothing is removed until it is confirmed.
const delUi = { plan: null, busy: null };
const cpsUi = { checkpoints: null, diffs: null, loading: false, error: null };
const diffUi = { diffText: null, diffPath: null, loading: false, error: null };
const selection = { run: null, cell: null, cp: null };

// ── toasts ──────────────────────────────────────────────────────────────────
//
// THE RULE THESE EXIST TO SERVE: standardise the VIEW, never the data.
//
// This bench's history is heterogeneous by nature — runs stopped early, trees
// written before conventions this code knows about, cells that never got as far
// as a build. None of that gets normalised or repaired on the way to the screen.
// Each row is shown as what it is, and anything that cannot be shown or done
// says WHY, in a sentence that can be copied and handed to someone else without
// re-deriving the context.
//
// So every toast carries: a code, a reason, and where it happened — and a copy
// button that yields all three as one pasteable block.

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

/**
 * Raise a toast. Never throws, never dedupes away a repeat: the same failure
 * happening twice is two facts, and collapsing them has hidden a real one
 * before (a surface that showed one message for eleven findings).
 */
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
    // Clipboard denied (insecure origin, permissions). Fall through.
  }
  return false;
}

/** Exposed for tests: the live toast list. */
export function currentToasts() {
  return toasts.items;
}

// ── pure renderers ──────────────────────────────────────────────────────────
// Each returns an HTML string. No DOM access, no fetch — tests import these.

/** One run row. Carries data-run + data-cell for the delegated click. */
export function renderRunRow(run) {
  const r = run ?? {};
  const dev = r.dev_mode_enabled
    ? `<span class="dev-on">enabled</span> <span class="dev-src">${esc(r.dev_mode_source ?? "")}</span>` +
      (r.dev_mode_file ? `<span class="hist-sub dev-file">${esc(r.dev_mode_file)}</span>` : "")
    : `<span class="dev-off">off</span>`;
  // The play control is a SIBLING of the row button, not a child: a button
  // inside a button is invalid markup and the inner click never arrives.
  const id = `${r.benchmark_id}::${r.cell}`;
  // `tree_id` is the run's own identity; `benchmark_id` is the resolvable
  // half and reads "backups" for every archived row. Showing the latter would
  // label a dozen different runs identically.
  const treeId = r.tree_id ?? r.benchmark_id;
  const era = r.archived
    ? `<span class="hist-era">archived</span>`
    : `<span class="hist-era live">live tree</span>`;
  // An unrecognised layout is shown as unrecognised. The row still resolves —
  // its (benchmark_id, cell) pair is untouched — but nothing here invents an
  // identity the path did not carry.
  const idLabel = r.unreadable
    ? `<span class="hist-none">unrecognised</span>`
    : esc(treeId);
  const busy = playUi.busy === id;
  const live = playUi.playing && `${playUi.playing.run}::${playUi.playing.cell}` === id;
  const label = busy ? "starting…" : live ? "open ↗" : "view result";
  return (
    `<div class="hist-rowwrap">` +
      `<button type="button" class="hist-row run-row" data-run="${esc(r.benchmark_id)}" data-cell="${esc(r.cell)}">` +
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
export function renderRuns(state) {
  if (state?.loading) return `<div class="hist-note">reading history…</div>`;
  if (state?.error) return `<div class="hist-error" role="alert">${esc(state.error)}</div>`;
  const runs = Array.isArray(state?.runs) ? state.runs : [];
  if (runs.length === 0) return `<div class="hist-note">No runs yet</div>`;
  return (
    `<div class="hist-head run-row" aria-hidden="true">` +
      `<span>benchmark_id</span><span>dev_mode</span><span>checkpoints_dir</span><span>transcript_file</span>` +
    `</div>` +
    `<div class="hist-rows">${runs.map((r) => renderRunRow(r)).join("")}</div>`
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
 * The files changed AT one check-point: the diffs[] entry whose `to` === cpId.
 * The first check-point has no such entry — that is the baseline, and we say so.
 * data-file carries the diff PATH (the files[].diff value); data-change carries
 * the change kind as an ATTRIBUTE — never an interpolated class name.
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

/**
 * The diff pane. Renders via the vendored diff2html UMD global; if the vendor
 * file failed to load we say so honestly — never a spinner, never a blank.
 */
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

// ── paint ───────────────────────────────────────────────────────────────────

/** The last "view result" refusal, verbatim. Never a spinner, never silence. */
export function renderPlayNote(state) {
  const s = state ?? {};
  if (s.error) return `<div class="hist-error" role="alert">${esc(s.error)}</div>`;
  if (s.playing) {
    const p = s.playing;
    // A build that answers /health but not / is the seeded-not-yet-built case:
    // the scaffold ships a working health route and a serveStatic that throws.
    // Saying which it is here is the difference between a useful check and a
    // tab full of {"error":"Error: not implemented"}.
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

/**
 * The delete confirmation: the server's own restatement, verbatim.
 *
 * The sentence is NOT composed here. The control plane computed it from what is
 * actually on disk and issued a token bound to that; re-wording it in the
 * browser would let the two drift and would show an operator a promise the
 * server never made.
 */
export function renderDeleteConfirm(state) {
  const p = state?.plan;
  if (!p) return "";
  return (
    `<div class="hist-confirm" role="alertdialog">` +
      `<div class="hist-confirm-head">delete run ${esc(p.tree_id)} — permanent</div>` +
      `<div class="hist-confirm-body">${esc(p.restatement)}</div>` +
      `<div class="hist-confirm-actions">` +
        `<button type="button" class="hist-play on" data-del-go="1">delete permanently</button>` +
        `<button type="button" class="hist-play" data-del-cancel="1">cancel</button>` +
      `</div>` +
    `</div>`
  );
}

function renderPage() {
  const runs =
    `<section class="hist-pane"><h2 class="hist-h">runs</h2>` +
    `<div class="hist-playnote">${renderPlayNote(playUi)}</div>` +
    `<div class="hist-confirm-slot">${renderDeleteConfirm(delUi)}</div>` +
    `<div class="hist-runs">${renderRuns(runsUi)}</div></section>`;
  if (!selection.run) return runs;
  const files = selection.cp
    ? renderFiles(cpsUi.checkpoints, cpsUi.diffs, selection.cp)
    : `<div class="hist-note">select a check-point</div>`;
  return runs +
    `<section class="hist-pane">` +
      `<h2 class="hist-h">checkpoints <span class="hist-sub">${esc(selection.run)}</span></h2>` +
      `<div class="hist-cps">${renderCheckpoints({ ...cpsUi, selected: selection.cp })}</div>` +
      `<h2 class="hist-h">files</h2>` +
      `<div class="hist-files">${files}</div>` +
      `<h2 class="hist-h">diff</h2>` +
      `<div class="hist-diff">${renderDiff(diffUi)}</div>` +
    `</section>`;
}

/** Apply state to the page. A no-op under Node (no document) so loaders stay testable. */
function paint() {
  if (typeof document === "undefined") return;
  const root = document.getElementById("history-root");
  if (!root) return;
  root.innerHTML = renderPage();
}

// ── loaders ─────────────────────────────────────────────────────────────────
// Every request is same-origin; the dashboard relays it to the control plane.
// Loaders mutate module state and re-paint. Errors surface the server's `reason` — never a spinner.

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
      // The contract: checkpoints/diffs are null when nothing was captured.
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
 * The address the OPERATOR's device can actually open.
 *
 * The control plane spawns the artifact on the bench host and reports
 * `http://localhost:<port>/` — true on that host, false from every other
 * device on the LAN (an iPad's localhost is the iPad). The artifact binds
 * every interface, so the port is reachable at the hostname this page itself
 * was served from; only the host needs swapping, and only the browser knows
 * it. Falls back to the spawner's url verbatim when there is no usable port
 * or no hostname to swap in (a refusal carries no port; Node has no location).
 */
export function playUrl(port, serverUrl) {
  const hostname = globalThis.location?.hostname;
  const p = Number(port);
  if (!hostname || !Number.isInteger(p) || p < 1 || p > 65535) return serverUrl;
  // A browser hands back an IPv6 hostname already bracketed; anything else
  // carrying a colon needs brackets before a port can follow it.
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return `http://${host}:${p}/`;
}

/** GET /api/play → what is being played right now, or null. Same-origin proxy. */
export async function loadPlaying() {
  try {
    const res = await fetch(`/api/play`);
    const data = await res.json().catch(() => null);
    const playing = data?.playing ?? null;
    // The spawner's url names the bench host; the operator may be elsewhere
    // on the LAN. Same port, this browser's host — see playUrl.
    playUi.playing = playing ? { ...playing, url: playUrl(playing.port, playing.url) } : null;
  } catch {
    playUi.playing = null;
  }
  paint();
  return playUi.playing;
}

/**
 * Boot one built result and open it.
 *
 * The POST rides the same-origin relay: the dashboard proxies BOTH GETs and
 * POSTs to the loopback control plane — writes are proxied, not performed by
 * the dashboard — exactly as it does for starting a run. The PORT comes from
 * the spawner (only it knows what it assigned); the HOST comes from this
 * page's own address, so an operator on an iPad opens the bench's LAN name
 * and not the iPad itself — see playUrl.
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
      // The named refusals — no_build, no_entrypoint, port_ignored,
      // boot_failed, invalid_run — reach the operator verbatim, with the row
      // they came from, ready to paste.
      toast({
        code: data?.code ?? `http_${res.status}`,
        reason: playUi.error,
        where: `POST /api/play/start · ${run} · ${cell}`,
      });
      return null;
    }
    // One rewritten url feeds the stored state, the toast, and the tab, so
    // every surface the operator sees names a host their device can reach.
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
    // It booted — but a build that answers /health and not / is the
    // seeded-not-yet-built case, and that deserves the same pasteable sentence
    // as an outright refusal rather than a surprise 500 in a new tab.
    // REQ-DEBUG says the debug routes must 404 without DEBUG_API. No gate can
    // check it — every gate boots the candidate WITH the seam on — so playing
    // the shipped configuration is the only place it is observable.
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
 * Step one: ask what would go. Nothing is removed.
 *
 * A refusal here — the live tree, a run in flight, an archive whose layout the
 * server does not recognise — is toasted with its code and reason and no
 * confirmation is offered. There is deliberately no "force": a shape this code
 * does not understand is not a shape it should delete.
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

// ── click handling ──────────────────────────────────────────────────────────

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
 * Attach ONE delegated click listener on the page root and kick off the first
 * load. Dispatch is innermost-first: [data-file] → [data-cp] → [data-run].
 */
export function boot() {
  if (typeof document === "undefined") return;
  const root = document.getElementById("history-root");
  if (!root) return;
  root.addEventListener("click", (event) => {
    const el = event.target && typeof event.target.closest === "function" ? event.target : null;
    if (!el) return;
    // Play controls are dispatched FIRST and are siblings of the row button, so
    // clicking "view result" never also selects the row.
    const copyEl = el.closest("[data-toast-copy]");
    if (copyEl) { copyToast(copyEl.getAttribute("data-toast-copy")); return; }
    const closeEl = el.closest("[data-toast-close]");
    if (closeEl) { dismissToast(closeEl.getAttribute("data-toast-close")); return; }
    const stopEl = el.closest("[data-play-stop]");
    if (stopEl) { stopPlay(); return; }
    // Delete: preview, then confirm. Both before the row branch, so neither
    // also selects the row underneath.
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
      // Already up: just open it again. Re-spawning would kill the game the
      // operator is in the middle of and hand them a fresh board.
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
  // Toasts live outside #history-root (fixed to the viewport), so their copy
  // and dismiss clicks need their own delegated listener — the root's never
  // sees them.
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
