// PLAY A BUILT RESULT — the operator's own check on the grading. A human
// playing the build catches what the gates can't (a run frozen at 95/117 whose
// page was visibly dead in seconds).
//
// The artifact reads PORT (default 8002, the grader's); play assigns a free
// port, so it never collides with grading. A build that ignores PORT would land
// on 8002, so startPlay checks the port it asked for is the one answering and
// kills it otherwise. DEBUG_API is unset: play runs the configuration that
// ships, which no gate ever exercises.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

import { resolveStartCommand } from "../grader/lib/entrypoint.mjs";
import { resolveCellDir } from "./history.mjs";
import {
  listServers,
  portHolders,
  reapServers,
  registerServer,
} from "./servers.mjs";

/** This module's registry kind (grading uses "gate"). */
export const PLAY_KIND = "play";

function refuse(code, reason, status = 400) {
  return { ok: false, code, reason, status };
}

/**
 * A free port from the OS (listen(0), then close). The race before the child
 * binds is accepted: a failed bind is loud.
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** The play server running right now, or null. Read from the registry. */
export function playStatus(benchRoot) {
  const rows = listServers(benchRoot).filter((r) => r.kind === PLAY_KIND);
  if (rows.length === 0) return null;
  // Newest wins; startPlay reaps before spawning.
  rows.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  const r = rows[0];
  return {
    pid: r.pid,
    port: r.port,
    url: `http://localhost:${r.port}/`,
    run: r.label ? String(r.label).split("::")[0] : null,
    cell: r.label ? String(r.label).split("::")[1] ?? null : null,
    started_at: r.started_at,
  };
}

/** Stop whatever is being played. Idempotent; "nothing was running" is a result. */
export async function stopPlay(benchRoot) {
  const report = await reapServers({ kind: PLAY_KIND }, benchRoot);
  return { ok: true, stopped: report.killed.length, pruned: report.pruned.length };
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
 * Boot one built result and return the URL to open. Named refusals:
 *   invalid_run    the identifiers did not resolve inside the runs root
 *   no_build       no worktree, or no src/ in it
 *   no_entrypoint  nothing says how to start it
 *   port_ignored   it bound a port other than the one given
 *   boot_failed    it started and never answered
 */
export async function startPlay({ runsRoot, benchRoot, run, cell }) {
  const cellDir = resolveCellDir(runsRoot, run, cell);
  if (!cellDir) {
    return refuse("invalid_run", "run or cell identifier is invalid");
  }

  const worktree = join(cellDir, "worktree");
  if (!existsSync(join(worktree, "src"))) {
    return refuse(
      "no_build",
      `no build to play at ${worktree} — this cell produced no source tree ` +
        "(it aborted before writing files, or the run tree has been reset).",
      404,
    );
  }

  let entrypoint;
  let flags;
  try {
    ({ entrypoint, flags } = resolveStartCommand(worktree));
  } catch (err) {
    return refuse("no_entrypoint", String(err?.message ?? err), 422);
  }

  // One at a time; reaping first keeps playStatus honest.
  await stopPlay(benchRoot);

  const port = await freePort();
  // The artifact's own start command, the same one the grader uses.
  const child = spawn("node", [...flags, entrypoint], {
    cwd: worktree,
    env: {
      ...process.env,
      PORT: String(port),
      // Unset, not "0" (a presence check would still see a set variable).
      DEBUG_API: undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (c) => {
    stderr = `${stderr}${c}`.slice(-4000);
  });
  child.stdout?.resume();

  if (child.pid) {
    registerServer(
      {
        pid: child.pid,
        port,
        kind: PLAY_KIND,
        label: `${run}::${cell}`,
        cwd: worktree,
        entrypoint,
      },
      benchRoot,
    );
  }

  const url = `http://localhost:${port}/`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await stopPlay(benchRoot);
      return refuse(
        "boot_failed",
        `the build exited immediately (code ${child.exitCode}). stderr:\n${stderr.trim() || "<empty>"}`,
        422,
      );
    }
    try {
      const res = await fetch(`${url}health`, { signal: AbortSignal.timeout(500) });
      if (res.status === 200) {
        // Health is not the page: a seeded, unbuilt scaffold answers /health and
        // throws at `/`. The root is probed and its answer returned with the URL —
        // reported, never refused.
        const page = await probePage(url);
        const seam = await probeDebugSeam(url);
        return { ok: true, url, port, pid: child.pid, run, cell, ...page, ...seam };
      }
    } catch {
      // Not up yet.
    }
    await sleep(150);
  }

  // It never answered on the given port: likely a hardcoded port, which would
  // have taken 8002. Say which, and take it down either way.
  const holders = await portHolders(8002);
  const squatting = holders.some((h) => h.pid === child.pid);
  await stopPlay(benchRoot);

  if (squatting) {
    return refuse(
      "port_ignored",
      "this build ignores the PORT it is given and binds a fixed port, so it " +
        "cannot be run alongside a grading pass. It has been stopped.",
      409,
    );
  }
  return refuse(
    "boot_failed",
    `no answer at ${url}health after 10s. stderr:\n${stderr.trim() || "<empty>"}`,
    504,
  );
}
