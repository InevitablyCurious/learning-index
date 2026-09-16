"""Pure roster and catalogue data for the Okp benchmark harness.

These blocks were split out of harness/config.py so the large data literals
live apart from the run-configuration code. Every name here is re-exported by
harness/config.py through a PEP 562 module-level __getattr__, so the public
import surface (`from harness.config import X`, `config.X`) is unchanged.

Import direction: this module imports the dataclasses it needs from
harness.config at top level; harness.config never imports this module at top
level (only lazily, inside __getattr__ and the roster accessor functions).
That one-way top-level dependency is what keeps the split free of a circular
import under either import order.
"""

from __future__ import annotations

from harness.config import BenchmarkWave, BenchmarkSchedule, LadderRung


# ---------------------------------------------------------------------------
# Default schedule: current canon roster (UNKNOWN/UNORDERED)
# ---------------------------------------------------------------------------

# Canonical benchmark schedule — current roster with UNKNOWN/UNORDERED tiers
# (D-BENCH-CONTRACT-2026-07 §10, DECISIONS §22.10).
# Prior step-down/distillation framing and superseded rosters (D-BENCH-CONTRACT-2026-07)
# are HISTORY, not current benchmark truth.
#
# Roster:
#   kimi/kimi-k3   (tier UNKNOWN)
#   kimi/kimi-k2.7-code  (tier UNKNOWN)
#   tencent/hy3    (tier UNKNOWN)
#
# OrcaRouter routes upstreams internally; provider pins are void on this substrate.
#
# Tiers remain UNKNOWN/UNORDERED until registry evidence (D-BENCH-CONTRACT-2026-07 §10).
# Prior scored roster (opus-4.8 / moonshotai/kimi-k2.7-code / opencode/big-pickle)
# → history.
_DEFAULT_SCHEDULE: BenchmarkSchedule = BenchmarkSchedule(
    waves=(
        BenchmarkWave(
            wave_id="baseline",
            models=(
                "kimi/kimi-k3",
                "kimi/kimi-k2.7-code",
                "tencent/hy3",
            ),
            tier="UNKNOWN",
            memory_modes=("off", "on"),
        ),
    ),
    schema_version=1,
)


# Scored-ladder roster — the single source of truth for the ordered rungs.
# CURRENT (2026-08-03, D4): SINGLE SUBJECT. The bench never selects a model —
# it tests whatever is loaded and learns which via API-response observation
# (identity handled separately by the observed-extraction invariant; see D2).
# There is ONE subject = whichever model is resident behind the Local LLM Proxy
# (:4545) at run time, with two self-lift arms off/on. The
# `local-llm-proxy/okp-bench-worker` slug is a neutral marker for "whatever
# is loaded" — the worker→proxy opencode provider selector (already the
# default) — NOT a specific model identity.
#
# ── RETIRED (2026-08-14), AND THE RUNG IS DELIBERATELY STILL HERE ────────────
#
# The auto-resident design above is RETIRED. Every cell now names its subject
# (`--model <bench alias>`), which is required — see `_apply_model_override` in
# scripts/run_cumulative.py. The rung below can no longer be RESOLVED: there is
# no code path that turns it into a roster entry.
#
# IT IS NOT DELETED, AND THAT IS NOT AN OVERSIGHT.
# `ladder_roster_fingerprint()` hashes this tuple, and the hash is
# frozen into every campaign manifest. `CumulativeSequencer.__init__` re-computes
# it on EVERY launch (not only on `resume`) and refuses on drift. Editing this
# tuple therefore invalidates runs/cumulative — the live campaign and the OFF
# baseline inside it — and the only remedy is archive-and-rerun at ~3h a cell.
# Note that the fingerprint covers THIS DEFAULT, not the roster that actually
# ran (the resolved model is recorded separately, in the manifest's `roster` and
# `roster_hash`), which is exactly why a rung nothing can reach still has teeth.
#
# So it stays until a natural archive point, when the campaign is being rebuilt
# anyway. Deleting it then costs nothing; deleting it now costs a re-baseline.
#
# SUPERSEDED history: paid OrcaRouter era 2026-07-24 (kimi-k3 source /
# kimi-k2.7-code BRACKET / tencent-hy3 measure; GLM-5.2 deselected 2026-07-27;
# xiaomi/mimo-v2.5-pro dropped), the local-model pivot 2026-07-31 that
# enumerated THREE LM Studio aliases (qwen3.6-35b-a3b/40b-deckard/27b-fable),
# and the 2026-08-09 provider rename orcarouter -> local-llm-proxy (the paid
# provider was long gone; the slug had become misleading). Both earlier eras
# named models; under the one-subject design the roster names none.
BACKGAMMON_SCORED_LADDER_ROSTER: tuple[LadderRung, ...] = (
    LadderRung(
        model="local-llm-proxy/okp-bench-worker",
        role="measure",
        memory_modes=("off", "on"),
        recorded_class=None,
    ),
)


