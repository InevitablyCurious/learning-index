import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  debugRoll,
  debugRollVerified,
  debugSetState,
  emptyPoints,
  getState,
  loadEngine,
  makeState,
  openingPoints,
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
    // The OPENING roll is one die per side and can never be four (G31), so
    // seed a LATER "roll" phase — the standard opening board, human to act —
    // and hunt the doubles there.
    let doubleState: any = null;
    for (let attempt = 0; attempt < 200 && !doubleState; attempt++) {
      await debugSetState(
        makeState({
          turn: "white",
          phase: "roll",
          dice: [],
          remainingDice: [],
          points: game.startingPoints(),
          bar: { white: 0, black: 0 },
          off: { white: 0, black: 0 },
        }),
      );
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
    const rolled = await debugRollVerified([1, 2]);
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
    // An ordinary turn from the opening position: a new game starts with the
    // opening roll (G31), which is not this check's subject.
    await debugSetState(makeState({ points: openingPoints(), turn: "white", phase: "roll" }));
    const before = await debugRollVerified([3, 1]);
    // No move to undo is not an undo finding: the movable-checker gates report
    // a roll that leaves no move when they fail too (a needs marker,
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
    const rolled = await debugRollVerified([1, 2]);
    // Finishing the game is the bear-off and win checks' ground (a needs marker).
    const winMove = (rolled.legalMoves as Move[]).find((m) => m.from === 1 && m.to === 25);
    expect(winMove, "[needs: G08]").toBeTruthy();
    await api("/api/move", { from: winMove!.from, to: winMove!.to, die: winMove!.die });
    const finished = await getState();
    expect(finished.winner, "[needs: G10]").toBe("white");
    // The prompt: gamesPlayed counts finished games — it goes up by one when a
    // game ends — and /api/new carries it forward. Each fault its own line.
    expect(finished.gamesPlayed, "[aspect: counted] the finished game was not counted").toBeGreaterThan(before);
    await api("/api/new", {});
    const fresh = await getState();
    expect(fresh.gamesPlayed, "[aspect: carried] a new game lowered the count").toBeGreaterThanOrEqual(finished.gamesPlayed);
    expect(fresh.gamesPlayed, "[aspect: extra] a new game raised the count").toBeLessThanOrEqual(finished.gamesPlayed);
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

  // The opening roll: ONE die per side; the higher side makes the first move
  // with both numbers; equal dice tie and roll again; nobody doubles before
  // the opening move is played. The order of the pair in the state is the
  // team's contract (F63), so the dice are compared here in any order.
  it("[G31] REQ-OPENING — the opening roll decides who goes first", async () => {
    // Black's pip count, counted here: black travels 1 → 24, so a checker on
    // point p is 25 - p from home, and one on the bar is 25.
    const blackPips = (s: any): number => {
      let pips = 25 * s.bar.black;
      for (let p = 1; p <= 24; p++) if (s.points[p] < 0) pips += -s.points[p] * (25 - p);
      return pips;
    };

    // The player's die is higher: the first move is the player's, with both
    // numbers still to play.
    await api("/api/new", { difficulty: "easy" });
    let state = await debugRollVerified([6, 5]);
    expect(state.turn, "[aspect: won]").toBe("white");
    expect(state.phase, "[aspect: dice]").toBe("move");
    expect(state.remainingDice, "[aspect: dice]").toContain(6);
    expect(state.remainingDice, "[aspect: dice]").toContain(5);

    // Equal dice: still the opening roll.
    await api("/api/new", { difficulty: "easy" });
    state = await debugRollVerified([4, 4]);
    expect(state.phase, "[aspect: tie] [needs: G01]").toBe("openingRoll");

    // Nobody doubles before the opening move is played: not offered, and a
    // double asked for anyway changes nothing — refused with an error status
    // or answered with the state unchanged, either way.
    await api("/api/new", { difficulty: "easy" });
    state = await getState();
    expect(state.canDouble, "[aspect: cube]").toBe(false);
    await api("/api/double", {}).catch(() => undefined);
    state = await getState();
    expect(state.cube.value, "[aspect: cubemoved]").toBe(1);
    expect(state.phase, "[aspect: cubemoved]").not.toBe("doubleOffered");
    expect(state.winner, "[aspect: cubemoved]").toBeNull();

    // The computer's die is higher: its first move is made with those same two
    // numbers — nothing can be hit at the opening, so the pips it moves are their
    // sum — and then the turn is the player's. Easy never doubles, so the
    // computer's turn is only its move. A computer that rolls fresh dice for that
    // move went 5, 6, 7, 8, 7 pips on server code that never changed, and passed
    // whenever a random roll made 8 (run f3c91051, round 4; WO-GATE-WALL-FLUKES).
    // So the openings have sums a random roll seldom makes (1-2 = 3, 5-6 = 11),
    // and behind each sits a queued roll no opening move uses: a re-rolling
    // computer takes it and moves a sum no opening gives; a correct one leaves it
    // for the player's next roll, which drains it. Last in this test, so a
    // computer that ignores its numbers never hides the tie or the cube.
    for (const [opening, decoy] of [
      [[1, 2], [6, 6]],
      [[5, 6], [1, 1]],
    ] as const) {
      await api("/api/new", { difficulty: "easy" });
      state = await debugRollVerified([...opening]);
      expect(state.turn, "[aspect: first]").toBe("black");
      const pipsBefore = blackPips(state);
      await debugRoll([...decoy]);
      await api("/api/ai", {});
      state = await getState();
      expect(pipsBefore - blackPips(state), "[aspect: numbers]").toBe(opening[0] + opening[1]);
      expect(state.turn, "[aspect: handback]").toBe("white");
      await api("/api/roll", {});
    }
  });

  // The computer stuck is a turn returned, not a turn hung: black on the bar
  // with every entry point held and a roll it cannot use must pass the turn
  // back AND say why.
  it("[G32] REQ-TURN — when the computer is stuck, the game says so and the turn returns", async () => {
    const points = emptyPoints();
    for (let p = 1; p <= 6; p++) points[p] = 2; // white wall on 1..6 (12 white)
    points[13] = 3; // +3 white = 15 white
    points[12] = -5;
    points[17] = -5;
    points[19] = -4; // black = 14 on board, +1 on bar = 15
    // phase "move" makes /api/ai play these dice directly — no cube decision.
    await debugSetState(
      makeState({
        points,
        bar: { white: 0, black: 1 },
        off: { white: 0, black: 0 },
        turn: "black",
        phase: "move",
        dice: [6, 5],
        message: "",
      }),
    );
    const state = await api("/api/ai", {});
    expect(state.turn, "[aspect: pass] [needs: G25]").toBe("white");
    expect(state.message, "[aspect: wording] [needs: F05]").toMatch(/no moves available/i);
  });
});
