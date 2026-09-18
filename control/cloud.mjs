// CLOUD BASELINES — models the bench can measure that are not resident. The
// harness runs a cloud cell with --cloud (slug {router}/{provider}/{model},
// checked against the OrcaRouter block in harness/config.py); this lets the board
// launch one.
//
// The catalogue mirrors config.py (JS cannot import Python) and a drift test in
// control.test.mjs pins the two. The API key is resolved here from the
// environment or config/cloud.env and never sent to or accepted from the
// browser: only {present, source, fingerprint} crosses the wire. The per-cell
// spend ceiling is mirrored so the confirmation can state it.

import { promises as fs } from "node:fs";
import { ROUTERS, resolveRouterKey } from "./routers.mjs";
import { join } from "node:path";

/** The router the slug names (mirrors config.DEFAULT_CLOUD_ROUTER). */
const DEFAULT_CLOUD_ROUTER = "orcarouter";

/** Mirrors spend_key.CLOUD_API_KEY_ENV. */
export const CLOUD_API_KEY_ENV = "ORCAROUTER_API_KEY";

/**
 * The per-cell spend ceiling (mirrors openrouter_proxy.py), stated on the
 * confirmation card.
 */
export const ABSOLUTE_MAX_USD = 12.0;

/**
 * The catalogue (mirror of config.CLOUD_ORCAROUTER_PROVIDER["models"]), keyed
 * by the {provider}/{model} key the harness validates.
 */
/**
 * Advisory, not a gate: a narrower window is badged, never hidden. It cannot
 * bias a within-model delta; it risks hitting the provider's ceiling mid-run.
 */
export const CONTEXT_ADVISORY_FLOOR = 262144;

/**
 * Below this context window, chunk-boundary compaction defaults on (the build
 * would crowd out the repair phase). Separate from CONTEXT_ADVISORY_FLOOR, which
 * asks a different question. A default, not a gate; both substrates.
 */
export const COMPACT_DEFAULT_CEILING = 524288;

