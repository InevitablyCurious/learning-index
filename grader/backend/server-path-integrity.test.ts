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
  ordinaryTurn,
  seedRolled,
} from "../lib/harness.ts";

type Move = { from: number; to: number; die: number };
type Board = {
  points: number[];
  bar: { white: number; black: number };
  off: { white: number; black: number };
};

describe("Backgammon backend server-path integrity", () => {
  let game: any;
  let ai: any;
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    ({ game, ai } = await loadEngine());
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
    // A gammon named as something else is the classification's finding (G10's
    // own line); only a gammon that scores wrong is told as the points.
    expect(state.winType).toBe("gammon");
    expect(state.pointsWon, "[aspect: points]").toBe(2);
  });

  // M25: undo restores the board exactly — no checker lost.
  it("[G23] REQ-UNDO — undo restores the board exactly", async () => {
    // An ordinary turn from the opening position: a new game starts with the
    // opening roll (G31), which is not this check's subject.
    await ordinaryTurn();
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

    // A hit taken back: the computer's piece returns to its point and leaves the
    // bar. Jerry, 2026-11-02, playing run 1793615343's build: two black pieces on
    // the bar and seventeen in all — its undo put a hit piece back AND added one
    // to the bar.
    const points = emptyPoints();
    points[24] = 2; points[13] = 5; points[8] = 3; points[6] = 5;
    points[10] = -1; points[1] = -2; points[12] = -4; points[17] = -3; points[19] = -5;
    await seedRolled(makeState({ points, bar: { white: 0, black: 0 }, off: { white: 0, black: 0 } }), [3, 1]);
    const hitBefore = await getState();
    const hitMove = (hitBefore.legalMoves as Move[]).find((m) => m.from === 13 && m.to === 10);
    expect(hitMove, "[needs: G04]").toBeTruthy();
    await api("/api/move", { from: 13, to: 10, die: 3 });
    const hitUndone = await api("/api/undo", {});
    const hit = "[aspect: hit] after a hit was taken back the board was not as it was";
    expect(hitUndone.points, hit).toEqual(hitBefore.points);
    // Whose piece is left on the bar is named (Jerry, 2026-11-12): run
    // 1794493441's build put the computer's piece back and left one of the
    // player's own on the bar, and "extra pieces of the computer's" was false.
    expect(
      hitUndone.bar.white,
      `[aspect: hitmine] after a hit was taken back the player's pieces on the bar went from ${hitBefore.bar.white} to ${hitUndone.bar.white}`,
    ).toBe(hitBefore.bar.white);
    expect(hitUndone.bar, hit).toEqual(hitBefore.bar);
  });

  // Races from even to hopeless for black (white falling behind a checker at a
  // time), each played to the computer's turn through End Turn; the offer from
  // the middle race the build doubles on, or the last state when none does.
  const raceLadder = () => {
    const races: { points: number[]; off: { white: number; black: number } }[] = [];
    for (let whiteOff = 10; whiteOff >= 0; whiteOff -= 2) {
      const points = emptyPoints();
      points[19] = -5; // black 30 pips, ten off
      points[6] = 15 - whiteOff;
      races.push({ points, off: { white: whiteOff, black: 10 } });
    }
    return races;
  };
  const toComputersTurn = async (race: { points: number[]; off: { white: number; black: number } }) => {
    await api("/api/new", {});
    await debugSetState(
      makeState({
        ...race,
        bar: { white: 0, black: 0 },
        turn: "white",
        phase: "move",
        dice: [6, 5],
        remainingDice: [],
        turnOver: true,
        cube: { value: 1, owner: null },
        difficulty: "hard",
        winner: null,
      }),
    );
    let play = await api("/api/endturn", {});
    for (let guard = 0; guard < 12 && play.turn === "black" && play.phase !== "doubleOffered" && !play.winner; guard++) {
      play = await api("/api/ai", {});
    }
    return play;
  };
  const offeredRace = async () => {
    const offering = [];
    let last: any;
    for (const race of raceLadder()) {
      last = await toComputersTurn(race);
      if (last.phase === "doubleOffered") offering.push(race);
    }
    if (offering.length === 0) return last;
    return toComputersTurn(offering[Math.floor((offering.length - 1) / 2)]!);
  };

  // M24: accepting the computer's double makes the cube 2, owned by the player.
  it("[G24] REQ-CUBE-ACCEPT — accepting the computer's double makes the cube 2", async () => {
    // Reached the way a game reaches it: white ends its turn, and the computer,
    // well ahead in a race on hard, offers on its own turn. The spec does not say whether the cube doubles at the offer or at the take;
    // an offer injected at cube 1 suits only the second (run 1793627441's server
    // doubled at the offer, showed 2 after the take, and was told "the cube
    // stayed at one"). Either way the taken cube is 2 and the player's.
    // The race is one the build itself doubles on: the win-chance formula is
    // the build's, so a fixed race sits inside its window for some formulas and
    // below it for others (run 1793743564 round 4 rated black 0.77 here, held
    // by its own rule, and the check read that as a lost offer).
    const play = await offeredRace();
    expect(play.phase, "[needs: G12 F49] the computer never offered a double").toBe("doubleOffered");
    const res = await api("/api/double/respond", { accept: true });
    expect(res.cube.value).toBe(2);
    const OWNER = "[aspect: owner] the taken cube was not the player's";
    expect(res.cube.owner, OWNER).toBe("white");
    const state = await getState();
    expect(state.cube.value).toBe(2);
    expect(state.cube.owner, OWNER).toBe("white");

    // The doubler still plays the turn it doubled on: the computer moves before
    // the player rolls (run 1793642496's build handed the turn straight back,
    // and the computer never played).
    const blackOf = (st: any) =>
      JSON.stringify([(st.points as number[]).map((v) => (v < 0 ? v : 0)), st.bar.black, st.off.black]);
    const before = blackOf(state);
    let after = state;
    for (let guard = 0; guard < 12 && after.turn === "black"; guard++) {
      after = await api("/api/ai", {});
    }
    expect(blackOf(after), "[aspect: plays] after the take the computer skipped its turn").not.toBe(before);
  });

  // The computer doubles before it rolls, as a player may: run 1793672355's build
  // rolled first and offered with its dice on the table. The first race of the
  // ladder the build offers in is judged; a build that never offers is G12's and
  // F49's finding, not this one's.
  it("[G24] REQ-CUBE-ACCEPT — the computer doubles before it rolls", async () => {
    const wouldDouble: number[] = [];
    for (const race of raceLadder()) {
      const play = await toComputersTurn(race);
      if (play.phase !== "doubleOffered") {
        try {
          if (ai.shouldAiDouble({ ...race, bar: { white: 0, black: 0 } }, "black", { value: 1, owner: null }, "hard")?.action === "double") {
            wouldDouble.push(race.off.white);
          }
        } catch {}
        continue;
      }
      expect(play.remainingDice ?? [], "[aspect: before] the computer rolled before it offered its double").toEqual([]);
      return;
    }
    // No race drew an offer. When the build's own cube judgement said double in
    // one of them, the offer was lost on the way to the board — not G12's
    // finding (run 1793736621 round 2 let the computer double only in a phase
    // its turn never has, and the player heard only "it doubles at the wrong
    // moments").
    expect(wouldDouble, "[aspect: never] the computer, far ahead, never offered a double").toEqual([]);
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
      // /api/ai advances ONE AI step (chunk-03): a build may play the whole turn
      // in one call or one move per call. Step it until the turn comes back, as
      // G33 does (run 1793568361 round 5: shown dice, move 1, move 2 — 3 and 11
      // pips — and a single call was told "doesn't use the two numbers").
      for (let guard = 0; guard < 12; guard++) {
        state = await api("/api/ai", {});
        if (state.turn !== "black") break;
      }
      state = await getState();
      expect(pipsBefore - blackPips(state), "[aspect: numbers]").toBe(opening[0] + opening[1]);
      expect(state.turn, "[aspect: handback]").toBe("white");
      await api("/api/roll", {});
    }
  });

  // [G36] One roll per turn, through the API (Jerry, 2026-11-12: a build that
  // rolled again for a player who had played his whole roll let him skip the
  // computer's turn). Ignored or refused, a second roll changes nothing.
  it("[G36] REQ-ROLL-ONCE — a roll asked for after the dice are down changes nothing", async () => {
    await api("/api/new", {});
    let state = await debugRollVerified([5, 3]);
    expect(state.turn).toBe("white");
    for (let guard = 0; guard < 6 && state.remainingDice.length > 0 && (state.legalMoves ?? []).length > 0; guard++) {
      const m = state.legalMoves[0];
      state = await api("/api/move", { from: m.from, to: m.to, die: m.die });
    }
    expect(state.remainingDice.length, "the opening roll could not be played out through the API").toBe(0);
    // No decoy roll is queued: a correct build never takes it, and a dice queue
    // left behind would be the next check's roll. A second roll shows anyway —
    // new dice to play.
    const dice = JSON.stringify(state.dice);
    let after = await api("/api/roll", {}).catch(() => null);
    after = after ?? (await getState());
    expect(
      after.turn === "white" && after.remainingDice.length === 0 && JSON.stringify(after.dice) === dice,
      `a second /api/roll rolled again: dice ${JSON.stringify(after.dice)}, ${after.remainingDice.length} to play`,
    ).toBe(true);
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
    // One AI step per call (chunk-03): step until the turn comes back, and read
    // what the game said along the way.
    let state = await getState();
    const said: string[] = [];
    // A double offered on the way is answered as a player would, by taking it:
    // run 1793637084's computer counted its own bar piece as a lead and doubled
    // here, and the loop that never answered was told "never gives the turn back".
    for (let guard = 0; guard < 12 && state.turn === "black"; guard++) {
      state =
        state.phase === "doubleOffered"
          ? await api("/api/double/respond", { accept: true })
          : await api("/api/ai", {});
      said.push(String(state.message ?? ""));
    }
    expect(state.turn, "[aspect: pass] [needs: G25]").toBe("white");
    expect(said.join(" | "), "[aspect: wording] [needs: F05]").toMatch(/no moves available/i);
  });

  // The computer offers a double when it is well ahead, not after every turn: from
  // the even opening position its first turn at any difficulty offers nothing
  // (run 1791408711's build offered after every computer turn, on medium too,
  // so the player was answering a double before the game had begun).
  it("[G33] REQ-CUBE-AI — the computer does not offer a double at an even start", async () => {
    for (const difficulty of ["easy", "medium", "hard"]) {
      await api("/api/new", {});
      await debugSetState(
        makeState({
          points: openingPoints(),
          turn: "black",
          phase: "move",
          dice: [3, 1],
          remainingDice: [3, 1],
          difficulty,
          cube: { value: 1, owner: null },
        }),
      );
      let state = await getState();
      let guard = 0;
      while (state.turn !== "white" && guard < 12) {
        state = await api("/api/ai", {});
        guard++;
      }
      expect(
        state.phase === "doubleOffered" || Boolean(state.doubleOfferedBy),
        `[aspect: early] the computer offered a double after its first turn on ${difficulty}`,
      ).toBe(false);

      // And through a real opening the computer wins (3 against 5), which is how a
      // player meets that first turn: run 1793634524's final build offered after
      // its first opening move, a path the seeded position above never took.
      await api("/api/new", { difficulty });
      let opened = await debugRollVerified([3, 5]);
      let offered = false;
      for (let g = 0; g < 12 && opened.turn !== "white"; g++) {
        if (opened.phase === "doubleOffered" || opened.doubleOfferedBy) {
          offered = true;
          break;
        }
        opened = await api("/api/ai", {});
      }
      offered = offered || opened.phase === "doubleOffered" || Boolean(opened.doubleOfferedBy);
      expect(offered, `[aspect: early] the computer offered a double in its opening turn on ${difficulty}`).toBe(false);
    }
  });

  // The computer's higher-die rule as a game plays it (2026-11-12): the
  // computer's dice come from its own roll, handed over the way its game hands
  // them, never in the check's order. Run 1794511349's engine took its dice in
  // the order given and tried only the first; its game always hands it the
  // bigger die first, so it played right in every game, while its move-chooser
  // called with [2, 4] played the 2 — and the player was told "the computer
  // plays the smaller die", which no player of that build could see. Reached
  // the way a game reaches the computer's turn: the player's turn finished, the
  // computer's dice queued, End Turn, then one AI step at a time. Two spots
  // where either number moves the computer's lone piece but not both (black
  // moves up the numbers): A, black on 5 and a white pair on 11, a 2 and a 4 —
  // only 5->9; B, black on 6, a white pair on 13 and a white blot on 8, a 5 and
  // a 2 — only 6->11 (the 2 would hit, which an evaluator likes). The player
  // owns the cube, so the computer cannot double first.
  it("[G30] REQ-HIGHER-DIE — the computer obeys the higher-die rule", async () => {
    const spots = [
      { black: 5, white: { 11: 2 }, off: { white: 13, black: 14 }, dice: [2, 4], higher: 4 },
      { black: 6, white: { 13: 2, 8: 1 }, off: { white: 12, black: 14 }, dice: [5, 2], higher: 5 },
    ];
    for (const spot of spots) {
      for (const difficulty of ["easy", "medium", "hard"]) {
        for (let trial = 0; trial < 3; trial++) {
          await api("/api/new", {});
          const points = emptyPoints();
          points[spot.black] = -1;
          for (const [at, n] of Object.entries(spot.white)) points[Number(at)] = n;
          await debugSetState(
            makeState({
              points,
              bar: { white: 0, black: 0 },
              off: spot.off,
              turn: "white",
              phase: "move",
              dice: [6, 5],
              remainingDice: [],
              turnOver: true,
              cube: { value: 2, owner: "white" },
              difficulty,
              winner: null,
            }),
          );
          await debugRoll(spot.dice);
          let state = await api("/api/endturn", {});
          for (let guard = 0; guard < 12 && state.turn === "black" && !state.winner; guard++) {
            state = await api("/api/ai", {});
          }
          expect(state.turn, "[needs: G25] the computer never finished its turn").toBe("white");
          const now = (state.points as number[]).findIndex((v, i) => i >= 1 && i <= 24 && v < 0);
          expect(now, "[aspect: passed] [needs: G25] the computer rolled and passed without moving its piece").not.toBe(spot.black);
          const played = now - spot.black;
          expect(played, `the computer played the ${played} when only the ${spot.higher} could be used`).toBe(spot.higher);
        }
      }
    }
  });
});
