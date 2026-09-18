// ─────────────────────────────────────────────────────────────────────────────
// REMOTE VIEWING — the LAN switch's resolution contract (WO-RV02).
//
// Pure functions, no side effects, no I/O: this module DECIDES, server.mjs
// ACTS. Two questions live here:
//
//   1. What did the operator ask for?  (resolveRemoteViewing)
//   2. What address do we bind to honour it?  (resolveBind)
//
// THE FAILURE MODE THIS EXISTS TO PREVENT: a typo'd env var silently coerced
// into a default. If REMOTE_VIEWING is set to anything other than the two
// accepted words, `resolveRemoteViewing` returns `mode: null` plus a structured
// error and the caller MUST refuse to start — a switch that guesses which way
// the operator meant is a switch that will eventually guess "exposed" when
// "disabled" was typed. Refusal is loud; coercion is invisible.
//
// Peer-level trust (who may connect once bound) is a separate concern and
// lives in ./net-policy.mjs — binding wide and trusting wide are two different
// decisions and must never be conflated into one flag.
// ─────────────────────────────────────────────────────────────────────────────

/** The operator-facing switch: REMOTE_VIEWING=disabled|enabled. */
export const REMOTE_VIEWING_ENV_VAR = "REMOTE_VIEWING";

/**
 * Set (truthy) inside the container image so the server knows its network
 * namespace — not the bind address — is the exposure boundary. Named here so
 * the image, the server and the tests all point at ONE string.
 */
export const CONTAINER_ENV_VAR = "OKP_DASH_CONTAINER";

/** The only two values the switch accepts, echoed in every rejection. */
const ACCEPTED_MODES = ["disabled", "enabled"];

/**
 * Resolve the REMOTE_VIEWING env var into a strict enum.
 *
 * Returns `{ mode, source, error }`:
 *   - unset / empty / whitespace-only → disabled, source "default" — the
 *     safe state needs no opt-in, and "nobody asked" is distinguishable
 *     from "somebody asked for off" (source "environment") in logs.
 *   - "disabled" / "enabled" (trim + case-insensitive) → that mode.
 *   - ANY other non-empty value → `mode: null` plus
 *     `error: { value, accepted }` carrying the RAW value as typed. The
 *     caller must refuse startup; this function never picks a fallback.
 *
 * `env` is injectable so tests (and only tests) pass a fake one; the default
 * reads the real environment at CALL time, not import time.
 */
export function resolveRemoteViewing({ env = process.env } = {}) {
  const raw = env[REMOTE_VIEWING_ENV_VAR];

  // Absent, empty or whitespace-only: nobody expressed an intent. Default to
  // disabled — exposure is opt-in, never opt-out.
  if (raw == null || String(raw).trim() === "") {
    return { mode: "disabled", source: "default", error: null };
  }

  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "disabled") {
    return { mode: "disabled", source: "environment", error: null };
  }
  if (normalized === "enabled") {
    return { mode: "enabled", source: "environment", error: null };
  }

  // Anything else is a typo, a shell accident or a value from a different
  // tool's vocabulary. Report it verbatim — the operator needs to see what
  // they ACTUALLY set, not a lowercased echo of it — and let the caller stop.
  return {
    mode: null,
    source: "environment",
    error: { value: raw, accepted: [...ACCEPTED_MODES] },
  };
}

/** Host strings that mean "this machine only" for bind purposes. */
const LOOPBACKISH_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Is `host` a loopback-ish address? The whole 127.0.0.0/8 range counts (via
 * the "127." prefix), plus the conventional names. Case-insensitive: host
 * strings arrive from env vars and CLI flags, both of which humans type.
 */
function isLoopbackish(host) {
  const h = host.toLowerCase();
  return LOOPBACKISH_HOSTS.has(h) || h.startsWith("127.");
}

/**
 * Host strings that mean "every interface on this machine". Binding one is
 * never LAN-only — it is all-interfaces, including any public one. `::0` is
 * the alternate zero-compressed spelling of `::`.
 */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", "::0"]);

function isWildcard(host) {
  return WILDCARD_HOSTS.has(host.toLowerCase());
}

/**
 * A "specific" address names ONE interface: non-empty, neither loopback nor
 * all-interfaces. Numeric IPv4/IPv6 or a hostname both qualify — this module
 * deliberately does not resolve names; the OS bind is the only truth there.
 */
function isSpecific(host) {
  return host !== "" && !isLoopbackish(host) && !isWildcard(host);
}

