/*
 * loop-kill-scanner — loop-kill signature observation for the egress sidecar.
 *
 * The relay kills repetition loops, but the "this was a loop" signal
 * (relay_loop_detected / generation loop detected) dies inside the stock
 * opencode runtime, so the harness sees a 600s stall instead of a recoverable
 * loop-kill. The egress sidecar is the only in-our-code component on the wire,
 * so it OBSERVES response-stream bytes (never modifies them — the pipe stays
 * byte-transparent) and records the event as a marker file the harness reads.
 *
 * Two halves, deliberately split:
 *   createLoopKillScanner — pure byte logic, NO filesystem access.
 *   writeLoopKillMarker   — best-effort marker write; errors are swallowed
 *                           because the proxy MUST keep streaming.
 *
 * Stdlib only (node:fs, node:path).
 */

const fs = require("node:fs");
const path = require("node:path");

// Wire signatures, lowercased — feed() lowercases stream text before matching.
const LOOP_KILL_SIGNATURES = ["relay_loop_detected", "generation loop detected"];

// Rolling tail cap. Both signatures are < 64 chars, so a signature spanning a
// chunk boundary is always fully contained in (tail + next chunk).
const TAIL_CAP = 64;

/*
 * One scanner per response. feed() accepts Buffer or string, converts to utf8
 * lowercased, and checks tail+chunk for ANY signature. On the first match it
 * calls onMatch(signature) EXACTLY ONCE and becomes a no-op for all later
 * feeds — one marker per response.
 */
function createLoopKillScanner({ onMatch }) {
  let tail = "";
  let matched = false;
  return {
    feed(chunk) {
      if (matched) return; // already fired: no-op forever after
      const text = (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)).toLowerCase();
      const combined = tail + text;
      for (const signature of LOOP_KILL_SIGNATURES) {
        if (combined.includes(signature)) {
          matched = true; // set before the callback so re-entrant feeds no-op too
          onMatch(signature);
          return;
        }
      }
      // Check BEFORE trimming: a signature may sit mid-chunk in a chunk far
      // larger than the cap. The trimmed tail only carries a boundary-spanning
      // prefix forward into the next feed.
      tail = combined.slice(-TAIL_CAP);
    },
  };
}

/*
 * Write (overwrite) loop-kill-<safeSessionId>.json into markerDir:
 *   {"session_id": <sessionId|null>, "timestamp": <epoch_ms int>, "signature": "<sig>"}
 * safeSessionId: every char not in [A-Za-z0-9_-] replaced by "_"; null/empty
 * sessionId uses the literal "unknown". Falsy markerDir disables the write.
 * All fs access is wrapped and swallowed — the marker is best-effort and must
 * never take the proxy down.
 */
function writeLoopKillMarker({ markerDir, sessionId, signature, now = Date.now }) {
  if (!markerDir) return; // disabled
  try {
    const safeSessionId = sessionId
      ? String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_")
      : "unknown";
    const timestamp = Math.trunc(now());
    const content =
      `{"session_id": ${JSON.stringify(sessionId || null)},` +
      ` "timestamp": ${timestamp},` +
      ` "signature": ${JSON.stringify(signature)}}`;
    fs.writeFileSync(path.join(markerDir, `loop-kill-${safeSessionId}.json`), content);
  } catch {
    // best-effort: swallow write errors, keep streaming
  }
}

module.exports = {
  LOOP_KILL_SIGNATURES,
  createLoopKillScanner,
  writeLoopKillMarker,
};
