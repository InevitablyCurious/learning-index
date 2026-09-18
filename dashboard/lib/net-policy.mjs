// NET POLICY — used by the board server on every request. Pure, no I/O; both
// answers come from the socket and headers, never from what the client claims.
//   guardPeer / classifyAddress: only loopback, private (RFC 1918 / ULA) and
//     link-local peers are served; anything internet-routable is refused.
//   isSameOrigin: writes must come from the dashboard's own origin, or from no
//     browser at all.
// Fail-closed: anything unparseable or ambiguous is refused.

import { isIP } from "node:net";

/** Trusted classes. Not "unspecified" (a bind wildcard, not a peer) or public. */
const TRUSTED_CLASSES = new Set(["loopback", "private", "link-local"]);

/**
 * Expand a valid IPv6 address into eight hextets, handling "::" and a trailing
 * embedded IPv4, so classification never depends on spelling.
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
 * Classify an IP string: loopback | private | link-local | unspecified |
 * public | unparseable. IPv4-mapped IPv6 ("::ffff:a.b.c.d") is classified by
 * its IPv4; other spellings fall to the IPv6 rules, which can only be stricter.
 */
export function classifyAddress(ip) {
  if (typeof ip !== "string" || ip === "") return "unparseable";

  let candidate = ip;
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    let rest = ip.slice("::ffff:".length);
    if (rest.toLowerCase().startsWith("0:")) rest = rest.slice(2);
    // Strip only when a real IPv4 is underneath.
    if (isIP(rest) === 4) candidate = rest;
  }

  const version = isIP(candidate);
  if (version === 4) return classifyIPv4(candidate);
  if (version === 6) return classifyIPv6(candidate);
  return "unparseable";
}

/** Loopback, private or link-local. Public, unspecified and unparseable are not. */
export function isTrustedPeer(ip) {
  return TRUSTED_CLASSES.has(classifyAddress(ip));
}

/**
 * Origin check for writes:
 *   no Origin header → true (non-browser clients; browsers always send one on POST)
 *   Origin "null"    → false (sandboxed or file:// pages)
 *   otherwise        → protocol + host + port must match the Host header;
 *                      any parse failure or empty host → false
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
 * May this socket's peer proceed? { ok, reason }; a refusal names the address
 * (from the socket) and its class.
 */
export function guardPeer(remoteAddress) {
  const klass = classifyAddress(remoteAddress);
  if (TRUSTED_CLASSES.has(klass)) return { ok: true, reason: null };
  return {
    ok: false,
    reason: `untrusted peer ${remoteAddress ?? "(unknown)"} classified ${klass}`,
  };
}
