import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadEngine,
  startServer,
  stopServer,
  debugSetState,
  debugRollVerified,
  getState,
  api,
  emptyPoints,
  makeState,
  openingPoints,
  ordinaryTurn,
} from "../lib/harness.ts";
import {
  DOUBLE_WINDOW,
  TAKE_POINT,
  expectedOfferAction,
  isNonDecreasing,
  withinParityBand,
} from "../lib/acceptance.ts";

const { game, ai } = await loadEngine();

const bd = (
  pts: number[],
  bar = { white: 0, black: 0 },
  off = { white: 0, black: 0 },
) => ({ points: pts, bar, off });

const refWp = (myPip: number, oppPip: number): number => {
  if (myPip === 0 && oppPip === 0) return 0.5;
  const raw = 1 / (1 + Math.exp(-0.045 * (oppPip - myPip)));
  return Math.max(0.02, Math.min(0.98, raw));
};

describe("[G09] REQ-BEAROFF-GATE — bear-off blocked while a checker is outside home / on bar", () => {
  it("[G09] REQ-BEAROFF-GATE — blocks bear-off when any white checker is outside home", () => {
    const points = emptyPoints();
    points[3] = 1;
    points[8] = 1; // outside white home
    // A position a game can reach: the rest of each side borne off. Run
    // 1793573164's engine counted home by its 15 checkers and, on a bare
    // two-checker board, offered 3 -> off; in any real game it refused it, and
    // the player was told "the game let me take a piece off" about a game that
    // never did.
    points[22] = -1;
    const board = bd(points, { white: 0, black: 0 }, { white: 13, black: 14 });

    expect(game.allInHome(board, "white")).toBe(false);

    const moves = game.singleMoves(board, "white", 3);
    expect(moves.every((m: { to: number }) => m.to !== 25)).toBe(true);
  });

  it("[G19] REQ-BEAROFF-GATE — blocks bear-off when white has any checker on the bar", () => {
    const points = emptyPoints();
    points[2] = 1;
    const board = bd(points, { white: 1, black: 0 });

    expect(game.allInHome(board, "white")).toBe(false);

    const moves = game.singleMoves(board, "white", 2);
    expect(moves.every((m: { to: number }) => m.to !== 25)).toBe(true);
  });
});

describe("[G10] REQ-WINCLASS — win / gammon / backgammon classification", () => {
  it("[G10] REQ-WINCLASS — classifies single when loser has already borne off at least one", () => {
    const points = emptyPoints();
    points[13] = -1;
    const board = bd(points, { white: 0, black: 0 }, { white: 15, black: 2 });

    expect(game.checkWin(board, "white")).toEqual({ won: true, type: "single" });
  });

  it("[G10] REQ-WINCLASS — classifies gammon when loser has no off, no bar, and none in winner home", () => {
    const points = emptyPoints();
    points[13] = -3;
    const board = bd(points, { white: 0, black: 0 }, { white: 15, black: 0 });

    expect(game.checkWin(board, "white")).toEqual({ won: true, type: "gammon" });
  });

  it("[G10] REQ-WINCLASS — classifies backgammon when loser checker is in winner home board", () => {
    const points = emptyPoints();
    points[3] = -1;
    const board = bd(points, { white: 0, black: 0 }, { white: 15, black: 0 });

    expect(game.checkWin(board, "white")).toEqual({ won: true, type: "backgammon" });
  });

  it("[G10] REQ-WINCLASS — classifies backgammon when loser still has a checker on the bar", () => {
    const points = emptyPoints();
    points[13] = -1;
    const board = bd(points, { white: 0, black: 1 }, { white: 15, black: 0 });

    expect(game.checkWin(board, "white")).toEqual({ won: true, type: "backgammon" });
  });

  it("[G10] REQ-WINCLASS — reports not-won when off count is below 15", () => {
    const points = emptyPoints();
    points[1] = 1;
    const board = bd(points, { white: 0, black: 0 }, { white: 14, black: 0 });

    expect(game.checkWin(board, "white").won).toBe(false);
  });
});

