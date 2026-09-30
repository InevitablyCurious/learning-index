// Backgammon HTTP server — Node standard library only, serves API + static UI on :8002.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  type GameState,
  type Move,
  type AppliedMove,
  type Player,
  type Board,
  BAR,
  OFF,
  createGame,
  cloneBoard,
  legalMovesNow,
  applyMove,
  pipCount,
  checkWin,
  opponent,
} from "./game.ts";
import {
  chooseMoves,
  shouldAiDouble,
  shouldAiAccept,
  winProbability,
} from "./ai.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
// The port this server listens on. `PORT` from the environment when it is set,
// otherwise 8002 — so the default `npm start` is unchanged, and a second copy
// can be run alongside it on another port without editing anything.
const PORT = Number(process.env.PORT ?? 8002);
const DEBUG = process.env.DEBUG_API === "1";
const HUMAN: Player = "white";
const AI: Player = "black";
const forcedDiceQueue: number[][] = [];

// ---- single in-memory game with a couple of transient turn flags ----
interface FullState extends GameState {
  aiCubeDone: boolean;
  aiOpening: boolean; // the computer won the opening roll and has yet to play those dice
}
let game: FullState = init("medium");
function init(difficulty: GameState["difficulty"]): FullState {
  const g = createGame(difficulty) as FullState;
  g.aiCubeDone = false;
  g.aiOpening = false;
  return g;
}

function boardView(g: GameState): Board {
  return { points: g.points, bar: g.bar, off: g.off };
}

function multiplier(type: "single" | "gammon" | "backgammon" | null): number {
  return type === "backgammon" ? 3 : type === "gammon" ? 2 : 1;
}

function humanCanDouble(g: FullState): boolean {
  return (
    g.phase === "roll" &&
    g.turn === HUMAN &&
    g.winner === null &&
    (g.cube.owner === null || g.cube.owner === HUMAN)
  );
}

// serialize the state the client needs
function serialize(g: FullState, extra: Record<string, unknown> = {}) {
  const b = boardView(g);
  const legal =
    g.turn === HUMAN && g.phase === "move" ? legalMovesNow(b, HUMAN, g.remainingDice) : [];
  return {
    points: g.points,
    bar: g.bar,
    off: g.off,
    turn: g.turn,
    phase: g.phase,
    dice: g.dice,
    remainingDice: g.remainingDice,
    cube: g.cube,
    difficulty: g.difficulty,
    score: g.score,
    winner: g.winner,
    winType: g.winType,
    pointsWon: g.pointsWon,
    doubleOfferedBy: g.doubleOfferedBy,
    message: g.message,
    turnOver: g.turnOver,
    gamesPlayed: g.gamesPlayed,
    pip: { white: pipCount(b, "white"), black: pipCount(b, "black") },
    legalMoves: legal,
    canDouble: humanCanDouble(g),
    ...extra,
  };
}

function finishGame(g: FullState, winner: Player, type: "single" | "gammon" | "backgammon" | null, declined: boolean) {
  const pts = declined ? g.cube.value : g.cube.value * multiplier(type);
  g.winner = winner;
  g.winType = declined ? "single" : type;
  g.pointsWon = pts;
  g.score[winner] += pts;
  g.phase = "gameover";
  g.gamesPlayed++;
  const who = winner === HUMAN ? "You win" : "AI wins";
  const label = declined
    ? "by a declined double"
    : type === "backgammon"
      ? "a BACKGAMMON (triple)"
      : type === "gammon"
        ? "a GAMMON (double)"
        : "the game";
  g.message = `${who} ${label} — ${pts} point${pts === 1 ? "" : "s"}.`;
}

// After a checker action, refresh turn-over status for the human.
function refreshHumanTurn(g: FullState) {
  const b = boardView(g);
  if (g.remainingDice.length === 0 || legalMovesNow(b, HUMAN, g.remainingDice).length === 0) {
    g.turnOver = true;
  }
}

