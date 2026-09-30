import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

// ── THE PORT IS ASSIGNED, NOT FIXED ─────────────────────────────────────────
//
// The grader needs a KNOWN port, which is not the same requirement as a FIXED
// one — and conflating the two is what made the built artifact impossible to
// run alongside a grading pass. `BENCH_PORT` assigns it; unset, it is 8002
// exactly as before, so a default grading run is byte-identical to every run
// that came before this seam and stays comparable with them.
//
// The artifact reads the same value from `PORT` (scaffold/golden
// `Number(process.env.PORT ?? 8002)`), and `startServer` passes it down
// explicitly rather than letting the operator's shell decide.
// ── ONE PORT PER WORKER ─────────────────────────────────────────────────────
//
// The suite runs SERIALLY today for one reason: every runner, and every test
// inside the frontend runner, boots a game server on the same fixed port, so
// two at once would fight over it and over each other's in-memory game state.
//
// That is a shared-resource problem, not a sequencing one. Verified in the test
// bodies: every frontend test builds its own position from scratch — F03 starts
// a new game and forces its own dice, F09 constructs an entire board and pushes
// it in — and none reads anything a previous test left behind. Give each worker
// its own server and the constraint is gone.
//
// The index comes from whichever runner is driving. Both set it per worker
// PROCESS, and this module is evaluated per process, so `PORT` and `BASE_URL`
// are already correct everywhere they are read — no test has to ask.
//
//   Playwright  TEST_PARALLEL_INDEX   0-based
//   Vitest      VITEST_POOL_ID        1-based (forks pool)
//
// Absent both — a single-worker run, or a direct `node` invocation — the index
// is 0 and the port is the base, byte-identical to every run before this.
const WORKER_INDEX = (() => {
  const pw = process.env.TEST_PARALLEL_INDEX;
  if (pw !== undefined && pw !== "") return Number(pw) || 0;
  const vi = process.env.VITEST_POOL_ID;
  if (vi !== undefined && vi !== "") return Math.max(0, (Number(vi) || 1) - 1);
  return 0;
})();

export const PORT_BASE = Number(process.env.BENCH_PORT ?? 8002);
export const PORT = PORT_BASE + WORKER_INDEX;
export const BASE_URL = `http://localhost:${PORT}`;
// Repo-relative: harness.ts lives at grader/lib/, the golden
// solution at task/backgammon/golden/. ESM, so derive from import.meta.url.
const DEFAULT_TARGET_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../task/backgammon/golden",
);

export const TARGET_DIR = process.env.BENCH_TARGET
  ? path.resolve(process.env.BENCH_TARGET)
  : DEFAULT_TARGET_DIR;

// Resolution lives in `lib/entrypoint.mjs` so the control plane's play server
// can spawn a build exactly the way the gates do — see that file's header.
// Imported as well as re-exported: a bare `export … from` publishes the name to
// importers without binding it in THIS module's scope, and `startServer` below
// calls it.
import { resolveEntrypoint, resolveStartCommand } from "./entrypoint.mjs";

export { resolveEntrypoint, resolveStartCommand };

export async function loadEngine(): Promise<{ game: any; ai: any }> {
  const gameUrl = pathToFileURL(path.join(TARGET_DIR, "src/game.ts")).href;
  const aiUrl = pathToFileURL(path.join(TARGET_DIR, "src/ai.ts")).href;
  const [game, ai] = await Promise.all([import(gameUrl), import(aiUrl)]);
  return { game, ai };
}

/**
 * Free the port, by killing whatever inside this container is holding it.
 *
 * ── WHY THE SIMPLE THING IS NOW THE RIGHT THING ────────────────────────────
 *
 * On the host this was indefensible: it `lsof`ed the port and SIGKILLed every
 * pid it found, ours or not — the operator's editor, an unrelated dev server,
 * the game they were playing. An ownership registry under `runs/servers/` was
 * added to make it discriminate, and that registry is what coupled the gates to
 * `control/` four directories up.
 *
 * Inside the grading container there is nobody else. Every process here belongs
 * to this grading run, so "kill whoever holds the port" is both complete and
 * harmless — the two properties that could not hold at the same time on a
 * shared machine. The registry is gone with the problem it solved.
 *
 * IT IS STILL NEEDED, which is the part I had wrong when I first removed it:
 * the container's runners execute SEQUENTIALLY and share its port namespace, so
 * a runner that dies without tearing down its server leaves the port held and
 * the NEXT runner cannot bind. Measured: gates-09-12 crashed mid-file and
 * frontend then failed with "8002 is already used".
 */