describe("[G11] REQ-CUBE-STATE — doubling-cube STATE machine (via server)", () => {
  let serverHandle: Awaited<ReturnType<typeof startServer>> | null = null;

  beforeAll(async () => {
    serverHandle = await startServer({ debug: true });
  });

  afterAll(async () => {
    if (serverHandle) {
      await stopServer(serverHandle);
    }
  });

  it("[G11] REQ-CUBE-STATE — the player may double on their turn with a centered cube", async () => {
    // A fresh game sits in the opening roll, where nobody may double yet
    // (G31). Reached as a game reaches it: the computer wins the opening (3
    // against 5), plays, and hands the turn over. A seeded turn read only the
    // debug route: run 1793713472's server kept a flag only play sets, the
    // seeded turn read "can't double" while every played turn could, and the
    // player was told "the game won't let me offer a double".
    await api("/api/new", {});
    let played = await debugRollVerified([3, 5]);
    for (let guard = 0; guard < 12 && played.turn === "black"; guard++) {
      played = await api("/api/ai", {});
    }
    expect(played.turn, "[needs: G31 F88] the computer's opening turn never came back").toBe("white");
    expect(played.canDouble, "on the player's first turn after the computer's opening, no double").toBe(true);
  });

  // A turn set up through the debug route plays like the same turn in a game:
  // the checks that seed a position and double from it lean on this. Run
  // 1793713472's server kept a flag only play sets, so a seeded turn could
  // never double while every played one could. The debug route is the team's.
  it("[G35] REQ-DEBUG-STATE — a seeded turn can double like a played one", async () => {
    // From a fresh game, as the seeding checks start (a played turn before it
    // would leave the build's flag set and hide the finding).
    await api("/api/new", {});
    await debugSetState(
      makeState({
        turn: "white",
        phase: "roll",
        cube: { value: 1, owner: null },
        winner: null,
        points: game.startingPoints(),
      }),
    );
    expect((await getState()).canDouble, "[needs: G11]").toBe(true);
  });

  it("[G26] REQ-CUBE-STATE — a new game starts with a centered cube", async () => {
    await api("/api/new", { difficulty: "medium" });
    const state = await getState();

    expect(state.cube).toEqual({ value: 1, owner: null });
  });

  it("[G20] REQ-CUBE-STATE — accepted human double doubles cube and transfers ownership to the taker", async () => {
    const VALUE = "[aspect: value]";
    const OWNER = "[aspect: owner]";
    // Standard backgammon: when the doubled player TAKES, the taker (here the AI,
    // black) owns the cube — not the doubler. A fresh game sits in the opening
    // roll, where a double is refused (G31), so seed a LATER turn: the even
    // opening board, where the AI's win prob is 0.5 >= its take point, so it
    // accepts.
    // Reached by play, as G11 is: the computer wins the opening and plays, and
    // on the player's turn the race is near even (run 1793713472's server kept a
    // flag only play sets, so a seeded turn could never double).
    await api("/api/new", {});
    let played = await debugRollVerified([3, 5]);
    for (let guard = 0; guard < 12 && played.turn === "black"; guard++) {
      played = await api("/api/ai", {});
    }
    expect((await getState()).canDouble, "[needs: G11]").toBe(true);
    const res = await api("/api/double");
    const state = await getState();
    // A double the computer passes ends the game with nobody taking the cube:
    // that is its take decision (G12), not the cube's (run 1793659780's build
    // passed even doubles, and the player was told the taker wasn't shown).
    expect(res.winner ?? null, "[needs: G12] the computer passed an even double").toBeNull();
    // An unanswered double is no take: run 1793709280's server left the
    // player's double waiting for a reply that never came, and the player was
    // told the taker wasn't shown as the owner.
    expect(res.phase, "[needs: F50] the computer never answered the double").not.toBe("doubleOffered");

    expect(res.cube.value, VALUE).toBe(2);
    expect(res.cube.owner, OWNER).toBe("black");
    expect(state.cube.value, VALUE).toBe(2);
    expect(state.cube.owner, OWNER).toBe("black");
  });

  it("[G21] REQ-CUBE-STATE — illegal double in move phase must not mutate cube", async () => {
    // An ordinary turn from the opening position: a new game starts with the
    // opening roll (G31), which is not this check's subject.
    await ordinaryTurn();
    await debugRollVerified([3, 1]);

    const before = await getState();
    expect(before.phase).toBe("move");
    expect(before.canDouble).toBe(false);

    // Refused with an error status or ignored — either way the cube stays.
    await api("/api/double").catch(() => undefined);
    const after = await getState();

    expect(after.cube).toEqual(before.cube);
  });
});

