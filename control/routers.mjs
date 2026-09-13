// ─────────────────────────────────────────────────────────────────────────────
// ROUTERS — the registry of cloud model routers, and their credential state
//
// The benchmark is substrate-neutral by intent: any provider, any memory system.
// OrcaRouter is the first router supported and the pinned default so a public
// checkout runs unconfigured, but it is a DEFAULT, NOT A REQUIREMENT. Adding a
// router is a row here, not a branch in a dispatcher — the same spec-as-data
// shape the tool registry uses.
//
// ── WHY THIS EXISTS AS A SURFACE AT ALL ─────────────────────────────────────
//
// Before this, a cloud cell could only authenticate if ORCAROUTER_API_KEY
// happened to be exported in the environment of whatever shell launched the
// control plane. The dashboard could not see that, could not change it, and
// rendered the consequence as a greyed-out button with no reason on it. The
// operator's only recourse was a terminal — which defeats the point of having a
// board at all.
//
// The service owns its own configuration now. It reads it, it reports it, and it
// can write it, so every capability the board depends on can be supplied FROM
// the board.
//
// ── WHAT NEVER CROSSES THIS BOUNDARY ────────────────────────────────────────
//
// A key goes IN and is never handed back out. The browser learns only whether a
// key is present and where it came from — never the value, never a prefix, never
// a masked form that could be lengthened by guessing. `key_fingerprint` is a
// SHA-256 first-8 so two keys can be told apart in a log without either being
// recoverable from it.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * THE REGISTRY.
 *
 * `env_var` is the name the harness reads at call time — it is the contract, and
 * the file below is only one way of populating it. `shared_config_key` is where
 * the wider Open Knowledge install may already hold the same credential, so an
 * operator who configured it once is not asked twice.
 */
export const ROUTERS = [
  {
    id: "orcarouter",
    label: "OrcaRouter",
    env_var: "ORCAROUTER_API_KEY",
    base_url: "https://api.orcarouter.ai/v1",
    shared_config_key: "orcarouter_api_key",
    default: true,
    note: "The pinned default. Every model in the catalogue is priced and routed through it.",
  },
];

/** Where a router's key file lives. One dotenv file holds every router's var. */
function keyFilePath(benchRoot, env = process.env) {
  return env.BENCH_CLOUD_KEY_FILE || join(benchRoot, "config", "cloud.env");
}

/**
 * Where the wider Open Knowledge install keeps operator config.
 *
 * HOME is read from the PASSED env, not from the process, so a caller handing in
 * an isolated environment gets an isolated path. Reaching past the caller to the
 * real home directory would make "no key configured" untestable and would let a
 * developer's own credential leak into a run that was supposed to have none.
 */
function sharedConfigPath(env = process.env) {
  if (env.OKP_DASHBOARD_CONFIG) return env.OKP_DASHBOARD_CONFIG;
  const home = env.HOME ?? (env === process.env ? homedir() : null);
  return home ? join(home, ".config", "okp", "dashboard.json") : null;
}

