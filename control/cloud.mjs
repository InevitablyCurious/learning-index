// ─────────────────────────────────────────────────────────────────────────────
// CLOUD BASELINES — the models this bench can measure that are not resident
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// The harness has been able to run a cloud cell for as long as `--cloud` has
// existed (`scripts/run_cumulative.py`, `_compose_cloud_slug`): it composes the
// slug `{router}/{provider}/{model}`, checks it against the OrcaRouter provider
// block in `harness/config.py`, and routes the cell straight at the vendor
// instead of the local relay. THE CONTROL PLANE COULD NOT REACH ANY OF IT. The
// board's only launch path built a local invocation, so the bench could measure
// exactly one class of model and the operator's answer to "benchmark a frontier
// model against this corpus" was to leave the board and use the CLI.
//
// ── A MIRROR, AND THE MIRROR IS DELIBERATE ──────────────────────────────────
//
// The catalogue below is a copy of `CLOUD_ORCAROUTER_PROVIDER["models"]`. The
// control plane is JS and the registry is Python, so there is no shared import —
// the same standing condition that makes `roster.mjs` mirror the worker context
// registry rather than reading it. The copy is PINNED BY A DRIFT TEST
// (control.test.mjs) against config.py, so a model added on one side and not the
// other fails a test rather than presenting as "that model does not exist".
//
// ── THE KEY IS RESOLVED HERE AND NEVER LEAVES ───────────────────────────────
//
// A cloud cell needs ORCAROUTER_API_KEY. It is resolved SERVER-SIDE, from the
// same two places `harness/spend_key.py` reads — the environment, then the
// dotenv-format key file (`config/cloud.env`, mode 0600) — and it is NEVER sent
// to the browser and never accepted FROM the browser. What crosses the wire is
// `{present, source, fingerprint}`: enough for the board to state whether a
// cloud launch can succeed and where the key came from, and useless to anyone
// who intercepts it.
//
// A KEY FIELD IN THE MODAL WOULD BE THE OBVIOUS DESIGN AND IT IS THE WRONG ONE.
// It would put a live credential in page memory, in the POST body, and in
// whatever the browser decides to autofill — to configure something that is
// already configured on disk, on a service that runs on the same machine.
//
// ── MONEY IS NOT A DETAIL ───────────────────────────────────────────────────
//
// A local cell costs hours. A cloud cell costs hours AND money, and the ceiling
// is real: the proxy refuses a reservation above ABSOLUTE_MAX_USD per cell. That
// number is mirrored here so the confirmation card can state the ceiling the
// operator is committing to, in the same breath as the model name.
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import { ROUTERS, resolveRouterKey } from "./routers.mjs";
import { join } from "node:path";

/**
 * The router the composed slug names. `run_cumulative.py` defaults to this when
 * `--router` is absent, and the slug it builds is `{router}/{provider}/{model}`.
 * Mirrors config.DEFAULT_CLOUD_ROUTER.
 */
const DEFAULT_CLOUD_ROUTER = "orcarouter";

/** Mirrors spend_key.CLOUD_API_KEY_ENV. */
export const CLOUD_API_KEY_ENV = "ORCAROUTER_API_KEY";

/**
 * The per-cell spend ceiling, mirrored from
 * `harness/adapters/openrouter_proxy.py` ABSOLUTE_MAX_USD.
 *
 * STATED ON THE CONFIRMATION CARD rather than left in the proxy. An operator
 * committing to a cloud cell is committing to a bill, and the one number that
 * bounds it should not require reading the adapter to find.
 */
export const ABSOLUTE_MAX_USD = 12.0;

/**
 * THE CATALOGUE — mirror of config.CLOUD_ORCAROUTER_PROVIDER["models"].
 *
 * Keyed by the `{provider}/{model}` key the harness validates against, which is
 * exactly what `--provider` and `--model` are split from. Storing the key in the
 * shape the harness checks means the control plane cannot compose a slug the
 * harness will reject: the two agree by construction rather than by care.
 */
/**
 * ADVISORY, NOT A GATE. Below this window the board badges the model with its
 * actual context and a caveat; it never hides it.
 *
 * The benchmark measures an INFORMATION DELTA WITHIN one model — the same model
 * runs OFF then ON repeatedly, so it is its own control and its window cancels
 * out of its own delta. A narrow window does not bias the measurement. What it
 * risks is the cell hitting the provider's context ceiling mid-run, which is a
 * runnability caveat the operator weighs, not a decision the picker makes for them.
 */
export const CONTEXT_ADVISORY_FLOOR = 262144;