# ---------------------------------------------------------------------------
# Cloud routing (--cloud): OrcaRouter provider block for worker opencode config
# ---------------------------------------------------------------------------
#
# THIS BLOCK IS NOT A CATALOGUE. It is the list of models the harness will
# ACCEPT: `_compose_cloud_slug` in scripts/run_cumulative.py exits 2 for any
# `{provider}/{model}` key absent from it, and the board's model picker is
# generated from it. Every entry is therefore a CLAIM that a benchmark cell can
# run on that model — and on the cloud branch a wrong claim costs money, not
# just time.
#
# ── PROVENANCE ─────────────────────────────────────────────────────────────
#
# Derived from OrcaRouter's own pricing catalogue,
# https://www.orcarouter.ai/api/pricing — the same endpoint this repo already
# pins by version hash (ORCAROUTER_PRICING_VERSION_PIN in
# adapters/openrouter_proxy.py), so it is not a new source of truth. 189 models
# were published; 87 are listed here.
#
# ── WHAT THE OTHER 102 ARE, AND WHY THEY ARE NOT HERE ──────────────────────
#
#   no tool calling   the bench drives an agentic build through opencode tool
#                     calls. A model without them cannot take one turn of this
#                     task — it fails at the first step, having been offered.
#   not text output   image, video and speech models (kling, imagen, gpt-image,
#                     tts-1). They cannot produce a repository.
#   wrong endpoint    the proxy posts to /v1/chat/completions; a model reachable
#                     only through another endpoint shape is not reachable here.
#   context < 262144  the LOCAL bench aliases are pinned at 262144
#                     (WORKER_MODEL_REGISTRY above). A cloud model with a
#                     smaller window would be measured under a tighter budget
#                     than the models it is compared against — a confound that
#                     presents as a capability difference and is invisible in
#                     the result.
#
# ── `output` IS LOAD-BEARING, NOT METADATA ─────────────────────────────────
#
# It is the vendor's stated `max_completion_tokens` where one is published, and
# 65536 for the 14 models that publish none (the value the hand-written block
# already used for exactly that case). Setting it BELOW what a model can emit
# truncates a response, and this bench classifies a provider-side truncation as
# a VOID INSTRUMENT — a cell that runs for hours and produces numbers measuring
# the harness rather than the model.
#
# ── MIRRORED IN control/cloud.mjs ──────────────────────────────────────────
#
# The control plane is JS and cannot import this. The two are pinned against
# each other — keys, count, context AND output — by a drift test in
# control/control.test.mjs, so a model added on one side and not the other fails
# a test rather than reaching an operator as "that model does not exist".
#
# `options.reasoningEffort` is set on ONE model and is an operator choice about
# how much thinking the subject may spend. It is deliberately not invented for
# the rest: unset takes the provider default, the only neutral value available.

DEFAULT_CLOUD_ROUTER = "orcarouter"

