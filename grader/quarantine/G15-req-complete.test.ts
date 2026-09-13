// ─────────────────────────────────────────────────────────────────────────────
// QUARANTINED — NOT A GRADED GATE.
//
// [G15] REQ-COMPLETE — a scripted full game reaches a winner with no exceptions.
//
// ── WHY IT IS HERE ──────────────────────────────────────────────────────────
//
// It is FLAKY, and the canon is that a flaky test leaves the grading suite.
// See `quarantine/README.md`.
//
// Evidence, on byte-identical code:
//   * `02` records it passing ONCE IN SEVEN runs.
//   * 2026-09-11, inside the grading container at one worker: it FAILED in one
//     full-suite run and then PASSED five times in a row on the same candidate
//     with the same command — a ~1-in-6 flip with nothing changed.
//
// ── WHY THAT IS DISQUALIFYING, NOT MERELY ANNOYING ──────────────────────────
//
// A gate that flips on identical code moves `resolved_count`, which is the
// convergence signal `06` reads as DIFFICULTY. So the noise does not stay in
// one gate: it manufactures and erases the very curve the benchmark exists to
// measure, and no amount of care downstream can tell its movement from a real
// one.
//
// ── WHAT IS NOW UNMEASURED, STATED PLAINLY ──────────────────────────────────
//
// REQ-COMPLETE is a real requirement and nothing else covers it end to end. A
// candidate whose engine cannot finish a game will still fail G13 (turn flow),
// G14 (AI legality over seeded self-play) and the frontend win gates — but
// "plays all the way to a winner with zero server exceptions" is not asserted
// anywhere while this file sits here.
//
// ── ITS FEEDBACK LINE, KEPT HERE ────────────────────────────────────────────
//
// Removed from `gates/feedback.json` along with the gate: that file's guards
// require every key to address a gate that actually exists, and a symptom line
// for a gate nobody can fail is exactly the drift they are there to catch. It
// is recorded here so re-admitting the gate restores both halves together —
// and so the work of writing it in the right voice is not repeated.
//
//   first : The game can crash partway through before anyone wins
//   repeat: It fell over on me again partway through, before either of us had finished.
//
// ── HOW IT COMES BACK ───────────────────────────────────────────────────────
//
// Not by being moved. Its bound is `iterations <= 500` against an AI that is
// free to play badly, so a correct-but-weak engine can legitimately run long:
// the gate conflates "finishes" with "finishes efficiently". Re-admitting it
// means making the assertion deterministic — bound the game by the ENGINE's
// own legal-move exhaustion rather than an iteration budget, or drive it with
// scripted dice that provably terminate — and then showing it green across
// repeated runs on identical code.
//
// Nothing outside this directory runs this file: `vitest.config.ts` includes
// only `backend/**`, and `report.mjs` walks only `backend/`. It is kept
// runnable so the work to fix it starts from something that executes.
//
//   npx vitest run --config vitest.quarantine.config.ts
// ─────────────────────────────────────────────────────────────────────────────

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { api, debugRoll, getState, startServer, stopServer } from "../lib/harness.ts";

describe("[G15] REQ-COMPLETE — scripted full game reaches winner with zero exceptions (via server)", () => {
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    server = await startServer({ debug: true });
  });

  afterAll(async () => {
    await stopServer(server);
  });

  it("[G15] REQ-COMPLETE — complete game to winner with fixed debug dice script", async () => {
    const scriptedRolls = [[6, 5], [6, 6, 6, 6], [5, 4], [3, 1], [2, 1]];
    let rollIndex = 0;
    const nextRoll = () => {
      const roll = scriptedRolls[rollIndex % scriptedRolls.length];
      rollIndex++;
      return [...roll];
    };

    let state = await api("/api/new", { difficulty: "medium" });
    let iterations = 0;
    let thrown: unknown = null;

    try {
      while (!state.winner && iterations < 500) {
        iterations++;

        if (state.turn === "white") {
          if (state.phase === "roll") {
            await debugRoll(nextRoll());
            state = await api("/api/roll", {});
            continue;
          }

          if (state.phase === "move") {
            const legalMoves = (state.legalMoves ?? []) as Move[];
            if (legalMoves.length > 0) {
              const m = legalMoves[0];
              state = await api("/api/move", { from: m.from, to: m.to, die: m.die });
              continue;
            }

            if (state.turnOver) {
              state = await api("/api/endturn", {});
              continue;
            }
          }

          if (state.turnOver) {
            state = await api("/api/endturn", {});
            continue;
          }

          state = await getState();
          continue;
        }

        if (state.turn === "black") {
          if (state.phase === "doubleOffered") {
            state = await api("/api/double/respond", { accept: true });
            continue;
          }

          if (state.phase === "roll") {
            await debugRoll(nextRoll());
          }

          state = await api("/api/ai", {});
          continue;
        }

        state = await getState();
      }
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeNull();
    expect(
      state.winner,
      `Expected winner within 500 iterations, but loop stopped at ${iterations}.`,
    ).toBeTruthy();
    expect(["single", "gammon", "backgammon"]).toContain(state.winType);
    expect(iterations).toBeLessThanOrEqual(500);
  });
});