function reverseMove(b: Board, player: Player, am: AppliedMove) {
  const sign = player === "white" ? 1 : -1;
  if (am.to === OFF) {
    if (player === "white") b.off.white--;
    else b.off.black--;
  } else {
    b.points[am.to] -= sign; // remove our checker back off the destination
    if (am.hit) {
      b.points[am.to] = -sign; // restore the single opponent checker we had hit
      if (player === "white") b.bar.black--;
      else b.bar.white--;
    }
  }
  if (am.from === BAR) {
    if (player === "white") b.bar.white++;
    else b.bar.black++;
  } else {
    b.points[am.from] += sign;
  }
}

function rollDice(): number[] {
  if (forcedDiceQueue.length > 0) return forcedDiceQueue.shift()!;
  const d1 = 1 + Math.floor(Math.random() * 6);
  const d2 = 1 + Math.floor(Math.random() * 6);
  return d1 === d2 ? [d1, d1, d1, d1] : [d1, d2];
}

// Opening roll: ONE die per side — [playerDie, computerDie]. Equal values are a
// tie (still length 2); this must NEVER produce a 4-length doubles array.
function rollOpeningDice(): number[] {
  if (forcedDiceQueue.length > 0) return forcedDiceQueue.shift()!;
  const d1 = 1 + Math.floor(Math.random() * 6);
  const d2 = 1 + Math.floor(Math.random() * 6);
  return [d1, d2];
}

const DEBUG_STATE_KEYS = [
  "points",
  "bar",
  "off",
  "turn",
  "phase",
  "dice",
  "remainingDice",
  "cube",
  "difficulty",
  "score",
  "winner",
  "winType",
  "pointsWon",
  "doubleOfferedBy",
  "message",
  "turnOver",
  "gamesPlayed",
] as const;

function actionDebugState(body: any) {
  for (const key of DEBUG_STATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      (game as any)[key] = body[key];
    }
  }
  game.aiOpening = false; // a position set by hand is never the opening's pending move
}

function actionDebugRoll(body: any) {
  if (game.phase === "openingRoll") {
    // Opening roll: dice are [playerDie, computerDie] — order is meaningful, never sort.
    forcedDiceQueue.push(body.dice);
  } else {
    // Normal turns honor the "sorted ascending" contract.
    forcedDiceQueue.push([...body.dice].sort((a, b) => a - b));
  }
}

// ---------------- action handlers ----------------

function actionNew(body: any) {
  const diff = ["easy", "medium", "hard"].includes(body?.difficulty) ? body.difficulty : game.difficulty;
  const score = game.score; // keep running match score across games
  const gamesPlayed = game.gamesPlayed; // keep games-played count across games
  game = init(diff);
  game.score = score;
  game.gamesPlayed = gamesPlayed;
  game.message = "New game. Roll to see who goes first.";
}

function actionRoll() {
  if (game.turn !== HUMAN || game.winner) return;
  if (game.phase === "openingRoll") {
    // Both sides roll ONE die; the higher side plays first with both numbers.
    // This is the ONE place dice are NOT sorted: [playerDie, computerDie].
    const dice = rollOpeningDice();
    const [playerDie, computerDie] = dice;
    game.dice = dice;
    if (playerDie === computerDie) {
      // Tie — phase stays "openingRoll", turn stays HUMAN, roll again.
      game.remainingDice = [];
      game.message = `You both rolled ${playerDie}. Tie — roll again.`;
      return;
    }
    game.turn = playerDie > computerDie ? HUMAN : AI;
    game.aiOpening = game.turn === AI;
    game.phase = "move";
    game.remainingDice = [playerDie, computerDie];
    game.history = [];
    game.turnOver = false;
    game.message =
      game.turn === HUMAN
        ? `You rolled ${playerDie}, the computer rolled ${computerDie} — you go first.`
        : `You rolled ${playerDie}, the computer rolled ${computerDie} — the computer goes first.`;
    return;
  }
  if (game.phase !== "roll") return;
  game.dice = rollDice();
  game.remainingDice = game.dice.slice();
  game.phase = "move";
  game.history = [];
  game.turnOver = false;
  const b = boardView(game);
  const legal = legalMovesNow(b, HUMAN, game.remainingDice);
  const dl = game.dice.length === 4 ? `double ${game.dice[0]}s` : `${game.dice[0]} and ${game.dice[1]}`;
  if (legal.length === 0) {
    game.turnOver = true;
    game.message = "No moves available";
  } else {
    game.message = `You rolled ${dl}. Select a checker to move.`;
  }
}

