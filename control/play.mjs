// PLAY A BUILT RESULT — the operator's own check on the grading. A human
// playing the build catches what the gates can't (a run frozen at 95/117 whose
// page was visibly dead in seconds).
//
// The candidate runs where grading runs it: inside the grader image, started by
// harness/play_container.py. It used to be a host process — the operator's node,
// the operator's ~/.ssh, the operator's Docker socket, a writable worktree — and
// a model-authored start script is untrusted input, so the host is the one place
// it must never execute. What comes back is one published 127.0.0.1 port to open
// in a browser and nothing else.
//
// DEBUG_API is not passed: play runs the configuration that ships, which no gate
// ever exercises (they all boot with the seam on).

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveCellDir } from "./history.mjs";
import {
  deregisterServer,
  listServers,
  reapServers,
  registerServer,
} from "./servers.mjs";
import { PYTHON } from "./state.mjs";

/** This module's registry kind (grading uses "gate"). */
export const PLAY_KIND = "play";

/** A container start is a handful of docker calls; this is the leash on a hang. */
const CLI_TIMEOUT_MS = 120_000;

function refuse(code, reason, status = 400) {
  return { ok: false, code, reason, status };
}

/**
 * harness/play_container.py — one JSON line on stdout, read from the LAST line
 * even on a non-zero exit: a refusal is written as JSON too, and its code is
 * the whole point of asking.
 */
function cliExec(argv, benchRoot) {
  return new Promise((resolve) => {
    execFile(
      PYTHON,
      ["-m", "harness.play_container", ...argv],
      { cwd: benchRoot, timeout: CLI_TIMEOUT_MS },
      (err, stdout, stderr) => {
        const lines = String(stdout ?? "")
          .split("\n")
          .filter((line) => line.trim().length > 0);
        const last = lines[lines.length - 1];
        if (last) {
          try {
            resolve(JSON.parse(last));
            return;
          } catch {
            // Not a JSON line: reported as unexpected below.
          }
        }
        const reason =
          String(err?.message ?? "").trim() ||
          String(stderr ?? "").trim() ||
          "no output";
        resolve({ ok: false, code: "unexpected", reason });
      },
    );
  });
}

/**
 * The CLI runner. Swappable so tests can exercise the wiring here — refusal
 * mapping, registry, boot probe — without docker; production never replaces it.
 */
let playContainer = cliExec;

/** Replace the CLI runner (tests only; `null` restores the real one). */
export function setPlayContainer(fn) {
  playContainer = fn ?? cliExec;
}

/** Remove every play container and network. Fire-and-forget; never throws. */
export async function reapPlayContainers(benchRoot) {
  try {
    await playContainer(["reap", "--owner", "control"], benchRoot);
  } catch {
    // Best effort: an orphaned container is cleaned by the next start or stop.
  }
}

/** The play server running right now, or null. Read from the registry. */
export function playStatus(benchRoot) {
  // A server is reported only once it has answered: one still booting is not yet
  // something to frame, and the one it replaces keeps running until it does.
  const rows = listServers(benchRoot).filter((r) => r.kind === PLAY_KIND && r.ready === true);
  if (rows.length === 0) return null;
  // Newest wins; startPlay reaps before starting.
  rows.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  const r = rows[0];
  return {
    pid: r.pid,
    port: r.port,
    url: `http://localhost:${r.port}/`,
    run: r.label ? String(r.label).split("::")[0] : null,
    cell: r.label ? String(r.label).split("::")[1] ?? null : null,
    attempt: Number.isInteger(r.attempt) ? r.attempt : null,
    started_at: r.started_at,
  };
}

/**
 * Stop whatever is being played. Idempotent; "nothing was running" is a result.
 * `stopped` counts containers removed (a session is two: candidate + forwarder),
 * `pruned` counts registry records dropped.
 */
