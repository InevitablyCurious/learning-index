// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM TOOLS — the registry, and the one way a tool is invoked
//
// The benchmark is meant to be pointed at any memory system, and a "custom tool"
// is the unit of that adaptation. The shape here is the one the pluggable-
// substrates work landed on:
//
//   · SPEC-AS-DATA   a tool declares itself as a row, not as a branch in the
//                    dispatcher. Adding one is data.
//   · LAZY RESOLVE   the handler is looked up by name at call time.
//   · FAIL LOUD      an unknown or misconfigured tool ERRORS. It never returns a
//                    cheerful no-op, because a tool that silently does nothing is
//                    indistinguishable from one that worked.
//   · HONEST ABSENCE if a precondition is missing, the reason is named. Nothing
//                    is fabricated on the tool's behalf.
//
// ── WHY THE REGISTRY LIVES HERE AND NOT IN THE BOARD ────────────────────────
//
// The harness is what knows which tools are actually registered. A UI holding
// its own copy is a second source of truth that will eventually claim a tool is
// available when it is not — the exact failure this surface exists to prevent.
// The board renders whatever this file serves.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Where the reference implementation's admin CLI and bench identity live. */
function benchIdentityPaths(benchRoot) {
  const home = process.env.OKP_HOME ?? join(homedir(), ".okp", "bench");
  return {
    // The MCP moved into the client repo when the repos were consolidated;
    // `../okp-mcp` has not existed since, which left this tool permanently
    // "blocked" for a reason that read like a missing build rather than a stale
    // path. Matches dev/Makefile's MCP_DIR.
    mcpDir: process.env.OKP_MCP_DIR ?? resolve(benchRoot, "..", "client", "packages", "core"),
    home,
    // MATCHES bench-mcp.sh EXACTLY. A different keystore path here would sign
    // with a different identity than the one the bench MCP actually serves, and
    // the org would admit a key nothing holds.
    keystore: process.env.OKP_KEYSTORE_PATH ?? join(homedir(), ".okp", "bench", "leader-keystore"),
  };
}

/**
 * THE REGISTRY.
 *
 * `invoke.kind` names a handler below. `args` are declared, not hardcoded into a
 * command string — the UI renders them and the handler passes them as an ARGV
 * ARRAY, so an org id can never become shell syntax.
 */
export function toolRegistry(benchRoot) {
  return [...builtinTools(benchRoot), ...externalTools(benchRoot)];
}

