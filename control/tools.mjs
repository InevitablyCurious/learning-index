// TOOLS — the registry the board's drawer renders, and the one way a tool runs.
//
//   built-in  the benchmark's own, declared here
//   custom    served by a separate service at BENCH_TOOLS_URL (CUSTOM-TOOLS.md);
//             the benchmark knows none by name and never checks them
//
// The built-ins are the four refresh buttons. The benchmark runs the same with
// or without a service: preflight's fix buttons resolve against built-ins only.
// A tool is a data row, not a branch; an unknown or misconfigured tool errors
// loudly; an unreadable service shows as one blocked row with its address and
// reason.

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

/** How long listing the custom tools may take before the drawer reports it. */
const LIST_TIMEOUT_MS = 3000;
/** How long a custom tool may run when it declares no timeout of its own. */
const RUN_TIMEOUT_DEFAULT_MS = 900000;
/** Slack on top of a tool's own timeout, so the service can report its own. */
const RUN_TIMEOUT_SLACK_MS = 10000;

/** The custom-tools service address, or "" when none is attached. */
export function toolsServiceUrl(env = process.env) {
  return String(env.BENCH_TOOLS_URL ?? "").trim().replace(/\/+$/, "");
}

/** The interpreter the control plane already uses for the bench's own scripts. */
function controlPython(benchRoot) {
  return process.env.OKP_CONTROL_PYTHON ?? join(benchRoot, ".venv", "bin", "python");
}

/** The launchd job this control plane runs as, or "" when started by hand. */
function launchdLabel(env = process.env) {
  return String(env.BENCH_LAUNCHD_LABEL ?? "").trim();
}

function pythonScript(benchRoot, script) {
  return {
    kind: "script",
    command: controlPython(benchRoot),
    argv: [join(benchRoot, "scripts", script)],
    // Measured, not guessed: a warm rebuild is ~9.5min, of which ~6min is
    // docker.io resolution — the network-variable part. 30min is that cost
    // with headroom; the job's live log makes a hang visible long before it.
    timeoutMs: 1800000,
  };
}

function needsFile(path, what) {
  return { ok: existsSync(path), reason: `${what} is missing — ${path}` };
}

/**
 * THE REFRESH BUTTONS. Four parts of the benchmark keep running old code after
 * an edit; each has one button, and preflight names the button when that part
 * is behind. Everything else (harness, prompts, challenges, scripts) is read
 * fresh by every run.
 */
function builtinTools(benchRoot) {
  const label = launchdLabel();
  return [
    {
      id: "worker-image-rebuild",
      name: "Refresh worker",
      blurb:
        "After editing images/worker, images/sidecar or the opencode plugin. The worker " +
        "image the model runs in is built once; until it is rebuilt, every run uses the old one.",
      seams: [
        "rebuilds the worker image from images/worker, images/sidecar and the plugin",
        "stamps it with a fingerprint of those files, which preflight compares with the disk",
      ],
      args: [],
      // Changing the worker mid-run would change what is being measured.
      refuse_while_running: true,
      invoke: pythonScript(benchRoot, "rebuild_worker_image.py"),
      preconditions: [
        needsFile(join(benchRoot, "images", "worker", "Dockerfile"), "the worker Dockerfile"),
        needsFile(join(benchRoot, "scripts", "rebuild_worker_image.py"), "the rebuild script"),
        needsFile(controlPython(benchRoot), "the python that runs the rebuild"),
      ],
    },
    {
      id: "grader-image-rebuild",
      name: "Refresh grader",
      blurb:
        "After editing grader/ or images/grader. Grading runs in an image that is built once; " +
        "until it is rebuilt, every attempt is graded by the old gates.",
      seams: [
        "rebuilds the grading image from grader/ and images/grader",
        "stamps it with a fingerprint of those files, which preflight compares with the disk",
      ],
      args: [],
      refuse_while_running: true,
      invoke: pythonScript(benchRoot, "rebuild_grader_image.py"),
      preconditions: [
        needsFile(join(benchRoot, "images", "grader", "Dockerfile"), "the grader Dockerfile"),
        needsFile(join(benchRoot, "scripts", "rebuild_grader_image.py"), "the rebuild script"),
        needsFile(controlPython(benchRoot), "the python that runs the rebuild"),
      ],
    },
    {
      id: "control-restart",
      name: "Refresh control plane",
      blurb:
        "After editing control/. The control plane reads its code once, when it starts. " +
        "The board goes quiet for a few seconds while it restarts, then reconnects.",
      seams: [
        "answers first, then asks macOS (launchd) to restart this control plane",
        "launchd stops it and starts it again on the code on disk",
      ],
      args: [],
      // Runs are children of the control plane; restarting it would kill one.
      refuse_while_running: true,
      // A restart also orphans every tool job this process is running, so the
      // job runner refuses to start it while one is live (tooljobs.mjs).
      orphans_jobs: true,
      invoke: {
        kind: "script",
        after: {
          command: "/bin/sh",
          argv: ["-c", `sleep 1; exec launchctl kickstart -k "gui/$(id -u)/$0"`, label],
        },
        stdout: "Restarting. The board reconnects in a few seconds.",
      },
      preconditions: [
        {
          ok: Boolean(label),
          reason:
            "this control plane was started by hand, not as a login agent, so nothing can " +
            "restart it from here — stop it and run node control/server.mjs again",
        },
      ],
    },
    {
      id: "board-rebuild",
      name: "Refresh board",
      blurb:
        "After editing dashboard/. The board's page is baked into a container; this rebuilds " +
        "it and reloads this page when the new one is up. Safe during a run.",
      seams: [
        "docker compose build, in dashboard/ — its output is shown here",
        "then swaps the running board for the new one and this page reloads itself",
      ],
      args: [],
      refuse_while_running: false,
      reload_page: true,
      invoke: {
        kind: "script",
        command: "docker",
        argv: ["compose", "build"],
        cwd: join(benchRoot, "dashboard"),
        timeoutMs: 600000,
        // Detached: the swap replaces the container relaying this very request.
        after: { command: "docker", argv: ["compose", "up", "-d", "--force-recreate"] },
      },
      preconditions: [
        needsFile(join(benchRoot, "dashboard", "docker-compose.yml"), "the board's compose file"),
      ],
    },
  ];
}