export const CLOUD_MODELS = {
  "anthropic/claude-fable-5": { name: "Claude Fable 5", context: 1000000, output: 128000 },
  "anthropic/claude-haiku-4.5": { name: "Claude Haiku 4.5", context: 200000, output: 64000 },
  "anthropic/claude-opus-4.5": { name: "Claude Opus 4.5", context: 200000, output: 64000 },
  "anthropic/claude-opus-4.6": { name: "Claude Opus 4.6", context: 1000000, output: 128000 },
  "anthropic/claude-opus-4.7": { name: "Claude Opus 4.7", context: 1000000, output: 128000 },
  "anthropic/claude-opus-4.8": { name: "Claude Opus 4.8", context: 1000000, output: 128000 },
  "anthropic/claude-opus-5": { name: "Claude Opus 5", context: 1000000, output: 128000 },
  "anthropic/claude-sonnet-4.6": { name: "Claude Sonnet 4.6", context: 1000000, output: 64000 },
  "anthropic/claude-sonnet-5": { name: "Claude Sonnet 5", context: 1000000, output: 128000 },
  "deepseek/deepseek-chat": { name: "DeepSeek V3", context: 1048576, output: 384000 },
  "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash", context: 1048576, output: 384000 },
  "deepseek/deepseek-v4-flash-0731": { name: "DeepSeek V4 Flash 0731", context: 1048576, output: 384000 },
  "deepseek/deepseek-v4-flash-vision-exp": { name: "DeepSeek V4 Flash Vision (Exp)", context: 1048576, output: 384000 },
  "deepseek/deepseek-v4-pro": { name: "DeepSeek V4 Pro", context: 1048576, output: 384000 },
  "deepseek/deepseek-v4-pro-0813": { name: "DeepSeek V4 Pro 0813", context: 1048576, output: 384000 },
  "google/gemini-2.5-flash": { name: "Gemini 2.5 Flash", context: 1048576, output: 65536 },
  "google/gemini-2.5-flash-lite": { name: "Gemini 2.5 Flash Lite", context: 1048576, output: 65536 },
  "google/gemini-2.5-pro": { name: "Gemini 2.5 Pro", context: 1048576, output: 65536 },
  "google/gemini-3-flash-preview": { name: "Gemini 3 Flash Preview", context: 1048576, output: 65536 },
  "google/gemini-3.1-flash-lite-preview": { name: "Gemini 3.1 Flash Lite Preview", context: 1048576, output: 65536 },
  "google/gemini-3.1-pro-preview": { name: "Gemini 3.1 Pro Preview", context: 1048576, output: 65536 },
  "google/gemini-3.1-pro-preview-customtools": { name: "Gemini 3.1 Pro Preview Custom Tools", context: 1048576, output: 65536 },
  "google/gemini-3.5-flash": { name: "Gemini 3.5 Flash", context: 1048576, output: 65536 },
  "google/gemini-3.5-flash-lite": { name: "Gemini 3.5 Flash-Lite", context: 1048576, output: 65536 },
  "google/gemini-3.6-flash": { name: "Gemini 3.6 Flash", context: 1048576, output: 65536 },
  "google/gemma-4-26b-a4b-it": { name: "Gemma 4 26B A4B ", context: 262144, output: 32768 },
  "grok/grok-4.3": { name: "Grok 4.3", context: 1000000, output: 65536 },
  "grok/grok-4.5": { name: "Grok 4.5", context: 500000, output: 62500 },
  "grok/grok-4.6": { name: "Grok 4.6", context: 500000, output: 62500 },
  "kimi/kimi-k2.5": { name: "Kimi k2.5", context: 262144, output: 32768 },
  "kimi/kimi-k2.6": { name: "Kimi k2.6", context: 262144, output: 32768 },
  "kimi/kimi-k2.7-code": { name: "Kimi K2.7 Code", context: 262144, output: 262144 },
  "kimi/kimi-k3": { name: "Kimi K3", context: 1048576, output: 65536 },
  "meta/muse-spark-1.1": { name: "Muse Spark 1.1", context: 1048576, output: 65536 },
  "meta/muse-spark-1.2": { name: "Muse Spark 1.2", context: 1048576, output: 65536 },
  "minimax/minimax-m3": { name: "MiniMax M3", context: 1048576, output: 512000 },
  "obsidian/Qwen3.6-35B-A3B": { name: "Qwen3.6 35B A3B Uncensored (Aggressive)", context: 262144, output: 32768 },
  "obsidian/Qwen3.8-27B": { name: "Qwen3.8 27B", context: 262144, output: 32768 },
  "obsidian/gemma-4-26B-A4B": { name: "Gemma4 26B A4B Uncensored (Balanced)", context: 262144, output: 32768 },
  "openai/gpt-3.5-turbo": { name: "GPT-3.5 Turbo", context: 16385, output: 4096 },
  "openai/gpt-3.5-turbo-16k": { name: "GPT-3.5 Turbo 16k", context: 16385, output: 4096 },
  "openai/gpt-4": { name: "GPT-4", context: 8191, output: 8192 },
  "openai/gpt-4-turbo": { name: "GPT-4 Turbo", context: 128000, output: 4096 },
  "openai/gpt-4-turbo-2024-04-09": { name: "GPT 4 Turbo (2024-04-09)", context: 128000, output: 4096 },
  "openai/gpt-4.1": { name: "GPT-4.1", context: 1047576, output: 32768 },
  "openai/gpt-4.1-2025-04-14": { name: "GPT 4.1 (2025-04-14)", context: 1047576, output: 32768 },
  "openai/gpt-4.1-mini": { name: "GPT-4.1 Mini", context: 1047576, output: 32768 },
  "openai/gpt-4.1-mini-2025-04-14": { name: "GPT 4.1 Mini (2025-04-14)", context: 1047576, output: 32768 },
  "openai/gpt-4.1-nano": { name: "GPT-4.1 Nano", context: 1047576, output: 32768 },
  "openai/gpt-4.1-nano-2025-04-14": { name: "GPT 4.1 Nano (2025-04-14)", context: 1047576, output: 32768 },
  "openai/gpt-4o": { name: "GPT-4o", context: 128000, output: 16384 },
  "openai/gpt-4o-2024-05-13": { name: "GPT-4o (2024-05-13)", context: 128000, output: 16384 },
  "openai/gpt-4o-2024-08-06": { name: "GPT-4o (2024-08-06)", context: 128000, output: 16384 },
  "openai/gpt-4o-2024-11-20": { name: "GPT-4o (2024-11-20)", context: 128000, output: 16384 },
  "openai/gpt-4o-mini": { name: "GPT-4o-mini", context: 128000, output: 16384 },
  "openai/gpt-4o-mini-2024-07-18": { name: "GPT-4o-mini (2024-07-18)", context: 128000, output: 16384 },
  "openai/gpt-5": { name: "GPT-5", context: 400000, output: 128000 },
  "openai/gpt-5-2025-08-07": { name: "GPT 5 (2025-08-07)", context: 400000, output: 128000 },
  "openai/gpt-5-mini": { name: "GPT-5 Mini", context: 400000, output: 128000 },
  "openai/gpt-5-mini-2025-08-07": { name: "GPT 5 Mini (2025-08-07)", context: 400000, output: 128000 },
  "openai/gpt-5-nano": { name: "GPT-5 Nano", context: 400000, output: 128000 },
  "openai/gpt-5-nano-2025-08-07": { name: "GPT 5 Nano (2025-08-07)", context: 400000, output: 128000 },
  "openai/gpt-5-pro": { name: "GPT-5 Pro", context: 400000, output: 272000 },
  "openai/gpt-5-pro-2025-10-06": { name: "GPT 5 Pro (2025-10-06)", context: 400000, output: 272000 },
  "openai/gpt-5.1": { name: "GPT-5.1", context: 400000, output: 128000 },
  "openai/gpt-5.1-2025-11-13": { name: "GPT 5.1 (2025-11-13)", context: 400000, output: 128000 },
  "openai/gpt-5.1-codex": { name: "GPT-5.1-Codex", context: 400000, output: 128000 },
  "openai/gpt-5.1-codex-mini": { name: "GPT-5.1-Codex-Mini", context: 400000, output: 128000 },
  "openai/gpt-5.2": { name: "GPT-5.2", context: 400000, output: 128000 },
  "openai/gpt-5.2-2025-12-11": { name: "GPT 5.2 (2025-12-11)", context: 400000, output: 128000 },
  "openai/gpt-5.2-codex": { name: "GPT-5.2-Codex", context: 400000, output: 128000 },
  "openai/gpt-5.2-pro": { name: "GPT-5.2 Pro", context: 400000, output: 128000 },
  "openai/gpt-5.2-pro-2025-12-11": { name: "GPT 5.2 Pro (2025-12-11)", context: 400000, output: 128000 },
  "openai/gpt-5.3-codex": { name: "GPT-5.3-Codex", context: 400000, output: 128000 },
  "openai/gpt-5.4": { name: "GPT-5.4", context: 1050000, output: 128000 },
  "openai/gpt-5.4-2026-03-05": { name: "GPT 5.4 (2026-03-05)", context: 1050000, output: 128000 },
  "openai/gpt-5.4-mini": { name: "GPT-5.4 Mini", context: 400000, output: 128000 },
  "openai/gpt-5.4-nano": { name: "GPT-5.4 Nano", context: 400000, output: 128000 },
  "openai/gpt-5.4-pro": { name: "GPT-5.4 Pro", context: 1050000, output: 128000 },
  "openai/gpt-5.4-pro-2026-03-05": { name: "GPT 5.4 Pro (2026-03-05)", context: 1050000, output: 128000 },
  "openai/gpt-5.6-luna": { name: "GPT-5.6 Luna", context: 1050000, output: 128000 },
  "openai/gpt-5.6-sol": { name: "GPT-5.6 Sol", context: 1050000, output: 128000 },
  "openai/gpt-5.6-terra": { name: "GPT-5.6 Terra", context: 1050000, output: 128000 },
  "openai/gpt-oss-120b": { name: "gpt-oss-120b", context: 131072, output: 16384 },
  "qwen/qwen3-max": { name: "Qwen3 Max", context: 262144, output: 65536 },
  "qwen/qwen3-max-preview": { name: "qwen3 Max Preview", context: 262144, output: 65536 },
  "qwen/qwen3-vl-235b-a22b-thinking": { name: "Qwen3 VL 235B A22B Thinking", context: 131072, output: 40960 },
  "qwen/qwen3-vl-8b-instruct": { name: "Qwen3 VL 8B Instruct", context: 131072, output: 32768 },
  "qwen/qwen3-vl-8b-thinking": { name: "Qwen3 VL 8B Thinking", context: 131072, output: 40960 },
  "qwen/qwen3.5-122b-a10b": { name: "Qwen3.5-122B-A10B", context: 32768, output: 65536 },
  "qwen/qwen3.5-27b": { name: "Qwen3.5-27B", context: 32768, output: 65536 },
  "qwen/qwen3.5-35b-a3b": { name: "Qwen3.5-35B-A3B", context: 32768, output: 65536 },
  "qwen/qwen3.5-397b-a17b": { name: "Qwen3.5 397B A17B", context: 32768, output: 65536 },
  "qwen/qwen3.5-flash": { name: "qwen3.5 Flash", context: 1048576, output: 65536 },
  "qwen/qwen3.5-flash-2026-02-23": { name: "qwen3.5 Flash (2026-02-23)", context: 1048576, output: 65536 },
  "qwen/qwen3.5-plus": { name: "qwen3.5 Plus", context: 1048576, output: 65536 },
  "qwen/qwen3.5-plus-2026-02-15": { name: "qwen3.5 Plus (2026-02-15)", context: 1048576, output: 65536 },
  "qwen/qwen3.6-35b-a3b": { name: "Qwen3.6 35B A3B", context: 262144, output: 65536 },
  "qwen/qwen3.6-flash": { name: "Qwen3.6 Flash", context: 1048576, output: 65536 },
  "qwen/qwen3.6-flash-2026-04-16": { name: "qwen3.6 Flash (2026-04-16)", context: 1048576, output: 65536 },
  "qwen/qwen3.6-plus": { name: "Qwen3.6 Plus", context: 1048576, output: 65536 },
  "qwen/qwen3.6-plus-2026-04-02": { name: "qwen3.6 Plus (2026-04-02)", context: 1048576, output: 65536 },
  "qwen/qwen3.7-flash": { name: "Qwen3.7 Flash", context: 1000000, output: 65536 },
  "qwen/qwen3.7-plus": { name: "Qwen3.7 Plus", context: 1000000, output: 65536 },
  "qwen/qwen3.8-27b": { name: "Qwen3.8 27B", context: 262144, output: 32768 },
  "qwen/qwen3.8-flash": { name: "Qwen3.8 Flash", context: 1000000, output: 131072 },
  "qwen/qwen3.8-max": { name: "Qwen3.8 Max", context: 1000000, output: 65536 },
  "tencent/hy3": { name: "Hy3", context: 262144, output: 32768 },
  "z-ai/glm-4.5": { name: "GLM 4.5", context: 128000, output: 96000 },
  "z-ai/glm-4.5-air": { name: "GLM 4.5 Air", context: 128000, output: 96000 },
  "z-ai/glm-4.6": { name: "GLM 4.6", context: 200000, output: 128000 },
  "z-ai/glm-4.7": { name: "GLM 4.7", context: 200000, output: 128000 },
  "z-ai/glm-5": { name: "GLM 5", context: 200000, output: 128000 },
  "z-ai/glm-5.1": { name: "GLM 5.1", context: 200000, output: 128000 },
  "z-ai/glm-5.2": { name: "GLM 5.2", context: 1000000, output: 128000 },
  "z-ai/glm-5.3": { name: "GLM 5.3", context: 1000000, output: 128000 },
  "z-ai/glm-5.3-flash": { name: "GLM 5.3 Flash", context: 1000000, output: 128000 },
};

