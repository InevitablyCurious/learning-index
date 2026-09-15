// ─────────────────────────────────────────────────────────────────────────────
// TOOLS — the registry the board's tool drawer renders, and the one way a tool
// is invoked
//
// Two kinds of tool, and only two:
//
//   · BUILT-IN   the benchmark's own, declared in this file. Today: Rebuild
//                worker.
//   · CUSTOM     served by a separate custom-tools service at BENCH_TOOLS_URL —
//                for example a memory system's own operations. The benchmark
//                ships none of them, knows none of them by name, and never
//                checks them. The contract is CUSTOM-TOOLS.md.
//
// THE BENCHMARK RUNS THE SAME WITH OR WITHOUT A SERVICE. Nothing here is on the
// run path or the preflight path: preflight's fix buttons resolve against the
// built-ins only (describeBuiltinTools), so a slow, broken or absent service can
// cost the drawer a row and nothing else.
//
// Doctrine:
//   · SPEC-AS-DATA   a tool declares itself as a row, not as a branch in the
//                    dispatcher.
//   · FAIL LOUD      an unknown or misconfigured tool ERRORS. It never returns a
//                    cheerful no-op, because a tool that silently does nothing is
//                    indistinguishable from one that worked.
//   · HONEST ABSENCE a service that cannot be read is shown as one blocked row
//                    naming the address and the reason — never silently skipped.
//
// ── WHY THE REGISTRY LIVES HERE AND NOT IN THE BOARD ────────────────────────
//
// A UI holding its own copy is a second source of truth that will eventually
// claim a tool is available when it is not. The board renders what this serves.
// ─────────────────────────────────────────────────────────────────────────────

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
    // It REFUSES while a cell is in flight. Rebuilding the worker image
    // underneath a running cell changes the substrate mid-measurement, which
    // produces a result that looks valid and is not.
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
      // NOT A BARE `docker build`. The build has to record what it was built
      // FROM, or freshness has nothing to compare: docker is content-addressed,
      // so a content-identical rebuild is a cache hit that keeps the old image's
      // creation time, and an mtime check stays red through every rebuild.
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
 * The custom tools the attached service serves, or `[]` when none is attached.
 *
 * AN UNREADABLE SERVICE IS REPORTED, NEVER SKIPPED. Set but unreachable, or not
 * answering the contract, becomes ONE blocked row naming the address and the
 * reason. Returning `[]` would make a typo in the address indistinguishable from
 * a service that legitimately serves nothing.
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
    // BUILT-INS WIN A COLLISION. A service cannot make `worker-image-rebuild`
    // mean something else on one installation, and the attempt is shown.
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
    // What to say when it SUCCEEDS, when "it worked" is not the whole truth.
    // Absent for most tools: their own output is the report.
    success_note: t.success_note ?? null,
    seams: t.seams ?? [],
    args: (t.args ?? []).map((a) => ({ ...a })),
    status: failed.length === 0 ? "wired" : "blocked",
    // The board needs this to explain a refusal BEFORE the click, not after.
    refuse_while_running: t.refuse_while_running === true,
    // WHOSE TOOL THIS IS: a custom tool is not part of the benchmark anyone else
    // clones.
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
 * Resolve each preflight check's remedy TOOL ID into the button that repairs it.
 *
 * Preflight names the remedy by id and stops there, because this side knows
 * the registry: a board holding its own id->name table would be a second source
 * of truth. Callers pass the BUILT-IN registry — preflight is the benchmark's
 * own and never names a custom tool.
 *
 * AN UNRESOLVED ID BECOMES `null`, NOT A BUTTON. Every preflight detail already
 * names its own fix in words.
 *
 * Mutates the checks in place and returns them.
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

// ── handlers ─────────────────────────────────────────────────────────────────

/**
 * Run a declared command as an ARGV ARRAY — never a shell string.
 *
 * The command and its arguments come from the registry row, not from the
 * request, so a caller cannot compose one. Output is returned verbatim on
 * success and failure alike: rewriting it would hide which layer refused.
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
 * Ask the custom-tools service to run one of its tools.
 *
 * The service's own verdict and output are forwarded, never rewritten. A
 * service that cannot be reached, times out, or answers outside the contract is
 * a named failure — never a quiet ok.
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
 * Invoke a tool by id.
 *
 * FAIL LOUD AT EVERY STEP: unknown id, unknown handler kind, missing required
 * arg, failed precondition. None of these return ok — a tool that cannot run
 * says so.
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

  // ONLY DECLARED ARGUMENTS, AS STRINGS.
  const picked = {};
  for (const a of tool.args ?? []) {
    const v = args?.[a.name];
    if (v !== undefined && v !== null && String(v) !== "") picked[a.name] = String(v);
  }

  // Spread first so a row can never override `benchRoot` or the validated `args`.
  return await handler({ ...tool.invoke, benchRoot, args: picked });
}
