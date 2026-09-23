// PANEL: STARTUP FEED — every background process behind a benchmark start,
// each with a state and, when not ok, the reason in the publisher's own words (so
// "it silently did nothing" can't happen). startupFeed(board) is the one pure
// derivation; the renderer is a thin projection of it.
//
// States:
//   ok       running / reachable / healthy
//   busy     working right now
//   idle     wired, nothing to do (normal)
//   off      not running, and that's expected (never an alarm)
//   bad      broken, refused or unreachable — act on it
//   unknown  the board doesn't carry this fact (never assumed ok)
// Only `bad` raises the feed on its own.

import { esc, nul } from "../board.js";
import { activeCell } from "./cells.js";

/** Worst first; drives ordering and the headline verdict. */
const SEVERITY = { bad: 0, unknown: 1, busy: 2, ok: 3, idle: 4, off: 5 };

/** The single derivation: board payload in, process list out. */
export function startupFeed(board) {
  const b = board ?? {};
  const processes = [
    controlPlane(b),
    runner(b),
    modelProxy(b),
    eventFeed(b),
    tuiMirror(b),
    holdGate(b),
  ];

  // Blocking is derived from `bad`, never hand-listed.
  const blocking = processes.filter((p) => p.state === "bad");
  return {
    processes,
    blocking,
    ok: blocking.length === 0,
    verdict: verdict(processes, blocking),
  };
}

function verdict(processes, blocking) {
  if (blocking.length) {
    return blocking.length === 1
      ? `1 process is blocking a benchmark start — ${blocking[0].name}`
      : `${blocking.length} processes are blocking a benchmark start`;
  }
  const busy = processes.filter((p) => p.state === "busy");
  if (busy.length) return `${busy.length} running · nothing is blocking a start`;
  const unknown = processes.filter((p) => p.state === "unknown");
  if (unknown.length) return `${unknown.length} unreported · no failure observed, but not everything could be checked`;
  return "all wired · idle and ready to start a benchmark";
}

// ── THE PROCESSES ── each { id, name, state, detail, reason, why }, where
// `why` says what the process does for a start.

/**
 * The control plane — the only thing that can start a run. null control means
 * the dashboard's read failed; the source's reason says why.
 */
function controlPlane(b) {
  if (b.control) {
    return proc("control-plane", "control plane", "ok", "reachable", null,
      "the only surface that can start a run; the dashboard relays the board's requests to it.");
  }
  const src = (b.sources ?? []).find((s) => s.id === "control-plane");
  return proc("control-plane", "control plane", "bad", src?.reason ? "read failed" : "not wired", null,
    "the board cannot start a run itself — every start goes through the control service. Without it, no control on this board can do anything.",
    src?.reason
      ? `${src.reason}. It may be running and healthy — this is the dashboard's read of it failing.`
      : "the control plane is not running, or the dashboard was started without it.");
}

/**
 * The runner: the harness process of the cell the strip points at — its own
 * state and its own launch log, never the newest cell's.
 */
function runner(b) {
  const why =
    "the harness process that actually runs the cell — spawned by the control plane, writes the run log the whole board reads.";
  if (!b.control) {
    return proc("runner", "benchmark runner", "unknown", null, null, why,
      "the control plane did not report a run state");
  }
  const c = activeCell(b);
  if (!c) {
    return proc("runner", "benchmark runner", "idle", "idle", null, why,
      "no cell in this batch; the runner is free to start one.");
  }
  const label = `s${String(c.sequence_index).padStart(4, "0")}`;
  const log = c.log_path ? String(c.log_path).split("/").pop() : null;
  const detail = [label, c.state ?? "unknown", log].filter(Boolean).join(" · ");
  if (c.running) {
    return proc("runner", "benchmark runner", "busy", detail, null, why,
      Number.isFinite(c.heartbeat_age_s) && c.heartbeat_age_s > 90
        ? `the cell's heartbeat has been silent for ${c.heartbeat_age_s}s — at high accumulated context this can be normal prefill, but it is worth watching`
        : null);
  }
  return proc("runner", "benchmark runner", "idle", detail, null, why,
    c.void_reason ? `this cell ended — ${c.void_reason}` : "this cell is not running.");
}

/**
 * The model proxy and roster: a dead proxy or an empty bench roster blocks
 * starting.
 */
function modelProxy(b) {
  const roster = b.control?.roster ?? null;
  const why =
    "the local relay the benchmarked model is reached through. A start is refused outright when it is unreachable.";
  if (!roster) {
    return proc("model-proxy", "model proxy + roster", "unknown", null, null, why,
      "the control plane did not report a roster");
  }
  if (roster.proxy_ok === false) {
    return proc("model-proxy", "model proxy + roster", "bad", "unreachable", null, why,
      roster.reason ?? "the model proxy is unreachable — /api/run/start refuses every run while this is true");
  }
  const bench = roster.bench_models ?? (roster.models ?? []).filter((m) => m.bench_eligible !== false);
  if (!bench.length) {
    return proc("model-proxy", "model proxy + roster", "bad", "no bench-eligible model", null, why,
      "no bench-eligible model in the roster — an interactive slot contends with live daily-driver use and produces a measurement that cannot be defended");
  }
  const resident = bench.filter((m) => m.resident);
  return proc("model-proxy", "model proxy + roster", "ok",
    `${bench.length} bench-eligible${resident.length ? ` · ${resident.length} resident` : ""}`, null, why,
    resident.length ? null : "no bench model is resident right now — the first call will load one, which takes time but is not a failure.");
}

