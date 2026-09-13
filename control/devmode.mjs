// ─────────────────────────────────────────────────────────────────────────────
// DEV MODE — the control plane's own mode, and who is allowed to set it
//
// Dev mode gates capabilities that are useful while ITERATING ON THE BENCHMARK
// and wrong for measuring with it. The first is build-snapshot seeding: starting
// a cell from a previously built worktree instead of rebuilding the scaffolding.
// That saves hours per iteration and produces a cell that is NOT a scorable
// floor, so it must never be reachable by accident.
//
// ── WHY THE STATE LIVES HERE AND NOT IN THE BROWSER ─────────────────────────
//
// The board is a read-only container on :7717. The control plane is the host
// process that spawns the harness. A dev-mode flag held in the browser would
// mean this service takes the browser's word for what mode it is in — the same
// thing the confirmation-token design already refuses, for the same reason: the
// words the operator reads before a cell starts must be the words the server
// will act on, never a page's summary of them.
//
// So the mode is server state. The board renders what this module resolves, and
// a run that was a dev-mode run is one because THIS PROCESS was in dev mode.
//
// ── PRECEDENCE, AND WHY A PINNED ENV REFUSES THE TOGGLE ─────────────────────
//
// environment → state file → default OFF. An exported variable wins so CI and
// scripted runs can pin the mode without writing to disk.
//
// But a pinned environment makes the board's toggle a LIE: the POST would
// succeed, the file would change, and the next read would still answer with the
// environment. So `settable` is published alongside the value and the write
// REFUSES rather than performing a no-op an operator would have to discover by
// watching nothing happen.
//
// ── A MALFORMED SETTING IS OFF, AND SAYS SO ─────────────────────────────────
//
// `OKP_BENCH_DEV_MODE=enabled` is not a spelling this understands. It reads as
// OFF — the safe direction — but it never reads as "nobody configured anything".
// Absence and misconfiguration are different facts and the reason string keeps
// them apart, because a silently-ignored setting is how an operator concludes
// the feature is broken.
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

/** The variable the control plane reads at startup and on every resolve. */
export const DEV_MODE_ENV_VAR = "OKP_BENCH_DEV_MODE";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

/**
 * Where the toggled state is persisted.
 *
 * Beside `config/cloud.env`, which is the same class of thing: operator machine
 * state that must never be committed. Both are gitignored.
 */
export function devModeStateFile(benchRoot, env = process.env) {
  return env.OKP_BENCH_DEV_MODE_FILE || join(benchRoot, "config", "devmode.json");
}

async function readFileOrNull(path) {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Resolve dev mode, and say WHICH source answered and whether it can be changed.
 *
 * Never throws. An unreadable or malformed source resolves OFF with a reason —
 * the safe direction, stated rather than assumed.
 */
export async function resolveDevMode({ benchRoot, env = process.env } = {}) {
  const raw = env[DEV_MODE_ENV_VAR];
  if (typeof raw === "string" && raw.trim() !== "") {
    const value = raw.trim();
    const lower = value.toLowerCase();
    if (TRUTHY.has(lower) || FALSY.has(lower)) {
      const enabled = TRUTHY.has(lower);
      return {
        enabled,
        source: "environment",
        source_detail: `${DEV_MODE_ENV_VAR}=${value} is exported in the control plane's environment`,
        // PINNED. The toggle must refuse rather than write a file the next read
        // will ignore.
        settable: false,
        settable_reason:
          `${DEV_MODE_ENV_VAR} is exported, and an exported value wins over the ` +
          "stored one. Unset it in the control plane's environment and restart " +
          "to make this toggleable from the board.",
        reason: null,
      };
    }
    return {
      enabled: false,
      source: "environment_malformed",
      source_detail: `${DEV_MODE_ENV_VAR}=${value}`,
      settable: false,
      settable_reason:
        `${DEV_MODE_ENV_VAR} is exported but unreadable, so the stored value is ` +
        "not consulted. Fix or unset it, then restart the control plane.",
      reason:
        `${DEV_MODE_ENV_VAR} is set to "${value}", which is neither a yes ` +
        `(${[...TRUTHY].join(", ")}) nor a no (${[...FALSY].join(", ")}). ` +
        "Read as OFF. This is a misconfiguration, not an absent setting.",
    };
  }

  const path = devModeStateFile(benchRoot, env);
  const text = await readFileOrNull(path);
  if (text !== null) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.enabled === "boolean") {
        return {
          enabled: parsed.enabled,
          source: "state_file",
          source_detail: path,
          settable: true,
          settable_reason: null,
          reason: null,
        };
      }
      return {
        enabled: false,
        source: "state_file_malformed",
        source_detail: path,
        // STILL SETTABLE: writing repairs it, which is the useful behaviour. A
        // refusal here would leave the operator with a broken file and no
        // board-side way to fix it — the shell-shaped hole this whole surface
        // exists to close.
        settable: true,
        settable_reason: null,
        reason:
          `${path} parsed but carries no boolean \`enabled\` field. Read as OFF. ` +
          "Toggling from the board rewrites the file correctly.",
      };
    } catch {
      return {
        enabled: false,
        source: "state_file_malformed",
        source_detail: path,
        settable: true,
        settable_reason: null,
        reason: `${path} is not readable JSON. Read as OFF. Toggling from the board rewrites it.`,
      };
    }
  }

  return {
    enabled: false,
    source: "default",
    source_detail: null,
    settable: true,
    settable_reason: null,
    // NOT a reason — nothing is wrong. A fresh checkout is OFF and that is the
    // intended state, so this stays null and the board renders no warning.
    reason: null,
  };
}

/** The GET payload. One producer, so every surface answers identically. */
export async function readDevMode({ benchRoot, env = process.env } = {}) {
  return {
    ok: true,
    dev_mode: await resolveDevMode({ benchRoot, env }),
    state_file: devModeStateFile(benchRoot, env),
    env_var: DEV_MODE_ENV_VAR,
  };
}

/**
 * Set dev mode.
 *
 * Returns the RE-RESOLVED state, never what this function hoped it wrote — the
 * same discipline the routers panel follows, and the only version that cannot
 * report a success the next read disagrees with.
 */
export async function writeDevMode({ benchRoot, enabled, env = process.env } = {}) {
  if (typeof enabled !== "boolean") {
    return {
      ok: false,
      code: "enabled_not_boolean",
      reason: "`enabled` must be true or false — a mode has no third value to set it to",
    };
  }

  const current = await resolveDevMode({ benchRoot, env });
  if (!current.settable) {
    return {
      ok: false,
      code: "pinned_by_environment",
      reason: current.settable_reason,
      dev_mode: current,
    };
  }

  const path = devModeStateFile(benchRoot, env);
  try {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path,
      `${JSON.stringify({ enabled, updated_at: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (err) {
    return {
      ok: false,
      code: "write_failed",
      reason: `could not write ${path}: ${String(err?.message ?? err)}`,
      dev_mode: current,
    };
  }

  return { ok: true, dev_mode: await resolveDevMode({ benchRoot, env }), state_file: path };
}