/** Minimal dotenv: `KEY=value`, `#` comments, optional surrounding quotes. */
function parseDotenv(text) {
  const out = {};
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** First 8 of SHA-256. Enough to tell two keys apart, never enough to recover one. */
function keyFingerprint(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex").slice(0, 8);
}

async function readFileOrNull(path) {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Resolve one router's key, in precedence order, and say WHICH source answered.
 *
 * Precedence is deliberate: an exported variable wins so CI can inject without
 * writing to disk; the bench's own file is next because it is what this surface
 * writes; the shared install config is last because it belongs to the wider
 * product and this bench is only borrowing it.
 */
export async function resolveRouterKey(router, { benchRoot, env = process.env } = {}) {
  const fromEnv = typeof env[router.env_var] === "string" ? env[router.env_var].trim() : "";
  if (fromEnv) {
    return {
      present: true,
      source: "environment",
      source_detail: `${router.env_var} is exported in the control plane's environment`,
      fingerprint: keyFingerprint(fromEnv),
      reason: null,
    };
  }

  const path = keyFilePath(benchRoot, env);
  const text = await readFileOrNull(path);
  if (text !== null) {
    const value = (parseDotenv(text)[router.env_var] ?? "").trim();
    if (value) {
      return {
        present: true,
        source: "key_file",
        source_detail: path,
        fingerprint: keyFingerprint(value),
        reason: null,
      };
    }
  }

  const sharedPath = router.shared_config_key ? sharedConfigPath(env) : null;
  if (sharedPath) {
    const sharedText = await readFileOrNull(sharedPath);
    if (sharedText !== null) {
      try {
        const value = String(JSON.parse(sharedText)[router.shared_config_key] ?? "").trim();
        if (value) {
          return {
            present: true,
            source: "shared_config",
            source_detail: `${sharedPath} (${router.shared_config_key})`,
            fingerprint: keyFingerprint(value),
            reason: null,
          };
        }
      } catch {
        // A malformed shared config is not this surface's problem to repair; it
        // simply does not answer, and the reason below names every place looked.
      }
    }
  }

  return {
    present: false,
    source: null,
    source_detail: null,
    fingerprint: null,
    reason:
      `NO API KEY SET for ${router.label}. Looked in: $${router.env_var} (not exported), ` +
      `${path} (absent or no ${router.env_var} line)` +
      (sharedPath ? `, and ${sharedPath}` : "") +
      ". Set it on the Routers panel — a cloud cell cannot authenticate without it.",
  };
}

/** Every router with its credential state. Never includes a key value. */
export async function readRouters({ benchRoot, env = process.env } = {}) {
  const routers = await Promise.all(
    ROUTERS.map(async (r) => ({
      id: r.id,
      label: r.label,
      env_var: r.env_var,
      base_url: r.base_url,
      default: Boolean(r.default),
      note: r.note ?? null,
      key: await resolveRouterKey(r, { benchRoot, env }),
    })),
  );
  return {
    ok: true,
    routers,
    key_file: keyFilePath(benchRoot, env),
    // ONE PLACE SAYS WHETHER A CLOUD CELL CAN START AT ALL, and it is the same
    // sentence the board renders on the disabled control.
    can_start_cloud: routers.some((r) => r.key.present),
  };
}

/**
 * Write a router's key to the bench key file.
 *
 * Rewrites only that router's line, preserving anything else in the file — the
 * file is shared by every router, and clobbering a sibling's credential to set
 * your own would be a silent, expensive surprise.
 *
 * The file is created 0600 and the directory 0700. A credential written
 * world-readable is worse than no credential, because it looks handled.
 */
export async function writeRouterKey({ benchRoot, routerId, key, env = process.env }) {
  const router = ROUTERS.find((r) => r.id === routerId);
  if (!router) {
    return { ok: false, code: "router_unknown", reason: `no router '${routerId}'. Known: ${ROUTERS.map((r) => r.id).join(", ")}` };
  }
  const value = String(key ?? "").trim();
  if (!value) {
    return { ok: false, code: "key_empty", reason: "an empty key is not a key — nothing was written" };
  }
  if (/[\n\r]/.test(value)) {
    return { ok: false, code: "key_malformed", reason: "a key cannot contain a newline; the paste probably included surrounding text" };
  }

  const path = keyFilePath(benchRoot, env);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const existing = (await readFileOrNull(path)) ?? "";
  const kept = existing
    .split("\n")
    .filter((line) => !line.trim().startsWith(`${router.env_var}=`))
    .join("\n")
    .trim();

  const header =
    "# Router credentials for the benchmark. Written by the Routers panel.\n" +
    "# One KEY=value per line. This file is 0600 and must never be committed.\n";
  const body = `${kept ? kept.replace(/^#.*\n?/gm, "").trim() + "\n" : ""}${router.env_var}=${value}\n`;
  await fs.writeFile(path, header + body, { mode: 0o600 });
  await fs.chmod(path, 0o600);

  return {
    ok: true,
    router: router.id,
    source_detail: path,
    // The fingerprint, never the key. Enough to confirm the write landed and to
    // tell it apart from a previous one in a log.
    fingerprint: keyFingerprint(value),
  };
}
