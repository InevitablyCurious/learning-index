import { chromium } from "@playwright/test";
import {
  type ServerHandle,
  BASE_URL,
  api,
  debugRoll,
  emptyPoints,
  health,
  makeState,
  startServer,
  stopServer,
} from "../lib/harness.ts";
import { overlaps, readOffTray } from "../frontend/board-geometry.ts";
import { countDrawnCheckers } from "./checker-drawn.ts";

export interface Problem {
  check: string;
  expected: string;
  observed: string;
}

/**
 * What the pre-gate found, and what it actually looked at.
 *
 * `resolved` is the second half of the verdict. A check id absent from it was
 * never reached — an earlier failure skipped past it — so its silence says
 * nothing about the candidate and must not be read as a pass.
 */
export interface PreGateResult {
  problems: Problem[];
  resolved: Set<string>;
}

/** The counted elements, each asked separately whether it is DRAWN and TAGGED. */
export const COUNTED_ELEMENT_LABELS = [
  "point",
  "checker",
  "bar",
  "off-tray",
  "die",
] as const;

/**
 * One check's verdict: the finding against it, or `undefined` when it passed.
 *
 * The rule lives here, beside the result it reads, because it is the whole
 * difference between a score and a guess. Three cases, in order:
 *
 *   a matching problem   -> that finding
 *   not in `resolved`    -> never evaluated, which is a failure, not a pass
 *   otherwise            -> pass
 *
 * Matched on the id PLUS a trailing space, never a bare prefix: `state.off`
 * and `state.off.white` are different checks, as are `health.body` and
 * `health.body.status`, and a bare prefix would let one swallow the other's
 * failure and silently green a gate that failed.
 */
export function verdictFor(
  id: string,
  result: PreGateResult,
): Problem | undefined {
  const found = result.problems.find((p) => p.check.startsWith(`${id} `));
  if (found) {
    return found;
  }
  if (!result.resolved.has(id)) {
    return {
      check: id,
      expected: "this check is evaluated",
      observed: "never evaluated — an earlier step failed and skipped it",
    };
  }
  return undefined;
}

export const REQUIRED_STATIC_TESTIDS: string[] = [
  "scoreWhite",
  "scoreBlack",
  "difficulty",
  "newGameBtn",
  "board",
  "playfield",
  "checkerLayer",
  "pointHints",
  "turnIndicator",
  "pipWhite",
  "pipBlack",
  "cube",
  "cubeVal",
  "cubeOwner",
  "dice",
  "rollBtn",
  "doubleBtn",
  "undoBtn",
  "endTurnBtn",
  "message",
  "modalOverlay",
  "modalTitle",
  "modalBody",
  "modalBtns",
];

export const REQUIRED_STATE_KEYS: string[] = [
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
  "pip",
  "legalMoves",
  "canDouble",
];

function firstNonEmptyLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines[0] ?? "<empty>";
}

function asObserved(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function errorLine(error: unknown): string {
  if (error instanceof Error) {
    return firstNonEmptyLine(error.message || String(error));
  }
  return firstNonEmptyLine(String(error));
}

function bootObserved(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const stderrLine = lines.find((line) => line.toLowerCase().startsWith("stderr:"));
  if (stderrLine) {
    const onSameLine = stderrLine.slice("stderr:".length).trim();
    if (onSameLine.length > 0) {
      return onSameLine;
    }
    const idx = lines.indexOf(stderrLine);
    if (idx >= 0 && lines[idx + 1]) {
      return lines[idx + 1];
    }
  }
  return lines[0] ?? "<unknown boot failure>";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sortedDice(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.some((die) => typeof die !== "number")) {
    return null;
  }
  return [...value].sort((a, b) => a - b);
}

/** One tagged population, counted by whether it is DRAWN rather than tagged. */
type DrawnCheckers = { count: number; rejected: string[] };

/**
 * Count the checkers a player can actually SEE.
 *
 * The universe is every `[data-color][data-loc]` element, but membership in
 * that population is the page's CLAIM about the board, not a piece painted on
 * it — the selector is attribute-shaped too, so counting it alone grades the
 * attributes twice and the drawing never. The computed style and the box are
 * read here, in the page, and folded through `countDrawnCheckers` in Node: the
 * criteria stay in `checker-drawn.ts`, and not one of them is re-derived
 * against a live DOM here.
 *
 * A page that tags thirty checkers and paints none of them returns
 * `{ count: 0, rejected: [30 reasons] }` — zero drawn, never a silent zero.
 */
async function readDrawnCheckers(page: import("@playwright/test").Page): Promise<DrawnCheckers> {
  const rows = await page.locator("[data-color][data-loc]").evaluateAll((elements) => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    return elements.map((element) => {
      const el = element as HTMLElement;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        color: el.dataset.color ?? "",
        loc: el.dataset.loc ?? "",
        display: style.display,
        visibility: style.visibility,
        opacity: Number(style.opacity),
        width: rect.width,
        height: rect.height,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        viewportWidth,
        viewportHeight,
      };
    });
  });
  return countDrawnCheckers(rows);
}