function builtinTools(benchRoot) {
  const { mcpDir, keystore } = benchIdentityPaths(benchRoot);

  return [
    {
      id: "request-join",
      name: "Join org",
      blurb:
        "Press once, to ask a memory system's org to admit this bench so it can recall from it. " +
        "Nothing recalls until the org's leader accepts, by hand, on their own dashboard.",
      // THE TOOL'S OWN OUTCOME LINE, declared here rather than branched on in
      // the board. It used to be hardcoded in the drawer, so EVERY tool that
      // succeeded reported "Sent, NOT accepted — the leader still has to accept
      // it": a docker build that worked said it was waiting on a human.
      success_note:
        "Sent, NOT accepted — the org's leader still has to accept it on their dashboard.",
      seams: [
        "the bench signs a join request with its own identity and posts it to the hub",
        "the hub stores it; the leader's dashboard lists it",
        "the leader accepts — that is a human, wallet-signed act",
        "the recall path then checks membership",
      ],
      args: [
        {
          name: "org",
          label: "org id",
          required: true,
          default: process.env.OKP_BENCH_ORG ?? "okp-org-0",
          help: "the org to ask for admission",
        },
      ],
      invoke: { kind: "mcp-admin", command: "request-join" },
      // PRECONDITIONS ARE CHECKED, NOT ASSUMED. Each one that fails becomes the
      // tool's stated reason for being unavailable, so an operator is never left
      // guessing why a button is dead.
      preconditions: [
        {
          ok: existsSync(join(mcpDir, "dist", "admin.js")),
          reason: `the reference MCP is not built — ${join(mcpDir, "dist", "admin.js")} is missing (npm run build in client/packages/core)`,
        },
        {
          ok: existsSync(keystore),
          reason: `the bench has no identity — ${keystore} is missing (bench-mcp.sh start commissions it)`,
        },
      ],
    },

    // ── OPERATIONS ────────────────────────────────────────────────────────
    //
    // This used to require a terminal, which meant a capability the board
    // depended on could only be repaired somewhere the board could not see. An
    // operator sent to a shell for one thing ends up doing everything there.
    //
    // It REFUSES while a cell is in flight. That is not caution for its own
    // sake: rebuilding the worker image underneath a running cell changes the
    // substrate mid-measurement, which produces a result that looks valid and is
    // not. Stop the cell first — the board can do that now too.
    //
    // ONLY THE ONES A BARE CLONE CAN RUN LIVE HERE. `bench-mcp-restart` used to,
    // and it drove ../dev/scripts/bench-mcp.sh — so a clone of bench/ alone
    // rendered a permanently blocked row advertising a repo it does not have,
    // which is exactly what the seam below exists to prevent. It moved to
    // dev/bench-tools.json.
    {
      id: "worker-image-rebuild",
      name: "Rebuild worker",
      blurb:
        "Press when preflight says the worker image is stale, and after any edit under " +
        "images/worker. The agent plugin is baked into the image at build time, so until you " +
        "rebuild, every cell runs the old plugin without saying so.",
      seams: [
        "computes a digest of everything images/worker bakes in",
        "docker build -t okp-bench-worker:v1 images/worker, with that digest as a label",
        "preflight reads the label back and compares it to the source — a content check, not a timestamp",
      ],
      args: [],
      refuse_while_running: true,
      // NOT A BARE `docker build`. The build has to record what it was built
      // FROM, or freshness has nothing to compare: docker is content-addressed,
      // so a content-identical rebuild is a cache hit that keeps the old image's
      // creation time, and the mtime check this replaced stayed red through
      // every successful rebuild.
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

// ── THE EXTENSION SEAM ───────────────────────────────────────────────────────
//
// WHY IT EXISTS. Some tools serve the ITERATE-ON-THE-BENCH loop rather than the
// run-the-benchmark job — rebuilding images, restarting the control plane after
// an edit. Those are a contributor's concern, not a user's, and declaring them
// here would put dev orchestration into the repo people clone to measure their
// own memory system: a tool permanently "blocked because ../dev is missing" is
// worse than no tool, because it advertises something the clone cannot do.
//
// So the bench ships NONE of them and does not know they exist. An external
// manifest names them, and `OKP_BENCH_TOOLS_MANIFEST` points at it. Unset — the
// default, and what a fresh clone gets — this contributes nothing at all.
//
// TWO LIMITS, BOTH DELIBERATE:
//
//   · SCRIPT HANDLER ONLY. An external tool cannot select `mcp-admin`, which
//     runs as the BENCH IDENTITY against the leader keystore. Identity-bearing
//     handlers stay in this file where they can be reviewed; a manifest gets the
//     generic runner and nothing else.
//   · BUILT-INS WIN A COLLISION. A manifest cannot redefine `worker-image-rebuild`
//     to mean something else, and the attempt is reported rather than ignored.
//
// This is NOT a privilege boundary. The manifest names a command the control
// plane will execute, and the control plane already spawns docker builds — the
// trust level is the operator's own machine either way. The limits above keep
// the manifest from reaching machinery it has no business in, not from being
// trusted at all.
function externalToolsManifestPath() {
  return (process.env.OKP_BENCH_TOOLS_MANIFEST ?? "").trim();
}

/**
 * Tools contributed by an external manifest, or `[]`.
 *
 * A BROKEN MANIFEST IS REPORTED, NEVER SKIPPED. If the path is set and the file
 * is missing or malformed, this returns a single BLOCKED tool row carrying the
 * reason — the operator sees why their tool is absent, on the surface they went
 * looking for it. Returning `[]` would make a typo in the path indistinguishable
 * from a manifest that legitimately declares nothing.
 */
function externalTools(benchRoot) {
  const manifestPath = externalToolsManifestPath();
  if (!manifestPath) return [];

  const fail = (reason) => [
    {
      id: "external-tools",
      name: "external tool manifest",
      blurb: `Tools declared outside the bench repo, via OKP_BENCH_TOOLS_MANIFEST.`,
      seams: [`manifest: ${manifestPath}`],
      args: [],
      refuse_while_running: true,
      invoke: { kind: "script", command: "/usr/bin/false", argv: [] },
      preconditions: [{ ok: false, reason }],
    },
  ];

  let raw;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return fail(`cannot read ${manifestPath}: ${err?.message ?? err}`);
  }
  const declared = Array.isArray(raw?.tools) ? raw.tools : null;
  if (!declared) return fail(`${manifestPath} has no "tools" array`);

  const builtinIds = new Set(builtinTools(benchRoot).map((t) => t.id));
  const manifestDir = dirname(resolve(manifestPath));
  const out = [];

  for (const entry of declared) {
    const id = String(entry?.id ?? "").trim();
    if (!id) continue;
    if (builtinIds.has(id)) {
      out.push({
        id: `${id}-external`,
        name: String(entry?.name ?? id),
        blurb: String(entry?.blurb ?? ""),
        seams: [],
        args: [],
        refuse_while_running: true,
        invoke: { kind: "script", command: "/usr/bin/false", argv: [] },
        preconditions: [
          {
            ok: false,
            reason: `the manifest declares "${id}", which is a built-in tool — built-ins win, so this row does nothing. Rename it in ${manifestPath}.`,
          },
        ],
      });
      continue;
    }

    // Relative commands resolve against the MANIFEST's directory, not the
    // bench root: a dev manifest names its own scripts, and the two repos sit
    // side by side rather than one inside the other.
    const rawCommand = String(entry?.command ?? "").trim();
    const command = rawCommand.startsWith("/")
      ? rawCommand
      : resolve(manifestDir, rawCommand);

    const preconditions = [
      {
        ok: Boolean(rawCommand) && existsSync(command),
        reason: rawCommand
          ? `the command is missing — ${command}`
          : `the manifest entry "${id}" declares no command`,
      },
      ...(Array.isArray(entry?.requires_files) ? entry.requires_files : []).map(
        (r) => {
          const target = String(r?.path ?? "");
          const abs = target.startsWith("/") ? target : resolve(manifestDir, target);
          return {
            ok: Boolean(target) && existsSync(abs),
            reason: String(r?.reason ?? `a required file is missing — ${abs}`),
          };
        },
      ),
    ];

    out.push({
      id,
      name: String(entry?.name ?? id),
      blurb: String(entry?.blurb ?? ""),
      seams: Array.isArray(entry?.seams) ? entry.seams.map(String) : [],
      args: [],
      refuse_while_running: entry?.refuse_while_running !== false,
      invoke: {
        // FORCED. See the note above — a manifest never reaches `mcp-admin`.
        kind: "script",
        command,
        argv: Array.isArray(entry?.argv) ? entry.argv.map(String) : [],
        timeoutMs: Number.isFinite(entry?.timeout_ms)
          ? Number(entry.timeout_ms)
          : 900000,
      },
      preconditions,
      external: true,
    });
  }
  return out;
}

/** The interpreter the control plane already uses for the bench's own scripts. */
function controlPython(benchRoot) {
  return process.env.OKP_CONTROL_PYTHON ?? join(benchRoot, ".venv", "bin", "python");
}

/** The registry as the board consumes it: status resolved, no secrets. */
export function describeTools(benchRoot) {
  return toolRegistry(benchRoot).map((t) => {
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
      // WHOSE TOOL THIS IS. A contributed tool is not part of the benchmark
      // anyone else clones, and an operator comparing notes with another
      // installation needs to know which rows are local additions.
      external: t.external === true,
      // Named rather than summarised — "blocked" with no reason is the same as
      // no information.
      blocked_reason: failed.length ? failed.map((p) => p.reason).join("; ") : null,
    };
  });
}

/**
 * Resolve each preflight check's remedy TOOL ID into the button that repairs it.
 *
 * WHY THE SPLIT. Preflight names the remedy by id and stops there, because this
 * side is the one that knows the registry: a tool's display name lives in this
 * file (or the dev manifest), and whether it exists at all depends on the
 * installation — `bench-ready` and `bench-mcp-restart` are dev-contributed and
 * absent from a bare clone of bench/. A board holding its own id->name table
 * would be the second source of truth this file's header refuses.
 *
 * AN UNRESOLVED ID BECOMES `null`, NOT A BUTTON. Every preflight detail already
 * names its own fix in words, so a failure whose tool is not installed still
 * tells the operator what to do — it just does not offer a control that would
 * refuse the moment it was pressed.
 *
 * Mutates the checks in place and returns them: the payload is passed straight
 * through from the script, and rebuilding it here would be one more place for
 * the two shapes to drift.
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
          // Carried through so the board can say "press Rebuild worker —
          // blocked: no docker" instead of rendering a button that will refuse
          // the moment it is pressed.
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
 * Run the reference MCP's admin CLI AS THE BENCH.
 *
 * The environment is byte-for-byte the one bench-mcp.sh commissions with:
 * `OKP_SEED_BACKEND=file` keeps it headless (no Touch ID prompt on a machine
 * nobody is watching), and OKP_HOME/OKP_KEYSTORE_PATH scope it to the
 * bench's own seed. Getting this wrong does not fail — it succeeds AS THE
 * OPERATOR'S PERSONAL IDENTITY, which is the pre-pivot conflation the bench
 * identity split exists to make impossible.
 */
async function runMcpAdmin({ benchRoot, command, args, timeoutMs = 30000 }) {
  const { mcpDir, home, keystore } = benchIdentityPaths(benchRoot);
  const script = join(mcpDir, "dist", "admin.js");

  // ARGV ARRAY, NO SHELL — an org id is data, never syntax.
  const argv = [script, command];
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    argv.push(`--${k}`, String(v));
  }
  argv.push("--json", "true");

  return await new Promise((resolveP) => {
    const child = spawn(process.execPath, argv, {
      cwd: mcpDir,
      env: {
        ...process.env,
        OKP_SEED_BACKEND: "file",
        OKP_HOME: home,
        OKP_KEYSTORE_PATH: keystore,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      resolveP({ ok: false, code: "timeout", reason: `${command} did not finish within ${timeoutMs}ms`, stdout: out, stderr: err });
    }, timeoutMs);

    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveP({ ok: false, code: "spawn_failed", reason: String(e?.message ?? e), stdout: out, stderr: err });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        // THE CLI's OWN WORDS. Rewriting them hides which layer refused — the
        // same rule cmdRequestJoin follows when the hub refuses it.
        resolveP({
          ok: false,
          code: "tool_failed",
          reason: (err.trim() || out.trim() || `exited ${code}`).slice(0, 1200),
          stdout: out,
          stderr: err,
        });
        return;
      }
      // TWO QUESTIONS, TWO ANSWERS. `ok` says whether the tool RAN — exit 0
      // means the CLI did its work, and polluted or empty stdout does not undo
      // that, so this never flips to ok:false. What it must not do is report a
      // clean structured result it does not have: without the parse there is no
      // request_id and no status, and a card drawn green over garbage is the
      // silent-degradation class this file's FAIL LOUD doctrine forbids.
      let parsed = null;
      let parseError = null;
      try {
        parsed = JSON.parse(out);
      } catch (err) {
        parsed = null;
        parseError = String(err?.message ?? err);
      }
      resolveP(
        parseError === null
          ? { ok: true, result: parsed, stdout: out.slice(0, 4000) }
          : {
              ok: true,
              code: "ok_unparsed_output",
              reason: `the tool exited 0 but its output is not JSON, so no structured result was recovered: ${parseError}`,
              result: null,
              stdout: out.slice(0, 4000),
            },
      );
    });
  });
}