/**
 * THE CEILING BELOW WHICH CHUNK-BOUNDARY COMPACTION DEFAULTS ON.
 *
 * A model with less than this much room runs out of it during the six-chunk
 * build, and arrives at the repair phase unable to see which steps it has
 * already solved and why — the exact capability the troubleshooting phase
 * needs. Compaction spends the build narration (already committed to files) to
 * buy that room back.
 *
 * DELIBERATELY A SEPARATE NUMBER FROM `CONTEXT_ADVISORY_FLOOR`, which is a
 * different question wearing a similar shape: that one asks "will this cell hit
 * the provider ceiling and die", this one asks "will the build crowd out the
 * repair". Collapsing them into one constant would silently couple the
 * compaction default to the narrow-context badge, so that moving either number
 * for its own reasons would move the other for none.
 *
 * A DEFAULT, NOT A GATE. The operator sets the toggle; this only decides where
 * it starts. Applies to BOTH substrates — a 200k cloud model has the same
 * problem a 262k local one does, and the model does not care which side of the
 * relay it sits on.
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

/**
 * The catalogue as rows, provider first.
 *
 * The board's model picker filters by provider and by text, so it needs the
 * provider as its own field rather than a prefix to be re-split in the browser.
 * One split, here, and every consumer reads the same answer.
 */
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
      // Surfaced so the picker can badge it. `null` when the window is ample —
      // an absent note renders nothing, which is the common case.
      below_advisory_floor: m.context < CONTEXT_ADVISORY_FLOOR,
      context_note:
        m.context < CONTEXT_ADVISORY_FLOOR
          ? `${m.context.toLocaleString()} token context — below the ${CONTEXT_ADVISORY_FLOOR.toLocaleString()} the local bench aliases run at. ` +
            "The cell may hit the provider's context ceiling before the task completes. " +
            "OpenCode fires emergency compaction at 95% so the provider does not error out, " +
            "but compaction is not enabled by default here and a compacted run measures a different thing."
          : null,
      // The slug the manifest will record, composed the same way
      // `_compose_cloud_slug` composes it. Shown on the confirmation card so
      // the operator sees the identity that will be frozen, not a paraphrase.
      slug: `${DEFAULT_CLOUD_ROUTER}/${key}`,
    };
  });
}

/** The distinct providers, in catalogue order. The design's "4 providers". */
function cloudProviders() {
  return [...new Set(cloudCatalog().map((m) => m.provider))];
}

/**
 * Split a `{provider}/{model}` key. Returns `[null, null]` for anything that is
 * not exactly two segments — a key with three segments is a composed slug that
 * still carries its router, and treating it as a provider key would compose
 * `orcarouter/orcarouter/...` and fail at the harness with a confusing message.
 */
function splitCloudKey(key) {
  const parts = String(key ?? "").split("/").filter(Boolean);
  if (parts.length !== 2) return [null, null];
  return [parts[0], parts[1]];
}

/**
 * Is this a model the bench can route to the cloud, and if not, WHY not.
 *
 * Returns the same `{ok, code, reason}` shape every other gate in this service
 * returns, so a refusal here renders through the board's existing refusal path
 * rather than needing one of its own.
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
 * WHERE THE KEY COMES FROM, AND WHETHER IT IS THERE.
 *
 * The environment wins over the file, mirroring spend_key: a key exported into
 * the control plane's own environment is the one the spawned harness inherits,
 * so reporting the file's key while the harness would use the environment's
 * would be a report about a run that is not the one about to happen.
 *
 * NEVER RETURNS THE KEY. The fingerprint is returned instead — it identifies
 * WHICH key is in play (the useful question when two are configured) and
 * discloses nothing. This object is published to the browser.
 */
export async function readCloudKey({ benchRoot, env = process.env } = {}) {
  // ONE RESOLVER. This used to look only at the env var and config/cloud.env,
  // while the Routers panel looked in three places — so the board could report a
  // key present and this could still report a cloud cell unable to authenticate.
  // Two resolvers for one credential is how a greyed-out button outlives the
  // problem that caused it. The router registry is the single answer now.
  const router = ROUTERS.find((r) => r.id === DEFAULT_CLOUD_ROUTER) ?? ROUTERS[0];
  return resolveRouterKey(router, { benchRoot, env });
}

/**
 * The whole cloud capability, in one object.
 *
 * Assembled here rather than in the route so the launch gate and the board read
 * the SAME answer — a picker that offers a model the launch would refuse for
 * want of a key is the class of lie this codebase spends most of its comments
 * refusing to tell.
 */
export async function readCloud({ benchRoot, env = process.env } = {}) {
  const key = await readCloudKey({ benchRoot, env });
  return {
    ok: true,
    contract_version: CLOUD_CONTRACT_VERSION,
    router: DEFAULT_CLOUD_ROUTER,
    providers: cloudProviders(),
    models: cloudCatalog(),
    key,
    // The ceiling belongs beside the models, not in a footnote: it is the
    // number that bounds what a confirmation on this surface costs.
    spend_ceiling_usd: ABSOLUTE_MAX_USD,
    spend_note:
      `the proxy refuses any reservation above $${ABSOLUTE_MAX_USD.toFixed(2)} for a single cell. ` +
      "That is a hard ceiling on one cell, not a budget for the campaign.",
    // ONE PLACE SAYS WHETHER A CLOUD CELL CAN START AT ALL.
    can_start: key.present,
    can_start_reason: key.present ? null : key.reason,
  };
}

const CLOUD_CONTRACT_VERSION = 1;