CLOUD_ORCAROUTER_PROVIDER: dict = {
    "npm": "@ai-sdk/openai-compatible",
    "name": "OrcaRouter",
    "options": {
        "baseURL": "https://api.orcarouter.ai/v1",
        "apiKey": "{env:ORCAROUTER_API_KEY}",
        "headerTimeout": 60000,
        "chunkTimeout": 300000,
        "timeout": 900000,
    },
    "models": {
        # ── GENERATED FROM THE LIVE CATALOG ───────────────────────────────
        # Regenerated from https://www.orcarouter.ai/api/pricing on
        # 2026-08-28. Every entry's name, context/output limits, reasoning
        # flag and attachment flag come from that payload rather than being
        # hand-typed, because a hand-maintained roster drifts silently: the
        # previous one still listed `anthropic/claude-sonnet-4.5` and
        # `openai/gpt-5-codex` after both were withdrawn upstream, and either
        # would have failed at call time with no warning here.
        #
        # FILTERED TO WHAT A CELL CAN ACTUALLY DRIVE: per-token text models
        # that advertise `tools` in supported_parameters. Embeddings, image
        # and video endpoints are excluded — they cannot run a coding cell,
        # and listing them only makes a selectable list that can be wrong.
        #
        # Hand-tuned `options` blocks (e.g. an explicit reasoningEffort) are
        # carried across regenerations and must stay operator choices.
        "anthropic/claude-fable-5": {
            "name": "Claude Fable 5",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1000000, "output": 128000},
        },
        "anthropic/claude-haiku-4.5": {
            "name": "Claude Haiku 4.5",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 200000, "output": 64000},
        },
        "anthropic/claude-opus-4.5": {
            "name": "Claude Opus 4.5",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 200000, "output": 64000},
        },
        "anthropic/claude-opus-4.6": {
            "name": "Claude Opus 4.6",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1000000, "output": 128000},
        },
        "anthropic/claude-opus-4.7": {
            "name": "Claude Opus 4.7",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1000000, "output": 128000},
        },
        "anthropic/claude-opus-4.8": {
            "name": "Claude Opus 4.8",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1000000, "output": 128000},
        },
        "anthropic/claude-opus-5": {
            "name": "Claude Opus 5",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1000000, "output": 128000},
            "options": {"reasoningEffort": "medium"},
        },
        "anthropic/claude-sonnet-4.6": {
            "name": "Claude Sonnet 4.6",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1000000, "output": 64000},
        },
        "anthropic/claude-sonnet-5": {
            "name": "Claude Sonnet 5",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1000000, "output": 128000},
        },
        "deepseek/deepseek-chat": {
            "name": "DeepSeek V3",
            "reasoning": True,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 1048576, "output": 384000},
        },
        "deepseek/deepseek-v4-flash": {
            "name": "DeepSeek V4 Flash",
            "reasoning": True,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 1048576, "output": 384000},
        },
        "deepseek/deepseek-v4-flash-0731": {
            "name": "DeepSeek V4 Flash 0731",
            "reasoning": True,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 1048576, "output": 384000},
        },
        "deepseek/deepseek-v4-flash-vision-exp": {
            "name": "DeepSeek V4 Flash Vision (Exp)",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 384000},
        },
        "deepseek/deepseek-v4-pro": {
            "name": "DeepSeek V4 Pro",
            "reasoning": True,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 1048576, "output": 384000},
        },
        "deepseek/deepseek-v4-pro-0813": {
            "name": "DeepSeek V4 Pro 0813",
            "reasoning": True,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 1048576, "output": 384000},
        },
        "google/gemini-2.5-flash": {
            "name": "Gemini 2.5 Flash",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "google/gemini-2.5-flash-lite": {
            "name": "Gemini 2.5 Flash Lite",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "google/gemini-2.5-pro": {
            "name": "Gemini 2.5 Pro",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "google/gemini-3-flash-preview": {
            "name": "Gemini 3 Flash Preview",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "google/gemini-3.1-flash-lite-preview": {
            "name": "Gemini 3.1 Flash Lite Preview",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "google/gemini-3.1-pro-preview": {
            "name": "Gemini 3.1 Pro Preview",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "google/gemini-3.1-pro-preview-customtools": {
            "name": "Gemini 3.1 Pro Preview Custom Tools",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "google/gemini-3.5-flash": {
            "name": "Gemini 3.5 Flash",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "google/gemini-3.5-flash-lite": {
            "name": "Gemini 3.5 Flash-Lite",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "google/gemini-3.6-flash": {
            "name": "Gemini 3.6 Flash",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "google/gemma-4-26b-a4b-it": {
            "name": "Gemma 4 26B A4B ",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 262144, "output": 32768},
        },
        "grok/grok-4.3": {
            "name": "grok/grok-4.3",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1000000, "output": 65536},
        },
        "grok/grok-4.5": {
            "name": "Grok 4.5",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 500000, "output": 62500},
        },
        "grok/grok-4.6": {
            "name": "Grok 4.6",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 500000, "output": 62500},
        },
        "kimi/kimi-k2.5": {
            "name": "kimi/kimi-k2.5",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 262144, "output": 32768},
        },
        "kimi/kimi-k2.6": {
            "name": "kimi/kimi-k2.6",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 262144, "output": 32768},
        },
        "kimi/kimi-k2.7-code": {
            "name": "Kimi K2.7 Code",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 262144, "output": 262144},
        },
        "kimi/kimi-k3": {
            "name": "Kimi K3",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "meta/muse-spark-1.1": {
            "name": "Muse Spark 1.1",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "meta/muse-spark-1.2": {
            "name": "Muse Spark 1.2",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "minimax/minimax-m3": {
            "name": "MiniMax M3",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 512000},
        },
        "obsidian/Qwen3.6-35B-A3B": {
            "name": "Qwen3.6 35B A3B Uncensored (Aggressive)",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 262144, "output": 32768},
        },
        "obsidian/Qwen3.8-27B": {
            "name": "Qwen3.8 27B",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 262144, "output": 32768},
        },
        "obsidian/gemma-4-26B-A4B": {
            "name": "Gemma4 26B A4B Uncensored (Balanced)",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 262144, "output": 32768},
        },
        "openai/gpt-3.5-turbo": {
            "name": "GPT-3.5 Turbo",
            "reasoning": False,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 16385, "output": 4096},
        },
        "openai/gpt-3.5-turbo-16k": {
            "name": "GPT-3.5 Turbo 16k",
            "reasoning": False,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 16385, "output": 4096},
        },
        "openai/gpt-4": {
            "name": "GPT-4",
            "reasoning": False,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 8191, "output": 8192},
        },
        "openai/gpt-4-turbo": {
            "name": "GPT-4 Turbo",
            "reasoning": False,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 128000, "output": 4096},
        },
        "openai/gpt-4-turbo-2024-04-09": {
            "name": "openai/gpt-4-turbo-2024-04-09",
            "reasoning": False,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 128000, "output": 4096},
        },
        "openai/gpt-4.1": {
            "name": "GPT-4.1",
            "reasoning": False,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1047576, "output": 32768},
        },
        "openai/gpt-4.1-2025-04-14": {
            "name": "openai/gpt-4.1-2025-04-14",
            "reasoning": False,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1047576, "output": 32768},
        },
        "openai/gpt-4.1-mini": {
            "name": "GPT-4.1 Mini",
            "reasoning": False,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1047576, "output": 32768},
        },
        "openai/gpt-4.1-mini-2025-04-14": {
            "name": "openai/gpt-4.1-mini-2025-04-14",
            "reasoning": False,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1047576, "output": 32768},
        },
        "openai/gpt-4.1-nano": {
            "name": "GPT-4.1 Nano",
            "reasoning": False,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1047576, "output": 32768},
        },
        "openai/gpt-4.1-nano-2025-04-14": {
            "name": "openai/gpt-4.1-nano-2025-04-14",
            "reasoning": False,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1047576, "output": 32768},
        },
        "openai/gpt-4o": {
            "name": "GPT-4o",
            "reasoning": False,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 128000, "output": 16384},
        },
        "openai/gpt-4o-2024-05-13": {
            "name": "GPT-4o (2024-05-13)",
            "reasoning": False,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 128000, "output": 16384},
        },
        "openai/gpt-4o-2024-08-06": {
            "name": "GPT-4o (2024-08-06)",
            "reasoning": False,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 128000, "output": 16384},
        },
        "openai/gpt-4o-2024-11-20": {
            "name": "GPT-4o (2024-11-20)",
            "reasoning": False,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 128000, "output": 16384},
        },
        "openai/gpt-4o-mini": {
            "name": "GPT-4o-mini",
            "reasoning": False,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 128000, "output": 16384},
        },
        "openai/gpt-4o-mini-2024-07-18": {
            "name": "GPT-4o-mini (2024-07-18)",
            "reasoning": False,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 128000, "output": 16384},
        },
        "openai/gpt-5": {
            "name": "GPT-5",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 128000},
        },
        "openai/gpt-5-2025-08-07": {
            "name": "openai/gpt-5-2025-08-07",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 128000},
        },
        "openai/gpt-5-mini": {
            "name": "GPT-5 Mini",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 128000},
        },
        "openai/gpt-5-mini-2025-08-07": {
            "name": "openai/gpt-5-mini-2025-08-07",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 128000},
        },
        "openai/gpt-5-nano": {
            "name": "GPT-5 Nano",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 128000},
        },
        "openai/gpt-5-nano-2025-08-07": {
            "name": "openai/gpt-5-nano-2025-08-07",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 128000},
        },
        "openai/gpt-5-pro": {
            "name": "GPT-5 Pro",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 272000},
        },
        "openai/gpt-5-pro-2025-10-06": {
            "name": "openai/gpt-5-pro-2025-10-06",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 272000},
        },
        "openai/gpt-5.1": {
            "name": "GPT-5.1",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 128000},
        },
        "openai/gpt-5.1-2025-11-13": {
            "name": "openai/gpt-5.1-2025-11-13",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 128000},
        },
        "openai/gpt-5.1-codex": {
            "name": "GPT-5.1-Codex",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 128000},
        },
        "openai/gpt-5.1-codex-mini": {
            "name": "GPT-5.1-Codex-Mini",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 128000},
        },
        "openai/gpt-5.2": {
            "name": "GPT-5.2",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 128000},
        },
        "openai/gpt-5.2-2025-12-11": {
            "name": "openai/gpt-5.2-2025-12-11",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 128000},
        },
        "openai/gpt-5.2-codex": {
            "name": "GPT-5.2-Codex",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 128000},
        },
        "openai/gpt-5.2-pro": {
            "name": "GPT-5.2 Pro",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 128000},
        },
        "openai/gpt-5.2-pro-2025-12-11": {
            "name": "openai/gpt-5.2-pro-2025-12-11",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 128000},
        },
        "openai/gpt-5.3-codex": {
            "name": "GPT-5.3-Codex",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 128000},
        },
        "openai/gpt-5.4": {
            "name": "GPT-5.4",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1050000, "output": 128000},
        },
        "openai/gpt-5.4-2026-03-05": {
            "name": "openai/gpt-5.4-2026-03-05",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1050000, "output": 128000},
        },
        "openai/gpt-5.4-mini": {
            "name": "GPT-5.4 Mini",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 128000},
        },
        "openai/gpt-5.4-nano": {
            "name": "GPT-5.4 Nano",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 400000, "output": 128000},
        },
        "openai/gpt-5.4-pro": {
            "name": "GPT-5.4 Pro",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1050000, "output": 128000},
        },
        "openai/gpt-5.4-pro-2026-03-05": {
            "name": "openai/gpt-5.4-pro-2026-03-05",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1050000, "output": 128000},
        },
        "openai/gpt-5.6-luna": {
            "name": "GPT-5.6 Luna",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1050000, "output": 128000},
        },
        "openai/gpt-5.6-sol": {
            "name": "GPT-5.6 Sol",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1050000, "output": 128000},
        },
        "openai/gpt-5.6-terra": {
            "name": "GPT-5.6 Terra",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1050000, "output": 128000},
        },
        "openai/gpt-oss-120b": {
            "name": "gpt-oss-120b",
            "reasoning": True,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 131072, "output": 16384},
        },
        "qwen/qwen3-max": {
            "name": "Qwen3 Max",
            "reasoning": True,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 262144, "output": 65536},
        },
        "qwen/qwen3-max-preview": {
            "name": "qwen/qwen3-max-preview",
            "reasoning": True,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 262144, "output": 65536},
        },
        "qwen/qwen3-vl-235b-a22b-thinking": {
            "name": "Qwen3 VL 235B A22B Thinking",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 131072, "output": 40960},
        },
        "qwen/qwen3-vl-8b-instruct": {
            "name": "Qwen3 VL 8B Instruct",
            "reasoning": False,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 131072, "output": 32768},
        },
        "qwen/qwen3-vl-8b-thinking": {
            "name": "Qwen3 VL 8B Thinking",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 131072, "output": 40960},
        },
        "qwen/qwen3.5-122b-a10b": {
            "name": "Qwen3.5-122B-A10B",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 32768, "output": 65536},
        },
        "qwen/qwen3.5-27b": {
            "name": "Qwen3.5-27B",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 32768, "output": 65536},
        },
        "qwen/qwen3.5-35b-a3b": {
            "name": "Qwen3.5-35B-A3B",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 32768, "output": 65536},
        },
        "qwen/qwen3.5-397b-a17b": {
            "name": "Qwen3.5 397B A17B",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 32768, "output": 65536},
        },
        "qwen/qwen3.5-flash": {
            "name": "qwen/qwen3.5-flash",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "qwen/qwen3.5-flash-2026-02-23": {
            "name": "qwen/qwen3.5-flash-2026-02-23",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "qwen/qwen3.5-plus": {
            "name": "qwen/qwen3.5-plus",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "qwen/qwen3.5-plus-2026-02-15": {
            "name": "qwen/qwen3.5-plus-2026-02-15",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "qwen/qwen3.6-35b-a3b": {
            "name": "Qwen3.6 35B A3B",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 262144, "output": 65536},
        },
        "qwen/qwen3.6-flash": {
            "name": "Qwen3.6 Flash",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "qwen/qwen3.6-flash-2026-04-16": {
            "name": "qwen/qwen3.6-flash-2026-04-16",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "qwen/qwen3.6-plus": {
            "name": "Qwen3.6 Plus",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "qwen/qwen3.6-plus-2026-04-02": {
            "name": "qwen/qwen3.6-plus-2026-04-02",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1048576, "output": 65536},
        },
        "qwen/qwen3.7-flash": {
            "name": "Qwen3.7 Flash",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1000000, "output": 65536},
        },
        "qwen/qwen3.7-plus": {
            "name": "Qwen3.7 Plus",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1000000, "output": 65536},
        },
        "qwen/qwen3.8-27b": {
            "name": "Qwen3.8 27B",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 262144, "output": 32768},
        },
        "qwen/qwen3.8-flash": {
            "name": "Qwen3.8 Flash",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1000000, "output": 131072},
        },
        "qwen/qwen3.8-max": {
            "name": "Qwen3.8 Max",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1000000, "output": 65536},
        },
        "tencent/hy3": {
            "name": "Hy3",
            "reasoning": True,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 262144, "output": 32768},
        },
        "z-ai/glm-4.5": {
            "name": "GLM 4.5",
            "reasoning": True,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 128000, "output": 96000},
        },
        "z-ai/glm-4.5-air": {
            "name": "GLM 4.5 Air",
            "reasoning": True,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 128000, "output": 96000},
        },
        "z-ai/glm-4.6": {
            "name": "GLM 4.6",
            "reasoning": True,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 200000, "output": 128000},
        },
        "z-ai/glm-4.7": {
            "name": "GLM 4.7",
            "reasoning": True,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 200000, "output": 128000},
        },
        "z-ai/glm-5": {
            "name": "GLM 5",
            "reasoning": True,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 200000, "output": 128000},
        },
        "z-ai/glm-5.1": {
            "name": "GLM 5.1",
            "reasoning": True,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 200000, "output": 128000},
        },
        "z-ai/glm-5.2": {
            "name": "GLM 5.2",
            "reasoning": True,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 1000000, "output": 128000},
        },
        "z-ai/glm-5.3": {
            "name": "GLM 5.3",
            "reasoning": True,
            "tool_call": True,
            "attachment": False,
            "limit": {"context": 1000000, "output": 128000},
        },
        "z-ai/glm-5.3-flash": {
            "name": "GLM 5.3 Flash",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": 1000000, "output": 128000},
        },
    },
}

