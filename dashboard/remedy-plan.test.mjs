// ─────────────────────────────────────────────────────────────────────────────
// PREFLIGHT REFUSAL -> THE BUTTON THAT FIXES IT
//
// The launch checklist used to end at "Fix what preflight named, then start
// again", where what preflight named was a shell command. Preflight now names a
// tool id, the control plane resolves it against the real registry, and this
// turns a list of failed checks into the SHORT list of distinct buttons.
//
// The grouping is the part worth pinning: a stale worker image trips several
// checks at once, and rendering one button per failed check would tell the
// operator to press rebuild three times for one problem.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import { remedyPlan } from "./panels/create.js";

const REBUILD = {
  id: "worker-image-rebuild",
  name: "Rebuild worker",
  status: "wired",
  blocked_reason: null,
  refuse_while_running: true,
};
const READY = {
  id: "control-restart",
  name: "Refresh control plane",
  status: "wired",
  blocked_reason: null,
  refuse_while_running: true,
};

test("several checks repaired by one tool collapse to ONE button", () => {
  const { remedies, unfixable } = remedyPlan([
    { name: "worker image", remedy_tool: REBUILD.id, remedy: REBUILD },
    { name: "serve-drive image", remedy_tool: REBUILD.id, remedy: REBUILD },
    { name: "self-compact phase gate", remedy_tool: REBUILD.id, remedy: REBUILD },
  ]);

  assert.equal(remedies.length, 1);
  assert.equal(remedies[0].name, "Rebuild worker");
  // Each button names what it repairs, so one press is visibly one press for
  // three failures rather than looking like it addressed only the first.
  assert.deepEqual(remedies[0].checks.map((c) => c.name), [
    "worker image",
    "serve-drive image",
    "self-compact phase gate",
  ]);
  assert.equal(unfixable.length, 0);
});

test("distinct tools stay distinct buttons, in the order they were named", () => {
  const { remedies } = remedyPlan([
    { name: "control plane", remedy_tool: READY.id, remedy: READY },
    { name: "worker image", remedy_tool: REBUILD.id, remedy: REBUILD },
  ]);
  assert.deepEqual(remedies.map((r) => r.id), ["control-restart", "worker-image-rebuild"]);
});

test("a failure with no tool is reported, never silently dropped", () => {
  // Dropping it would turn "press these two buttons" into a promise that the
  // next launch goes through — when an unarchived campaign slot is still in the
  // way and no button touches it.
  const { remedies, unfixable } = remedyPlan([
    { name: "worker image", remedy_tool: REBUILD.id, remedy: REBUILD },
    { name: "campaign slot", remedy_tool: null, remedy: null },
  ]);
  assert.equal(remedies.length, 1);
  assert.deepEqual(unfixable.map((c) => c.name), ["campaign slot"]);
});

test("a tool this installation does not have is unfixable, not a dead button", () => {
  // `remedy_tool` set but `remedy` null is the control plane saying "preflight
  // named a tool that is not registered here" — a bare clone of bench/ has no
  // dev-contributed tools. The check's own detail still names the fix in words.
  const { remedies, unfixable } = remedyPlan([
    { name: "control plane", remedy_tool: "control-restart", remedy: null },
  ]);
  assert.equal(remedies.length, 0);
  assert.deepEqual(unfixable.map((c) => c.name), ["control plane"]);
});

test("a blocked tool is still offered, carrying its own reason", () => {
  // Shown DISABLED with the reason rather than hidden: "the button that would
  // fix this cannot run, and here is why" is information; a missing button is
  // just an operator wondering what to do.
  const blocked = { ...REBUILD, status: "blocked", blocked_reason: "no docker on PATH" };
  const { remedies } = remedyPlan([
    { name: "worker image", remedy_tool: blocked.id, remedy: blocked },
  ]);
  assert.equal(remedies.length, 1);
  assert.equal(remedies[0].status, "blocked");
  assert.equal(remedies[0].blocked_reason, "no docker on PATH");
});

test("no failures means no block at all", () => {
  const { remedies, unfixable } = remedyPlan([]);
  assert.equal(remedies.length, 0);
  assert.equal(unfixable.length, 0);
});
