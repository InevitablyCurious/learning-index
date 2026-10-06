// assertRollTook: a roll that answers with dice the queue did not give is a
// refused setup, never an answer "that can't be checked".
import { describe, expect, it } from "vitest";
import { assertRollTook } from "../lib/harness.ts";

describe("assertRollTook", () => {
  it("accepts the dice that were queued, in either order, and a double as two or four", () => {
    expect(() => assertRollTook([6, 5], [5, 6])).not.toThrow();
    expect(() => assertRollTook([4, 4], [4, 4, 4, 4])).not.toThrow();
  });

  it("refuses other dice", () => {
    expect(() => assertRollTook([6, 5], [3, 1])).toThrow(/SETUP REFUSED/);
  });

  it("cannot check an answer that carries no dice, and does not refuse it", () => {
    expect(() => assertRollTook([6, 5], undefined)).not.toThrow();
    expect(() => assertRollTook([6, 5], [])).not.toThrow();
  });

  it("refuses dice that are not a flat list of numbers (the queued entry taken as one die)", () => {
    // run 1791304274: the page answered [[6,5],6] and every check riding on the roll
    // told the player their pieces showed no moves.
    expect(() => assertRollTook([6, 5], [[6, 5], 6])).toThrow(/SETUP REFUSED.*\[\[6,5\],6\]/);
  });
});
