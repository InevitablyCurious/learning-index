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
    // No move at all is the movable-checker gate's complaint when an ordinary
    // roll gives none either (a needs marker, harness/adapters/challenge/stages.py).
    expect(
      state.legalMoves.length,
      "[aspect: nomove] [needs: REQ-HINT/hint F03 F25]",
    ).toBeGreaterThan(0);
    const board: Board = { points: state.points, bar: state.bar, off: state.off };
    expect(
      game.maxPlies(board, "white", state.remainingDice),
      "[aspect: doublemoves]",
    ).toBeGreaterThanOrEqual(3);
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
    // No move to undo is not an undo finding: the movable-checker gate plays
    // this same 3-1 opening roll and reports it when it fails too (a needs marker,
    // harness/adapters/challenge/stages.py).
    const noMove = "[aspect: nomove] [needs: REQ-HINT/hint F03 F25]";
    expect(before.phase, noMove).toBe("move");
    const move = (before.legalMoves as Move[])[0];
    expect(move, noMove).toBeTruthy();
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

  // A finished game is not the end of the count: /api/new carries gamesPlayed forward.
  it("[G27] REQ-NEWGAME-CARRY — a new game keeps gamesPlayed", async () => {
    const points = emptyPoints();
    points[1] = 1; // one white checker on point 1 (distance 1)
    points[13] = -15; // black's 15 checkers, none in white's home (1-6)
    const before = (await getState()).gamesPlayed;
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
    const finished = await getState();
    expect(finished.gamesPlayed).toBe(before + 1);
    await api("/api/new", {});
    const fresh = await getState();
    expect(fresh.gamesPlayed).toBe(before + 1);
  });

  // The debug route takes turnOver and gamesPlayed like any other state field.
  it("[G28] REQ-DEBUG-STATE — the debug route honours turnOver and gamesPlayed", async () => {
    const res = await api("/api/debug/state", { turnOver: true, gamesPlayed: 5 });
    expect(res.turnOver).toBe(true);
    expect(res.gamesPlayed).toBe(5);
    const state = await getState();
    expect(state.turnOver).toBe(true);
    expect(state.gamesPlayed).toBe(5);
  });

  // Deep links must not 404: every non-/api path serves the page.
  it("[G29] REQ-SPA-FALLBACK — any non-/api path serves the game page", async () => {
    const res = await fetch(`${server.baseUrl}/game`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") || "").toContain("text/html");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });
});
