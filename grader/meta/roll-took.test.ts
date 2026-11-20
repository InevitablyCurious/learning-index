// assertRollTook: a roll that answers with dice the queue did not give is a
// refused setup, never an answer "that can't be checked". It reads the roll's
// whole answer: dice the computer rolled in the same call are not the roll's.
import { describe, expect, it } from "vitest";
import { assertRollTook } from "../lib/harness.ts";

const white = (dice: unknown) => ({ turn: "white", phase: "move", dice });

describe("assertRollTook", () => {
  it("accepts the dice that were queued, in either order, and a double as two or four", () => {
    expect(() => assertRollTook([6, 5], white([5, 6]))).not.toThrow();
    expect(() => assertRollTook([4, 4], white([4, 4, 4, 4]))).not.toThrow();
  });

  it("refuses other dice while the roll is still the player's", () => {
    expect(() => assertRollTook([6, 5], white([3, 1]))).toThrow(/SETUP REFUSED/);
    // A tied opening stays the player's to roll again: other dice there are refused too.
    expect(() => assertRollTook([3, 3], { turn: "white", phase: "openingRoll", dice: [4, 2] })).toThrow(/SETUP REFUSED/);
  });

  it("cannot check an answer that carries no dice, and does not refuse it", () => {
    expect(() => assertRollTook([6, 5], undefined)).not.toThrow();
    expect(() => assertRollTook([6, 5], white(undefined))).not.toThrow();
    expect(() => assertRollTook([6, 5], white([]))).not.toThrow();
  });

  it("does not refuse an answer that already shows the computer to move", () => {
    // run 1795181750 (a11): queued 1-2, the computer won the opening and rolled
    // 4-5 inside the same /api/roll; "the debug endpoint didn't take the dice" was
    // told of a queue the build had used. What the computer then moved is G31's.
    expect(() => assertRollTook([1, 2], { turn: "black", phase: "move", dice: [4, 5] })).not.toThrow();
    expect(() => assertRollTook([1, 2], { turn: "black", phase: "move", dice: [1, 2] })).not.toThrow();
  });

  it("refuses dice that are not a flat list of numbers (the queued entry taken as one die)", () => {
    // run 1791304274: the page answered [[6,5],6] and every check riding on the roll
    // told the player their pieces showed no moves.
    expect(() => assertRollTook([6, 5], white([[6, 5], 6]))).toThrow(/SETUP REFUSED.*\[\[6,5\],6\]/);
  });
});