/**
 * Whether the off tray is actually DRAWN, not merely tagged.
 *
 * Same two-part shape as the checkers: `renderSelector` is the universe, and
 * `readDrawn` is the verdict. The tray's universe used to be dead — the golden
 * draws it as `class="offtray"` (no hyphen, no `id="off-tray"`, no `data-loc`
 * on the tray div: task/backgammon/golden/public/app.js:69-70) — so nothing
 * matched and `REQ-RENDER/off-tray` was satisfied by the tag alone. A board that
 * tagged the tray and hid it (`display:none`) passed: markup nobody drew.
 *
 * Existence and visibility are NOT re-derived here. `readOffTray` answers both,
 * with the one threshold for "not visibly rendered" the grader uses everywhere:
 * `visible` is true only for a non-empty box that is not `display:none`, not
 * `visibility:hidden`, and not faded below `opacity` 0.05.
 *
 * Three outcomes: drawn -> 1; tagged but not visible -> 0 with the reason (a
 * REQ-RENDER finding, and the only honest one — a player sees an empty board);
 * no tag at all -> 0 and no rejection, because nothing claims to be a tray to
 * reject.
 */
async function readDrawnOffTray(page: import("@playwright/test").Page): Promise<DrawnCheckers> {
  const tray = await readOffTray(page);
  if (!tray.exists) {
    return { count: 0, rejected: [] };
  }
  if (tray.visible) {
    return { count: 1, rejected: [] };
  }
  return {
    count: 0,
    rejected: ["the off tray is tagged but not visible (display:none / hidden / zero-size / faded)"],
  };
}

/**
 * Wait until `expected` checkers are actually DRAWN, or the deadline passes.
 *
 * Best effort on purpose: a board that never draws its checkers is the render
 * check's finding, not an exception thrown out of the pre-gate. The count that
 * settles this wait is the same predicate that grades it, so the wait cannot
 * come to rest on a state the check would go on to reject — a page that settles
 * here has passed what is measured below.
 */
async function waitForDrawnCheckers(
  page: import("@playwright/test").Page,
  expected: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { count } = await readDrawnCheckers(page);
      if (count >= expected) return;
      await page.waitForTimeout(50);
    }
  } catch {
    // A page mid-navigation answers nothing; the check that reads it reports.
  }
}

/**
 * Ask a counted element's two questions separately.
 *
 * `renderSelector` must NOT depend on `data-testid` — it is what decides
 * whether the thing was drawn at all. The two outcomes:
 *
 *   drawn, not labelled   -> REQ-TESTID/*  (only a programmatic consumer sees it)
 *   not drawn             -> REQ-RENDER/*  (the tester sees it while playing)
 *
 * WHO MEASURES THE DRAW is per-label, and the difference is not cosmetic. A
 * label whose own render selector already means "this was painted" only needs
 * its render selector read when the tag is missing, so it keeps the tag-count
 * early return: `if (tagOk) return;`. A label whose render selector is
 * attribute-shaped too cannot be trusted to answer the question at all — for
 * `checker` the `[data-color][data-loc]` population is exactly the claim under
 * test — and such a label passes `readDrawn`, which measures whether each
 * element is actually painted. There the drawn count is taken UP FRONT and a
 * pass needs BOTH answers: a tag count that is right while the draw is not is
 * the defect that override exists to catch.
 *
 * Never both complaints, and never the attribute complaint alone: an element
 * that was never drawn cannot be said to be missing an attribute, and
 * reporting it that way would send an integration complaint about a board that
 * is simply not there.
 */