/** The catalogue as rows, with the provider as its own field. */
export function cloudCatalog() {
  return Object.entries(CLOUD_MODELS).map(([key, m]) => {
    const [provider, model] = splitCloudKey(key);
    return {
      key,
      provider,
      model,
      name: m.name,
      context: m.context,
      output: m.output,
      // For the picker's badge.
      below_advisory_floor: m.context < CONTEXT_ADVISORY_FLOOR,
      context_note:
        m.context < CONTEXT_ADVISORY_FLOOR
          ? `${m.context.toLocaleString()} token context — below the ${CONTEXT_ADVISORY_FLOOR.toLocaleString()} the local bench aliases run at. ` +
            "The cell may hit the provider's context ceiling before the task completes. " +
            "OpenCode fires emergency compaction at 95% so the provider does not error out, " +
            "but compaction is not enabled by default here and a compacted run measures a different thing."
          : null,
      // The slug the manifest will record, shown on the confirmation card.
      slug: `${DEFAULT_CLOUD_ROUTER}/${key}`,
    };
  });
}

/** The distinct providers, in catalogue order. The design's "4 providers". */
function cloudProviders() {
  return [...new Set(cloudCatalog().map((m) => m.provider))];
}

/**
 * Split a {provider}/{model} key; anything but two segments is [null, null]
 * (a three-segment slug still carries its router).
 */