/** The event feed: disconnected looks like a wedge, so it's stated. */
function eventFeed(b) {
  const e = b.events ?? null;
  const why =
    "the live event stream from the running agent — tool calls, files, grading. When it is down the board goes quiet even though the run may be fine.";
  if (!e) {
    return proc("event-feed", "event feed (SSE)", "unknown", null, null, why,
      "the board carries no event section");
  }
  if (e.connected === false) {
    // No cell running means no session to stream: normal, not bad.
    const running = b.control?.run?.state === "running";
    return proc("event-feed", "event feed (SSE)", running ? "bad" : "off",
      "disconnected", null, why,
      running
        ? `${e.reason ?? "the event feed is disconnected"} — a cell IS running, so this is a real loss of visibility, not an idle stream`
        : `${e.reason ?? "disconnected"} — expected while no cell is running: there is no session to stream.`);
  }
  return proc("event-feed", "event feed (SSE)", e.total > 0 ? "ok" : "idle",
    `${e.total ?? 0} events`, null, why);
}

/** The TUI mirror, whose window hosts this feed. */
function tuiMirror(b) {
  const t = b.tui ?? null;
  const why =
    "a strictly read-only mirror of the run's terminal. It attaches to the session the runner opens; it never writes to the pty.";
  if (!t) {
    return proc("tui-mirror", "TUI mirror", "off", "not attached", null, why,
      activeCell(b)
        ? "no frame received for this cell yet — the mirror attaches to its session when the TUI MIRROR tab is open"
        : "no cell selected — the mirror follows the cell strip");
  }
  if (t.status === "failed") {
    return proc("tui-mirror", "TUI mirror", "bad", "failed", null, why,
      t.reason ?? "could not attach to the session");
  }
  if (t.status === "starting") {
    return proc("tui-mirror", "TUI mirror", "busy", "attaching", null, why,
      t.reason ?? "first paint takes about 10 seconds — normal, not a hang");
  }
  if (t.status === "live") return proc("tui-mirror", "TUI mirror", "ok", "live", null, why);
  if (t.status === "silent") return proc("tui-mirror", "TUI mirror", "idle", "attached · silent", null, why, t.reason ?? null);
  if (t.status === "exited") return proc("tui-mirror", "TUI mirror", "off", "exited", null, why, t.reason ?? null);
  return proc("tui-mirror", "TUI mirror", "off", "not attached", null, why,
    t.reason ?? "no session observed yet — the mirror attaches when a run opens one");
}

/** A hold blocks the run by design and must never look like a crash. */
function holdGate(b) {
  const h = b.hold ?? null;
  const why = "a deliberate stop the harness places on a run — it blocks progress on purpose and waits for a human.";
  if (!h) return proc("hold-gate", "hold gate", "idle", "no hold", null, why);
  return proc("hold-gate", "hold gate", "bad", "HELD", null, why,
    (h.reason ?? "a hold is in place") + " — the run is stopped on purpose and will not continue until it is released.");
}

function proc(id, name, state, detail, _unused, why, reason = null) {
  return { id, name, state, detail: detail ?? null, reason, why };
}

// ── RENDER ──

/** The feed as drawn inside the TUI mirror, worst first. */
export function renderStartupFeed(board) {
  const feed = startupFeed(board);
  const rows = [...feed.processes].sort((a, b2) => SEVERITY[a.state] - SEVERITY[b2.state]);

  return `
    <div class="sfeed">
      <div class="sfeed-head">
        <span class="kick">BENCHMARK STARTUP — BACKGROUND PROCESSES</span>
        <span class="spacer"></span>
        <span class="sfeed-verdict ${feed.ok ? "" : "bad"}">${esc(feed.verdict)}</span>
      </div>
      <div class="sfeed-rows">
        ${rows.map(row).join("")}
      </div>
      <div class="sfeed-foot">${esc(
        "This feed is replaced by the terminal the moment the mirror paints a live frame — it reports the startup, not the run.",
      )}</div>
    </div>`;
}

function row(p) {
  return `
    <div class="sfrow ${esc(p.state)}">
      <span class="sfdot ${esc(p.state)}"></span>
      <span class="sfname">${esc(p.name)}</span>
      <span class="sfstate">${esc(p.state.toUpperCase())}</span>
      <span class="sfdetail">${p.detail ? esc(p.detail) : nul("no detail reported")}</span>
      <span class="sfwhy">${esc(p.why)}</span>
      ${p.reason ? `<span class="sfreason ${p.state === "bad" ? "bad" : ""}">${esc(p.reason)}</span>` : ""}
    </div>`;
}