// The computer's take, as its own game asks it: a take function written with
// the cube before the difficulty is called that way, and its own words for take
// and pass count as the prompt's. Whether those words and that shape are the
// prompt's is the last G12 check's, scored and never told (Jerry, 2026-11-03).
const TAKE_WORDS = new Set(["double", "accept", "take"]);
const PASS_WORDS = new Set(["no-double", "decline", "pass", "drop"]);
function takeAnswer(board: unknown, difficulty: "easy" | "medium" | "hard"): string {
  const answer =
    ai.shouldAiAccept.length >= 4
      ? ai.shouldAiAccept(board, "black", { value: 1, owner: null }, difficulty)
      : ai.shouldAiAccept(board, "black", difficulty);
  const action = String(answer?.action);
  return TAKE_WORDS.has(action) ? "double" : PASS_WORDS.has(action) ? "no-double" : action;
}

describe("[G12] REQ-CUBE-AI — cube AI accept/decline and offer window thresholds", () => {
  it("[G12] REQ-CUBE-AI — accepts near-even cube offers across all difficulties", () => {
    const points = emptyPoints();
    points[6] = 5; // white pip 30
    points[19] = -5; // black pip 30
    // Positions a game can reach: the other ten of each side borne off (run
    // 1793660917's engine counted borne-off checkers, declined this race as five
    // checkers a side with none off, and took it in every game that reaches it).
    const board = bd(points, { white: 0, black: 0 }, { white: 10, black: 10 });

    const myPip = game.pipCount(board, "black");
    const oppPip = game.pipCount(board, "white");
    const wp = refWp(myPip, oppPip);

    expect({ myPip, oppPip }).toEqual({ myPip: 30, oppPip: 30 });
    expect(wp).toBe(0.5);
    expect(withinParityBand(ai.winProbability(board, "black"))).toBe(true);
    expect(wp).toBeGreaterThanOrEqual(TAKE_POINT.easy);
    expect(wp).toBeGreaterThanOrEqual(TAKE_POINT.medium);
    expect(wp).toBeGreaterThanOrEqual(TAKE_POINT.hard);
    expect(takeAnswer(board, "easy")).toBe("double");
    expect(takeAnswer(board, "medium")).toBe("double");
    expect(takeAnswer(board, "hard")).toBe("double");
  });

  it("[G12] REQ-CUBE-AI — declines when black win chance is below hard take point", () => {
    const points = emptyPoints();
    points[2] = 1; // white pip 2
    const board = bd(points, { white: 0, black: 14 }, { white: 14, black: 1 }); // black pip 350 from bar

    const myPip = game.pipCount(board, "black");
    const oppPip = game.pipCount(board, "white");
    const wp = refWp(myPip, oppPip);

    expect({ myPip, oppPip }).toEqual({ myPip: 350, oppPip: 2 });
    expect(wp).toBe(0.02);
    expect(ai.winProbability(board, "black"), "[needs: G22]").toBeLessThan(TAKE_POINT.hard);
    expect(wp).toBeLessThan(TAKE_POINT.hard);
    expect(takeAnswer(board, "hard")).toBe("no-double");
  });

  it("[G12] REQ-CUBE-AI — offers only inside hard window, never when blocked/easy/too-good", () => {
    const anyPoints = emptyPoints();
    anyPoints[6] = 1;
    anyPoints[19] = -1;
    const anyBoard = bd(anyPoints, { white: 0, black: 0 }, { white: 14, black: 14 });
    expect(
      ai.shouldAiDouble(anyBoard, "black", { value: 2, owner: "white" }, "hard")
        .action
    ).toBe("no-double");

    const windowPoints = emptyPoints();
    windowPoints[19] = -5; // black pip 30
    windowPoints[6] = 10; // white pip 60
    windowPoints[1] = 1; // white pip +1 => total 61
    const windowBoard = bd(windowPoints, { white: 0, black: 0 }, { white: 4, black: 10 });

    const windowMyPip = game.pipCount(windowBoard, "black");
    const windowOppPip = game.pipCount(windowBoard, "white");
    expect({ windowMyPip, windowOppPip }).toEqual({ windowMyPip: 30, windowOppPip: 61 });

    // REQ-WINPROB is formula-agnostic: on a board near the 0.90 "too good" ceiling, one
    // conforming monotonic model may rate this position INSIDE the offer window (=> double)
    // while a steeper conforming model rates it > 0.90 (=> hold, too good). The contract does
    // NOT fix a single decision here. So grade the candidate's OFFER for internal consistency
    // with its OWN win-probability estimate under the published REQ-CUBE-AI policy, rather than
    // forcing the reference formula's decision on this ambiguous board.
    const windowWpCand = ai.winProbability(windowBoard, "black");
    expect(
      ai.shouldAiDouble(windowBoard, "black", { value: 1, owner: null }, "hard").action
    ).toBe(expectedOfferAction(windowWpCand, "hard", true));
    // easy never offers a double, regardless of win probability
    expect(
      ai.shouldAiDouble(windowBoard, "black", { value: 1, owner: null }, "easy").action
    ).toBe(expectedOfferAction(windowWpCand, "easy", true));

    const tooGoodPoints = emptyPoints();
    tooGoodPoints[24] = -1; // black pip 1
    const tooGoodBoard = bd(tooGoodPoints, { white: 14, black: 0 }, { white: 1, black: 14 }); // white pip 350 from bar

    const tooGoodMyPip = game.pipCount(tooGoodBoard, "black");
    const tooGoodOppPip = game.pipCount(tooGoodBoard, "white");
    const tooGoodWp = refWp(tooGoodMyPip, tooGoodOppPip);

    expect({ tooGoodMyPip, tooGoodOppPip }).toEqual({ tooGoodMyPip: 1, tooGoodOppPip: 350 });
    expect(tooGoodWp).toBeGreaterThan(DOUBLE_WINDOW.upper);
    expect(ai.winProbability(tooGoodBoard, "black"), "[needs: G22]").toBeGreaterThan(DOUBLE_WINDOW.upper);
    expect(
      ai.shouldAiDouble(tooGoodBoard, "black", { value: 1, owner: null }, "hard")
        .action
    ).toBe("no-double");
  });

  // The cube functions answer as the build prompt writes them: (b, player,
  // difficulty) for a take, "double" for take/offer and "no-double" for
  // pass/hold. Run 1793683721's engine answered "accept" and took a cube
  // argument; every game still played right through its own server, and G12's
  // player line was told for words no player sees. Scored, never told (Jerry,
  // 2026-11-03: "leave G12 words untold").
  it("[G12] REQ-CUBE-AI — the cube functions answer in the build prompt's words", () => {
    const points = emptyPoints();
    points[6] = 5;
    points[19] = -5;
    const board = bd(points, { white: 0, black: 0 }, { white: 10, black: 10 });
    expect(ai.shouldAiAccept.length, "[untold] the take function does not take (board, player, difficulty)").toBe(3);
    const words = ["double", "no-double"];
    for (const difficulty of ["easy", "medium", "hard"] as const) {
      expect(words, "[untold] a cube answer outside double / no-double").toContain(ai.shouldAiAccept(board, "black", difficulty).action);
      expect(words, "[untold] a cube answer outside double / no-double").toContain(
        ai.shouldAiDouble(board, "black", { value: 1, owner: null }, difficulty).action,
      );
    }
  });

  it("[G22] REQ-WINPROB — winProbability is monotonically non-decreasing in the player's pip lead", () => {
    const fbPoints = emptyPoints();
    fbPoints[2] = 1;
    const farBehind = bd(fbPoints, { white: 0, black: 14 }); // black 350 vs white 2 (lead -348)
    const nePoints = emptyPoints();
    nePoints[6] = 5;
    nePoints[19] = -5;
    const nearEven = bd(nePoints); // 30 vs 30 (lead 0)
    const winPoints = emptyPoints();
    winPoints[19] = -5;
    winPoints[6] = 10;
    winPoints[1] = 1;
    const windowB = bd(winPoints); // black 30 vs white 61 (lead +31)
    const faPoints = emptyPoints();
    faPoints[24] = -1;
    const farAhead = bd(faPoints, { white: 14, black: 0 }); // black 1 vs white 350 (lead +349)
    // ordered by INCREASING black pip lead
    const wps = [farBehind, nearEven, windowB, farAhead].map((b) =>
      ai.winProbability(b, "black"),
    );
    expect(isNonDecreasing(wps)).toBe(true);
  });
});
