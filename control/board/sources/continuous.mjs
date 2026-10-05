// SOURCE: continuous — the continuous-mode chain (control/continuous.mjs): which
// run of the chain is going, what it started from, and, once ended, why. The
// board's banner (dashboard/panels/continuous.js) draws it.

import { readChain } from "../../continuous.mjs";

export const id = "continuous";
export const fields = ["continuous"];
export function describe() {
  return "continuous mode — the chain of runs, each from the last one's end snapshot";
}

export async function read(ctx) {
  return {
    ok: true,
    provenance: null,
    patch: { continuous: await readChain({ benchRoot: ctx.benchRoot }) },
  };
}