export async function freePort(port = PORT): Promise<void> {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]));
  } catch {
    // lsof exits nonzero when nothing holds the port. That is the goal state.
    return;
  }
  for (const raw of String(stdout).split(/\s+/)) {
    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export interface ServerHandle {
  proc: ChildProcess;
  baseUrl: string;
  stdout?: string;
  stderr?: string;
  /** The writable checkout this server runs from (freshCheckout), removed on stop. */
  checkout?: string;
}

/**
 * A FRESH, WRITABLE COPY of the candidate for one server to run from.
 *
 * The candidate is mounted read-only (harness/grader_run.py), which no
 * deployment an app is written for looks like. An app that keeps a file of its
 * own — a perfectly ordinary design — worked in the model's container and died
 * here on EROFS, and every later gate reported a failure the model could not
 * see (run 1790183923, attempt 3: 44 gates). Each server now boots from its own
 * copy: writes succeed, and nothing written survives into the next server, so
 * every boot is the clean checkout the feedback promises. The mount stays
 * read-only: grading never changes the model's tree.
 */
export function freshCheckout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-"));
  fs.cpSync(TARGET_DIR, dir, { recursive: true });
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attachOutput(
  proc: ChildProcessWithoutNullStreams,
  handle: ServerHandle,
): void {
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");

  proc.stdout.on("data", (chunk: string) => {
    handle.stdout = `${handle.stdout ?? ""}${chunk}`;
  });
  proc.stderr.on("data", (chunk: string) => {
    handle.stderr = `${handle.stderr ?? ""}${chunk}`;
  });
}

function normalizePath(pathname: string): string {
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const onDone = () => {
      cleanup();
      resolve(true);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve(proc.exitCode !== null);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      proc.off("exit", onDone);
      proc.off("close", onDone);
    };

    proc.once("exit", onDone);
    proc.once("close", onDone);
  });
}

export async function startServer(opts?: {
  debug?: boolean;
  env?: Record<string, string>;
}): Promise<ServerHandle> {
  // The artifact's OWN start command, flags included. See `lib/entrypoint.mjs`
  // for why discarding them made grading depend on the operator's host Node.
  const checkout = freshCheckout();
  const { entrypoint, flags } = resolveStartCommand(checkout);
  const proc = spawn("node", [...flags, entrypoint], {
    cwd: checkout,
    env: {
      ...process.env,
      // Authoritative: the harness assigns the port, never the operator's
      // shell. Unset `BENCH_PORT` and this is 8002, as it has always been.
      PORT: String(PORT),
      DEBUG_API: opts?.debug === false ? "" : "1",
      ...(opts?.env ?? {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const handle: ServerHandle = {
    proc,
    baseUrl: BASE_URL,
    stdout: "",
    stderr: "",
    checkout,
  };
  attachOutput(proc as ChildProcessWithoutNullStreams, handle);

  let spawnError: Error | null = null;
  proc.once("error", (err) => {
    spawnError = err;
    handle.stderr = `${handle.stderr ?? ""}${String(err)}\n`;
  });

  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(
        `Failed to spawn server process: ${spawnError.message}\nstderr:\n${handle.stderr ?? ""}`,
      );
    }
    if (proc.exitCode !== null) {
      throw new Error(
        `Server exited before becoming healthy (exit=${proc.exitCode}, signal=${proc.signalCode ?? "none"}).\nstderr:\n${handle.stderr ?? ""}`,
      );
    }

    try {
      const res = await fetch(`${BASE_URL}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.status === 200) {
        return handle;
      }
    } catch {
      // Retry until timeout.
    }

    await sleep(100);
  }

  await stopServer(handle);
  const stderr = (handle.stderr ?? "").trim() || "<empty>";
  throw new Error(
    `Timed out waiting for /health at ${BASE_URL} after 6000ms.\nstderr:\n${stderr}`,
  );
}

export async function stopServer(h: ServerHandle): Promise<void> {
  try {
    await stopProcess(h);
  } finally {
    if (h.checkout) fs.rmSync(h.checkout, { recursive: true, force: true });
  }
}

async function stopProcess(h: ServerHandle): Promise<void> {
  const proc = h.proc;
  if (!proc) {
    return;
  }

  if (proc.exitCode !== null) {
    return;
  }

  try {
    proc.kill("SIGTERM");
  } catch {
    // Best-effort shutdown.
  }

  const exitedAfterTerm = await waitForExit(proc, 1_500);
  if (exitedAfterTerm || proc.exitCode !== null) {
    return;
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    // Best-effort shutdown.
  }

  await waitForExit(proc, 1_500);
}

export async function api(pathname: string, body?: any): Promise<any> {
  const response = await fetch(`${BASE_URL}${normalizePath(pathname)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(30_000),
  });

  // A non-2xx is never a success: surface it (status + the server's error
  // detail) instead of letting an error body pass as a parsed response.
  // The body is read exactly once — as text — then parsed from that text,
  // because a Response body cannot be consumed twice.
  const text = await response.text();
  if (!response.ok) {
    let detail = text.trim();
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
        detail = parsed.error.trim();
      }
    } catch {
      // Non-JSON error body — keep the raw text as the detail.
    }
    throw new Error(
      `HTTP ${response.status} from POST ${normalizePath(pathname)}: ${detail || "<empty body>"}`,
    );
  }
  return JSON.parse(text);
}

export async function getState(): Promise<any> {
  return api("/api/state");
}

// ── A SETUP THAT DID NOT TAKE IS NOT THE BEHAVIOUR UNDER TEST ────────────────
//
// Most gates reach their situation through the candidate's own debug endpoint
// and then judge player behaviour. When the endpoint refused or dropped part of
// the setup, the gate failed anyway — and the model was told the PLAYER story
// ("I picked the hard computer, refreshed the page…") about a thing that never
// happened (run 1790183923: the endpoint rejected every partial body). So the
// setup is checked against what the endpoint echoes BEFORE the behaviour is
// judged, and a setup that did not take fails with this marker. The harness
// routes a marked failure to a true line about the debug endpoint
// (harness/adapters/challenge/feedback.py SETUP_REFUSED), never the gate's own.
export const SETUP_REFUSED = "SETUP REFUSED";

// Display text the app may legitimately rewrite as the state changes.
const SETUP_UNCHECKED = new Set(["message"]);

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    return ka.length === Object.keys(b as object).length &&
      ka.every((k) => sameValue((a as any)[k], (b as any)[k]));
  }
  return a === b;
}

/** The fields of `sent` that the echo does not carry back unchanged. */
export function setupNotTaken(sent: Record<string, any>, echo: unknown): string[] {
  if (!echo || typeof echo !== "object") return Object.keys(sent).filter((k) => !SETUP_UNCHECKED.has(k));
  return Object.keys(sent).filter(
    (k) => !SETUP_UNCHECKED.has(k) && !sameValue(sent[k], (echo as any)[k]),
  );
}

export function assertSetupTook(sent: Record<string, any>, echo: unknown): void {
  const missed = setupNotTaken(sent, echo);
  if (missed.length) {
    // What was SENT travels with what did not take: "a position" and "just
    // difficulty" are different requests, and a candidate that tested the one
    // it was told about found it working (run 1790191629: the gate sent only
    // {difficulty}, the model was told "a position", sent a full board, and
    // saw it take).
    // And the app's own error text, when it answered with one: it is what the
    // integrating team would have in front of them.
    const said = echo && typeof (echo as any).error === "string" ? ` [error: ${(echo as any).error}]` : "";
    throw new Error(
      `${SETUP_REFUSED}: /api/debug/state did not take ${missed.join(", ")} (sent ${Object.keys(sent).join(", ")})${said}`,
    );
  }
}

export async function debugSetState(partial: Record<string, any>): Promise<any> {
  let echo: any;
  try {
    echo = await api("/api/debug/state", partial);
  } catch (error) {
    throw new Error(`${SETUP_REFUSED}: /api/debug/state answered ${String((error as Error).message).split("\n")[0]}`);
  }
  assertSetupTook(partial, echo);
  return echo;
}

export async function debugRoll(dice: number[]): Promise<any> {
  return api("/api/debug/roll", { dice });
}

export async function health(): Promise<Response> {
  return fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(30_000) });
}

