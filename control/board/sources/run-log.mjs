// SOURCE: run-log — the live pulse between status records, parsed from the
// runner's PROGRESS lines in the launch log (every few minutes; the status stream
// lands only at attempt end). A fallback: live.jsonl is authoritative.
//
// `turns=` is scoring turns (raw minus guard- and finalize-killed); the board
// shows those. `session_turns=` (raw) is carried only as an anomaly figure.
// recovery_nudges is shown because nudges are unbounded: a climbing count with a
// phase that never advances is the wedged-relay signature. Tail-bounded.

import { join } from "node:path";
import { int, str } from "../contract.mjs";
import { readTail } from "./_runtime.mjs";
import { newestLog } from "../../runstate.mjs";
import { countChunkPrompts } from "../../challenges.mjs";

/**
 * How many chunks this build sends. BENCH_TASK_DIR is the same seam the
 * harness reads, so a run pointed at a variant challenge counts that one's
 * chunks rather than the bundled task's.
 */
async function chunkTotal(ctx) {
  // Instrumentation, never a gate: a caller with no benchRoot (the source's
  // own tests drive `read` with a bare ctx) gets null rather than a throw. A
  // missing chunk count costs one label; a throw here costs the whole pulse.
  const dir =
    process.env.BENCH_TASK_DIR ||
    (ctx?.benchRoot ? join(ctx.benchRoot, "task", "backgammon") : null);
  return dir ? await countChunkPrompts(dir) : null;
}

export const id = "run-log";
export const fields = ["run.phase", "run.chunk", "run.turns", "run.state", "run.elapsed_s"];
export function describe() {
  return "runner PROGRESS lines — the live pulse between attempt records";
}

const KV = /(\w+)=([^\s]+)/g;

function parseKV(line) {
  const out = {};
  let m;
  KV.lastIndex = 0;
  while ((m = KV.exec(line))) out[m[1]] = m[2];
  return out;
}

// The newest live launch log comes from control/runstate.mjs, so the board and
// the control plane agree on which run is live.

/** "initial-chunk-5" -> 5 ; "feedback-2" -> null (no longer a build chunk) */
function chunkOf(phase) {
  const m = /^initial-chunk-(\d+)$/.exec(phase ?? "");
  return m ? Number(m[1]) : null;
}

export async function read(ctx) {
  const log = await newestLog(ctx.runsRoot);
  if (!log) return { ok: false, reason: "no cell launch log under runs root" };

  const text = await readTail(log.path);
  const lines = text.split("\n").filter((l) => l.includes("PROGRESS"));
  if (!lines.length) {
    return { ok: false, reason: "log present but carries no PROGRESS lines yet" };
  }

  let phase = null;
  let chunk = null;
  let sessionTurns = null; // raw, inflated by recovered turns — never the measurement
  let mode = null;
  let recoveries = 0;
  let terminal = null;

  // Every PROGRESS line is logged twice (structured + bare), so deltas are keyed
  // by phase and each phase counts once.
  const phaseDeltas = new Map();

  for (const line of lines) {
    const kv = parseKV(line);
    const step = str(kv.step);

    // Step-scoped: `mode=` and `phase=` mean other things on other steps.
    switch (step) {
      case "memory-mode":
        mode = str(kv.mode); // "on" | "off" — the arm
        break;
      case "serve-drive-end": {
        const ph = str(kv.phase) ?? "(unnamed)";
        phase = ph;
        const c = chunkOf(kv.phase);
        if (c !== null) chunk = c;
        // Last write wins per phase (the duplicates agree).
        phaseDeltas.set(ph, {
          turns: int(kv.turns) ?? 0,
          guard: int(kv.guard_aborted_turns) ?? 0,
          // Absent on older logs: 0, never null.
          finalize: int(kv.finalize_timeout_turns) ?? 0,
          nudges: int(kv.recovery_nudges) ?? 0,
        });
        // Cumulative for the cell, not a delta: take the last.
        sessionTurns = int(kv.session_turns) ?? sessionTurns;
        break;
      }
      case "serve-drive-start":
      case "transport-recovery": {
        const c = chunkOf(kv.phase);
        if (kv.phase) phase = str(kv.phase);
        if (c !== null) chunk = c;
        if (step === "transport-recovery") recoveries += 1;
        break;
      }
      case "chunk-compaction":
        chunk = int(kv.chunk) ?? chunk;
        break;
      default:
        break;
    }
  }

  let scoringTurns = null;
  let guardAborted = 0;
  let finalizeTurns = 0;
  let nudges = 0;
  for (const d of phaseDeltas.values()) {
    scoringTurns = (scoringTurns ?? 0) + d.turns;
    guardAborted += d.guard;
    finalizeTurns += d.finalize;
    nudges += d.nudges;
  }
  // Recovery lines are duplicated too.
  recoveries = Math.round(recoveries / 2);

  // The runner's last line is a bare JSON status object when the cell stops.
  for (const raw of text.split("\n").slice(-6)) {
    const t = raw.trim();
    if (!t.startsWith("{") || !t.endsWith("}")) continue;
    try {
      const o = JSON.parse(t);
      if (typeof o?.status === "string") terminal = o.status;
      if (typeof o?.memory_mode === "string") mode = o.memory_mode;
    } catch {
      /* not a status object */
    }
  }

  // How long since the log was written — a debug fact, never a liveness verdict.
  // From the file's mtime, not the timestamp text (naive local times read wrong in
  // a UTC container).
  const silentFor = Math.max(0, Math.round((Date.now() - log.mtime) / 1000));

  // The stall verdict belongs to the control plane (from the harness's own
  // heartbeat, via reconcileRunLiveness); log silence would call a mid-turn cell
  // stalled. This source's own fallback state is `running`.

  return {
    ok: true,
    provenance: { path: log.path, mtime: log.mtime, bytes: log.size },
    patch: {
      run: {
        phase,
        // Counted from the challenge's prompts folder, never a literal. A
        // hardcoded 6 outlived the six-chunk task and drew every cell of the
        // five-chunk build as "chunk N of 6".
        chunk: { current: chunk, total: await chunkTotal(ctx) },
        turns: scoringTurns, // SCORING turns. never session_turns.
        session_turns: sessionTurns, // raw, carried for the anomaly rail only
        arm: mode,
        state: terminal ? "complete" : "running",
        terminal_status: terminal,
        log_silent_s: silentFor, // debug fact — never a liveness gate
      },
      honesty: {
        transport: {
          // Recovered, not fatal: nudged and excluded from scoring. Not an alarm.
          guard_aborts: guardAborted,
          finalize_timeout_turns: finalizeTurns,
          recovery_nudges: nudges,
          recoveries,
        },
        // Real turns that burned real tokens and are excluded from the measurement.
        recovered_turns: guardAborted + finalizeTurns,
      },
    },
  };
}
