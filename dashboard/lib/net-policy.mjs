// ─────────────────────────────────────────────────────────────────────────────
// NET POLICY — who counts as a trusted peer, and is this request same-origin?
// (used by the board server on every request.)
//
// Pure functions, no side effects, no I/O. Once the dashboard can be bound to
// a LAN interface, two questions
// arrive per request and both must be answered from the socket, not from
// anything the client says about itself:
//
//   1. guardPeer / isTrustedPeer / classifyAddress — is the peer on a
//      loopback, private (RFC 1918 / ULA) or link-local address? The LAN
//      trust model is "same house, same wire": anything routable from the
//      internet is refused even if the bind is wide.
//   2. isSameOrigin — a browser on the LAN may be pointed at a malicious
//      page; the Origin header is the browser's own (unforgeable-by-JS)
//      statement of where the request came from. Writes must come from the
//      dashboard's own origin, or from no browser at all.
//
// Fail-closed throughout: anything unparseable, unexpected or ambiguous is
// refused. A classifier that guesses "trusted" on weird input is a hole; one
// that guesses "untrusted" is an inconvenience.
// ─────────────────────────────────────────────────────────────────────────────

import { isIP } from "node:net";

/**
 * Classifications that count as "on the local wire" for peer trust.
 * Deliberately EXCLUDES "unspecified" (0.0.0.0/:: is a bind wildcard, not a
 * peer identity — a socket claiming it is lying or broken) and "public".
 */
const TRUSTED_CLASSES = new Set(["loopback", "private", "link-local"]);

/**
 * Expand a syntactically valid IPv6 address (net.isIP() === 6 — syntax is
 * guaranteed before this is called) into its eight 16-bit hextets.
 *
 * Handles "::" compression and a trailing embedded IPv4 ("fe80::1.2.3.4"),
 * which is rewritten to its two-hextet form first so the rest of the parser
 * sees only hex. Zero dependencies, ~15 lines, and it means classification
 * never depends on the canonical spelling an address arrived in —
 * "0:0:0:0:0:0:0:1" is loopback exactly like "::1".
 */
