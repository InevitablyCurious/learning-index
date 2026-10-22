// ─────────────────────────────────────────────────────────────────────────────
// CONTROL PLANE — BROWSER GUARD
//
// Binding 127.0.0.1 keeps other machines out, not other web pages: any page
// open in a browser on this machine can send requests to 127.0.0.1:8718.
//
//   - No CORS stops such a page from READING a reply, not from SENDING a
//     write. A text/plain POST needs no preflight, and every route here parses
//     its body as JSON whatever its type. Nothing legitimate sends this server
//     an Origin (the dashboard relay strips it; continuous mode and the tools
//     are not browsers), so a write that carries one came from a web page.
//   - A page on a domain re-resolved to 127.0.0.1 (DNS rebinding) is
//     same-origin with itself and CAN read replies. Its Host header still names
//     that domain, so only loopback names and the relay's host.docker.internal
//     are answered.
// ─────────────────────────────────────────────────────────────────────────────

import { isIP } from "node:net";

import { refuse } from "../contract.mjs";

/** Host names this server answers to; IP literals always pass (no DNS). */
const NAMED_HOSTS = new Set(["localhost", "host.docker.internal"]);

/** Read-only methods: a page cannot read their replies without CORS. */
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** Is `hostHeader` an address of this machine rather than someone's domain? */
export function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== "string" || hostHeader === "") return false;
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  return isIP(hostname) !== 0 || NAMED_HOSTS.has(hostname);
}

/** A refusal for a request a web page sent, or null to let it through. */
export function refuseBrowser(req) {
  const host = req.headers?.host;
  if (!isLoopbackHost(host)) {
    return refuse("untrusted_host", `Host ${host ?? "(none)"} is not this machine's loopback`);
  }
  const origin = req.headers?.origin;
  if (origin != null && !SAFE_METHODS.has(req.method)) {
    return refuse(
      "cross_origin_denied",
      `a write from a web page (Origin ${origin}) is refused; browsers drive this through the dashboard`,
    );
  }
  return null;
}