/**
 * Run a declared command as an ARGV ARRAY — never a shell string.
 *
 * The command and its arguments come from the registry row, not from the
 * request, so a caller cannot compose one. What the request may supply is
 * nothing at all: these tools take no arguments by design.
 *
 * Output is returned verbatim on success and failure alike. Rewriting it would
 * hide which layer refused, which is the first thing anyone debugging needs.
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

const HANDLERS = { "mcp-admin": runMcpAdmin, script: runScript };

/**
 * Invoke a tool by id.
 *
 * FAIL LOUD AT EVERY STEP: unknown id, unknown handler kind, missing required
 * arg, failed precondition. None of these return ok — a tool that cannot run
 * says so.
 */
export async function invokeTool(benchRoot, id, args = {}) {
  const tool = toolRegistry(benchRoot).find((t) => t.id === String(id));
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
    // A registry row naming a handler that does not exist is a CONFIGURATION
    // BUG, and it surfaces as one rather than as a tool that quietly does
    // nothing.
    return {
      ok: false,
      code: "unknown_handler",
      reason: `tool ${tool.id} declares handler ${JSON.stringify(String(tool.invoke?.kind))}, which is not registered`,
    };
  }

  const picked = {};
  for (const a of tool.args ?? []) {
    const v = args?.[a.name];
    if (v !== undefined && v !== null && String(v) !== "") picked[a.name] = String(v);
  }

  // THE WHOLE INVOKE ROW IS FORWARDED. Passing only `command` silently dropped
  // every other declared field — a row could specify `argv` and `timeoutMs` and
  // the handler would never see them, which is a registry that lies about what
  // it supports. Spread first so a row can never override `benchRoot` or the
  // validated `args`.
  return await handler({ ...tool.invoke, benchRoot, args: picked });
}
