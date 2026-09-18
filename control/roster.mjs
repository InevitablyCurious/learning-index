// ROSTER — which models exist, and which are resident. Two sources, kept
// apart:
//   proxy   :4545/v1/models       aliases the bench can name, and their window
//   runtime :1234/api/v0/models   what is loaded, and at what context
// A mismatch between them has voided cells, so both are reported and
// context_match computed. An unreachable side is null with a reason, never an
// empty list that looks like "no models".

import { BENCH_PURPOSE } from "./contract.mjs";

/**
 * Retired aliases: advertised by the proxy (which lives outside this repo),
 * refused by the bench. `okp-bench-worker` maps to whatever model is resident, so
 * a cell on it names no model. Named once here so every surface refuses it for
 * the same reason.
 */
export const RETIRED_ALIASES = {
  "okp-bench-worker":
    "retired: this alias resolves to whatever model is resident behind the proxy, so a cell "
    + "run on it measures an unrecorded subject. Benchmark a named bench alias instead.",
};

/** Context options offered by the UI. */
export const CONTEXT_CHOICES = [65536, 131072, 262144];

async function getJson(url, timeoutMs = 2000) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status} from ${url}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, reason: `unreachable: ${url} (${String(err?.message ?? err)})` };
  }
}

/** The runtime's model list by upstream id (state, max and loaded context). */
function indexRuntime(data) {
  const out = new Map();
  const rows = Array.isArray(data?.data) ? data.data : [];
  for (const r of rows) {
    const id = typeof r?.id === "string" ? r.id : null;
    if (!id) continue;
    out.set(id, {
      state: typeof r.state === "string" ? r.state : null,
      max_context: Number.isFinite(r.max_context_length) ? r.max_context_length : null,
      loaded_context: Number.isFinite(r.loaded_context_length) ? r.loaded_context_length : null,
    });
  }
  return out;
}

/**
 * Match a proxy alias's upstream model to a runtime entry; the two name it
 * differently, so matching is normalised. No match stays null — a wrong match
 * would report another model's context.
 */
export function matchRuntime(upstreamModel, runtimeIndex) {
  if (!upstreamModel) return null;
  const norm = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[_\s]/g, "-")
      .replace(/-(mlx|gguf|mxfp4|q\d[a-z0-9_]*|\d+bit)\b/g, "")
      .replace(/[^a-z0-9.]/g, "");

  const want = norm(upstreamModel);
  if (!want) return null;

  for (const [id, info] of runtimeIndex) {
    const have = norm(id.includes("/") ? id.split("/").pop() : id);
    if (have && (have === want || want.endsWith(have) || have.endsWith(want))) {
      return { id, ...info };
    }
  }
  return null;
}

/** Build the roster. Never throws: an unreachable side is null with a reason. */
export async function readRoster({ proxyUrl, runtimeUrl }) {
  const [proxyRes, runtimeRes] = await Promise.all([
    getJson(`${proxyUrl}/v1/models`),
    getJson(`${runtimeUrl}/api/v0/models`),
  ]);

  const notes = [];
  if (!proxyRes.ok) notes.push(`proxy roster unwired — ${proxyRes.reason}`);
  if (!runtimeRes.ok) notes.push(`runtime residency unwired — ${runtimeRes.reason}`);

  const runtimeIndex = runtimeRes.ok ? indexRuntime(runtimeRes.data) : new Map();
  const rows = proxyRes.ok && Array.isArray(proxyRes.data?.data) ? proxyRes.data.data : [];

  const models = rows.map((r) => {
    const id = String(r?.id ?? "");
    const upstream = typeof r?.upstream_model === "string" ? r.upstream_model : null;
    const purpose = typeof r?.purpose === "string" ? r.purpose : null;
    const rt = runtimeRes.ok ? matchRuntime(upstream, runtimeIndex) : null;

    // The alias's window as the proxy reports it (the same value the worker's
    // opencode.json gets).
    const declared = Number.isFinite(r?.context_length) ? r.context_length : null;
    const loaded = rt?.loaded_context ?? null;

    const retired = RETIRED_ALIASES[id] ?? null;

    return {
      id,
      upstream_model: upstream,
      purpose,
      // A retired alias is never bench-eligible; the reason travels with the row.
      bench_eligible: purpose === BENCH_PURPOSE && !retired,
      retired_reason: retired,
      // null when the runtime is unreachable — unknown, not "not loaded".
      resident: runtimeRes.ok ? rt?.state === "loaded" : null,
      declared_context: declared,
      max_context: rt?.max_context ?? null,
      loaded_context: loaded,
      // null when either side is unobserved.
      context_match:
        declared === null || loaded === null ? null : declared === loaded,
      runtime_id: rt?.id ?? null,
    };
  });

  return {
    ok: proxyRes.ok,
    models,
    bench_models: models.filter((m) => m.bench_eligible),
    context_choices: CONTEXT_CHOICES,
    proxy_ok: proxyRes.ok,
    runtime_ok: runtimeRes.ok,
    // Verbatim, for the control region.
    notes,
    reason: proxyRes.ok ? null : proxyRes.reason,
  };
}
