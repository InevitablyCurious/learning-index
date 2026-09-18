// SOURCE: run-manifest — the active run's manifest.json (written at start):
// provenance a skeptic checks first — org, model, seed, roster, and the recall
// mode that decides whether the approval gate auto-approves. Gate mode is
// derived from the recorded L4_OKP_RECALL_MODE lever (test = auto-approve,
// anything else = human), and null when not recorded. policy_version and
// policy_anchor_status are always null now (the hub is no longer read).

import { str, int } from "../contract.mjs";
import { readJson, activeRun } from "./_runtime.mjs";

export const id = "run-manifest";
export const fields = ["provenance", "run.org_id", "run.model"];
export function describe() {
  return "run manifest — levers, org, model identity (RC-5)";
}

export async function read(ctx) {
  // The active run's manifest, so provenance matches the gates on the wall.
  const run = await activeRun(ctx.runsRoot);
  if (!run?.manifestPath) return { ok: false, reason: "no manifest.json under runs root" };

  const m = await readJson(run.manifestPath);
  if (!m) return { ok: false, reason: "manifest.json unreadable or malformed" };

  const levers = m.run_context?.levers ?? {};
  const recallMode = str(levers.L4_OKP_RECALL_MODE?.value);
  const edge = m.run_context?.edge_policy ?? {};

  const schedule = Array.isArray(m.schedule) ? m.schedule : [];
  const roster = Array.isArray(m.roster) ? m.roster : [];
  const model =
    str(schedule[0]?.provider_pin) ??
    str(roster[0]?.provider_pin) ??
    str(roster[0]?.model);

  return {
    ok: true,
    provenance: {
      path: run.manifestPath,
      mtime: run.manifestStat?.mtimeMs ?? null,
      bytes: run.manifestStat?.size ?? null,
      run: run.name,
    },
    patch: {
      run: {
        org_id: str(m.org_id),
        model,
        started_at: Date.parse(str(m.created_at) ?? "") || null,
      },
      provenance: {
        // test mode auto-approves; anything else waits on a human.
        gate_mode: recallMode === null ? null : recallMode === "test" ? "auto-approve" : "human",
        gate_mode_source: recallMode ? `L4_OKP_RECALL_MODE=${recallMode}` : null,
        policy_version: str(edge.version),
        policy_anchor_status: str(edge.anchor_status),
        seed: int(m.seed),
      },
    },
  };
}