/**
 * Decide the bind address for a resolved mode — FAIL-CLOSED (WO-RV03).
 *
 * Inputs:
 *   - `mode`      the resolved REMOTE_VIEWING value ("disabled" | "enabled").
 *   - `dashHost`  RAW host string from OKP_DASH_HOST / --host (host process).
 *   - `container` truthy inside the container image.
 *   - `bindHost`  the compose PUBLISH host (OKP_BIND_HOST) — the address the
 *                 port is published on OUTSIDE the container. Meaningful only
 *                 when `container` is truthy; there it is the real exposure
 *                 boundary and gets validated against the mode.
 *
 * Returns `{ host, note, error }`. When `error` is a string the caller MUST
 * refuse startup — this function reports contradictions, it never coerces one
 * into a "probably meant" address. On refusal `host` is null on the host path
 * (nothing may bind) and stays the container-internal "0.0.0.0" on the
 * container path (the error there is about the PUBLISH, not the internal
 * bind). Refusals are returned, NOT thrown; an unresolved mode (null — the
 * invalid-value case) still THROWS, because the caller was supposed to stop
 * before getting here.
 *
 * Rules:
 *
 *   CONTAINER (internal bind is always 0.0.0.0 — loopback inside a container
 *   makes a published port serve nothing; the publish host is the boundary):
 *     1. disabled + bindHost beyond loopback (wildcard or any LAN/public IP)
 *        → REFUSAL: the WO-RV02 bypass, where a wide compose publish exposed
 *        the board while the switch said "disabled".
 *     2. enabled + bindHost unset/empty/loopback → REFUSAL: enabled must not
 *        silently publish nothing (or loopback) and call it LAN access.
 *     3. enabled + bindHost wildcard → REFUSAL: all-interfaces is not the
 *        LAN-only exposure "enabled" promises; one specific address is.
 *     4. otherwise → internal bind 0.0.0.0, no error.
 *
 *   HOST PROCESS:
 *     5. disabled → bind 127.0.0.1, ALWAYS. A wider dashHost is overridden
 *        OUT LOUD via `note` — a config line that is silently ignored is a
 *        config line somebody will later believe.
 *     6. enabled + dashHost specific → bind exactly that address.
 *     7. enabled + dashHost unset/loopback/wildcard → REFUSAL. The old
 *        behaviour (bind 0.0.0.0 and label it "LAN-only") bound EVERY
 *        interface, including public ones — a mislabel, not a feature.
 */
export function resolveBind({ mode, dashHost, container = false, bindHost }) {
  if (mode !== "disabled" && mode !== "enabled") {
    throw new Error(
      `resolveBind: mode must be "disabled" or "enabled", got ${JSON.stringify(mode)} — an unresolved REMOTE_VIEWING value must stop startup, not reach the bind decision`,
    );
  }

  if (container) {
    const publish =
      bindHost == null || String(bindHost).trim() === ""
        ? null
        : String(bindHost).trim();

    if (mode === "disabled" && publish !== null && !isLoopbackish(publish)) {
      return {
        host: "0.0.0.0",
        note: null,
        error: `REMOTE_VIEWING=disabled but OKP_BIND_HOST=${publish} would publish beyond loopback; unset OKP_BIND_HOST or set REMOTE_VIEWING=enabled`,
      };
    }
    if (mode === "enabled") {
      if (publish === null || isLoopbackish(publish)) {
        return {
          host: "0.0.0.0",
          note: null,
          error: "REMOTE_VIEWING=enabled requires OKP_BIND_HOST=<specific physical LAN address>; refusing to publish loopback while enabled",
        };
      }
      if (isWildcard(publish)) {
        return {
          host: "0.0.0.0",
          note: null,
          error: `OKP_BIND_HOST=${publish} is all-interfaces, not LAN-only; set OKP_BIND_HOST to a specific physical LAN address`,
        };
      }
    }
    return { host: "0.0.0.0", note: null, error: null };
  }

  const effective =
    dashHost == null || dashHost === "" ? "127.0.0.1" : String(dashHost);

  if (mode === "disabled") {
    return {
      host: "127.0.0.1",
      note: isLoopbackish(effective)
        ? null
        : `REMOTE_VIEWING=disabled ignores OKP_DASH_HOST=${effective}; binding loopback`,
      error: null,
    };
  }

  // enabled on the host process: reachable from the LAN means ONE named
  // interface, never all of them and never the untouched loopback default.
  if (!isSpecific(effective)) {
    return {
      host: null,
      note: null,
      error: isWildcard(effective)
        ? `OKP_DASH_HOST=${effective} is all-interfaces, not LAN-only; set OKP_DASH_HOST/--host to a specific physical LAN address`
        : "REMOTE_VIEWING=enabled requires a specific physical LAN host address; set OKP_DASH_HOST/--host (e.g. 192.168.50.140)",
    };
  }
  return { host: effective, note: null, error: null };
}
