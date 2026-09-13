import { chromium } from "@playwright/test";
import {
  type ServerHandle,
  BASE_URL,
  api,
  debugRoll,
  debugSetState,
  health,
  makeState,
  startServer,
  stopServer,
} from "../lib/harness.ts";

export interface Problem {
  check: string;
  expected: string;
  observed: string;
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

/**
 * Ask a counted element's two questions separately.
 *
 * `renderSelector` must NOT depend on `data-testid` — it is what decides
 * whether the thing was drawn at all. The two outcomes:
 *
 *   drawn, not labelled   -> REQ-TESTID/*  (only a programmatic consumer sees it)
 *   not drawn             -> REQ-RENDER/*  (the tester sees it while playing)
 *
 * Never both, and never the attribute complaint alone: an element that was
 * never drawn cannot be said to be missing an attribute, and reporting it that
 * way would send an integration complaint about a board that is simply not
 * there.
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
}): Promise<void> {
  const { add, page, label, expected, exact } = opts;
  const withTestId = await page.locator(opts.testIdSelector).count();
  const ok = exact ? withTestId === expected : withTestId >= expected;
  if (ok) return;

  const drawn = await page.locator(opts.renderSelector).count();
  const drawnOk = exact ? drawn === expected : drawn >= expected;
  const want = exact ? String(expected) : `>=${expected}`;

  if (drawnOk) {
    // It is on screen and correct; it simply cannot be selected.
    add(
      `REQ-TESTID/${label} — ${opts.testIdText}`,
      want,
      `${withTestId} (${drawn} drawn without the attribute)`,
    );
    return;
  }
  add(`REQ-RENDER/${label} — ${opts.renderText}`, want, String(drawn));
}

export async function runPreGate(): Promise<Problem[]> {
  const problems: Problem[] = [];
  const add = (check: string, expected: string, observed: string) => {
    problems.push({ check, expected, observed });
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
      return problems;
    }

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

      if (!isRecord(body) || body.status !== "ok") {
        add("REQ-API/health.body.status — /health body carries \"status\":\"ok\"", '{"status":"ok",...}', asObserved(body));
      }
    } catch (error) {
      add("REQ-BIND/health — GET /health succeeds", "GET /health succeeds", errorLine(error));
    }

    try {
      const echoed = await debugSetState(
        makeState({
          off: { white: 7, black: 0 },
          turn: "white",
          phase: "roll",
        }),
      );

      // ── MISSING AND WRONG-SHAPE ARE ONE FINDING, NOT TWO ────────────────
      //
      // The shape checks below run ONLY when the key is present. An absent
      // `pip` used to trip both this loop ("missing") and the shape check
      // ("not an object"), so one absence produced two findings for one gate —
      // and, now that each check is its own gate, would have made the failing
      // count on the wall disagree with the count on the attempt row by
      // exactly the number of absent typed fields.
      const present = (key: string) =>
        isRecord(echoed) && Object.prototype.hasOwnProperty.call(echoed, key);

      for (const key of REQUIRED_STATE_KEYS) {
        if (!present(key)) {
          add(`REQ-STATE/state.${key} — /api/state response carries the "${key}" field`, "present", "missing");
        }
      }

      // Guarded for the same reason: a missing `off` is already reported by the
      // loop, and re-reporting it here as a wrong VALUE would accuse the model
      // of a bug it does not have.
      if (present("off")) {
        const offWhite = (echoed as any)?.off?.white;
        if (offWhite !== 7) {
          add("REQ-STATE/state.off.white — seeded off counts survive the state echo", "7", String(offWhite));
        }
      }

      if (present("pip")) {
        const pip = (echoed as any)?.pip;
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

      if (present("legalMoves") && !Array.isArray((echoed as any)?.legalMoves)) {
        add("REQ-STATE/state.legalMoves — state carries legalMoves as an array", "array", asObserved((echoed as any)?.legalMoves));
      }

      if (present("canDouble") && typeof (echoed as any)?.canDouble !== "boolean") {
        add("REQ-STATE/state.canDouble — state carries canDouble as a boolean", "boolean", asObserved((echoed as any)?.canDouble));
      }
    } catch (error) {
      add("REQ-DEBUG/debug.setState — debug.setState seeds a board and /api/state echoes it", "debug state can be set and echoed", errorLine(error));
    }

    try {
      await debugRoll([6, 1]);
      const rolled = await api("/api/roll");
      const dice = sortedDice((rolled as any)?.dice);
      const honored = dice !== null && dice.length === 2 && dice[0] === 1 && dice[1] === 6;
      if (!honored) {
        add("REQ-DEBUG/debug.roll — the debug roll queue is honored by /api/roll", "dice [1,6] after /api/roll", asObserved((rolled as any)?.dice));
      }
    } catch (error) {
      add("REQ-DEBUG/debug.roll — the debug roll queue is honored by /api/roll", "debug roll queue is honored", errorLine(error));
    }

    try {
      browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="board"]', { timeout: 5_000 });

      for (const testId of REQUIRED_STATIC_TESTIDS) {
        const count = await page
          .locator(`[data-testid="${testId}"]`)
          .count();
        if (count < 1) {
          add(`REQ-TESTID/testid.${testId} — page exposes data-testid "${testId}"`, "present", "missing");
        }
      }

      await api("/api/new", {});
      await debugRoll([3, 1]);
      await api("/api/roll");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="board"]', { timeout: 5_000 });

      await page
        .waitForFunction(
          () => document.querySelectorAll('[data-testid="checker"]').length === 30,
          undefined,
          { timeout: 2_000 },
        )
        .catch(() => undefined);
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
        renderSelector: "[data-color][data-loc]",
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
        renderSelector: '#off-tray, .off-tray, [data-loc="off"]',
        expected: 1,
        exact: false,
        renderText: "the board shows an off tray",
        testIdText: 'a data-testid "off-tray" element is present',
      });

      await countedElement({
        add,
        page,
        label: "die",
        testIdSelector: '[data-testid="die"]',
        // No second spec'd attribute exists for a die, so the render side counts
        // whatever the dice container actually drew.
        renderSelector: '[data-testid="dice"] *, .die',
        expected: 2,
        exact: false,
        renderText: "the dice are shown after a roll",
        testIdText: 'at least two data-testid "die" elements are present',
      });

      let hintCount = await page.locator('[data-testid="hint"]').count();
      if (hintCount < 1) {
        const selectableWhites = page.locator(
          '[data-testid="checker"][data-color="white"].selectable',
        );
        const selectableCount = await selectableWhites.count();

        if (selectableCount > 0) {
          // Fire the DOM click handler directly (dispatchEvent) so it works even
          // if the checker is scrolled outside this browser's default viewport.
          await selectableWhites.first().dispatchEvent("click");
          await page.waitForTimeout(200);
        } else {
          const whiteCheckers = page.locator(
            '[data-testid="checker"][data-color="white"]',
          );
          const whiteCount = await whiteCheckers.count();
          for (let i = 0; i < whiteCount; i++) {
            try {
              await whiteCheckers.nth(i).dispatchEvent("click");
            } catch {
              // Keep probing other white checkers.
            }
            await page
              .waitForFunction(
                () => document.querySelectorAll('[data-testid="hint"]').length > 0,
                undefined,
                { timeout: 250 },
              )
              .catch(() => undefined);
            hintCount = await page.locator('[data-testid="hint"]').count();
            if (hintCount > 0) {
              break;
            }
          }
        }

        hintCount = await page.locator('[data-testid="hint"]').count();
      }

      if (hintCount < 1) {
        add(
          "REQ-HINT/hint — selecting a movable checker shows one hint per playable die",
          "hints appear after selecting a movable checker",
          "none",
        );
      }

      await page.close();
    } catch (error) {
      add("REQ-TESTID/dom — page DOM exposes the required testids and hint flow", "DOM testids and hint flow are present", errorLine(error));
    }
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

  return problems;
}