/** A drawer row that can only say why it does nothing. */
function blockedRow({ id, name, blurb, reason }) {
  return {
    id,
    name,
    blurb,
    seams: [],
    args: [],
    refuse_while_running: false,
    external: true,
    invoke: { kind: "none" },
    preconditions: [{ ok: false, reason }],
  };
}

function cleanArgs(declared) {
  return (Array.isArray(declared) ? declared : [])
    .filter((a) => a && String(a.name ?? "").trim())
    .map((a) => ({
      name: String(a.name).trim(),
      label: String(a.label ?? a.name),
      required: a.required === true,
      default: a.default === undefined || a.default === null ? "" : String(a.default),
      help: a.help ? String(a.help) : "",
    }));
}

/**
 * The attached service's tools, or [] when none is attached. Unreachable or
 * off-contract becomes one blocked row, never [] (a typo'd address must not look
 * like an empty service).
 */
async function serviceTools(benchRoot) {
  const url = toolsServiceUrl();
  if (!url) return [];

  const unavailable = (reason) => [
    blockedRow({
      id: "custom-tools",
      name: "Custom tools",
      blurb: `Tools served by the custom-tools service at ${url} (BENCH_TOOLS_URL).`,
      reason: `custom tools unavailable at ${url} — ${reason}`,
    }),
  ];

  let body;
  try {
    const res = await fetch(`${url}/tools`, {
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return unavailable(`GET /tools answered ${res.status}`);
    body = await res.json();
  } catch (err) {
    return unavailable(String(err?.message ?? err));
  }
  const declared = Array.isArray(body?.tools) ? body.tools : null;
  if (!declared) return unavailable('GET /tools returned no "tools" array');

  const builtinIds = new Set(builtinTools(benchRoot).map((t) => t.id));
  const out = [];
  for (const entry of declared) {
    const id = String(entry?.id ?? "").trim();
    if (!id) continue;
    // Built-ins win a name collision, and the attempt is shown.
    if (builtinIds.has(id)) {
      out.push(
        blockedRow({
          id: `${id}-external`,
          name: String(entry?.name ?? id),
          blurb: String(entry?.blurb ?? ""),
          reason: `the custom-tools service declares "${id}", which is a built-in tool — built-ins win, so this row does nothing`,
        }),
      );
      continue;
    }
    out.push({
      id,
      name: String(entry?.name ?? id),
      blurb: String(entry?.blurb ?? ""),
      success_note: entry?.success_note ? String(entry.success_note) : null,
      seams: Array.isArray(entry?.seams) ? entry.seams.map(String) : [],
      args: cleanArgs(entry?.args),
      refuse_while_running: entry?.refuse_while_running !== false,
      external: true,
      invoke: {
        kind: "service",
        url,
        id,
        timeoutMs: Number.isFinite(entry?.timeout_ms) ? Number(entry.timeout_ms) : RUN_TIMEOUT_DEFAULT_MS,
      },
      preconditions: [],
    });
  }
  return out;
}

/** Every tool: the built-ins, then whatever the attached service serves. */
export async function toolRegistry(benchRoot) {
  return [...builtinTools(benchRoot), ...(await serviceTools(benchRoot))];
}

/** A registry row as the board consumes it: status resolved, nothing executable. */
function describe(t) {
  const failed = (t.preconditions ?? []).filter((p) => !p.ok);
  return {
    id: t.id,
    name: t.name,
    blurb: t.blurb,
    // What to say on success when "it worked" isn't the whole truth.
    success_note: t.success_note ?? null,
    // The board reloads itself once the tool's work is live (Refresh board).
    reload_page: t.reload_page === true,
    seams: t.seams ?? [],
    args: (t.args ?? []).map((a) => ({ ...a })),
    status: failed.length === 0 ? "wired" : "blocked",
    // So the board can explain a refusal before the click.
    refuse_while_running: t.refuse_while_running === true,
    // A custom tool is not part of the benchmark others clone.
    external: t.external === true,
    blocked_reason: failed.length ? failed.map((p) => p.reason).join("; ") : null,
  };
}

/** The whole drawer: built-ins plus the attached service's tools. */
export async function describeTools(benchRoot) {
  return (await toolRegistry(benchRoot)).map(describe);
}

/** The built-in tools only — never contacts the custom-tools service. */
export function describeBuiltinTools(benchRoot) {
  return builtinTools(benchRoot).map(describe);
}

/**
 * Resolve each preflight check's remedy id to the built-in tool that fixes it;
 * an unresolved id becomes null (the check's detail already says the fix in
 * words). Mutates and returns the checks.
 */
export function attachRemedies(checks, registry) {
  for (const check of checks ?? []) {
    const id = check?.remedy_tool;
    if (!id) continue;
    const tool = (registry ?? []).find((t) => t.id === id);
    check.remedy = tool
      ? {
          id: tool.id,
          name: tool.name,
          status: tool.status,
          blocked_reason: tool.blocked_reason ?? null,
          refuse_while_running: tool.refuse_while_running === true,
        }
      : null;
  }
  return checks;
}

// ── handlers ──

/**
 * Run a declared command as an argv array, never a shell string. Command and
 * args come from the registry row, not the request. Output returned verbatim,
 * and streamed chunk-by-chunk to `onChunk` when given (tool jobs tail it live).
 * `after`, when present, is started detached once the command succeeds — for
 * work that would cut off this very reply (restarting the control plane or the
 * board's container).
 */
async function runScript({ command, argv, cwd, after, stdout = "", timeoutMs = 120000, benchRoot, onChunk }) {
  const out = command
    ? await runCommand({ command, argv, cwd: cwd ?? benchRoot, timeoutMs, onChunk })
    : { ok: true, code: "ok", reason: null, stdout, stderr: "" };
  // The no-command case (Refresh control plane) still tells a watching job.
  if (!command && stdout && typeof onChunk === "function") onChunk("stdout", `${stdout}\n`);
  if (out.ok && after) {
    spawn(after.command, after.argv ?? [], {
      cwd: cwd ?? benchRoot,
      env: { ...process.env },
      detached: true,
      stdio: "ignore",
    }).unref();
  }
  return out;
}

/**
 * Run one command and settle on the child's `exit` (code + signal = verdict),
 * never on stdio EOF alone: a descendant that outlives the child (a rebuild
 * script's docker) holds the pipe write-ends open, so `close` may never fire.
 */
export async function runCommand({ command, argv, cwd, timeoutMs, onChunk }) {
  return await new Promise((resolveP) => {
    /** `close` follows `exit` within single-digit ms normally — a few hundred ms captures trailing stdio without delaying the verdict, and bounds the wait when a surviving descendant holds the pipes open. */
    const STDIO_GRACE_MS = 300;
    const child = spawn(command, argv ?? [], { cwd, env: { ...process.env } });
    let out = "";
    let err = "";
    let timer = null;
    let grace = null;
    let settled = false;
    let verdict = null;

    // Single settlement funnel: idempotent, and tears down every timer so no
    // stray arm can fire (or keep the loop alive) after the promise resolves.
    const settle = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolveP(payload);
    };
    const drained = (v) => ({ ...v, stdout: out.slice(-8000), stderr: err.slice(-8000) });

    timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle({
        ok: false,
        code: "timeout",
        reason: `no result after ${Math.round(timeoutMs / 1000)}s — the command was terminated`,
        stdout: out.slice(-4000),
        stderr: err.slice(-4000),
      });
    }, timeoutMs);

    child.stdout?.on("data", (d) => { const s = String(d); out += s; onChunk?.("stdout", s); });
    child.stderr?.on("data", (d) => { const s = String(d); err += s; onChunk?.("stderr", s); });

    child.on("error", (e) => {
      settle({ ok: false, code: "spawn_failed", reason: String(e?.message ?? e) });
    });

    child.on("exit", (code, signal) => {
      if (settled) return; // timeout already resolved — no stray grace timer.
      verdict =
        code === 0 && signal === null
          ? { ok: true, code: "ok", reason: null }
          : code !== null
            ? { ok: false, code: `exit_${code}`, reason: `the command exited ${code} — its own output is below` }
            : { ok: false, code: String(signal), reason: `the command was killed by ${signal} — its own output is below` };
      // Bounded grace for trailing stdio; if `close` never comes (wedged pipe),
      // settle anyway with whatever the data handlers accumulated.
      grace = setTimeout(() => settle(drained(verdict)), STDIO_GRACE_MS);
    });

    child.on("close", () => {
      // Normal path: stdio drained right after exit — settle fully drained.
      if (verdict) settle(drained(verdict));
    });
  });
}