function splitCloudKey(key) {
  const parts = String(key ?? "").split("/").filter(Boolean);
  if (parts.length !== 2) return [null, null];
  return [parts[0], parts[1]];
}

/**
 * Can the bench route this model to the cloud, and if not, why — in the
 * standard {ok, code, reason} refusal shape.
 */
export function resolveCloudModel(key) {
  const k = String(key ?? "").trim();
  if (!k) {
    return { ok: false, code: "cloud_model_missing", reason: "no cloud model was named" };
  }
  const [provider, model] = splitCloudKey(k);
  if (!provider || !model) {
    return {
      ok: false,
      code: "cloud_model_malformed",
      reason:
        `'${k}' is not a {provider}/{model} key. The harness validates the composed slug against ` +
        "the OrcaRouter provider block, and a key of any other shape cannot be composed.",
    };
  }
  const entry = CLOUD_MODELS[k];
  if (!entry) {
    return {
      ok: false,
      code: "cloud_model_unknown",
      reason:
        `'${k}' is not in the OrcaRouter provider block. available: ${Object.keys(CLOUD_MODELS).sort().join(", ")}`,
    };
  }
  return {
    ok: true,
    key: k,
    provider,
    model,
    name: entry.name,
    context: entry.context,
    output: entry.output,
    slug: `${DEFAULT_CLOUD_ROUTER}/${k}`,
  };
}

