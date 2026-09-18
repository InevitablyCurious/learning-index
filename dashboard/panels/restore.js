// ─────────────────────────────────────────────────────────────────────────────
// RESTORE — put a previous bench back
//
// Every reset parks the live bench into `runs/backups/<unix-seconds>/`. This is
// the surface that reads them back: one scrollable list, one card per backup,
// enough on each card to choose WITHOUT opening a folder.
//
// ── WHAT A CARD HAS TO ANSWER ───────────────────────────────────────────────
//
// "Which one was that?" is a question about CONTENT, not about a timestamp. A
// list of unix seconds is technically complete and useless — so each card leads
// with when it was taken in words, then the models it holds, then the counts.
// The models are the line an operator actually recognises their own work by.
//
// ── THE CHECK IS SHOWN BEFORE IT IS NEEDED ──────────────────────────────────
//
// A backup that would fail the restore check is marked on its card and its
// button is dead, rather than letting the operator pick it and be refused. The
// reason travels with the mark: a refusal an operator cannot act on is noise.
// ─────────────────────────────────────────────────────────────────────────────

import { esc } from "../board.js";

const ui = {
  open: false,
  loading: false,
  backups: null,
  error: null,
  // The card the operator picked. Confirmation is a SECOND step, on the same
  // surface, so the list stays visible behind the decision.
  selected: null,
  token: null,
  restatement: null,
  pending: false,
  refusal: null,
};

export function isRestoreOpen() {
  return ui.open === true;
}

export function openRestore() {
  ui.open = true;
  ui.error = null;
  ui.refusal = null;
  ui.selected = null;
  ui.token = null;
  ui.restatement = null;
}

export function closeRestore() {
  ui.open = false;
  ui.selected = null;
  ui.token = null;
  ui.restatement = null;
  ui.refusal = null;
}

export function clearSelection() {
  ui.selected = null;
  ui.token = null;
  ui.restatement = null;
  ui.refusal = null;
}

/** Load the list. Called on open, so the list is never stale on screen. */
export async function loadBackups() {
  ui.loading = true;
  ui.error = null;
  try {
    const res = await fetch(`/api/backups`);
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      ui.error = data?.reason ?? `HTTP ${res.status}`;
      ui.backups = [];
    } else {
      ui.backups = Array.isArray(data?.backups) ? data.backups : [];
    }
  } catch (err) {
    ui.error = String(err?.message ?? err);
    ui.backups = [];
  } finally {
    ui.loading = false;
  }
}

/** Pick one: the server re-runs its checks and mints a token. */
export async function armRestore(id) {
  ui.pending = true;
  ui.refusal = null;
  ui.selected = String(id);
  try {
    const res = await fetch(`/api/backups/restore/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: String(id) }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      ui.refusal = { code: data?.code ?? `HTTP ${res.status}`, reason: data?.reason ?? "restore refused" };
      ui.token = null;
      ui.restatement = null;
    } else {
      ui.token = data?.token ?? null;
      ui.restatement = data?.restatement ?? null;
    }
  } catch (err) {
    ui.refusal = { code: "unreachable", reason: String(err?.message ?? err) };
  } finally {
    ui.pending = false;
  }
}

export async function commitRestore() {
  if (!ui.token || !ui.selected) return;
  ui.pending = true;
  try {
    const res = await fetch(`/api/backups/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: ui.selected, confirm: ui.token }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      ui.refusal = { code: data?.code ?? `HTTP ${res.status}`, reason: data?.reason ?? "restore refused" };
      ui.pending = false;
      return;
    }
    // Every panel's local state now refers to data that has been replaced
    // wholesale. A reload is the only way the board comes back describing the
    // bench that is actually there — same reasoning as the reset path.
    window.location.reload();
  } catch (err) {
    ui.refusal = { code: "unreachable", reason: String(err?.message ?? err) };
    ui.pending = false;
  }
}

// ── formatting ───────────────────────────────────────────────────────────────