/**
 * Ask the custom-tools service to run one of its tools. Its verdict and output
 * are forwarded as-is; unreachable, timed out or off-contract is a named failure.
 */
async function runService({ url, id, timeoutMs = RUN_TIMEOUT_DEFAULT_MS, args }) {
  let res;
  let text = "";
  try {
    res = await fetch(`${url}/tools/run`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ id, args: args ?? {} }),
      signal: AbortSignal.timeout(timeoutMs + RUN_TIMEOUT_SLACK_MS),
    });
    text = await res.text();
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return {
      ok: false,
      code: timedOut ? "timeout" : "service_unreachable",
      reason: timedOut
        ? `the custom-tools service at ${url} gave no result within ${Math.round((timeoutMs + RUN_TIMEOUT_SLACK_MS) / 1000)}s`
        : `custom tools unavailable at ${url} — ${String(err?.message ?? err)}`,
    };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return {
      ok: false,
      code: "service_bad_response",
      reason: `the custom-tools service at ${url} answered ${res.status} with something that is not JSON`,
      stdout: text.slice(-4000),
    };
  }
  const ok = body?.ok === true;
  return {
    ok,
    code: body?.code ?? (ok ? "ok" : "tool_failed"),
    reason: body?.reason ?? null,
    stdout: String(body?.stdout ?? "").slice(-8000),
    stderr: String(body?.stderr ?? "").slice(-8000),
    result: body?.result ?? null,
  };
}