# ── RETIRED BENCH ALIASES ────────────────────────────────────────────────────
#
# Aliases the proxy may still serve that the bench must REFUSE to measure, each
# with the reason stated. `--model <retired alias>` exits 2 quoting it.
#
# `okp-bench-worker` resolves upstream to `auto` — whichever model happens to
# be resident behind the proxy — so a cell run on it measures an unrecorded
# subject. That was the original one-subject design (D4) and it is retired: every
# cell now names its model.
#
# MIRRORED IN control/roster.mjs as RETIRED_ALIASES, because the control plane is
# JS and cannot import this. The two are pinned against each other by a drift
# test (control/control.test.mjs), so a retirement declared on one side and not
# the other fails a test instead of silently offering the alias on the board.
RETIRED_MODEL_ALIASES: dict[str, str] = {
    "okp-bench-worker": (
        "retired: this alias resolves to whatever model is resident behind the proxy, "
        "so a cell run on it measures an unrecorded subject. "
        "Benchmark a named bench alias instead."
    ),
}

# Schema version for the frozen ladder run manifest. Bump whenever the manifest
# structure or the roster's interpretation changes, so that resuming a run frozen
# under an older schema fails loudly instead of being silently reinterpreted.
# v2 = roster-A structured rungs (role/memory_modes/recorded_class) replacing the
# v1 (model_id, run_count) 14-cell tuples.
BACKGAMMON_LADDER_SCHEMA_VERSION: int = 2
