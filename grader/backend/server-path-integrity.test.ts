import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("Backgammon backend server-path integrity", () => {
  let game: any;
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    ({ game } = await loadEngine());
    server = await startServer({ debug: true });
  });

  afterAll(async () => {
    await stopServer(server);
  });

  // M09: a real doubles roll through /api/roll yields four dice, not two.
  it("[G03] REQ-DICE — a real doubles roll through /api/roll yields four dice", async () => {
    let doubleState: any = null;
    for (let attempt = 0; attempt < 200 && !doubleState; attempt++) {
      await api("/api/new", { difficulty: "medium" });
      const state = await api("/api/roll", {});
      if (state.dice.length === 4) doubleState = state;
    }
    expect(doubleState, "[aspect: doubles]").not.toBeNull();
    const state = doubleState!;
    expect(new Set(state.dice).size).toBe(1);
    expect(state.remainingDice.length, "[aspect: doubles]").toBe(4);
    expect(state.legalMoves.length).toBeGreaterThan(0);
    const board: Board = { points: state.points, bar: state.bar, off: state.off };
    expect(game.maxPlies(board, "white", state.remainingDice)).toBeGreaterThanOrEqual(3);
  });

  // M21: a gammon win scores double points (pointsWon === 2), not single.
  it("[G10] REQ-WINCLASS — a gammon win scores double points", async () => {
    const points = emptyPoints();
    points[1] = 1; // one white checker on point 1 (distance 1)
    points[13] = -15; // black's 15 checkers, none in white's home (1-6)
    await debugSetState(
      makeState({
        points,
        bar: { white: 0, black: 0 },
        off: { white: 14, black: 0 },
        turn: "white",
        phase: "roll",
        dice: [],
        remainingDice: [],
        cube: { value: 1, owner: null },
        winner: null,
        winType: null,
        pointsWon: 0,
        message: "",
      }),
    );
    await debugRoll([1, 2]);
    const rolled = await api("/api/roll", {});
    const winMove = (rolled.legalMoves as Move[]).find((m) => m.from === 1 && m.to === 25);
    expect(winMove).toBeTruthy();
    await api("/api/move", { from: winMove!.from, to: winMove!.to, die: winMove!.die });
    const state = await getState();
    expect(state.winner).toBe("white");
    expect(state.winType, "[aspect: points]").toBe("gammon");
    expect(state.pointsWon, "[aspect: points]").toBe(2);
  });

  // M25: undo restores the board exactly — no checker lost.
  it("[G23] REQ-UNDO — undo restores the board exactly", async () => {
    await api("/api/new", { difficulty: "medium" });
    await debugRoll([3, 1]);
    const before = await api("/api/roll", {});
    expect(before.phase).toBe("move");
    const move = (before.legalMoves as Move[])[0];
    expect(move).toBeTruthy();
    const beforeBoard = {
      points: [...before.points],
      bar: { ...before.bar },
      off: { ...before.off },
    };
    await api("/api/move", { from: move!.from, to: move!.to, die: move!.die });
    const afterUndo = await api("/api/undo", {});
    expect(afterUndo.points).toEqual(beforeBoard.points);
    expect(afterUndo.bar).toEqual(beforeBoard.bar);
    expect(afterUndo.off).toEqual(beforeBoard.off);
  });

  // M24: accepting the computer's double makes the cube 2, owned by the player.
  it("[G24] REQ-CUBE-ACCEPT — accepting the computer's double makes the cube 2", async () => {
    await debugSetState(
      makeState({
        cube: { value: 1, owner: null },
        phase: "doubleOffered",
        doubleOfferedBy: "black",
        turn: "black",
        winner: null,
      }),
    );
    const res = await api("/api/double/respond", { accept: true });
    expect(res.cube.value).toBe(2);
    expect(res.cube.owner).toBe("white");
    const state = await getState();
    expect(state.cube).toEqual({ value: 2, owner: "white" });
  });
});