const HANDLERS = { script: runScript, service: runService };

/**
 * Resolve a tool run to its validated parts, or the loud failure. Shared by
 * invokeTool (run to completion) and the job runner (tooljobs.mjs), so a run
 * is refused the same way however it is executed.
 */
export async function resolveTool(benchRoot, id, args = {}) {
  const tool = (await toolRegistry(benchRoot)).find((t) => t.id === String(id));
  if (!tool) return { ok: false, code: "unknown_tool", reason: `no tool ${JSON.stringify(String(id))} is registered` };

  const failed = (tool.preconditions ?? []).filter((p) => !p.ok);
  if (failed.length) {
    return { ok: false, code: "tool_blocked", reason: failed.map((p) => p.reason).join("; ") };
  }

  for (const a of tool.args ?? []) {
    if (a.required && !String(args?.[a.name] ?? "").trim()) {
      return { ok: false, code: "missing_arg", reason: `${tool.name} needs ${a.name}` };
    }
  }

  const handler = HANDLERS[tool.invoke?.kind];
  if (!handler) {
    return {
      ok: false,
      code: "unknown_handler",
      reason: `tool ${tool.id} declares handler ${JSON.stringify(String(tool.invoke?.kind))}, which is not registered`,
    };
  }

  // Only declared arguments, as strings.
  const picked = {};
  for (const a of tool.args ?? []) {
    const v = args?.[a.name];
    if (v !== undefined && v !== null && String(v) !== "") picked[a.name] = String(v);
  }

  return { ok: true, tool, handler, picked };
}

/**
 * Invoke a tool by id, synchronously. Unknown id, unknown handler, missing
 * argument and failed precondition all fail loudly. The board's run route
 * starts a tracked job instead (tooljobs.mjs); this remains the job runner's
 * own executor and the seam tests' entry point.
 */
export async function invokeTool(benchRoot, id, args = {}) {
  const resolved = await resolveTool(benchRoot, id, args);
  if (!resolved.ok) return resolved;

  const { tool, handler, picked } = resolved;
  // Spread first so a row can't override benchRoot or the validated args.
  return await handler({ ...tool.invoke, benchRoot, args: picked });
}
