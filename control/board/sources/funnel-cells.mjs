// SOURCE: funnel-cells — the recall funnel counters the memory plugin writes
// per session, exported at teardown to
// data/cells/<ts>-<label>/funnel-snapshot.json (counts and ms only; no memory
// content). OFF cells never have one (by construction). serve_sent is delivery,
// not a win; gate_decision_ms is tiny in bench mode because the gate
// auto-approves.

import { join } from "node:path";
import { int, str } from "../contract.mjs";
import { readJson, listDir, statOrNull } from "./_runtime.mjs";

export const id = "funnel-cells";
export const fields = ["honesty.serves", "honesty.coverage", "honesty.wasted_turns", "funnel"];
export function describe() {
  return "plugin funnel counters per cell (ON cells only; absent on control by construction)";
}

const NUMERIC = [
  "episode_opened",
  "episode_armed",
  "recall_fired",
  "gate_shown",
  "gate_decided",
  "serve_sent",
  "serve_rejected",
  "confirmed_on_chain",
  "distinct_failure_keys",
];

export async function read(ctx) {
  const cellsDir = join(ctx.benchRoot, "data", "cells");
  const entries = [];
  for (const ent of await listDir(cellsDir)) {
    if (!ent.isDirectory()) continue;
    const p = join(cellsDir, ent.name, "funnel-snapshot.json");
    const st = await statOrNull(p);
    if (st?.isFile()) entries.push({ name: ent.name, path: p, mtime: st.mtimeMs, size: st.size });
  }

  if (!entries.length) {
    return {
      ok: false,
      reason: "no funnel snapshot yet — written by ON cells only (control cells have no plugin state by construction)",
    };
  }

  entries.sort((a, b) => b.mtime - a.mtime);

  const totals = Object.fromEntries(NUMERIC.map((k) => [k, 0]));
  const gateMs = [];
  let predicateMode = null;
  let sessions = 0;

  for (const e of entries) {
    const snap = await readJson(e.path);
    if (!snap || typeof snap !== "object") continue;
    for (const counters of Object.values(snap)) {
      if (!counters || typeof counters !== "object") continue;
      sessions += 1;
      for (const k of NUMERIC) totals[k] += int(counters[k]) ?? 0;
      const ms = int(counters.gate_decision_ms);
      if (ms !== null) gateMs.push(ms);
      predicateMode = str(counters.predicate_mode) ?? predicateMode;
    }
  }

  if (!sessions) {
    return { ok: false, reason: "funnel snapshot present but carries no sessions" };
  }

  // Coverage: episodes whose gate decided. Armed but undecided counts as
  // neither.
  const concluded = totals.gate_decided;
  const total = totals.episode_opened;

  return {
    ok: true,
    provenance: { path: entries[0].path, mtime: entries[0].mtime, bytes: entries[0].size },
    patch: {
      funnel: {
        ...totals,
        predicate_mode: predicateMode,
        gate_decision_ms_samples: gateMs,
        sessions,
      },
      honesty: {
        serves: {
          sent: totals.serve_sent,
          rejected: totals.serve_rejected,
          confirmed_on_chain: totals.confirmed_on_chain,
        },
        coverage: { concluded, total },
        // Episodes that opened but never armed: turns burned before recall could fire.
        wasted_turns: Math.max(0, totals.episode_opened - totals.episode_armed),
      },
    },
  };
}