export function emptyPoints(): number[] {
  return new Array(26).fill(0);
}

// The standard opening arrangement, written out here rather than read from the
// candidate's engine: a check that needs an ordinary turn from the opening
// position sets it up through the debug seam, because a new game now starts
// with the opening roll (G31), which is not what those checks are about.
export function openingPoints(): number[] {
  const points = emptyPoints();
  points[24] = 2;
  points[13] = 5;
  points[8] = 3;
  points[6] = 5;
  points[1] = -2;
  points[12] = -5;
  points[17] = -3;
  points[19] = -5;
  return points;
}

export function makeState(partial: Record<string, any>): Record<string, any> {
  const base = {
    points: emptyPoints(),
    bar: { white: 0, black: 0 },
    off: { white: 0, black: 0 },
    turn: "white",
    phase: "move",
    dice: [] as number[],
    remainingDice: [] as number[],
    cube: { value: 1, owner: null as "white" | "black" | null },
    difficulty: "medium",
    score: { white: 0, black: 0 },
    winner: null as "white" | "black" | null,
    winType: null as "single" | "gammon" | "backgammon" | null,
    pointsWon: 0,
    doubleOfferedBy: null as "white" | "black" | null,
    message: "",
  };

  return {
    ...base,
    ...partial,
    points: Array.isArray(partial.points) ? [...partial.points] : base.points,
    bar: { ...base.bar, ...(partial.bar ?? {}) },
    off: { ...base.off, ...(partial.off ?? {}) },
    dice: Array.isArray(partial.dice) ? [...partial.dice] : base.dice,
    remainingDice: Array.isArray(partial.remainingDice)
      ? [...partial.remainingDice]
      : base.remainingDice,
    cube: { ...base.cube, ...(partial.cube ?? {}) },
    score: { ...base.score, ...(partial.score ?? {}) },
  };
}
