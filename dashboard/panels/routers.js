// ─────────────────────────────────────────────────────────────────────────────
// ROUTERS — cloud credentials, set from the board
//
// ── WHY THIS SURFACE EXISTS ─────────────────────────────────────────────────
//
// A cloud cell needs a router API key. Before this panel the only way to supply
// one was to export a variable into the shell that happened to launch the
// control plane, or hand-write a dotenv file beside it. The board could see
// neither, so it rendered the consequence as a greyed-out "Cloud API baseline"
// with no reason attached, and the operator had to leave for a terminal to find
// out why.
//
// That is the failure this panel closes. An operator driven to a shell for one
// capability ends up driving everything from there, and the board stops being
// the interface it was built to be.
//
// ── THE KEY IS ONE-WAY ──────────────────────────────────────────────────────
//
// A key goes in and never comes back. The server returns only `{present,
// source, fingerprint}` — enough to say a launch will authenticate and which
// credential is in play, worth nothing to anyone reading it off the wire. The
// input is `type=password` with autocomplete off and is never populated from the
// server, so the browser has nothing to remember or re-offer.
//
// ── NO API KEY SET IS A STATE, NOT AN ABSENCE ───────────────────────────────
//
// A router with no key renders as loudly as one with a key, and carries the
// server's own reason — every location that was checked. "Nothing here" with no
// explanation is what sent the operator to a terminal in the first place.
//
// ── THE REGISTRY IS SERVED, NOT HELD HERE ───────────────────────────────────
//
// OrcaRouter is the first router supported and more are expected. The list comes
// from `GET /api/routers` so adding one is a row in the harness, never an edit
// here. A UI holding its own copy would eventually offer a router the harness
// cannot route to.
// ─────────────────────────────────────────────────────────────────────────────

import { esc } from "../board.js";

const ui = {
  loading: false,
  data: null,
  error: null,
  // Typed keys, per router, never read back from the server.
  drafts: {},
  busy: {},
  results: {},
};

export function setRouterDraft(id, value) {
  ui.drafts[id] = value;
}

/** Load router state. Called on open, so the panel is never stale on screen. */
export async function loadRouters(base) {
  ui.loading = true;
  ui.error = null;
  try {
    const res = await fetch(`${base}/api/routers`);
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
 * Save one router's key.
 *
 * The draft is cleared on success so the typed value does not linger in memory
 * or survive a re-render, and the registry is reloaded so what the panel shows
 * is what the server now resolves — not what this function hoped it wrote.
 */
export async function saveRouterKey(base, id) {
  const key = String(ui.drafts[id] ?? "").trim();
  if (!key) {
    ui.results[id] = { ok: false, code: "key_empty", reason: "nothing typed — no key was sent" };
    return;
  }
  ui.busy[id] = true;
  ui.results[id] = null;
  try {
    const res = await fetch(`${base}/api/routers/key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ router: id, key }),
    });
    const data = await res.json().catch(() => null);
    ui.results[id] =
      data ?? { ok: false, code: `HTTP ${res.status}`, reason: "the control plane returned nothing readable" };
    if (ui.results[id].ok) {
      ui.drafts[id] = "";
      await loadRouters(base);
    }
  } catch (err) {
    ui.results[id] = { ok: false, code: "unreachable", reason: String(err?.message ?? err) };
  } finally {
    ui.busy[id] = false;
  }
}

// ── render ───────────────────────────────────────────────────────────────────

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

  // Replacing an existing key is allowed and says so. A field that silently
  // overwrites is worse than one that states what it will do.
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
 * THE ROUTER CREDENTIAL SECTION, WITHOUT A DRAWER AROUND IT.
 *
 * Split out so the hamburger menu can carry credentials and tools in ONE
 * surface. The operator asked for one place to go; two drawers that each hold
 * half of "things I configure" is the shape that made them hunt.
 *
 * The state, the loader and the save path are untouched and still live in this
 * module — only the frame moved. `data-router-save` continues to work wherever
 * this is mounted, because the handler is delegated on the document.
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

