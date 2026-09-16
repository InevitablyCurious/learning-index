// ─────────────────────────────────────────────────────────────────────────────
// GATE DETAIL — what each square on the wall checked, how, and what happened
//
// The wall's squares carried a short test title and a colour. Reading a red
// square meant opening the test file, the grading report and feedback.json side
// by side. This joins them, per gate, into one record the board's hover card
// renders as it is:
//
//   name / what / how   the challenge's own plain description (grader/checks.json)
//   rounds              pass / fail / not run, per grading round, oldest first
//   last_failure        the grading report's own words for the latest failure
//   told                the complaint sentences the model was sent for it
//
// VERBATIM, NOT INTERPRETED. The failure line is the assertion's first line with
// the stack trace dropped. Rewriting "expected 2 to be +0" into a sentence would
// need per-check knowledge this module does not have, and a paraphrase that is
// wrong is worse than a technical line that is right.
//
// ABSENT IS STATED. A gate the descriptions do not cover gets `description:
// null`, never a guess; a run with no reports yet has no `last_failure`.
// READ-ONLY: reads JSON. Never writes, never spawns.
// ─────────────────────────────────────────────────────────────────────────────

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** A check's bracket token: `G01` from `G01` or from `…[G01] …`. */
export function gateToken(id) {
  const s = String(id ?? "");
  const bare = /^([A-Z]+\d+)$/.exec(s);
  if (bare) return bare[1];
  const bracketed = /\[([A-Z]+\d+)\]/.exec(s);
  return bracketed ? bracketed[1] : null;
}

/** Match a setup check's title against the challenge's title patterns. */
function matchSetup(title, setup) {
  for (const entry of setup ?? []) {
    const escaped = String(entry.title).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escaped.replace("\\{x\\}", "(.+?)")}$`);
    const m = pattern.exec(title);
    if (!m) continue;
    const x = m[1] ?? "";
    const fill = (t) => String(t ?? "").replaceAll("{x}", x);
    return { key: fill(entry.key), name: fill(entry.name), what: fill(entry.what), how: fill(entry.how) };
  }
  return null;
}

/** The plain description for one gate, or null. */
export function describeGate(gate, descriptions) {
  if (!descriptions) return null;
  const token = gateToken(gate.id);
  if (token && token !== "CONF" && descriptions.checks?.[token]) {
    const d = descriptions.checks[token];
    return { key: token, name: d.name, what: d.what, how: d.how };
  }
  const title = gate.title ?? String(gate.id ?? "").split("[CONF] ").pop();
  return matchSetup(title, descriptions.setup);
}

/** The assertion's own first line, with the stack trace and location split off. */
export function technicalLine(observed) {
  const lines = String(observed ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines.find((l) => !l.startsWith("at ")) ?? "";
  const where = lines.find((l) => l.startsWith("at /gates/"));
  const location = where ? where.replace(/^at \/gates\//, "").replace(/:\d+$/, "") : null;
  return { message: first.slice(0, 240), location };
}

/** The newest cell directory of a campaign, or null. */
async function latestCellDir(runPath) {
  const cells = [];
  for (const arm of ["memoryOFF", "memoryON"]) {
    let names = [];
    try {
      names = await readdir(join(runPath, arm));
    } catch {
      continue;
    }
    for (const n of names) if (n.startsWith("cell-")) cells.push(join(runPath, arm, n));
  }
  return cells.sort().pop() ?? null;
}

/**
 * Attach `detail` to every gate. Pure over its inputs apart from reading the
 * descriptions, the complaint sentences and the campaign's grading reports.
 */
export async function attachGateDetail({ gates, attempts, runPath, graderDir }) {
  const descriptions = graderDir ? await readJson(join(graderDir, "checks.json")) : null;
  const feedback = graderDir ? (await readJson(join(graderDir, "feedback.json")))?.gates ?? {} : {};

  // Per round: gate id -> status.
  const rounds = (attempts ?? []).map((a) => {
    const byId = new Map();
    for (const r of Array.isArray(a.gate_results) ? a.gate_results : []) byId.set(r.id, r.status);
    return { attempt: a.attempt, byId };
  });

  // The grading reports, newest round first, for the failure text.
  const cell = runPath ? await latestCellDir(runPath) : null;
  const reports = [];
  if (cell) {
    for (const r of [...rounds].reverse()) {
      const report = await readJson(join(cell, `attempt-${r.attempt}-report.json`));
      if (report) reports.push({ attempt: r.attempt, problems: report.problems ?? [] });
    }
  }

  return gates.map((gate) => {
    const description = describeGate(gate, descriptions);
    const key = description?.key ?? gateToken(gate.id);
    const matches = (check) => {
      const c = String(check ?? "");
      if (!key) return false;
      return /^[A-Z]+\d+$/.test(key) ? c.includes(`[${key}]`) : c === key || c.startsWith(`${key} `);
    };
    let lastFailure = null;
    for (const report of reports) {
      const problem = report.problems.find((p) => matches(p.check));
      if (problem) {
        lastFailure = { attempt: report.attempt, ...technicalLine(problem.observed) };
        break;
      }
    }
    const told = feedback[key] ?? (key?.startsWith("REQ-") ? feedback.CONF : null) ?? null;
    return {
      ...gate,
      detail: {
        description,
        rounds: rounds.map((r) => ({ attempt: r.attempt, status: r.byId.get(gate.id) ?? null })),
        last_failure: lastFailure,
        told: told ? { first: told.first ?? null, repeat: told.repeat ?? null } : null,
      },
    };
  });
}
