// ─────────────────────────────────────────────────────────────────────────────
// MEMORY BACKENDS — the plug-in registry, and the ONE place a backend's name
// appears in the benchmark service.
//
// This bench is public: anyone plugs their own memory system in. That contract
// only holds if adding a backend is adding a ROW HERE, and nothing else in the
// tree learns its name. The adapter, the worker, the run launcher and the board
// all stay generic — they carry "a backend", never "tokp".
//
// A backend is three facts:
//
//   id      what the board and the preflight script agree to call it
//   label   what an operator reads
//   env()   the environment a run using this backend needs
//
// `env()` is a FUNCTION, not a literal, because the values are resolved from the
// operator's own installation (where the plugin tree is checked out) rather than
// baked in. It returns an object, and it may return an EMPTY object when the
// installation cannot supply the values — that is not an error here. Preflight
// is where a missing value becomes a refusal, so this module never throws and
// never guesses: it reports what it could resolve, and the preflight rows say
// what that means.
//
// ── WHY THE ENV IS RESOLVED HERE AND NOT LEFT TO THE OPERATOR'S SHELL ────────
//
// Run 1788848333 went out with BENCH_AGENTS_AUX_FILE unset. Nothing was broken;
// nothing was wired. The cell ran to completion with the model never told to
// record anything, and the empty result was indistinguishable from a real
// finding about the memory system. Making the board resolve and apply the env
// is what turns "did you remember to export it" into a question the service can
// answer for itself.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { join } from "node:path";

/** Where this installation keeps the plugin tree, or "" when it was never told. */
function pluginRoot() {
  return String(process.env.OKP_BENCH_PLUGIN_DIR ?? "").trim();
}

const BACKENDS = [
  {
    id: "tokp",
    label: "TOKp",
    blurb: "in-session capture — the model records through a tool as it works",
    /**
     * TOKp needs two things in the run's environment:
     *
     *   BENCH_AGENTS_AUX_FILE  the standing record mandate, appended to the
     *                          worker's AGENTS.md at seed time
     *   OKP_BENCH_PLUGIN_DIR   the plugin tree, passed through so the run sees
     *                          the same one the control plane was started with
     *
     * Both are resolved from the plugin root. A missing mandate file yields no
     * entry for it rather than a path that does not exist: the seam ABORTS on a
     * declared-but-unreadable path, so handing it one would turn a
     * misconfiguration into a crashed run instead of a preflight refusal.
     */
    env() {
      const root = pluginRoot();
      if (!root) return {};
      const out = { OKP_BENCH_PLUGIN_DIR: root };
      const mandate = join(root, "plugins", "tokp-record-mandate.md");
      if (existsSync(mandate)) out.BENCH_AGENTS_AUX_FILE = mandate;
      return out;
    },
  },
];

const BY_ID = new Map(BACKENDS.map((b) => [b.id, b]));

/** Every backend the board may offer, as plain data. */
export function listMemoryBackends() {
  return BACKENDS.map(({ id, label, blurb }) => ({ id, label, blurb }));
}

/** One backend, or null. Callers treat null as "not a backend this bench has". */
export function memoryBackend(id) {
  return BY_ID.get(String(id ?? "").trim()) ?? null;
}

/**
 * The environment a run with this backend needs, or `{}` for an unknown id.
 *
 * Empty is a legitimate answer and never an exception: a bench with no plugin
 * tree checked out runs fine with no memory layer, and it is preflight — not
 * this lookup — that decides whether "no memory layer" is acceptable for the
 * run being started.
 */
export function memoryBackendEnv(id) {
  return memoryBackend(id)?.env() ?? {};
}
