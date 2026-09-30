import { beforeAll, describe, expect, it } from "vitest";
import {
  api,
  debugRoll,
  debugSetState,
  emptyPoints,
  getState,
  loadEngine,
  makeState,
  startServer,
  stopServer,
} from "../lib/harness.ts";

type Move = { from: number; to: number; die: number };
type Board = {
  points: number[];
  bar: { white: number; black: number };
  off: { white: number; black: number };
};

const STARTING_POINTS_EXPECTED = [
  0, -2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5, 5, 0, 0, 0, -3, 0, -5, 0, 0, 0,
  0, 2, 0,
];

const norm = (ms: Move[]) => ms.map((m) => `${m.from}-${m.to}-${m.die}`).sort();

const bd = (
  pts: number[],
  bar = { white: 0, black: 0 },
  off = { white: 0, black: 0 },
): Board => ({ points: pts, bar, off });

// Imported by directive for parity with future gates that exercise debug HTTP routes.
void { startServer, stopServer, debugSetState, debugRoll, getState, api, makeState };

describe("Backgammon backend gates 01-08", () => {
  let game: any;
  let ai: any;

  beforeAll(async () => {
    ({ game, ai } = await loadEngine());
    expect(game).toBeTruthy();
    expect(ai).toBeTruthy();
  });

  it("[G01] REQ-INIT — initial position", () => {
    // Each assertion names its aspect, so the model hears which part of a new
    // game is wrong (harness/adapters/challenge/feedback.py _ASPECT_RE), not a
    // list of everything this gate happens to check.
    const PIECES = "[aspect: pieces]";
    const SETUP = "[aspect: setup]";
    const points = game.startingPoints();

    expect(points, PIECES).toEqual(STARTING_POINTS_EXPECTED);

    const state = game.createGame("medium");
    expect(state.turn, SETUP).toBe("white");
    expect(state.phase, SETUP).toBe("openingRoll");
    expect(state.cube, SETUP).toEqual({ value: 1, owner: null });
    expect(state.bar, PIECES).toEqual({ white: 0, black: 0 });
    expect(state.off, PIECES).toEqual({ white: 0, black: 0 });
    expect(state.difficulty, SETUP).toBe("medium");
    expect(state.winner, SETUP).toBeNull();
    expect(state.points, PIECES).toEqual(game.startingPoints());
    expect(state.points, PIECES).toEqual(STARTING_POINTS_EXPECTED);

    expect(game.opponent("white"), "[aspect: opponent]").toBe("black");
    expect(game.opponent("black"), "[aspect: opponent]").toBe("white");
  });

  it("[G02] REQ-PIP — pip count", () => {
    // THE OPENING POSITION ONLY. This is a stage-2 check ("a new game looks
    // right"), and its complaint describes a fresh board. It used to also count
    // bar positions and a nearly finished game; once the opening was fixed the
    // model kept being told the fresh board was wrong while the failure was on
    // the bar (run 1789655638). Bar counts live in [E06], stage 4. The nearly
    // finished case added nothing: the opening already tests both formulas.
    // The STANDARD opening, not the build's own: a build that sets up the wrong
    // position counts its own board right, and the player sees pip counts that
    // add up for the pieces shown — the setup is G01's complaint, not a second
    // one here (run 1790349319: 139/178 on a wrong opening, told as "doesn't
    // add up").
    const start = bd([...STARTING_POINTS_EXPECTED], { white: 0, black: 0 }, { white: 0, black: 0 });
    expect(game.pipCount(start, "white")).toBe(167);
    expect(game.pipCount(start, "black")).toBe(167);
  });

  it("[G03] REQ-DICE — dice → moves", () => {
    const start = bd([...game.startingPoints()], { white: 0, black: 0 }, { white: 0, black: 0 });

    // One complaint per fault (Jerry, 2026-09-24): a broken double must not be
    // told as a broken plain roll too, nor the other way round.
    expect(game.maxPlies(start, "white", [3, 3, 3, 3]), "[aspect: doublemoves]").toBe(4);
    expect(game.maxPlies(start, "white", [3, 1]), "[aspect: plainmoves]").toBe(2);
    expect(game.maxPlies(start, "black", [6, 6, 6, 6]), "[aspect: doublemoves]").toBe(4);
  });

  it("[G04] REQ-MOVES — legal-move generation (blocked points)", () => {
    const pts = emptyPoints();
    pts[8] = 1;
    pts[5] = -2;
    const board = bd(pts);

    const blocked = game.singleMoves(board, "white", 3) as Move[];
    expect(norm(blocked)).toEqual(norm([]));
  });

  it("[G17] REQ-MOVES — legal-move generation (hits)", () => {
    const pts = emptyPoints();
    pts[8] = 1;
    pts[6] = -1;
    const board = bd(pts);

    const hit = game.singleMoves(board, "white", 2) as Move[];
    expect(norm(hit)).toEqual(norm([{ from: 8, to: 6, die: 2 }]));
  });

  it("[G18] REQ-MOVES — legal-move generation (die 6 from the outer points)", () => {
    // Move-generation for the opening roll's die 6, isolated from the bear-off
    // precondition: the home board is empty, so a 6 moves only the OUTER
    // checkers (points 24, 13, 8). "Point 6 must not bear off before all
    // checkers are home" is G09's rule (stage 5), not this check's — asserting
    // it here made the bear-off-before-home mutation (M18) fire at stage 3
    // with the "opening-6 blocked checkers" symptom instead of G09's true one.
    const pts = emptyPoints();
    pts[24] = 2;
    pts[13] = 5;
    pts[8] = 3;
    const board = bd(pts);
    const dieSixMoves = game.singleMoves(board, "white", 6) as Move[];
    const fromValues = [...new Set(dieSixMoves.map((m) => m.from))].sort((a, b) => a - b);

    expect(fromValues).toEqual([8, 13, 24]);
  });

  it("[G06] REQ-BAR — bar re-entry + blocked pass", () => {
    const REENTER = "[aspect: reenter]";
    const BLOCKED = "[aspect: blocked]";
    const entryPts = emptyPoints();
    entryPts[10] = -1;
    entryPts[8] = 1;
    const entryBoard = bd(entryPts, { white: 1, black: 0 }, { white: 0, black: 0 });

    // Which fault, told as the player meets it: another piece moving while one
    // waits on the bar; no way back in at all; or a way back in on the wrong
    // point. Run 1790633807's bar piece came in at the wrong end (a 2 entered
    // on point 2, not 23, its hint drawn there) and was told "the game let me
    // play other pieces".
    const entryMoves = game.singleMoves(entryBoard, "white", 2) as Move[];
    expect(entryMoves.every((m) => m.from === 0), REENTER).toBe(true);
    expect(entryMoves.length, "[aspect: noentry] no way in off the bar onto an open point").toBeGreaterThan(0);
    expect(norm(entryMoves), "[aspect: wrongpoint] the bar piece is offered the wrong point").toEqual(
      norm([{ from: 0, to: 23, die: 2 }]),
    );

    const blockedPts = emptyPoints();
    blockedPts[23] = -2;
    blockedPts[21] = -2;
    const blockedBoard = bd(blockedPts, { white: 1, black: 0 }, { white: 0, black: 0 });

    expect(game.legalMovesNow(blockedBoard, "white", [2, 4]), BLOCKED).toEqual([]);
  });

  it("[G07] REQ-HIT — hitting → bar", () => {
    const pts = emptyPoints();
    pts[8] = 1;
    pts[5] = -1;
    const board = bd(pts);

    const hit = game.applyMove(board, "white", { from: 8, to: 5, die: 3 });
    expect(hit).toBe(true);
    expect(board.points[5]).toBe(1);
    expect(board.bar.black).toBe(1);
    expect(board.points[8]).toBe(0);
  });

  it("[G08] REQ-BEAROFF — bear-off incl overshoot", () => {
    const overshootAllowedPts = emptyPoints();
    overshootAllowedPts[3] = 2;
    const overshootAllowedBoard = bd(overshootAllowedPts, { white: 0, black: 0 }, { white: 13, black: 0 });

    // Two faults, each told as itself. Refusing a number bigger than the
    // furthest-back piece needs (run 1790650821: pieces only on 3, a 5, no move
    // at all) was told "the game still lets me bear off from a point closer to
    // the edge" — the opposite.
    const OVERSHOOT = "[aspect: overshoot]";
    expect(game.allInHome(overshootAllowedBoard, "white"), OVERSHOOT).toBe(true);
    expect(norm(game.singleMoves(overshootAllowedBoard, "white", 5) as Move[]), OVERSHOOT).toEqual(
      norm([{ from: 3, to: 25, die: 5 }]),
    );

    const overshootRejectedPts = emptyPoints();
    overshootRejectedPts[5] = 1;
    overshootRejectedPts[3] = 1;
    const overshootRejectedBoard = bd(overshootRejectedPts, { white: 0, black: 0 }, { white: 13, black: 0 });

    const dieFiveMoves = game.singleMoves(overshootRejectedBoard, "white", 5) as Move[];
    expect(norm(dieFiveMoves)).not.toContain("3-25-5");
    // The exact 5 not bearing off is the exact-die gate's finding (E03).
    expect(norm(dieFiveMoves), "[needs: E03]").toEqual(norm([{ from: 5, to: 25, die: 5 }]));
  });
});
