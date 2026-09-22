// BENCH CONTROL PLANE — SHARED STATE: parsed argv, bench paths, the event ring
// and its persistence, the TUI mirror, and the mutable cells. Reassigned cells
// (ringRunDir, counterWatch) are behind get/set accessors (ESM import bindings
// are read-only). initState() runs the startup side effects once. The launched
// runs are NOT here: the N-slot run ledger (run-ledger.mjs) owns them.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EventRing, subscribe } from "./events.mjs";
import { createAgentEventSink } from "./agent-events.mjs";
import { TuiMirror } from "./tui.mjs";
// Circular by design, and safe: both sides are hoisted functions and neither
// reads the other at load.
import { activeRunDir } from "./lib/lifecycle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    port: Number(process.env.OKP_CONTROL_PORT ?? 8718),
    benchRoot: process.env.OKP_CONTROL_BENCH_ROOT ?? resolve(HERE, ".."),
    proxyUrl: process.env.OKP_CONTROL_PROXY_URL ?? "http://127.0.0.1:4545",
    runtimeUrl: process.env.OKP_CONTROL_RUNTIME_URL ?? "http://127.0.0.1:1234",
    serveUrl: process.env.OKP_CONTROL_SERVE_URL ?? "http://127.0.0.1:8719",
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

  --port <n>          default 8718
  --bench-root <dir>  default: the parent of this file
  --proxy-url <url>   default http://127.0.0.1:4545   (model roster)
  --runtime-url <url> default http://127.0.0.1:1234   (residency + context)
  --serve-url <url>   default http://127.0.0.1:8719   (worker event stream)

  Binds 127.0.0.1 only. There is deliberately no --host flag.
`);
  process.exit(0);
}

export const BENCH_ROOT = resolve(args.benchRoot);
export const RUNS_ROOT = join(BENCH_ROOT, "runs");
export const PYTHON = args.python ?? join(BENCH_ROOT, ".venv", "bin", "python");
export const RUN_SCRIPT = join(BENCH_ROOT, "scripts", "run_cumulative.py");

// ── mutable state ──

export const ring = new EventRing();

// Every pushed agent row is appended to the active run's agent-events.jsonl
// (flushed every 1s and on shutdown), so a past run's feed survives a restart.
// Grading rows aren't persisted: they're rebuilt from files.
const agentSink = createAgentEventSink({ runsRoot: RUNS_ROOT, getRunDir: activeRunDir });

// The run the ring holds rows for; reset when the active run changes.
let ringRunDir = null;
export function getRingRunDir() { return ringRunDir; }
export function setRingRunDir(next) { ringRunDir = next; }

// On demand: starts on the first poll, stops when nothing reads it. Never
// writes to the pty.
export const tui = new TuiMirror({ serveUrl: args.serveUrl });

// Per-run memory for the external-counter watch (lib/lifecycle.mjs).
let counterWatch = { logPath: null, seen: new Map() };
export function getCounterWatch() { return counterWatch; }
export function setCounterWatch(next) { counterWatch = next; }

// The 1s persist flush; unref'd.
let persistTimer = null;

/** The startup side effects, in their original order; called once. */
export function initState() {
  ring.sink = agentSink;
  persistTimer = setInterval(() => { void agentSink.flush(); }, 1000);
  persistTimer.unref?.();
  // Subscribes for the life of the process, reconnecting forever (a cell's
  // serve restarts across teardown).
  subscribe(`${args.serveUrl}/event`, ring);
  process.on("exit", () => tui.shutdown());
  process.on("SIGINT", () => { tui.shutdown(); void agentSink.flush().finally(() => process.exit(0)); });
  process.on("SIGTERM", () => { tui.shutdown(); void agentSink.flush().finally(() => process.exit(0)); });
}