export async function stopPlay(benchRoot) {
  const res = await playContainer(["reap", "--owner", "control"], benchRoot);
  const pruned = [];
  for (const rec of listServers(benchRoot)) {
    if (rec.kind !== PLAY_KIND) continue;
    deregisterServer(rec.pid, benchRoot);
    pruned.push(rec);
  }
  return {
    ok: true,
    stopped: res?.removed_containers?.length ?? 0,
    pruned: pruned.length,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Is the debug seam open on a build running without DEBUG_API? REQ-DEBUG says
 * it must not be, and no gate can check it (they all boot with DEBUG_API=1).
 * Reported, never refused. The empty body changes nothing on a build that
 * answers. null = could not ask.
 */
async function probeDebugSeam(url) {
  try {
    const res = await fetch(`${url}api/debug/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(3_000),
    });
    return { debug_seam_open: res.status !== 404, debug_seam_status: res.status };
  } catch {
    return { debug_seam_open: null, debug_seam_status: null };
  }
}

/**
 * What the build serves at `/` (status plus an excerpt). Never throws; an
 * unreadable root is page_status null.
 */
async function probePage(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    const body = await res.text().catch(() => "");
    return {
      page_status: res.status,
      page_excerpt: body.replace(/\s+/g, " ").trim().slice(0, 200),
    };
  } catch (err) {
    return { page_status: null, page_excerpt: String(err?.message ?? err).slice(0, 200) };
  }
}

/**
 * The build the grader judged last: the newest round in the cell's checkpoint
 * index, `{ attempt, tree }`, or null when no round has been graded. The index
 * lists a checkpoint only once its tree is copied, so a half-written one is
 * never served. Jerry, 2026-10-28: the board shows what the grader saw, never
 * the model's working copy mid-edit ("i need to be able to see what the grader
 * and you are seeing").
 */
export function latestGraded(cellDir) {
  let index;
  try {
    index = JSON.parse(readFileSync(join(cellDir, "checkpoints", "index.json"), "utf8"));
  } catch {
    return null;
  }
  const last = (index?.checkpoints ?? []).at(-1);
  if (!last || typeof last.tree_path !== "string" || !Number.isInteger(last.attempt)) return null;
  const tree = join(cellDir, last.tree_path);
  return existsSync(join(tree, "src")) ? { attempt: last.attempt, tree } : null;
}

/**
 * Boot one built result in the grader image and return the URL to open. Named
 * refusals:
 *   invalid_run      the identifiers did not resolve inside the runs root
 *   no_build         no round has been graded yet (the build served is the
 *                    newest graded checkpoint, never the working copy)
 *   no_entrypoint    nothing says how to start it
 *   image_missing    the grader image is not built
 *   docker_missing   docker is not reachable
 *   boot_failed      it started and never answered
 *   registry_failed  it could not be recorded, so it was stopped, not played
 *   port_ignored     RETIRED from this path: the candidate binds 8002 inside its
 *                    own container, so it can no longer squat a host port.
 */
export async function startPlay({ runsRoot, benchRoot, run, cell }) {
  const cellDir = resolveCellDir(runsRoot, run, cell);
  if (!cellDir) {
    return refuse("invalid_run", "run or cell identifier is invalid");
  }

  const graded = latestGraded(cellDir);
  if (!graded) {
    return refuse(
      "no_build",
      `no graded build to play in ${cellDir} — no round has been graded yet ` +
        "(or the cell aborted before its first grade, or the run tree has been reset).",
      404,
    );
  }
  const worktree = graded.tree;

  // The session identity, and the name the module names everything from: its
  // containers, its network, and this registry record.
  const name = `${run}::${cell}`;
  // One at a time, but the one running keeps running until the new one answers:
  // a build that will not boot must not take the working one down with it.
  const started = await playContainer(
    ["start", "--name", name, "--worktree", worktree, "--owner", "control", "--cell", cell],
    benchRoot,
  );

  if (!started?.ok) {
    const reason = String(started?.reason ?? "the play container could not be started");
    switch (String(started?.code ?? "")) {
      case "no_entrypoint":
        return refuse("no_entrypoint", reason, 422);
      case "image_missing":
        return refuse("image_missing", reason, 503);
      case "docker_missing":
        return refuse("docker_missing", reason, 503);
      default:
        // start_failed, unexpected, absent: the candidate did not come up.
        return refuse("boot_failed", reason, 422);
    }
  }

  const port = Number(started.host_port);
  const candidate = String(started.candidate ?? "");
  const url = String(started.url ?? `http://localhost:${port}/`);

  const record_ = {
    pid: name,
    container: candidate,
    port,
    kind: PLAY_KIND,
    label: name,
    cwd: worktree,
    attempt: graded.attempt,
    entrypoint: candidate,
  };
  if (registerServer(record_, benchRoot) === null) {
    // A running container with no record is unreapable — nothing can find it to
    // stop it later. Take it down now: there is never a play server running
    // without a registry record.
    await playContainer(["stop", "--name", name], benchRoot);
    return refuse(
      "registry_failed",
      `the server registry could not record ${name}, so the container was ` +
        "stopped rather than left running unreapable.",
      500,
    );
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}health`, { signal: AbortSignal.timeout(500) });
      if (res.status === 200) {
        // Health is not the page: a seeded, unbuilt scaffold answers /health and
        // throws at `/`. The root is probed and its answer returned with the URL —
        // reported, never refused.
        const page = await probePage(url);
        const seam = await probeDebugSeam(url);
        // Answering: mark it ready, then retire every other play server.
        registerServer({ ...record_, ready: true }, benchRoot);
        await reapServers({ kind: PLAY_KIND, except: name }, benchRoot);
        return { ok: true, url, port, pid: name, run, cell, attempt: graded.attempt, ...page, ...seam };
      }
    } catch {
      // Not up yet.
    }
    await sleep(150);
  }

  // It started and never answered: take it down either way.
  await playContainer(["stop", "--name", name], benchRoot);
  deregisterServer(name, benchRoot);
  return refuse("boot_failed", `no answer at ${url}health after 10s.`, 504);
}