function expandIPv6(addr) {
  let s = addr.toLowerCase();

  // Trailing dotted-quad → two hextets (a.b.c.d → (a<<8|b):(c<<8|d)).
  const dot = s.lastIndexOf(".");
  if (dot !== -1) {
    const colon = s.lastIndexOf(":", dot);
    const [a, b, c, d] = s.slice(colon + 1).split(".").map(Number);
    s = `${s.slice(0, colon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head, tail = ""] = s.split("::");
  const parse = (part) =>
    part === "" ? [] : part.split(":").map((h) => parseInt(h, 16));
  const hi = parse(head);
  const lo = parse(tail);
  const fill = new Array(8 - hi.length - lo.length).fill(0);
  return [...hi, ...fill, ...lo];
}

/** Classify a syntactically valid IPv4 address (net.isIP() === 4). */
function classifyIPv4(ip) {
  const o = ip.split(".").map(Number);
  if (o[0] === 0 && o[1] === 0 && o[2] === 0 && o[3] === 0) return "unspecified";
  if (o[0] === 127) return "loopback"; // 127.0.0.0/8
  if (o[0] === 10) return "private"; // 10.0.0.0/8
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return "private"; // 172.16.0.0/12
  if (o[0] === 192 && o[1] === 168) return "private"; // 192.168.0.0/16
  if (o[0] === 169 && o[1] === 254) return "link-local"; // 169.254.0.0/16
  return "public";
}

/** Classify a syntactically valid IPv6 address (net.isIP() === 6). */
function classifyIPv6(ip) {
  const h = expandIPv6(ip);
  if (h.every((x) => x === 0)) return "unspecified"; // "::"
  if (h[7] === 1 && h.slice(0, 7).every((x) => x === 0)) return "loopback"; // "::1"
  if (h[0] >= 0xfe80 && h[0] <= 0xfebf) return "link-local"; // fe80::/10
  if (h[0] >= 0xfc00 && h[0] <= 0xfdff) return "private"; // fc00::/7 (ULA)
  return "public";
}

/**
 * Classify an IP address string into exactly one of:
 * "loopback" | "private" | "link-local" | "unspecified" | "public" |
 * "unparseable".
 *
 * IPv4-mapped IPv6 ("::ffff:a.b.c.d", and the "::ffff:0:a.b.c.d" SIIT form)
 * is classified by its EMBEDDED IPv4 — the mapping is a rendering of a v4
 * peer, not a different peer. Only the compressed "::ffff:" spellings are
 * special-cased because that is what OS sockets actually report; a fully
 * expanded "0:0:0:0:0:ffff:a.b.c.d" falls through to generic IPv6 rules,
 * which can only ever classify it MORE conservatively (public, refused) —
 * never less. Everything unparseable is its own class so callers can tell
 * "internet" apart from "garbage" in logs.
 */
export function classifyAddress(ip) {
  if (typeof ip !== "string" || ip === "") return "unparseable";

  let candidate = ip;
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    let rest = ip.slice("::ffff:".length);
    if (rest.toLowerCase().startsWith("0:")) rest = rest.slice(2);
    // Only strip when a real IPv4 is underneath; "::ffff:<anything else>"
    // stays whole and takes the generic IPv6 path.
    if (isIP(rest) === 4) candidate = rest;
  }

  const version = isIP(candidate);
  if (version === 4) return classifyIPv4(candidate);
  if (version === 6) return classifyIPv6(candidate);
  return "unparseable";
}

/**
 * Is this peer on the local wire (loopback, RFC 1918 / ULA private, or
 * link-local)? Public, unspecified and unparseable addresses are NOT trusted:
 * the LAN switch widens the bind, it does not adopt the internet.
 */
export function isTrustedPeer(ip) {
  return TRUSTED_CLASSES.has(classifyAddress(ip));
}

/**
 * CSRF/origin check for state-changing requests.
 *
 *   - No Origin header (null/undefined/"") → true. curl, SSE reconnects and
 *     other non-browser clients never send one, and under the LAN trust model
 *     a non-browser client on a trusted peer address is allowed. (Browsers
 *     CANNOT omit Origin on POST — so "absent" reliably means "not a
 *     browser".)
 *   - Origin "null" → false, always. That is a sandboxed/opaque origin (a
 *     file:// page, a cross-origin iframe) — exactly the shape an embedded
 *     attacker page wears, and it must never write.
 *   - Otherwise compare URL-normalized origins: protocol + host + port,
 *     case- and default-port-insensitive, per the URL spec. Any parse
 *     failure on either side → false. A missing/empty hostHeader can't
 *     produce a meaningful origin either — refused rather than string-
 *     concatenated into "http://undefined".
 */
export function isSameOrigin(originHeader, hostHeader) {
  if (originHeader == null || originHeader === "") return true;
  if (originHeader === "null") return false;
  if (typeof hostHeader !== "string" || hostHeader === "") return false;
  try {
    return new URL(originHeader).origin === new URL(`http://${hostHeader}`).origin;
  } catch {
    return false;
  }
}

/**
 * The one call a request handler needs: may this socket's peer proceed?
 *
 * Returns `{ ok, reason }` — reason is null when ok, and when refused it
 * NAMES the address and its classification, because "403 forbidden" in a log
 * tells an operator nothing about whether the refusal was correct. The
 * address is echoed from the socket, never from client-supplied data.
 */
export function guardPeer(remoteAddress) {
  const klass = classifyAddress(remoteAddress);
  if (TRUSTED_CLASSES.has(klass)) return { ok: true, reason: null };
  return {
    ok: false,
    reason: `untrusted peer ${remoteAddress ?? "(unknown)"} classified ${klass}`,
  };
}