/**
 * Where the key comes from, and whether it is there: environment first (what
 * the spawned harness inherits), then the file. Never returns the key, only its
 * fingerprint.
 */
export async function readCloudKey({ benchRoot, env = process.env } = {}) {
  // One resolver: the router registry (shared with the Routers panel).
  const router = ROUTERS.find((r) => r.id === DEFAULT_CLOUD_ROUTER) ?? ROUTERS[0];
  return resolveRouterKey(router, { benchRoot, env });
}

/** The whole cloud capability, shared by the launch gate and the board. */
export async function readCloud({ benchRoot, env = process.env } = {}) {
  const key = await readCloudKey({ benchRoot, env });
  return {
    ok: true,
    contract_version: CLOUD_CONTRACT_VERSION,
    router: DEFAULT_CLOUD_ROUTER,
    providers: cloudProviders(),
    models: cloudCatalog(),
    key,
    // The ceiling travels with the models.
    spend_ceiling_usd: ABSOLUTE_MAX_USD,
    spend_note:
      `the proxy refuses any reservation above $${ABSOLUTE_MAX_USD.toFixed(2)} for a single cell. ` +
      "That is a hard ceiling on one cell, not a budget for the campaign.",
    // The one answer to whether a cloud cell can start.
    can_start: key.present,
    can_start_reason: key.present ? null : key.reason,
  };
}

const CLOUD_CONTRACT_VERSION = 1;
