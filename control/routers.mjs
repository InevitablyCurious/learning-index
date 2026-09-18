// ROUTERS — cloud model routers and their credential state. OrcaRouter is the
// pinned default (a public checkout runs unconfigured), not a requirement; a
// router is a data row. The service reads, reports and writes its own keys, so a
// key can be set from the board. A key goes in and never comes out: the browser
// sees only whether one is present, where it came from, and a SHA-256 first-8
// fingerprint.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The registry. `env_var` is what the harness reads; `shared_config_key` is
 * where the wider Open Knowledge install may already hold the key.
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

/** One dotenv file holds every router's variable. */
function keyFilePath(benchRoot, env = process.env) {
  return env.BENCH_CLOUD_KEY_FILE || join(benchRoot, "config", "cloud.env");
}

/**
 * The shared install config. HOME comes from the passed env, so tests and
 * isolated runs never pick up a developer's own key.
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
 * Resolve a router's key and say which source answered: environment (CI can
 * inject), then the bench's own file (what this writes), then the shared config.
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
        // A malformed shared config just doesn't answer.
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
    // The one answer to whether a cloud cell can start.
    can_start_cloud: routers.some((r) => r.key.present),
  };
}

/**
 * Write a router's key: only its own line changes (other routers share the
 * file). File 0600, folder 0700.
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
    // The fingerprint, never the key.
    fingerprint: keyFingerprint(value),
  };
}
