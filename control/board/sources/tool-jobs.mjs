// SOURCE: tool-jobs — the refresh/custom-tool jobs (control/tooljobs.mjs).
// Publishing them on the board frame is what makes a refresh observable: live
// output, elapsed time and the verdict reach every attached client, survive a
// reconnect, and outlive the request that started them.

import { listToolJobs } from "../../tooljobs.mjs";

export const id = "tool-jobs";
export const fields = ["tool_jobs"];
export function describe() {
  return "tool jobs — refresh/custom tool runs: status, live output tail, verdict";
}

export async function read(ctx) {
  const jobs = listToolJobs(ctx.benchRoot);
  return {
    ok: true,
    provenance: null,
    patch: {
      tool_jobs: {
        jobs,
        running: jobs.filter((j) => j.status === "running").length,
      },
    },
  };
}
