import fs from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PORT,
  api,
  debugRoll,
  debugRollVerified,
  debugSetState,
  emptyPoints,
  freePort,
  freshCheckout,
  getState,
  loadEngine,
  makeState,
  openingPoints,
  resolveStartCommand,
  startServer,
  stopServer,
  ordinaryTurn,
} from "../lib/harness.ts";

type Player = "white" | "black";
type Difficulty = "easy" | "medium" | "hard";
type Move = { from: number; to: number; die: number };
type Board = {
  points: number[];
  bar: { white: number; black: number };
  off: { white: number; black: number };
};

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

const sortedDice = (dice: number[]) => [...dice].sort((a, b) => a - b);

function sameMove(a: Move, b: Move): boolean {
  return a.from === b.from && a.to === b.to && a.die === b.die;
}

function removeDie(remaining: number[], die: number): void {
  const idx = remaining.indexOf(die);
  expect(idx).toBeGreaterThanOrEqual(0);
  if (idx >= 0) {
    remaining.splice(idx, 1);
  }
}

function cloneBoardFromState(state: any): Board {
  return {
    points: [...state.points],
    bar: { ...state.bar },
    off: { ...state.off },
  };
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function rollDice(rng: () => number): number[] {
  const d1 = 1 + Math.floor(rng() * 6);
  const d2 = 1 + Math.floor(rng() * 6);
  return d1 === d2 ? [d1, d1, d1, d1] : [d1, d2];
}

function waitForExitWithTimeout(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // best-effort cleanup only
      }
      resolve({ code: proc.exitCode, signal: proc.signalCode, timedOut: true });
    }, timeoutMs);

    // `close`, not `exit`: `exit` can fire before the piped stdout/stderr are
    // drained, so the port-in-use message the gate reads could still be in
    // flight — a correct app failing on a partial read (lib/harness.ts waits
    // on `close` for the same reason).
    proc.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut: false });
    });
  });
}

