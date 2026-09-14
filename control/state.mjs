// ─────────────────────────────────────────────────────────────────────────────
// BENCH CONTROL PLANE — SHARED STATE
//
// Split out of server.mjs (LI-14 phase 1). The singletons and process-lifetime
// state the server and its lib/ helpers share: the parsed argv, the bench
// paths, the event ring and its persist sink, the TUI mirror, and the three
// mutable cells.
//
// ESM IMPORT BINDINGS ARE READ-ONLY IN THE IMPORTER, so every cell that is
// REASSIGNED (launcher, ringRunDir, counterWatch) is served through get/set
// accessors rather than exported as a bare `let` — an importer writing a bare
// imported binding is a SyntaxError, not a silent no-op.
//
// initState() carries the import-time side effects that used to run at the top
// of server.mjs, in the exact order they ran there. server.mjs calls it once
// at startup, before createServer.
// ─────────────────────────────────────────────────────────────────────────────

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EventRing, subscribe } from "./events.mjs";
import { createAgentEventSink } from "./agent-events.mjs";
import { TuiMirror } from "./tui.mjs";
// Circular by design: the sink needs the run-dir resolver, and the resolver
// needs this module's state. Safe in ESM — both sides are hoisted function
// declarations, and neither module reads the other's bindings at evaluation.
import { activeRunDir } from "./lib/lifecycle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    port: Number(process.env.OKP_CONTROL_PORT ?? 7718),
    benchRoot: process.env.OKP_CONTROL_BENCH_ROOT ?? resolve(HERE, ".."),
    proxyUrl: process.env.OKP_CONTROL_PROXY_URL ?? "http://127.0.0.1:4545",
    runtimeUrl: process.env.OKP_CONTROL_RUNTIME_URL ?? "http://127.0.0.1:1234",
    serveUrl: process.env.OKP_CONTROL_SERVE_URL ?? "http://127.0.0.1:4096",
    python: process.env.OKP_CONTROL_PYTHON ?? null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--bench-root") out.benchRoot = String(argv[++i]);
    else if (a === "--proxy-url") out.proxyUrl = String(argv[++i]);
    else if (a === "--runtime-url") out.runtimeUrl = String(argv[++i]);
    else if (a === "--serve-url") out.serveUrl = String(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

export const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
bench control plane

  node server.mjs [options]

  --port <n>          default 7718
  --bench-root <dir>  default: the parent of this file
  --proxy-url <url>   default http://127.0.0.1:4545   (model roster)
  --runtime-url <url> default http://127.0.0.1:1234   (residency + context)
  --serve-url <url>   default http://127.0.0.1:4096   (worker event stream)

  Binds 127.0.0.1 only. There is deliberately no --host flag.
`);
  process.exit(0);
}

export const BENCH_ROOT = resolve(args.benchRoot);
export const RUNS_ROOT = join(BENCH_ROOT, "runs");
export const PYTHON = args.python ?? join(BENCH_ROOT, ".venv", "bin", "python");
export const RUN_SCRIPT = join(BENCH_ROOT, "scripts", "run_cumulative.py");

// ── mutable state: the ONLY things this service owns ─────────────────────────

/** The launcher process this service spawned, if any. */
let launcher = null;
export function getLauncher() { return launcher; }
export function setLauncher(next) { launcher = next; }

export const ring = new EventRing();

// Persist the agent event feed: every pushed row is enqueued and flushed to
// the active run's agent-events.jsonl (append-only) so a past run's feed
// survives restart. Rows are held until a run is known; flushed every 1s and
// on shutdown. Grading rows (admit) are NOT persisted — they are already
// durable (rebuilt from files each poll).
const agentSink = createAgentEventSink({ runsRoot: RUNS_ROOT, getRunDir: activeRunDir });

// Which run dir the ring currently holds rows for. null until the first
// /api/events poll resolves it. Re-checked on every poll: when the active run
// changes (a tree wipe, a stopped run, a new cell), the ring is reset so a
// long-lived process never serves a prior run's pinned rows against the
// current one.
let ringRunDir = null;
export function getRingRunDir() { return ringRunDir; }
export function setRingRunDir(next) { ringRunDir = next; }

// The TUI mirror is ON-DEMAND, unlike the event feed. It costs a resident
// `opencode attach` client, so it starts on the first poll and stops itself once
// nothing is reading — polling IS the keepalive. It NEVER writes to the pty, so
// it cannot disturb the live session it is showing.
export const tui = new TuiMirror({ serveUrl: args.serveUrl });

// Per-run memory for the external-counter watch — the WATCHING A SERVICE THAT
// ANNOUNCES NOTHING block in lib/lifecycle.mjs states the rules. Reassigned
// when the run changes, so it sits behind an accessor like the other cells.
let counterWatch = { logPath: null, seen: new Map() };
export function getCounterWatch() { return counterWatch; }
export function setCounterWatch(next) { counterWatch = next; }

// The 1s persist flush, started by initState() and never cleared; unref'd, so
// it never holds the process open.
let persistTimer = null;

/**
 * THE IMPORT-TIME SIDE EFFECTS, in the exact order they ran at the top of
 * server.mjs before the split. Called ONCE by server.mjs at startup.
 */
export function initState() {
  ring.sink = agentSink;
  persistTimer = setInterval(() => { void agentSink.flush(); }, 1000);
  persistTimer.unref?.();
  // The event subscription runs for the life of the process and reconnects
  // forever. A cell's serve dies and restarts across teardown; that is normal and
  // must not require an operator action to recover the feed.
  subscribe(`${args.serveUrl}/event`, ring);
  process.on("exit", () => tui.shutdown());
  process.on("SIGINT", () => { tui.shutdown(); void agentSink.flush().finally(() => process.exit(0)); });
  process.on("SIGTERM", () => { tui.shutdown(); void agentSink.flush().finally(() => process.exit(0)); });
}
