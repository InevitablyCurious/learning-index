// DEV MODE — the control plane's own mode, which gates capabilities for
// iterating on the benchmark (first: seeding a cell from a build snapshot, which
// is never a scorable floor). Server state, never the browser's claim.
//
// Precedence: environment → state file → default OFF. A pinned environment makes
// the mode unsettable (`settable` is published and the write refuses, rather
// than changing a file the next read ignores). An unrecognised value reads OFF,
// with a reason that tells it apart from "not configured".

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

/** The variable the control plane reads at startup and on every resolve. */
export const DEV_MODE_ENV_VAR = "BENCH_DEV_MODE";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

/** Beside config/cloud.env: machine state, gitignored. */
export function devModeStateFile(benchRoot, env = process.env) {
  return env.BENCH_DEV_MODE_FILE || join(benchRoot, "config", "devmode.json");
}

async function readFileOrNull(path) {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Resolve dev mode, which source answered, and whether it can change. Never
 * throws; a bad source resolves OFF with a reason.
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
        // Pinned: the toggle refuses.
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
        // Still settable: writing repairs the broken file from the board.
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
    // Nothing wrong: a fresh checkout is OFF by design.
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

/** Set dev mode; returns the re-read state, not what it hoped it wrote. */
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