describe("Backgammon backend gates 13-16", () => {
  describe("[G13] REQ-TURN — turn-flow integrity (via server)", () => {
    let server: Awaited<ReturnType<typeof startServer>>;

    beforeAll(async () => {
      server = await startServer({ debug: true });
      expect(server.baseUrl).toContain(`:${PORT}`);
    });

    afterAll(async () => {
      await stopServer(server);
    });

    it("[G13] REQ-TURN — no die reuse after consumption", async () => {
      // An ordinary turn from the opening position: a new game starts with the
      // opening roll (G31), which is not this check's subject.
      await ordinaryTurn({ difficulty: "easy" });
      let state = await debugRollVerified([3, 1]);
      expect(state.phase).toBe("move");
      expect(sortedDice(state.remainingDice)).toEqual([1, 3]);

      const moveUsingThree = (state.legalMoves as Move[]).find((m) => m.die === 3);
      expect(moveUsingThree).toBeTruthy();
      if (!moveUsingThree) return;

      state = await api("/api/move", {
        from: moveUsingThree.from,
        to: moveUsingThree.to,
        die: 3,
      });
      expect(sortedDice(state.remainingDice)).toEqual([1]);

      const secondAttempt = await api("/api/move", {
        from: moveUsingThree.from,
        to: moveUsingThree.to,
        die: 3,
      });
      expect(sortedDice(secondAttempt.remainingDice)).toEqual([1]);
    });

    it("[G25] REQ-TURN — the computer takes its turn", async () => {
      // An ordinary turn from the opening position: a new game starts with the
      // opening roll (G31), which is not this check's subject.
      await ordinaryTurn({ difficulty: "easy" });
      let state = await debugRollVerified([4, 2]);
      // No move after the roll is not the computer's finding: the
      // movable-checker gate reports it when an ordinary roll gives none either
      // (a needs marker, harness/adapters/challenge/stages.py).
      const noMove = "[aspect: nomove] [needs: REQ-HINT/hint F03 F25]";
      expect(state.turn).toBe("white");
      expect(state.phase, noMove).toBe("move");

      // A player plays a move the game shows, and tries the next one when a
      // move is refused. Run 1790615587's server listed moves with the smaller
      // die and refused them while the larger had a move; always sending the
      // first listed move ran the turn out and told "the computer never takes
      // its turn". A game that takes none of the moves it lists is the
      // played-move gate's finding.
      const refused = "[needs: F25] the game refused every move it listed";
      let moveSteps = 0;
      while (!state.turnOver && moveSteps < 16) {
        const legalMoves = (state.legalMoves ?? []) as Move[];
        expect(legalMoves.length, moveSteps === 0 ? noMove : undefined).toBeGreaterThan(0);
        const before = JSON.stringify(state.remainingDice);
        let taken = false;
        for (const m of legalMoves) {
          const next = await api("/api/move", { from: m.from, to: m.to, die: m.die });
          if (next.turnOver || JSON.stringify(next.remainingDice) !== before) {
            state = next;
            taken = true;
            break;
          }
        }
        expect(taken, refused).toBe(true);
        moveSteps++;
      }

      expect(state.turnOver).toBe(true);

      // The computer's turn, however the app runs it: step by step through
      // /api/ai, or whole inside /api/endturn. Run 1790608868's server played
      // it inside end turn — black moved and the roll came back to the player,
      // who watched the computer take its turn — and was told the computer
      // "just sits there". Its pieces moving is the computer taking its turn.
      const blackOf = (s: any) =>
        JSON.stringify([(s.points as number[]).map((n) => Math.min(n, 0)), s.bar.black, s.off.black]);
      const blackBefore = blackOf(state);
      state = await api("/api/endturn", {});

      let guard = 0;
      while (state.turn !== "white" && guard < 12) {
        state = state.turn === "black" ? await api("/api/ai", {}) : await getState();
        // The computer moved and then stopped to offer a double, with moves still
        // to play: the player watches it play once and wait on an answer, not
        // "never take its turn" (run 1791385175: the offer came after its first
        // move, on easy, which never offers). Told as what was seen.
        expect(
          state.phase === "doubleOffered" && blackOf(state) !== blackBefore,
          "[aspect: offered] the computer moved, then stopped partway through its turn to offer a double",
        ).toBe(false);
        guard++;
      }

      expect(state.turn).toBe("white");
      expect(blackOf(state), "[aspect: skipped] the roll came back to white and black never moved").not.toBe(blackBefore);
    });

    it("[G13] REQ-TURN — auto-pass when stuck on bar", async () => {
      // A REAL position, 15 a side, as the spec promises every seed is
      // (chunk-03.md: "exactly 15 checkers per side"). It was 1 white and 4
      // black, which an app that validates positions rightly refuses — failing
      // a turn-flow gate over our board. White's entry points for the 2-4
      // (23 and 21) are blocked; the other checkers sit where they touch
      // neither entry nor the pass.
      const points = emptyPoints();
      points[23] = -2;
      points[21] = -2;
      points[24] = -11;
      points[6] = 14;

      await debugSetState(
        makeState({
          points,
          bar: { white: 1, black: 0 },
          turn: "white",
          phase: "roll",
          dice: [],
          remainingDice: [],
          message: "",
        }),
      );

      const state = await debugRollVerified([2, 4]);

      // A stuck player exists only once pieces come in off the bar where they
      // should (G06: run 1790633807's entered at the wrong end and were never
      // stuck); a turn that ends with no word of it is the notice gate's (F05).
      const entry = "[needs: G06]";
      const notice = "[needs: F05]";
      expect(state.turnOver, entry).toBe(true);
      expect(Array.isArray(state.legalMoves), entry).toBe(true);
      expect(state.legalMoves.length, entry).toBe(0);
      expect(typeof state.message, notice).toBe("string");
      expect(state.message.trim().length, notice).toBeGreaterThan(0);
      expect(state.message, notice).toMatch(/no moves available/i);
    });
  });

  describe("[G15] REQ-COMPLETE — a full game reaches a winner with zero exceptions (via server)", () => {
    let server: Awaited<ReturnType<typeof startServer>>;

    beforeAll(async () => {
      server = await startServer({ debug: true });
      expect(server.baseUrl).toContain(`:${PORT}`);
    });

    afterAll(async () => {
      await stopServer(server);
    });

    it("[G15] REQ-COMPLETE — plays a full game to a winner with fixed dice and no exceptions", async () => {
      // A fixed non-tie opening roll: white (6) beats the computer (5) and plays first.
      const OPENING_ROLL = [6, 5];
      // Cycling forced dice for every subsequent roll, white's and the computer's alike.
      const SCRIPTED_ROLLS = [[6, 6, 6, 6], [5, 4], [3, 1], [2, 1]];
      let rollIndex = 0;
      const nextRoll = () => {
        const roll = SCRIPTED_ROLLS[rollIndex % SCRIPTED_ROLLS.length];
        rollIndex++;
        return [...roll];
      };

      // Why this bound, and why it can fail:
      //  * A turn is at most 4 plies (doubles), and every accepted ply removes at
      //    least 1 pip from the mover (singleMoves is forward-only), so a hit-free
      //    game needs at most 167 plies per side = 334 total (game.ts).
      //  * A hit recycles pips (<=24 back onto the victim) instead of ending the
      //    game, so it stretches the game past 334; the reference engine's own
      //    self-play harness guards a full game at 2000 turns (src/test.ts) and
      //    observed a 554-turn maximum over 400 games.
      //  * A turn costs at most 8 calls (1 debugRoll + 1 roll + <=4 moves + 1
      //    endturn for the human; 1 debugRoll + 1 ai + 1 double-response for the
      //    computer). 8000 calls covers ~1000 turns at 8 calls/turn — twice the
      //    engine's own observed worst case. The no-progress detector, not this
      //    ceiling, is what fails a stuck engine immediately.
      const MAX_ITERATIONS = 8000;

      let state = await api("/api/new", { difficulty: "medium" });
      let iterations = 0;
      let thrown: unknown = null;

      try {
        // Opening roll: force a non-tie, then roll. White wins and plays first.
        await debugRoll(OPENING_ROLL);
        state = await api("/api/roll", {});

        while (!state.winner && iterations < MAX_ITERATIONS) {
          iterations++;
          const before = JSON.stringify(state);

          if (state.turn === "white") {
            if (state.phase === "roll") {
              await debugRoll(nextRoll());
              state = await api("/api/roll", {});
            } else if (state.phase === "move") {
              const legalMoves = (state.legalMoves ?? []) as Move[];
              if (legalMoves.length > 0) {
                const m = legalMoves[0];
                state = await api("/api/move", { from: m.from, to: m.to, die: m.die });
              } else if (state.turnOver) {
                state = await api("/api/endturn", {});
              } else {
                throw new Error(`white in move phase: no legal moves and no turnOver (remainingDice=${JSON.stringify(state.remainingDice)})`);
              }
            } else {
              throw new Error(`white: unexpected phase ${state.phase}`);
            }
          } else if (state.turn === "black") {
            if (state.phase === "doubleOffered") {
              state = await api("/api/double/respond", { accept: true });
            } else if (state.phase === "move") {
              // The computer won the opening roll (not reachable here — the
              // opening is forced non-tie in white's favour) and must play the
              // dice already on the table; /api/ai does so without rolling.
              state = await api("/api/ai", {});
            } else if (state.phase === "roll") {
              await debugRoll(nextRoll());
              state = await api("/api/ai", {});
            } else {
              throw new Error(`black: unexpected phase ${state.phase}`);
            }
          } else {
            throw new Error(`no turn: turn=${state.turn}`);
          }

          if (!state.winner && JSON.stringify(state) === before) {
            throw new Error(`no progress after iteration ${iterations}: turn=${state.turn} phase=${state.phase}`);
          }
        }
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeNull();
      expect(
        state.winner,
        `Expected a winner within ${MAX_ITERATIONS} iterations, but the loop stopped at ${iterations} without one.`,
      ).toBeTruthy();
      expect(["single", "gammon", "backgammon"]).toContain(state.winType);
    });
  });

  describe("[G16] REQ-BIND — port 8002 bind + clear failure when taken", () => {
    it("[G16] REQ-BIND — second server exits non-zero with clear 8002 in-use message", async () => {
      await freePort(PORT);
      // Its own writable checkout, like every server the gates boot: on the
      // read-only mount an app that writes a file would fail for THAT reason,
      // and this gate would pass or fail on EROFS instead of on the port.
      const checkout2 = freshCheckout();
      const startCmd = resolveStartCommand(checkout2);
      const h = await startServer({ debug: true });

      let p2: ChildProcessWithoutNullStreams | null = null;
      let stdout = "";
      let stderr = "";

      try {
        // The SAME start command the first server used — a second copy that
        // could not boot at all would "pass" this gate for the wrong reason.
        p2 = spawn("node", [...startCmd.flags, startCmd.entrypoint], {
          cwd: checkout2,
          // PORT must match the first server's, or there is no collision to
          // observe: this gate is about what happens when the port is TAKEN,
          // and a second copy left to its own default would simply bind a
          // different port and run happily forever.
          env: { ...process.env, PORT: String(PORT), DEBUG_API: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });

        p2.stdout.setEncoding("utf8");
        p2.stderr.setEncoding("utf8");
        p2.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        p2.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });

        const result = await waitForExitWithTimeout(p2, 6_000);
        expect(result.timedOut).toBe(false);
        expect(result.code).not.toBe(0);

        const combined = `${stdout}\n${stderr}`;
        expect(combined).toContain(String(PORT));
        expect(combined).toMatch(/in use|already/i);
      } finally {
        if (p2 && p2.exitCode === null) {
          try {
            p2.kill("SIGKILL");
          } catch {
            // best-effort cleanup only
          }
        }

        await stopServer(h);
        fs.rmSync(checkout2, { recursive: true, force: true });
        await freePort(PORT);
      }
    });
  });
});
