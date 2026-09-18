// ROUTERS — cloud credentials, set from the board (so the operator never has
// to leave for a terminal to supply one). A key goes in and never comes back:
// the server returns {present, source, fingerprint}; the input is a password
// field with autocomplete off, never prefilled. A router with no key says so,
// with every place the server checked. The router list comes from
// GET /api/routers, never held here.

import { esc } from "../board.js";

const ui = {
  loading: false,
  data: null,
  error: null,
  // Typed keys, per router; never read back from the server.
  drafts: {},
  busy: {},
  results: {},
};

export function setRouterDraft(id, value) {
  ui.drafts[id] = value;
}

/** Load router state. Called on open, so the panel is never stale on screen. */
export async function loadRouters() {
  ui.loading = true;
  ui.error = null;
  try {
    const res = await fetch(`/api/routers`);
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      ui.error = data?.reason ?? `HTTP ${res.status}`;
      ui.data = null;
    } else {
      ui.data = data;
    }
  } catch (err) {
    ui.error = String(err?.message ?? err);
    ui.data = null;
  } finally {
    ui.loading = false;
  }
}

/**
 * Save one router's key, clear the draft, and reload so the panel shows what
 * the server now resolves.
 */
export async function saveRouterKey(id) {
  const key = String(ui.drafts[id] ?? "").trim();
  if (!key) {
    ui.results[id] = { ok: false, code: "key_empty", reason: "nothing typed — no key was sent" };
    return;
  }
  ui.busy[id] = true;
  ui.results[id] = null;
  try {
    const res = await fetch(`/api/routers/key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ router: id, key }),
    });
    const data = await res.json().catch(() => null);
    ui.results[id] =
      data ?? { ok: false, code: `HTTP ${res.status}`, reason: "the control plane returned nothing readable" };
    if (ui.results[id].ok) {
      ui.drafts[id] = "";
      await loadRouters();
    }
  } catch (err) {
    ui.results[id] = { ok: false, code: "unreachable", reason: String(err?.message ?? err) };
  } finally {
    ui.busy[id] = false;
  }
}

// ── render ──

/** Where the key came from, in words an operator can act on. */
function sourceWord(source) {
  return (
    {
      environment: "exported in the control plane's environment",
      key_file: "stored in the bench key file",
      shared_config: "read from your Open Knowledge config",
    }[source] ?? source
  );
}

function routerCard(r) {
  const busy = ui.busy[r.id] === true;
  const result = ui.results[r.id] ?? null;
  const set = r.key?.present === true;

  const state = set
    ? `<span class="rt-state rt-set">KEY SET</span>
       <span class="rt-meta">${esc(sourceWord(r.key.source))} · fingerprint ${esc(r.key.fingerprint ?? "")}</span>`
    : `<span class="rt-state rt-unset">NO API KEY SET</span>
       <span class="rt-meta">${esc(r.key?.reason ?? "no key resolved")}</span>`;

  // Replacing a key is allowed and says so.
  const action = set ? "Replace key" : "Set key";

  return `
    <div class="rt-card">
      <div class="rt-head">
        <span class="rt-name">${esc(r.label)}${r.default ? ` <span class="rt-badge">default</span>` : ""}</span>
        <span class="rt-var">${esc(r.env_var)}</span>
      </div>
      ${r.note ? `<div class="rt-note">${esc(r.note)}</div>` : ""}
      <div class="rt-status">${state}</div>
      <div class="rt-form">
        <input class="rt-input" type="password" autocomplete="off" spellcheck="false"
               placeholder="paste ${esc(r.label)} API key"
               value="${esc(ui.drafts[r.id] ?? "")}"
               data-router-input="${esc(r.id)}" ${busy ? "disabled" : ""} />
        <button class="rt-save" data-router-save="${esc(r.id)}" ${busy ? "disabled" : ""}>
          ${busy ? "saving…" : esc(action)}
        </button>
      </div>
      ${
        result
          ? `<div class="rt-result ${result.ok ? "ok" : "bad"}">${esc(
              result.ok
                ? `written to ${result.source_detail} · fingerprint ${result.fingerprint}`
                : `${result.code}: ${result.reason}`,
            )}</div>`
          : ""
      }
    </div>`;
}

/**
 * The credential section on its own, mounted inside the tools drawer (one
 * place for things the operator configures). The save handler is delegated, so
 * it works wherever this is mounted.
 */
export function renderRoutersSection() {
  const body = ui.loading
    ? `<div class="rt-empty">loading…</div>`
    : ui.error
      ? `<div class="rt-empty bad">${esc(ui.error)}</div>`
      : !ui.data?.routers?.length
        ? `<div class="rt-empty">no routers registered</div>`
        : ui.data.routers.map(routerCard).join("");

  return `
    <section class="mn-sec">
      <span class="mn-h">ROUTER &amp; API KEY</span>
      <p class="dw-lede">
        A cloud cell authenticates through a router. The key is written to
        ${esc(ui.data?.key_file ?? "the bench key file")} with owner-only
        permissions and is never sent back to this page.
      </p>
      ${body}
    </section>`;
}