function actionMove(body: any) {
  if (game.turn !== HUMAN || game.phase !== "move" || game.winner) return;
  const { from, to, die } = body || {};
  const b = boardView(game);
  const legal = legalMovesNow(b, HUMAN, game.remainingDice);
  const m = legal.find((x) => x.from === from && x.to === to && x.die === die);
  if (!m) return; // illegal — ignore
  const hit = applyMove(b, HUMAN, m);
  game.history.push({ ...m, hit });
  const idx = game.remainingDice.indexOf(die);
  game.remainingDice.splice(idx, 1);

  const win = checkWin(b, HUMAN);
  if (win.won) {
    finishGame(game, HUMAN, win.type, false);
    return;
  }
  refreshHumanTurn(game);
  if (game.turnOver) {
    game.message = "No more legal moves. Click “End Turn”.";
  } else {
    game.message = `Move played. ${game.remainingDice.length} die/dice left.`;
  }
}

function actionUndo() {
  if (game.turn !== HUMAN || game.phase !== "move" || game.winner) return;
  const am = game.history.pop();
  if (!am) return;
  const b = boardView(game);
  reverseMove(b, HUMAN, am);
  game.remainingDice.push(am.die);
  game.remainingDice.sort((a, c) => a - c);
  game.turnOver = false;
  game.message = "Move undone. Select a checker to move.";
}

function actionEndTurn() {
  if (game.turn !== HUMAN || game.winner) return;
  if (game.phase !== "move" || !game.turnOver) return;
  handOverToAi();
}

function handOverToAi() {
  game.turn = AI;
  game.phase = "roll";
  game.dice = [];
  game.remainingDice = [];
  game.history = [];
  game.turnOver = false;
  game.aiCubeDone = false;
  game.doubleOfferedBy = null;
  game.message = "AI's turn.";
}

// Human offers a double; AI decides immediately.
function actionDouble() {
  if (!humanCanDouble(game)) return;
  const b = boardView(game);
  const decision = shouldAiAccept(b, AI, game.difficulty);
  game.doubleOfferedBy = HUMAN;
  if (decision.action === "double") {
    // AI accepts
    game.cube.value *= 2;
    game.cube.owner = AI;
    game.phase = "roll";
    game.doubleOfferedBy = null;
    game.message = `AI accepts the double. Cube is now ${game.cube.value}. Roll the dice.`;
  } else {
    // AI declines
    finishGame(game, HUMAN, null, true);
    game.message = `AI declines the double. ${game.message}`;
  }
  return { cubeReasoning: decision.reasoning, accepted: decision.action === "double" };
}

// Human responds to an AI-offered double.
function actionRespondDouble(body: any) {
  if (game.phase !== "doubleOffered" || game.doubleOfferedBy !== AI || game.winner) return;
  const accept = !!body?.accept;
  if (accept) {
    game.cube.value *= 2;
    game.cube.owner = HUMAN;
    game.phase = "roll";
    game.turn = AI; // still the AI's turn to roll
    game.doubleOfferedBy = null;
    game.aiCubeDone = true;
    game.message = `You accepted the double. Cube is now ${game.cube.value}. AI rolls…`;
  } else {
    finishGame(game, AI, null, true);
    game.message = `You declined the double. ${game.message}`;
  }
}

