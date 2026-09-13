// ─────────────────────────────────────────────────────────────────────────────
// PLAY A BUILT RESULT — the operator's own validator.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// Until now the gate suite was the only thing that ever looked at what a model
// built. That makes the grading unfalsifiable from the outside: when a run sits
// flat and non-green, "the model could not do it" and "the corpus asked for
// something impossible" produce identical numbers, identical anomaly counters,
// and a clean ledger. Run 1788804359 was five attempts frozen at 95/117 with
// `void_instrument=[]` — and a person opening the page would have seen a dead
// board in two seconds.
//
// So: the grading certifies the model, and a human playing the build certifies
// the grading. This module is the second half. It is the only control that
// exists for the environment surface — the golden satisfies origin, binding and
// entrypoint by accident of how it was written, so it can never catch a corpus
// defect in any of them.
//
// ── WHY IT CANNOT COLLIDE WITH A GRADING PASS ───────────────────────────────
//
// The built artifact reads `Number(process.env.PORT ?? 8002)`. Grading leaves
// PORT unset and gets 8002 exactly as it always has; play ASSIGNS a free port
// and never goes near it. There is no mutual exclusion here and none is needed:
// the two simply do not want the same address.
//
// A build that IGNORES PORT would land on 8002 anyway, straight into the
// grader's port. That is why `startPlay` verifies the port it asked for is the
// one actually answering, and kills the process and says so plainly when it is
// not — rather than leaving a squatter on the port for the next run to trip on.
//
// ── DEBUG_API IS DELIBERATELY UNSET ─────────────────────────────────────────
//
// Every gate boots with `DEBUG_API=1`. Play boots without it, because that is
// the artifact that ships — playing the debug build would validate something
// nobody runs. Worth stating plainly: this is the first configuration of a
// candidate that nothing else in the system has ever exercised.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

import { resolveStartCommand } from "../tasks/backgammon/gates/lib/entrypoint.mjs";
import { resolveCellDir } from "./history.mjs";
import {
  listServers,
  portHolders,
  reapServers,
  registerServer,
} from "./servers.mjs";

/** The registry `kind` this module owns. Grading uses `"gate"`. */
export const PLAY_KIND = "play";

function refuse(code, reason, status = 400) {
  return { ok: false, code, reason, status };
}

/**
 * A free TCP port from the OS.
 *
 * `listen(0)` then close: the kernel picks one that is free right now. There is
 * a race between closing and the child binding, and it is accepted — the child
 * failing to bind is a loud, diagnosable exit, not a silent wrong answer, and
 * the alternative (a fixed play port) is the collision this whole change exists
 * to remove.
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
  // Newest wins: `startPlay` reaps before spawning, so more than one row means
  // a record outlived its process and the live one is the last written.
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
 * Is the debug seam open on a build running WITHOUT `DEBUG_API`?
 *
 * ── THE ONE CLAUSE NOTHING ELSE CAN CHECK ──────────────────────────────────
 *
 * `REQ-DEBUG` says the debug routes must behave as unknown endpoints when
 * `DEBUG_API` is not `1`. No gate asserts it and no gate ever could: every gate
 * boots the candidate WITH `DEBUG_API=1`, because the suite drives positions and
 * dice through that seam. So a candidate that ships the debug API wide open
 * scores exactly the same as one that gates it.
 *
 * Play is the only thing that runs a candidate in its shipped configuration, so
 * play is the only place the clause can be observed at all. Reported, never
 * refused — an open seam is a finding about the build, not a reason to withhold
 * it from the person who wanted to look at it.
 *
 * The probe carries an EMPTY body on purpose: `/api/debug/state` overwrites the
 * fields it is given, and none are given, so a build that answers it is told to
 * change nothing. `null` means the question could not be asked.
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
 * What the build actually serves at `/` — status plus a short excerpt.
 *
 * Never throws and never blocks the boot: a build whose root cannot be read is
 * reported as `page_status: null`, which the page renders as "could not be
 * read" rather than as success.
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
 * Boot one built result and hand back the URL to open.
 *
 * Refusals are named, never generic — an operator who clicks "view result" and
 * gets nothing needs to know which of the four reasons it was:
 *
 *   invalid_run    the identifiers did not resolve inside the runs root
 *   no_build       the cell has no worktree, or no src/ in it (an aborted cell)
 *   no_entrypoint  nothing in the build says how to start it
 *   port_ignored   the build bound something other than the port it was given
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

  // One at a time. Reaping first is also what keeps `playStatus` honest.
  await stopPlay(benchRoot);

  const port = await freePort();
  // The artifact's own start command, flags included — the same resolution the
  // grader uses. Playing a build through a different command than the one that
  // graded it would put a different artifact in front of the operator, which
  // defeats the point of being able to play it at all.
  const child = spawn("node", [...flags, entrypoint], {
    cwd: worktree,
    env: {
      ...process.env,
      PORT: String(port),
      // Unset, not "0" — see the header. An empty string would still be a set
      // variable, and a build that checks presence rather than value would
      // enable the debug seam on it.
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
        // ── HEALTH IS NOT THE PAGE ────────────────────────────────────────
        //
        // The scaffold ships a working `/health` and a `serveStatic` that
        // throws "not implemented", so a cell that has been seeded and not yet
        // built answers health perfectly and serves a raw 500 at `/`. Opening
        // that in a tab with no explanation is how the first real use of this
        // button produced `{"error":"Error: not implemented"}` and no way to
        // tell whether the build was unfinished or broken.
        //
        // So the root is probed too, and what it answered travels back with
        // the URL. Reported, never refused: seeing a broken board IS the point
        // of playing a build, and refusing would hide the thing worth seeing.
        const page = await probePage(url);
        const seam = await probeDebugSeam(url);
        return { ok: true, url, port, pid: child.pid, run, cell, ...page, ...seam };
      }
    } catch {
      // Not up yet.
    }
    await sleep(150);
  }

  // It never answered where we told it to listen. The likeliest cause is a
  // build that hardcoded its port, which would have taken 8002 — the grader's.
  // Say which it is, and take the process down either way.
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