async function countedElement(opts: {
  add: (check: string, expected: string, observed: string) => void;
  page: import("@playwright/test").Page;
  label: string;
  testIdSelector: string;
  renderSelector: string;
  expected: number;
  exact: boolean;
  renderText: string;
  testIdText: string;
  readDrawn?: (page: import("@playwright/test").Page) => Promise<DrawnCheckers>;
}): Promise<void> {
  const { add, page, label, expected, exact } = opts;
  const meets = (count: number) => (exact ? count === expected : count >= expected);
  const want = exact ? String(expected) : `>=${expected}`;
  const withTestId = await page.locator(opts.testIdSelector).count();
  const tagOk = meets(withTestId);

  /** One finding, chosen by whether the thing was drawn — never both. */
  const report = (drawn: number, rejected: string[]) => {
    if (meets(drawn)) {
      // It is on screen and correct; it simply cannot be selected.
      add(
        `REQ-TESTID/${label} — ${opts.testIdText}`,
        want,
        `${withTestId} (${drawn} drawn without the attribute)`,
      );
      return;
    }
    add(
      `REQ-RENDER/${label} — ${opts.renderText}`,
      want,
      rejected.length > 0
        ? `${drawn} drawn, ${rejected.length} rejected — ${rejected.slice(0, 8).join("; ")}`
        : String(drawn),
    );
  };

  if (opts.readDrawn) {
    const drawn = await opts.readDrawn(page);
    if (tagOk && meets(drawn.count)) return;
    report(drawn.count, drawn.rejected);
    return;
  }

  if (tagOk) return;
  report(await page.locator(opts.renderSelector).count(), []);
}