function when(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown time";
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hr ago`;
  return `${Math.round(h / 24)} days ago`;
}

function size(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

/** "3 results · 2 run logs · 4.2 MB" — plural-correct, no zeros. */
function countLine(b) {
  const c = b.counts ?? {};
  const parts = [];
  if (c.results) parts.push(`${c.results} result${c.results === 1 ? "" : "s"}`);
  if (c.run_logs) parts.push(`${c.run_logs} run log${c.run_logs === 1 ? "" : "s"}`);
  if (!parts.length) parts.push(`${c.items ?? 0} item${c.items === 1 ? "" : "s"}`);
  parts.push(size(b.bytes) + (b.bytes_truncated ? "+" : ""));
  return parts.join(" · ");
}

/**
 * The models this backup holds, deduped across its result folders.
 *
 * This is the line an operator recognises their own work by, so it is never
 * silently empty: a backup with results but no readable model says so, which is
 * also the shape of a backup worth looking at before trusting.
 */
function modelLine(b) {
  const models = [...new Set((b.results ?? []).flatMap((r) => r.models ?? []))];
  if (models.length) return models.map((m) => `<span class="bk-model">${esc(m)}</span>`).join("");
  if ((b.counts?.results ?? 0) > 0) return `<span class="bk-model bk-unknown">model not recorded</span>`;
  return `<span class="bk-model bk-unknown">no results</span>`;
}

function cellLine(b) {
  const off = (b.results ?? []).reduce((n, r) => n + (r.cells_off ?? 0), 0);
  const on = (b.results ?? []).reduce((n, r) => n + (r.cells_on ?? 0), 0);
  if (!off && !on) return "";
  return `<span class="bk-cells">${off} memory-off · ${on} memory-on</span>`;
}

// ── render ───────────────────────────────────────────────────────────────────

export function renderRestoreButton(board) {
  if (!board?.control) return "";
  return `<button class="btn sm blrestore" data-restore-open="1">RESTORE</button>`;
}

export function renderRestoreModal(board) {
  if (!ui.open) return "";
  return `
    <div class="modal-scrim" data-restore-scrim="1">
      <div class="modal kmodal" role="dialog" aria-modal="true" aria-label="Restore benchmark data from a backup">
        <div class="bk-head">
          <span class="bk-title">RESTORE FROM HISTORY</span>
          <span class="bk-sub">every reset is kept · restoring saves the current bench first, so nothing is overwritten</span>
        </div>
        ${ui.selected ? confirmFrame() : listFrame()}
      </div>
    </div>`;
}

function listFrame() {
  if (ui.loading || ui.backups === null) {
    return `<div class="bk-empty">reading history…</div>
      <div class="bk-foot"><button class="btn sm" data-restore-cancel="1">close</button></div>`;
  }
  if (ui.error) {
    return `<div class="bk-refusal"><span class="bk-code">could not read history</span>${esc(ui.error)}</div>
      <div class="bk-foot"><button class="btn sm" data-restore-cancel="1">close</button></div>`;
  }
  if (!ui.backups.length) {
    return `<div class="bk-empty">No backups yet. Every RESET saves the bench here first, so this fills up the first time you reset.</div>
      <div class="bk-foot"><button class="btn sm" data-restore-cancel="1">close</button></div>`;
  }

  return `
    <div class="bk-list">${ui.backups.map(card).join("")}</div>
    <div class="bk-foot">
      <span class="bk-count">${ui.backups.length} backup${ui.backups.length === 1 ? "" : "s"}</span>
      <button class="btn sm" data-restore-cancel="1">close</button>
    </div>`;
}

function card(b) {
  const ok = b.check?.ok !== false;
  const warned = ok && (b.check?.warnings ?? []).length > 0;

  // The verdict rides on the card, with its reason, because a dead button whose
  // cause is elsewhere teaches an operator nothing.
  const badge = ok
    ? warned
      ? `<span class="bk-badge warn" title="${esc((b.check.warnings ?? []).join("; "))}">CHECK · ${
          b.check.warnings.length
        } NOTE${b.check.warnings.length === 1 ? "" : "S"}</span>`
      : `<span class="bk-badge ok">CHECK PASSED</span>`
    : `<span class="bk-badge bad" title="${esc((b.check?.errors ?? []).join("; "))}">CANNOT RESTORE</span>`;

  const why = ok ? "" : `<div class="bk-why">${esc((b.check?.errors ?? []).join(" · "))}</div>`;

  return `
    <div class="bk-card${ok ? "" : " dead"}">
      <div class="bk-row1">
        <span class="bk-when">${esc(when(b.created_at))}</span>
        <span class="bk-ago">${esc(ago(b.created_at))}</span>
        ${badge}
      </div>
      <div class="bk-row2">${modelLine(b)}</div>
      <div class="bk-row3">
        <span class="bk-counts">${esc(countLine(b))}</span>
        ${cellLine(b)}
      </div>
      ${why}
      <div class="bk-row4">
        <span class="bk-id">id ${esc(b.id)}</span>
        <button class="btn sm blrestore" data-restore-pick="${esc(b.id)}" ${ok ? "" : "disabled"}>restore this</button>
      </div>
    </div>`;
}

function confirmFrame() {
  const b = (ui.backups ?? []).find((x) => x.id === ui.selected);
  const body = ui.refusal
    ? `<div class="bk-refusal"><span class="bk-code">${esc(ui.refusal.code ?? "")}</span>${esc(ui.refusal.reason)}</div>`
    : ui.restatement
      ? `<pre class="bk-restatement">${esc(ui.restatement)}</pre>`
      : `<div class="bk-empty">checking this backup…</div>`;

  return `
    <div class="bk-confirm">
      <div class="bk-q">Restore this backup?</div>
      ${b ? `<div class="bk-chosen">${esc(when(b.created_at))} · ${esc(countLine(b))}</div>` : ""}
      ${body}
    </div>
    <div class="bk-foot">
      <button class="btn sm" data-restore-back="1">‹ back</button>
      <button class="btn sm blrestore" data-restore-confirm="1" ${
        ui.token && !ui.pending && !ui.refusal ? "" : "disabled"
      }>${ui.pending ? "…" : "restore"}</button>
    </div>`;
}