// Run one AI step: possibly offer a double, otherwise roll + move.
function actionAi() {
  if (game.turn !== AI || game.winner) return {};
  const b = boardView(game);

  // 0) the computer's dice are already on the table — it WON the opening roll
  //    (dice = [playerDie, computerDie]), or a position was set up that way:
  //    play those dice WITHOUT a fresh roll and WITHOUT a cube decision
  //    (nobody doubles before the opening move is played).
  if (game.phase === "move") {
    return aiPlayDice(b, game.dice.slice(), game.aiOpening);
  }

  // 1) cube decision at the start of the AI's turn
  if (game.phase === "roll" && !game.aiCubeDone) {
    const dec = shouldAiDouble(b, AI, game.cube, game.difficulty);
    game.aiCubeDone = true;
    if (dec.action === "double") {
      game.phase = "doubleOffered";
      game.doubleOfferedBy = AI;
      game.message = `AI offers a double to ${game.cube.value * 2}.`;
      return { cubeReasoning: dec.reasoning, aiDoubled: true };
    }
    // else fall through and roll
  }

  if (game.phase !== "roll") return {};

  // 2) roll and move
  const dice = rollDice();
  game.dice = dice;
  return aiPlayDice(b, dice);
}

// Play the AI's turn with the given dice, then hand back to the human. The
// opening's dice are one per side, so that turn's message says "opened with".
function aiPlayDice(b: Board, dice: number[], opening = false) {
  const result = chooseMoves(b, AI, dice, game.difficulty);
  const applied: AppliedMove[] = [];
  for (const m of result.moves) {
    const hit = applyMove(b, AI, m);
    applied.push({ ...m, hit });
  }
  game.remainingDice = [];
  game.aiOpening = false;

  const dl = dice.length === 4 ? `double ${dice[0]}s` : `${dice[0]} and ${dice[1]}`;
  const lead = opening ? "AI opened with" : "AI rolled";
  const win = checkWin(b, AI);
  if (win.won) {
    finishGame(game, AI, win.type, false);
    return { aiDice: dice, aiMoves: applied };
  }

  if (applied.length === 0) {
    game.message = `${lead} ${dl} — No moves available.`;
  } else {
    const hits = applied.filter((a) => a.hit).length;
    game.message = `${lead} ${dl} and played ${applied.length} move${applied.length === 1 ? "" : "s"}${hits ? `, hitting ${hits} of your checkers` : ""}. Your turn.`;
  }
  // hand back to human
  game.turn = HUMAN;
  game.phase = "roll";
  game.dice = [];
  game.history = [];
  game.turnOver = false;
  game.doubleOfferedBy = null;
  return { aiDice: dice, aiMoves: applied };
}

// ---------------- HTTP plumbing ----------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  rel = decodeURIComponent(rel.split("?")[0]);
  // prevent path traversal
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const data = await readFile(full);
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    // SPA fallback: every non-/api path serves the page
    const data = await readFile(path.join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    res.end(data);
  }
}

const server = http.createServer(async (req, res) => {
  const url = req.url || "/";
  const pathname = url.split("?")[0];
  try {
    if (url.startsWith("/api/")) {
      const body = req.method === "POST" ? await readBody(req) : {};
      let extra: Record<string, unknown> = {};
      if (DEBUG && pathname.startsWith("/api/debug/")) {
        switch (pathname) {
          case "/api/debug/state":
            actionDebugState(body);
            break;
          case "/api/debug/roll":
            actionDebugRoll(body);
            break;
          default:
            res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"unknown endpoint"}');
            return;
        }
        const payload = JSON.stringify(serialize(game, extra));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(payload);
        return;
      }
      switch (pathname) {
        case "/api/state":
          break;
        case "/api/new":
          actionNew(body);
          break;
        case "/api/roll":
          actionRoll();
          break;
        case "/api/move":
          actionMove(body);
          break;
        case "/api/undo":
          actionUndo();
          break;
        case "/api/endturn":
          actionEndTurn();
          break;
        case "/api/double":
          extra = actionDouble() || {};
          break;
        case "/api/double/respond":
          actionRespondDouble(body);
          break;
        case "/api/ai":
          extra = actionAi() || {};
          break;
        default:
          res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"unknown endpoint"}');
          return;
      }
      const payload = JSON.stringify(serialize(game, extra));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(payload);
      return;
    }
    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ status: "ok", port: PORT }));
      return;
    }
    await serveStatic(req, res, url);
  } catch (err) {
    console.error("Request error:", err);
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(err) }));
  }
});

server.on("error", (err) => {
  if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
    console.error(`Backgammon server: port ${PORT} is already in use — cannot start.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`Backgammon server running at http://localhost:${PORT}/`);
});
