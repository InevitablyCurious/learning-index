// The Live Build problem lists are the harness's own lines, split by shape.
import test from "node:test";
import assert from "node:assert/strict";
import { parseFeedback, groupKind } from "./panels/build-prose.js";

const MSG = [
  "That fixed it — I'm not running into this any more:",
  "",
  "1) I have to scroll to see the whole game.",
  "",
  "Before the list: every time I check, I run your latest code from scratch.",
  "",
  "These were working last time, and they're broken now:",
  "",
  "1) The pieces are too small — I expect each one about 80% as wide.",
  "2) Pieces in a stack are drawn on the same spot.",
  "",
  "I've checked your work thoroughly, and I want to list the issues that I've encountered while playing the game:",
  "",
  "1) The bar splits the board in the wrong place.",
  "",
  "Also, my software team is trying to integrate your app into their own software and they hit some problems on their side:",
  "",
  "1) They sent the turn-over flag and it still ignores it.",
  "",
  "They work from the written spec for this app.",
  "",
  "While you fix these, keep what the team's software depends on exactly as it is:",
  "- the data-testid tags: scoreWhite",
].join("\n");

test("lists are verbatim, boilerplate is held, nothing is dropped", () => {
  const { groups, held } = parseFeedback(MSG);
  assert.deepEqual(groups.map((g) => g.kind), ["fixed", "regressed", "new", "team"]);
  assert.deepEqual(groups.map((g) => g.items.length), [1, 2, 1, 1]);
  assert.equal(groups[1].items[0], "1) The pieces are too small — I expect each one about 80% as wide.");
  assert.equal(groups[1].lead, "These were working last time, and they're broken now:");
  assert.equal(held.length, 3);
  assert.ok(held[0].startsWith("Before the list"));
  assert.ok(held[2].startsWith("While you fix these"));
});

test("an unrecognised lead-in is still shown, with its own words", () => {
  const { groups } = parseFeedback("Something new I say:\n\n1) a thing");
  assert.equal(groups[0].kind, "other");
  assert.equal(groups[0].lead, "Something new I say:");
  assert.equal(groupKind("My software team had these working last time, and they're broken now on their side:"), "team-regressed");
});

test("the 'N other things' tail attaches to its list", () => {
  const { groups, held } = parseFeedback("That fixed it — x:\n\n1) a\n\n(3 other things I mentioned look fine now too.)");
  assert.equal(groups[0].note, "(3 other things I mentioned look fine now too.)");
  assert.equal(held.length, 0);
});

import { promptForTab } from "./panels/build-prose.js";
const M = (attempt, text) => ({ kind: "feedback", attempt, at: 1790955701112, text });

test("an attempt tab shows the prompt its grading produced (delivered into N+1)", () => {
  const msgs = [M(2, "two"), M(3, "three")];
  assert.equal(promptForTab(msgs, "1", { completed: 3, max: 5 }).text, "two");
  assert.equal(promptForTab(msgs, "2", { completed: 3, max: 5 }).text, "three");
  assert.match(promptForTab(msgs, "2", { completed: 3, max: 5 }).meta, /prompt sent into attempt 3/);
});

test("live shows the newest prompt", () => {
  assert.equal(promptForTab([M(2, "two"), M(3, "three")], "live", { completed: 3, max: 5 }).text, "three");
});

test("empty states are stated, never another tab's prompt", () => {
  const none = promptForTab([], "live", { completed: 0, max: 5 });
  assert.equal(none.text, undefined);
  assert.match(none.empty, /not been graded/);
  assert.match(promptForTab([M(2, "x")], "5", { completed: 5, max: 5 }).empty, /last attempt/);
  assert.match(promptForTab([M(2, "x")], "3", { completed: 2, max: 5 }).empty, /not been graded yet/);
  assert.match(promptForTab([M(2, "x")], "3", { completed: 4, max: 5 }).empty, /nothing was reported/);
  assert.match(promptForTab([], "live", { completed: 2, max: 5 }).empty, /nothing to report/);
});

test("a message without an attempt number takes its place in order", () => {
  assert.equal(promptForTab([{ kind: "feedback", text: "a" }, { kind: "feedback", text: "b" }], "2", { completed: 3, max: 5 }).text, "b");
});