export async function runPreGate(): Promise<PreGateResult> {
  const problems: Problem[] = [];
  const add = (check: string, expected: string, observed: string) => {
    problems.push({ check, expected, observed });
  };

  // ── WHAT WAS ACTUALLY LOOKED AT ─────────────────────────────────────────
  //
  // `problems` alone cannot tell "measured and found fine" apart from "never
  // measured": both are silence. Every catch below reports its own failure
  // and then SKIPS the checks after it, so those checks produced no problem
  // and the spec read them as passes — a scaffold with nothing implemented
  // scored 65 of 68 conformance gates.
  //
  // So each step also records the checks it actually resolved. Silence is a
  // pass only for an id in this set; silence for an id outside it is the
  // benchmark admitting it does not know. A check nobody resolves fails
  // loudly rather than passing quietly, which is the safe direction for a
  // mistake to fall.
  const resolved = new Set<string>();
  const resolve = (...ids: string[]) => {
    for (const id of ids) resolved.add(id);
  };

  let server: ServerHandle | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    try {
      server = await startServer({ debug: true });
    } catch (error) {
      add(
        "REQ-BIND/boot — server boots and listens on :8002 with /health ok",
        "server listening on :8002 with /health ok",
        bootObserved(error),
      );
      resolve("REQ-BIND/boot");
      return { problems, resolved };
    }
    resolve("REQ-BIND/boot");

    try {
      const response = await health();
      if (response.status !== 200) {
        add("REQ-API/health.status — GET /health returns 200", "200", String(response.status));
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        add("REQ-API/health.body — /health responds with JSON {\"status\":\"ok\",...}", '{"status":"ok",...}', errorLine(error));
        body = undefined;
      }

      if (isRecord(body) && body.status !== "ok") {
        add("REQ-API/health.body.status — /health body carries \"status\":\"ok\"", '{"status":"ok",...}', asObserved(body));
      }
      resolve(
        "REQ-API/health.status",
        "REQ-API/health.body",
        "REQ-API/health.body.status",
      );
    } catch (error) {
      add("REQ-BIND/health — GET /health succeeds", "GET /health succeeds", errorLine(error));
    }
    // Reached either way: the catch above is this check's own verdict.
    resolve("REQ-BIND/health");

    // ── WHAT THE STATE CARRIES: read plainly, no setup needed ─────────────
    //
    // Whether the reported state HAS a field, and whether it has the right
    // shape, is answered by reading it. It used to be read off the debug
    // endpoint's echo of a seeded board, so a refused seed took all twenty
    // presence gates with it — and the seed was an impossible board (7 white
    // checkers, 0 black), which an app that validates positions rightly
    // refuses (run 1790183923's baseline).
    try {
      const state = await api("/api/state");

      // ── MISSING AND WRONG-SHAPE ARE ONE FINDING, NOT TWO ────────────────
      //
      // The shape checks below run ONLY when the key is present. An absent
      // `pip` used to trip both this loop ("missing") and the shape check
      // ("not an object"), so one absence produced two findings for one gate —
      // and, now that each check is its own gate, would have made the failing
      // count on the wall disagree with the count on the attempt row by
      // exactly the number of absent typed fields.
      const present = (key: string) =>
        isRecord(state) && Object.prototype.hasOwnProperty.call(state, key);

      for (const key of REQUIRED_STATE_KEYS) {
        if (!present(key)) {
          add(`REQ-STATE/state.${key} — /api/state response carries the "${key}" field`, "present", "missing");
        }
      }

      if (present("pip")) {
        const pip = (state as any)?.pip;
        const pipOk =
          isRecord(pip) && typeof pip.white === "number" && typeof pip.black === "number";
        if (!pipOk) {
          add(
            "REQ-STATE/state.pip — state carries pip as an object with numeric white and black",
            "object with numeric white and black",
            asObserved(pip),
          );
        }
      }

      if (present("points")) {
        const points = (state as any)?.points;
        const pointsOk =
          Array.isArray(points) && points.length === 26 && points.every((p) => typeof p === "number");
        if (!pointsOk) {
          add(
            "REQ-STATE/state.points.length — state carries points as a 26-length numeric array",
            "array of 26 numbers",
            asObserved(points),
          );
        }
      }

      if (present("legalMoves") && !Array.isArray((state as any)?.legalMoves)) {
        add("REQ-STATE/state.legalMoves — state carries legalMoves as an array", "array", asObserved((state as any)?.legalMoves));
      }

      if (present("canDouble") && typeof (state as any)?.canDouble !== "boolean") {
        add("REQ-STATE/state.canDouble — state carries canDouble as a boolean", "boolean", asObserved((state as any)?.canDouble));
      }
      resolve(
        ...REQUIRED_STATE_KEYS.map((key) => `REQ-STATE/state.${key}`),
        "REQ-STATE/state.points.length",
        "REQ-STATE/state.legalMoves",
        "REQ-STATE/state.canDouble",
      );
    } catch {
      // Unresolved, so each presence gate reports "never evaluated": nothing
      // was read, so nothing about the fields can be said. A broken
      // /api/state is observed, and told, by the gates that use it.
    }

    // ── A POSITION SET, THEN READ BACK ────────────────────────────────────
    //
    // A LEGAL board (15 a side): white 8 on its six-point and 7 borne off,
    // black 15 on its own home point. The borne-off count is the property.
    try {
      const points = emptyPoints();
      points[6] = 8;
      points[24] = -15;
      // The plain call, not debugSetState: the echo IS what this check reads,
      // and the verifying helper would throw on the very value it grades.
      const echoed = await api(
        "/api/debug/state",
        makeState({ points, off: { white: 7, black: 0 }, turn: "white", phase: "roll" }),
      );
      // Guarded: a missing `off` is the presence gate's finding above, and
      // re-reporting it here as a wrong VALUE would count one absence twice.
      if (isRecord(echoed) && Object.prototype.hasOwnProperty.call(echoed, "off")) {
        const offWhite = (echoed as any)?.off?.white;
        if (offWhite !== 7) {
          add("REQ-STATE/state.off.white — seeded off counts survive the state echo", "7", String(offWhite));
        }
      }
      resolve("REQ-STATE/state.off.white");
    } catch (error) {
      add("REQ-DEBUG/debug.setState — debug.setState seeds a board and /api/state echoes it", "debug state can be set and echoed", errorLine(error));
    }
    resolve("REQ-DEBUG/debug.setState");

    try {
      // TWO rolls queued, taken in order (chunk-03: "Enqueue dice as the next
      // roll"). One queued roll could not tell a queue from a single slot that
      // the last call overwrites, or one that never clears: run 1793897465
      // round 10 kept only the last of two and answered it to every roll after,
      // and every check that queued an opening then a turn was told about the
      // dice it had not set up.
      await debugRoll([6, 1]);
      await debugRoll([5, 2]);
      const rolled = await api("/api/roll");
      const first = sortedDice((rolled as any)?.dice);
      const firstOk = first !== null && first.length === 2 && first[0] === 1 && first[1] === 6;
      // Back to a roll for white on a legal board, then the second queued roll.
      const back = emptyPoints();
      back[6] = 15;
      back[24] = -15;
      await api("/api/debug/state", makeState({ points: back, turn: "white", phase: "roll" }));
      const again = await api("/api/roll");
      const second = sortedDice((again as any)?.dice);
      const secondOk = second !== null && second.length === 2 && second[0] === 2 && second[1] === 5;
      if (!firstOk || !secondOk) {
        add(
          "REQ-DEBUG/debug.roll — the debug roll queue is honored by /api/roll",
          "dice [1,6] then [2,5] after queuing [6,1] then [5,2]",
          `${asObserved((rolled as any)?.dice)} then ${asObserved((again as any)?.dice)}`,
        );
      }
      resolve("REQ-DEBUG/debug.roll");
    } catch (error) {
      add("REQ-DEBUG/debug.roll.error — the debug roll endpoint answers without error", "debug roll answers without error", errorLine(error));
    }
    resolve("REQ-DEBUG/debug.roll.error");

    try {
      browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      // No single action may spend the pre-gate's whole budget: Playwright's
      // default is 30s, the same as the beforeAll limit (pregate.spec.ts), so
      // one stuck action published the pass ungradable. The reference runs the
      // whole pre-gate in under a second.
      page.setDefaultTimeout(5_000);

      // Fresh game BEFORE the frontend's first load, so the server is in the
      // "roll" phase when the page arrives and the roll button is enabled.
      await api("/api/new", {});

      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="board"]', { timeout: 5_000 });

      for (const testId of REQUIRED_STATIC_TESTIDS) {
        const count = await page
          .locator(`[data-testid="${testId}"]`)
          .count();
        if (count < 1) {
          add(`REQ-TESTID/testid.${testId} — page exposes data-testid "${testId}"`, "present", "missing");
        } else if (count > 1) {
          add(`REQ-TESTID/testid.${testId} — page exposes data-testid "${testId}"`, "exactly one", `duplicate (${count}) [aspect: dup]`);
        }
      }

      // The static elements keep their ids too: the build prompt's contract is
      // "static elements keep their existing `id` and ALSO carry a `data-testid`
      // with the same string". Run 9a946250's page kept every tag but renamed the
      // ids (end-turn-btn for endTurnBtn); its own lookup of #endTurnBtn came back
      // empty, the script died on load and the board was blank, and nothing here
      // said a name had changed — the player only saw an empty board.
      for (const id of REQUIRED_STATIC_TESTIDS) {
        const count = await page.locator(`[id="${id}"]`).count();
        if (count < 1) {
          add(`REQ-TESTID/id.${id} — page keeps the id "${id}"`, "present", "missing");
        }
      }

      // ── ROLL VIA THE FRONTEND, THEN CHECK RENDER *BEFORE* ANY RELOAD ──────
      // The click drives the app's own roll button (it POSTs /api/roll and
      // renders the dice). The `.catch` keeps a missing button from throwing
      // the whole pre-gate — its absence is already reported by the testid
      // loop above.
      // A player clicks Roll once the game is on screen, not the instant the
      // frame appears: the spec has the page load its game from the server, and
      // a correct page ignores a click made before it has (run 1790329339: the
      // click landed ~100 ms early, no roll was sent, and "the dice are drawn
      // after a roll" read 0 while a player's roll drew them). Bounded like
      // every wait here; a page that never draws its checkers is the checker
      // render check's finding. Settled on the DRAWN count, the same predicate
      // that grades it below — a page can carry the tags and paint nothing.
      await waitForDrawnCheckers(page, 30, 5_000);

      // ── WHICH LAYERS THE PAGE WORK BELOW BELONGS TO ──────────────────────
      //
      // A layer-scoped grade exports BENCH_LAYER for this child process
      // (report.mjs); a full grade sets nothing at all. L1 (board geometry) and
      // L2 (the pieces that are drawn) are both answered before a game is ever
      // played, so the gameplay steps below are the only ones that can spend the
      // whole conformance phase: a Roll button that clicks and does nothing
      // burns the hint-flow loop's four turns of rolls, clicks and waits past
      // the phase deadline, the phase aborts with every conformance gate
      // unmeasured, and the run is ungradable — so an L3 gameplay fault fails
      // the L1 and L2 grades it has nothing to do with.
      const gameplayScoped =
        process.env.BENCH_LAYER == null || process.env.BENCH_LAYER === "3";

      // What the two L3 gates below read to say whether they had a subject at
      // all. Out of scope it stays false, so they report "never evaluated"
      // rather than a finding about a roll nobody made.
      let rolled = false;
      if (gameplayScoped) {
        await debugRoll([3, 1]);
        // Bounded: a Roll button that is disabled (an app that opens a game with
        // the opening roll already made) was retried for Playwright's default
        // 30s — the whole pre-gate budget — so a candidate that passed every
        // conformance check overran it and the pass was published ungradable
        // (run 1790200233: 30.46s against the reference's 0.61s).
        // Whether the roll happened at all: a Roll button that cannot be clicked
        // at the start of a game is F61's finding, and the checks after it never
        // reached their subject — they are not told (run 1790769627's page kept
        // Roll disabled through the opening roll).
        rolled = await page
          .locator('[data-testid="rollBtn"]')
          .click({ timeout: 2_000 })
          .then(() => true, () => false);
        await page
          .waitForFunction(
            () => document.querySelectorAll('[data-testid="die"]').length >= 2,
            undefined,
            { timeout: 2_000 },
          )
          .catch(() => undefined);

        // NON-RELOAD render check: did the roll draw the dice at all? Distinct
        // from the reload-survival check below — "the dice didn't draw" vs "the
        // board reset wiped the roll away" are different failures.
        const drawnBefore = await page.locator('[data-testid="dice"] *, .die').count();
        if (drawnBefore < 2) {
          add("REQ-RENDER/die — the dice are drawn after a roll", ">=2", rolled ? String(drawnBefore) : "never evaluated — the Roll button could not be clicked at the start of a game");
        }
      }

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="board"]', { timeout: 5_000 });

      await waitForDrawnCheckers(page, 30, 2_000);
      await page
        .waitForFunction(
          () => document.querySelectorAll('[data-testid="die"]').length >= 2,
          undefined,
          { timeout: 2_000 },
        )
        .catch(() => undefined);

      // ── ELEMENT COUNTS ARE TWO QUESTIONS, NOT ONE ────────────────────────
      //
      // "24 points with data-testid" conflates a board that renders 20 points
      // (a human sees a broken board) with a board that renders 24 correctly
      // and labels 20 of them (invisible to everyone except an automated
      // consumer). Those are different failures with different audiences, and
      // one check cannot be reported to both.
      //
      // So each is asked twice: does the thing RENDER (counted by a selector
      // that does not rely on data-testid), and does it carry the ATTRIBUTE.
      //   REQ-RENDER/*  the tester sees this while playing
      //   REQ-TESTID/*  only a programmatic consumer sees this
      //
      // WHEN NEITHER SELECTOR FINDS IT, the render check reports and the
      // attribute check stays silent: we cannot prove an element exists to be
      // unlabelled, and accusing the integration of a missing attribute on an
      // element that was never drawn would be a fabricated finding.
      await countedElement({
        add,
        page,
        label: "point",
        testIdSelector: '[data-testid="point"]',
        renderSelector: "[data-point]",
        expected: 24,
        exact: true,
        renderText: "board renders 24 points",
        testIdText: 'board renders 24 data-testid "point" elements',
      });

      await countedElement({
        add,
        page,
        label: "checker",
        testIdSelector: '[data-testid="checker"]',
        // The universe, not the answer: `readDrawn` decides which of these
        // elements are actually painted, so a rigged board that emits the
        // attributes and draws nothing fails here.
        renderSelector: "[data-color][data-loc]",
        readDrawn: readDrawnCheckers,
        expected: 30,
        exact: true,
        renderText: "board renders 30 checkers (15 per side)",
        testIdText: 'board renders 30 data-testid "checker" elements (15 per side)',
      });

      await countedElement({
        add,
        page,
        label: "bar",
        testIdSelector: '[data-testid="bar"]',
        renderSelector: '#bar, .bar, [data-loc="bar"]',
        expected: 1,
        exact: false,
        renderText: "the board shows a bar",
        testIdText: 'a data-testid "bar" element is present',
      });

      await countedElement({
        add,
        page,
        label: "off-tray",
        testIdSelector: '[data-testid="off-tray"]',
        // The universe, not the answer — and it now contains what the golden
        // actually draws (`class="offtray"`, no hyphen, app.js:69): the old
        // selectors matched nothing, so the tag count stood alone and a tray
        // that was never painted passed. `readDrawn` decides the draw question.
        renderSelector: '#off-tray, .off-tray, .offtray, [data-loc="off"]',
        readDrawn: readDrawnOffTray,
        expected: 1,
        exact: false,
        renderText: "the board shows an off tray",
        testIdText: 'a data-testid "off-tray" element is present',
      });

      // ── EACH POINT'S TAG IS ON ITS OWN COLUMN ──────────────────────────────
      // The prompt puts `data-testid="point"` on the element that is the
      // point's column — the upright rectangle its triangle stands in, from
      // the board's edge to the middle — and every check that finds a spot on
      // the board (a click in a column, a hint, where a piece stands, which
      // way a triangle points) reads that element's box. Two tagged points
      // drawn over one another leave a spot that belongs to both. Run
      // 1790775221 made every point the full height of the board, over the
      // point opposite; with nothing here the tester spoke instead ("not in
      // two rows", "no triangle") for five runs of a board that looked like
      // two rows. Overlap is counted as the geometry checks count it: more
      // than a sliver each way.
      {
        const columns = await page.locator('[data-testid="point"]').evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            const num = (element as HTMLElement).dataset.point ?? "?";
            return { num, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          }),
        );
        const shared = columns.flatMap((a, i) =>
          columns.slice(i + 1).filter((b) => overlaps(a, b)).map((b) => `${a.num}/${b.num}`),
        );
        const check = "REQ-TESTID/point-column — each point's tag is on its own column";
        if (columns.length === 0) {
          add(check, "no two tagged points overlap", "never evaluated — no element is tagged point");
        } else if (shared.length > 0) {
          add(check, "no two tagged points overlap", `${shared.length} pairs overlap: ${shared.slice(0, 8).join(", ")}`);
        }
      }

      // ── RELOAD SURVIVAL, MANUALLY SPLIT ────────────────────────────────────
      // Same either/or semantics as `countedElement`, but the render complaint
      // is its own gate (`die-reload`): after a reload, "not drawn" means the
      // frontend reset the board and wiped the roll away — not that the dice
      // never rendered. No second spec'd attribute exists for a die, so the
      // render side counts whatever the dice container actually drew.
      {
        const drawnAfter = await page.locator('[data-testid="dice"] *, .die').count();
        const taggedAfter = await page.locator('[data-testid="die"]').count();
        if (taggedAfter < 2) {
          if (drawnAfter >= 2) {
            add("REQ-TESTID/die — at least two data-testid \"die\" elements are present", ">=2", rolled ? `${taggedAfter} (${drawnAfter} drawn without the attribute)` : "never evaluated — the Roll button could not be clicked at the start of a game");
          } else {
            add("REQ-RENDER/die-reload — the dice survive a page reload", ">=2", rolled ? String(drawnAfter) : "never evaluated — the Roll button could not be clicked at the start of a game");
          }
        }
      }

      // A movable piece is one that answers a click with hints: every white
      // checker is tried until one does. The build prompt names no class for
      // a movable piece, so none is looked for (FIX-26: run 1790414346 was
      // told "no checker I could pick up" by a page whose pieces picked up).
      // Each piece is scrolled into view first, so one outside this browser's
      // default viewport is still pressed where a player would press it.
      // The turn is the player's own: the click above was the OPENING roll, and a
      // build whose computer won it (or that handles the queued dice another way,
      // F63's finding) leaves the player holding no dice, so no piece could show a
      // hint yet. A player then waits for the computer and rolls again, so this does
      // too — up to three more rolls, stopping when a piece shows hints or the Roll
      // button will not click (the player then holds dice, and no hints is the
      // finding). Run 1791304274: the player's next Roll showed hints, and the line
      // told the model they never appeared.
      //
      // Gameplay only, for the reason the roll above is: this loop is the one step
      // that can spend the whole phase budget (four turns of rolls, clicks and
      // 1.5s waits), and at L1/L2 it is asking about a game that is not in scope.
      if (gameplayScoped) {
        let ordinaryRoll = rolled;
        let hintCount = 0;
        for (let turn = 0; turn < 4 && hintCount < 1; turn++) {
          if (turn > 0) {
            await debugRoll([3, 1]);
            const again = await page
              .locator('[data-testid="rollBtn"]')
              .click({ timeout: 2_000 })
              .then(() => true, () => false);
            if (!again) break;
            ordinaryRoll = true;
            await page
              .waitForFunction(() => document.querySelectorAll('[data-testid="die"]').length >= 2, undefined, {
                timeout: 2_000,
              })
              .catch(() => undefined);
          }
          hintCount = await page.locator('[data-testid="hint"]').count();
          if (hintCount < 1) {
            const whiteCheckers = page.locator('[data-testid="checker"][data-color="white"]');
            const whiteCount = await whiteCheckers.count();
            for (let i = 0; i < whiteCount; i++) {
              try {
                // A player's click: bring the piece into view and press the mouse on
                // it. A synthetic click event reaches only pages that listen for
                // "click"; run 1791381075's page listened for the mouse itself, showed
                // hints to every player, and was told "nothing shows me where it can
                // go" because the grader pressed nothing.
                const piece = whiteCheckers.nth(i);
                await piece.scrollIntoViewIfNeeded({ timeout: 1_000 });
                const box = await piece.boundingBox();
                if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
              } catch {
                // Keep probing other white checkers.
              }
              // A player waits to see the hints come up. Hints that appear after a
              // short pause were read as none, and the next press on another piece
              // then put them away (WO-AUDIT-A class a).
              await page
                .waitForFunction(() => document.querySelectorAll('[data-testid="hint"]').length > 0, undefined, {
                  timeout: 900,
                })
                .catch(() => undefined);
              hintCount = await page.locator('[data-testid="hint"]').count();
              if (hintCount > 0) {
                break;
              }
            }
          }
          // The computer may be moving: give it time before the player rolls again.
          if (hintCount < 1) await page.waitForTimeout(1_500);
        }

        if (hintCount < 1) {
          add(
            "REQ-HINT/hint — selecting a movable checker shows move hints",
            "hints appear after selecting a movable checker",
            ordinaryRoll ? "none" : "never evaluated — the Roll button could not be clicked at the start of a game",
          );
        }
      }

      await page.close();
      resolve(
        ...REQUIRED_STATIC_TESTIDS.map((testId) => `REQ-TESTID/testid.${testId}`),
        ...REQUIRED_STATIC_TESTIDS.map((id) => `REQ-TESTID/id.${id}`),
        ...COUNTED_ELEMENT_LABELS.flatMap((label) => [
          `REQ-RENDER/${label}`,
          `REQ-TESTID/${label}`,
        ]),
        "REQ-TESTID/point-column",
        "REQ-RENDER/die-reload",
        "REQ-HINT/hint",
      );
    } catch (error) {
      add("REQ-TESTID/dom — page DOM exposes the required testids and hint flow", "DOM testids and hint flow are present", errorLine(error));
    }
    resolve("REQ-TESTID/dom");
  } catch (error) {
    add("REQ-TESTID/pregate — conformance pre-gate completes without errors", "pre-gate completes", errorLine(error));
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // best effort
      }
    }
    if (server) {
      try {
        await stopServer(server);
      } catch {
        // best effort
      }
    }
  }

  resolve("REQ-TESTID/pregate");
  return { problems, resolved };
}
