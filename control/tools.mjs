// TOOLS — the registry the board's drawer renders, and the one way a tool runs.
//
//   built-in  the benchmark's own, declared here
//   custom    served by a separate service at BENCH_TOOLS_URL (CUSTOM-TOOLS.md);
//             the benchmark knows none by name and never checks them
//
// The benchmark runs the same with or without a service: preflight's fix buttons
// resolve against built-ins only. A tool is a data row, not a branch; an unknown
// or misconfigured tool errors loudly; an unreadable service shows as one blocked
// row with its address and reason.

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

function builtinTools(benchRoot) {
  return [
    // Refuses while a cell is in flight: rebuilding the worker mid-cell changes the
    // substrate under the measurement.
    {
      id: "worker-image-rebuild",
      name: "Rebuild worker",
      blurb:
        "Press when preflight says the worker image is stale, and after any edit under " +
        "images/worker. The image bakes its sources at build time, so until you rebuild, " +
        "every cell runs the old ones without saying so.",
      seams: [
        "computes a digest of everything images/worker bakes in",
        "docker build -t bench-worker:v1 images/worker, with that digest as a label",
        "preflight reads the label back and compares it to the source — a content check, not a timestamp",
      ],
      args: [],
      refuse_while_running: true,
      // Not a bare docker build: it records what it was built from, so freshness can
      // be checked (a cached rebuild keeps the old image's creation time).
      invoke: {
        kind: "script",
        command: controlPython(benchRoot),
        argv: [join(benchRoot, "scripts", "rebuild_worker_image.py")],
        timeoutMs: 900000,
      },
      preconditions: [
        {
          ok: existsSync(join(benchRoot, "images", "worker", "Dockerfile")),
          reason: `no worker Dockerfile at ${join(benchRoot, "images", "worker", "Dockerfile")}`,
        },
        {
          ok: existsSync(join(benchRoot, "scripts", "rebuild_worker_image.py")),
          reason: `the rebuild script is missing — ${join(benchRoot, "scripts", "rebuild_worker_image.py")}`,
        },
        {
          ok: existsSync(controlPython(benchRoot)),
          reason: `no python to run the rebuild with — ${controlPython(benchRoot)}`,
        },
      ],
    },
    // The grader image, same treatment: it bakes a digest of grader/ that
    // preflight reads back, so a stale grader is caught and fixed from here.
    {
      id: "grader-image-rebuild",
      name: "Rebuild grader",
      blurb:
        "Press when preflight says the grading image is stale or missing, and after any edit " +
        "under grader/ or images/grader. Grading runs only in this image, so until you rebuild, " +
        "every attempt is graded by the gate code the image was built with.",
      seams: [
        "computes a digest of the gate suite and the grader Dockerfile",
        "docker build of images/grader against the challenge's gate suite, with that digest as a label",
        "preflight reads the label back and compares it to the gates on disk — a content check, not a timestamp",
      ],
      args: [],
      // Rebuilding the grader mid-cell changes what the attempt is measured by.
      refuse_while_running: true,
      invoke: {
        kind: "script",
        command: controlPython(benchRoot),
        argv: [join(benchRoot, "scripts", "rebuild_grader_image.py")],
        timeoutMs: 900000,
      },
      preconditions: [
        {
          ok: existsSync(join(benchRoot, "images", "grader", "Dockerfile")),
          reason: `no grader Dockerfile at ${join(benchRoot, "images", "grader", "Dockerfile")}`,
        },
        {
          ok: existsSync(join(benchRoot, "scripts", "rebuild_grader_image.py")),
          reason: `the rebuild script is missing — ${join(benchRoot, "scripts", "rebuild_grader_image.py")}`,
        },
        {
          ok: existsSync(controlPython(benchRoot)),
          reason: `no python to run the rebuild with — ${controlPython(benchRoot)}`,
        },
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
 * args come from the registry row, not the request. Output returned verbatim.
 */
async function runScript({ command, argv, timeoutMs = 120000, benchRoot }) {
  return await new Promise((resolveP) => {
    const child = spawn(command, argv ?? [], { cwd: benchRoot, env: { ...process.env } });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolveP({
        ok: false,
        code: "timeout",
        reason: `no result after ${Math.round(timeoutMs / 1000)}s — the command was terminated`,
        stdout: out.slice(-4000),
        stderr: err.slice(-4000),
      });
    }, timeoutMs);
    child.stdout?.on("data", (d) => { out += String(d); });
    child.stderr?.on("data", (d) => { err += String(d); });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveP({ ok: false, code: "spawn_failed", reason: String(e?.message ?? e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({
        ok: code === 0,
        code: code === 0 ? "ok" : `exit_${code}`,
        reason: code === 0 ? null : `the command exited ${code} — its own output is below`,
        stdout: out.slice(-8000),
        stderr: err.slice(-8000),
      });
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
 * Invoke a tool by id. Unknown id, unknown handler, missing argument and
 * failed precondition all fail loudly.
 */
export async function invokeTool(benchRoot, id, args = {}) {
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

  // Spread first so a row can't override benchRoot or the validated args.
  return await handler({ ...tool.invoke, benchRoot, args: picked });
}
