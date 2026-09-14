// ─────────────────────────────────────────────────────────────────────────────
// SHARED STREAM STATE — the SSE client registry, ONE singleton.
//
// Every writer to the push channel imports THIS Set: the board patch tick
// (lib/broadcast.mjs), the TUI fast path (lib/tui.mjs), and the /api/stream
// connect handler (server.mjs). It must never be re-declared anywhere else —
// a second Set would silently fork the registry, and clients attached to the
// forked copy would stop receiving either board patches or TUI frames. That
// is a behavior bug with no error anywhere, so the singleton is the contract.
// ─────────────────────────────────────────────────────────────────────────────

/** Live /api/stream response sockets. Membership == an attached board client. */
export const streamClients = new Set();
