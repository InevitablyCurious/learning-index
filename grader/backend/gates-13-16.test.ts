import fs from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PORT,
  api,
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
      await debugSetState(makeState({ points: openingPoints(), turn: "white", phase: "roll", difficulty: "easy" }));
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
      await debugSetState(makeState({ points: openingPoints(), turn: "white", phase: "roll", difficulty: "easy" }));
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

  describe("[G14] REQ-AILEGAL — AI legality + hard beats easy (seeded self-play)", () => {
    let game: any;
    let ai: any;
    const originalRandom = Math.random;

    function randomReachablePosition(rng: () => number): { board: Board; player: Player } {
      let board: Board = {
        points: [...game.startingPoints()],
        bar: { white: 0, black: 0 },
        off: { white: 0, black: 0 },
      };
      let player: Player = "white";

      const prepHalfTurns = 1 + Math.floor(rng() * 7);
      for (let i = 0; i < prepHalfTurns; i++) {
        const dice = rollDice(rng);
        const remaining = [...dice];

        while (remaining.length > 0) {
          const legal = game.legalMovesNow(board, player, remaining) as Move[];
          if (legal.length === 0) break;

          const pick = legal[Math.floor(rng() * legal.length)];
          game.applyMove(board, player, pick);
          removeDie(remaining, pick.die);
        }

        const win = game.checkWin(board, player);
        if (win.won) {
          board = {
            points: [...game.startingPoints()],
            bar: { white: 0, black: 0 },
            off: { white: 0, black: 0 },
          };
          player = "white";
          continue;
        }

        player = game.opponent(player);
      }

      return { board: game.cloneBoard(board), player };
    }

    function replayAndAssertLegal(
      startBoard: Board,
      player: Player,
      dice: number[],
      moves: Move[],
    ): Board {
      const board = game.cloneBoard(startBoard);
      const remaining = [...dice];

      for (const move of moves) {
        const legalNow = game.legalMovesNow(board, player, remaining) as Move[];
        const legal = legalNow.some((candidate) => sameMove(candidate, move));
        expect(legal).toBe(true);

        game.applyMove(board, player, move);
        removeDie(remaining, move.die);
      }

      return board;
    }

    beforeAll(async () => {
      ({ game, ai } = await loadEngine());
    });

    afterAll(() => {
      Math.random = originalRandom;
    });

    it("[G14] REQ-AILEGAL — chooseMoves always returns legal move sequences", () => {
      const seed = 0x13a4b6c8;
      Math.random = mulberry32(seed);

      const samples = 200;
      for (let i = 0; i < samples; i++) {
        const { board, player } = randomReachablePosition(Math.random);
        const dice = rollDice(Math.random);

        for (const difficulty of DIFFICULTIES) {
          const start = game.cloneBoard(board);
          const result = ai.chooseMoves(game.cloneBoard(board), player, [...dice], difficulty) as {
            moves: Move[];
            board: Board;
          };

          const replayed = replayAndAssertLegal(start, player, [...dice], result.moves);
          expect(result.board).toEqual(replayed);
        }
      }
    });

    it("[G14] REQ-AISTRENGTH — hard(black) wins more than easy(white) in seeded self-play", () => {
      const seed = 0x5eed1337;
      Math.random = mulberry32(seed);

      const games = 25;
      let hardWins = 0;
      let easyWins = 0;
      let noResult = 0;

      for (let g = 0; g < games; g++) {
        const start = game.createGame("medium");
        const board = cloneBoardFromState(start);
        let player: Player = "white";
        let winner: Player | null = null;

        for (let halfTurns = 0; halfTurns < 400; halfTurns++) {
          const dice = rollDice(Math.random);
          const difficulty: Difficulty = player === "black" ? "hard" : "easy";
          const choice = ai.chooseMoves(game.cloneBoard(board), player, [...dice], difficulty) as {
            moves: Move[];
            board: Board;
          };
          board.points = [...choice.board.points];
          board.bar = { ...choice.board.bar };
          board.off = { ...choice.board.off };

          const win = game.checkWin(board, player);
          if (win.won) {
            winner = player;
            break;
          }

          player = game.opponent(player);
        }

        if (winner === "black") hardWins++;
        else if (winner === "white") easyWins++;
        else noResult++;
      }

      expect(hardWins + easyWins + noResult).toBe(games);
      expect(hardWins + easyWins).toBeGreaterThan(0);
      expect(hardWins).toBeGreaterThan(easyWins);
    });
  });

  // [G15] REQ-COMPLETE lived here and is QUARANTINED — it flipped on
  // byte-identical code. See quarantine/G15-req-complete.test.ts for the
  // evidence and what it would take to re-admit it.

  describe("[G30] REQ-HIGHER-DIE — the computer obeys the higher-die rule (seeded mp===1 trials)", () => {
    let game: any;
    let ai: any;

    beforeAll(async () => {
      ({ game, ai } = await loadEngine());
    });

    it("[G30] REQ-HIGHER-DIE — the computer obeys the higher-die rule", () => {
      const originalRandom = Math.random;
      Math.random = mulberry32(0x9e3779b9);

      try {
        const player: Player = "white";

        // Two deterministic positions with exactly one die playable (mp === 1),
        // non-doubles, both dice individually playable — the exact shape where
        // the rule says only the HIGHER die is legal. G14's fuzz never lands on
        // it, so the computer's published move-chooser is driven on them
        // directly, at every difficulty, several times.
        // A: white on 20, black pair on 14. A 2 (20→18) and a 4 (20→16) both
        // move, but either leaves the other die facing the pair. Only the 4 is
        // legal (20→16).
        const boardA: Board = {
          points: emptyPoints(),
          bar: { white: 0, black: 0 },
          off: { white: 0, black: 0 },
        };
        boardA.points[20] = 1;
        boardA.points[14] = -2;
        const diceA = [2, 4];

        // B: white on 19, black pair on 12, black blot on 17. A 5 (19→14) and
        // a 2 (19→17, hitting the blot) both move, but either leaves the other
        // die facing the pair. Only the 5 is legal (19→14). On a build without
        // the rule, evaluation prefers the hit, so hard/medium play the lower
        // die deterministically.
        const boardB: Board = {
          points: emptyPoints(),
          bar: { white: 0, black: 0 },
          off: { white: 0, black: 0 },
        };
        boardB.points[19] = 1;
        boardB.points[12] = -2;
        boardB.points[17] = -1;
        const diceB = [5, 2];

        for (const { board, dice } of [
          { board: boardA, dice: diceA },
          { board: boardB, dice: diceB },
        ]) {
          // Setup sanity, not a gate finding: a genuine higher-required case —
          // exactly one distinct die is playable, and it is the higher one.
          const legal = game.legalMovesNow(board, player, [...dice]) as Move[];
          const distinctDice = Array.from(new Set(legal.map((m) => m.die)));
          // The position only tests the computer when the game's own move list
          // already keeps the higher die; when it does not, the player's
          // higher-die check (G05) reports it.
          expect(distinctDice.length, "[needs: G05]").toBe(1);
          expect(distinctDice[0], "[needs: G05]").toBe(Math.max(...dice));

          for (const difficulty of DIFFICULTIES) {
            for (let trial = 0; trial < 40; trial++) {
              const result = ai.chooseMoves(game.cloneBoard(board), player, [...dice], difficulty) as {
                moves: Move[];
                board: Board;
              };
              for (const move of result.moves) {
                const ok = legal.some((candidate) => sameMove(candidate, move));
                expect(ok, "[needs: G14]").toBe(true);
              }
            }
          }
        }
      } finally {
        Math.random = originalRandom;
      }
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
