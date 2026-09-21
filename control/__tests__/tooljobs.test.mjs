// ─────────────────────────────────────────────────────────────────────────────
// TOOL JOB TESTS — the tracked-job contract behind POST /api/tools/run
// (control/tooljobs.mjs). A tool run is started, not awaited: the request
// returns a job record, output streams into its tail, the verdict settles it,
// and the record is persisted so a restart reaps it honestly.
//
// The script path is exercised through the registry's own seam tests; these
// run every job through a throwaway custom-tools service, the same pattern as
// seam-tools.test.mjs.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HERE } from "./_shared.mjs";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "okp-tooljobs-"));
}

/**
 * Serve `tools` from GET /tools and answer POST /tools/run per `onRun`
 * ({ ok, code, reason, stdout, stderr, result } or a Promise of one, so a test
 * can keep a run open). Returns { url, hits }.
 */
async function withToolsService({ tools, onRun }, fn) {
  const { createServer } = await import("node:http");
  const hits = [];
  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET") return send(200, { tools });
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += String(c); });
      req.on("end", async () => {
        const payload = body ? JSON.parse(body) : {};
        hits.push(payload);
        send(200, await onRun(payload));
      });
      return;
    }
    send(404, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const saved = process.env.BENCH_TOOLS_URL;
  process.env.BENCH_TOOLS_URL = url;
  try {
    return await fn(url, hits);
  } finally {
    if (saved === undefined) delete process.env.BENCH_TOOLS_URL;
    else process.env.BENCH_TOOLS_URL = saved;
    await new Promise((r) => server.close(r));
  }
}

const TOOL = {
  id: "join-something",
  name: "Join something",
  blurb: "asks to be admitted",
  args: [{ name: "org", required: true }],
  timeout_ms: 5000,
};

async function settled(listToolJobs, root, jobId, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const j = listToolJobs(root).find((x) => x.id === jobId);
    if (j && j.status !== "running") return j;
    if (Date.now() - t0 > ms) throw new Error(`job ${jobId} did not settle in ${ms}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("JOBS: a run is started, not awaited — and settles with the tool's own words", async () => {
  const { startToolJob, listToolJobs } = await import("../tooljobs.mjs");
  const root = tmpRoot();
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    await withToolsService(
      {
        tools: [TOOL],
        onRun: async () => {
          await gate;
          return { ok: true, code: "ok", reason: null, stdout: "asked the leader", stderr: "", result: { sent: "yes" } };
        },
      },
      async () => {
        const start = await startToolJob(root, "join-something", { org: "org-7" });
        assert.equal(start.ok, true);
        assert.equal(start.code, "started");
        assert.equal(start.job.status, "running");
        assert.equal(start.job.tool_id, "join-something");
        assert.ok(start.job.started_at, "a job carries its start time");

        // While the service holds the answer, the job is live and says what it
        // is waiting on — the honest clock, not a fake percentage.
        const live = listToolJobs(root).find((j) => j.id === start.job.id);
        assert.equal(live.status, "running");
        assert.match(live.output_tail, /custom-tools service/);

        release();
        const done = await settled(listToolJobs, root, start.job.id);
        assert.equal(done.status, "succeeded");
        assert.equal(done.code, "ok");
        assert.match(done.output_tail, /asked the leader/);
        assert.deepEqual(done.result, { sent: "yes" });
        assert.ok(done.ended_at, "a settled job carries its end time");
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JOBS: a second press joins the running job — no overlapping rebuilds", async () => {
  const { startToolJob, listToolJobs } = await import("../tooljobs.mjs");
  const root = tmpRoot();
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    await withToolsService(
      { tools: [TOOL], onRun: async () => { await gate; return { ok: true, code: "ok", reason: null }; } },
      async (_url, hits) => {
        const first = await startToolJob(root, "join-something", { org: "org-7" });
        const second = await startToolJob(root, "join-something", { org: "org-9" });
        assert.equal(second.code, "already_running");
        assert.equal(second.job.id, first.job.id, "the same job answers both presses");
        release();
        await settled(listToolJobs, root, first.job.id);
        assert.equal(hits.length, 1, "the service ran once");
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JOBS: refusals happen before any job exists", async () => {
  const { startToolJob, listToolJobs } = await import("../tooljobs.mjs");
  const root = tmpRoot();
  try {
    await withToolsService({ tools: [TOOL], onRun: () => ({ ok: true }) }, async () => {
      const unknown = await startToolJob(root, "nope", {});
      assert.equal(unknown.ok, false);
      assert.equal(unknown.code, "unknown_tool");

      const missing = await startToolJob(root, "join-something", {});
      assert.equal(missing.ok, false);
      assert.equal(missing.code, "missing_arg");

      assert.deepEqual(listToolJobs(root), [], "a refused start writes no job record");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JOBS: a 'running' record that outlived the control plane is reaped as interrupted", async () => {
  const { listToolJobs } = await import("../tooljobs.mjs");
  const root = tmpRoot();
  try {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(
      join(root, "data", "tool-jobs.json"),
      JSON.stringify({
        jobs: [{
          id: "tj-old", tool_id: "grader-image-rebuild", tool_name: "Refresh grader",
          status: "running", code: null, reason: null,
          started_at: "2026-09-19T16:44:00.000Z", ended_at: null,
          last_output_at: "2026-09-19T16:54:52.000Z", output_tail: "#9 still building",
        }],
      }),
    );
    const jobs = listToolJobs(root);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "failed");
    assert.equal(jobs[0].code, "interrupted");
    assert.match(jobs[0].reason, /restarted/);
    assert.match(jobs[0].reason, /preflight/i, "the reap points at the check that can actually answer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JOBS: a running substrate tool blocks a launch; a non-substrate tool does not", async () => {
  const { startToolJob, substrateRefreshInFlight, listToolJobs } = await import("../tooljobs.mjs");
  const root = tmpRoot();
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    const freeTool = { ...TOOL, id: "harmless", name: "Harmless", args: [], refuse_while_running: false };
    await withToolsService(
      { tools: [TOOL, freeTool], onRun: async () => { await gate; return { ok: true, code: "ok" }; } },
      async () => {
        assert.equal(substrateRefreshInFlight(root), null, "no jobs, no block");

        const free = await startToolJob(root, "harmless", {});
        assert.equal(free.ok, true);
        assert.equal(
          substrateRefreshInFlight(root),
          null,
          "a tool allowed during a cell does not block a launch either",
        );

        const blocking = await startToolJob(root, "join-something", { org: "org-7" });
        assert.equal(blocking.ok, true);
        const inFlight = substrateRefreshInFlight(root);
        assert.equal(inFlight?.tool_id, "join-something", "a substrate tool in flight blocks");

        release();
        await settled(listToolJobs, root, blocking.job.id);
        assert.equal(substrateRefreshInFlight(root), null, "the block lifts when the job settles");
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JOBS: the store persists the settled record", async () => {
  const { startToolJob, listToolJobs } = await import("../tooljobs.mjs");
  const root = tmpRoot();
  try {
    await withToolsService(
      { tools: [TOOL], onRun: () => ({ ok: false, code: "exit_2", reason: "the hub refused", stderr: "no" }) },
      async () => {
        const start = await startToolJob(root, "join-something", { org: "org-7" });
        const done = await settled(listToolJobs, root, start.job.id);
        assert.equal(done.status, "failed");
        assert.equal(done.code, "exit_2");

        const onDisk = JSON.parse(readFileSync(join(root, "data", "tool-jobs.json"), "utf8"));
        assert.equal(onDisk.jobs[0].id, start.job.id);
        assert.equal(onDisk.jobs[0].status, "failed");
        assert.match(onDisk.jobs[0].output_tail, /no/);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JOBS: the board source publishes the jobs on the frame", async () => {
  const { startToolJob, listToolJobs } = await import("../tooljobs.mjs");
  const source = await import("../board/sources/tool-jobs.mjs");
  const root = tmpRoot();
  try {
    const empty = await source.read({ benchRoot: root });
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.patch.tool_jobs, { jobs: [], running: 0 });

    await withToolsService(
      { tools: [TOOL], onRun: () => ({ ok: true, code: "ok" }) },
      async () => {
        const start = await startToolJob(root, "join-something", { org: "org-7" });
        await settled(listToolJobs, root, start.job.id);
        const read = await source.read({ benchRoot: root });
        assert.equal(read.patch.tool_jobs.jobs[0].id, start.job.id);
        assert.equal(read.patch.tool_jobs.running, 0);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JOBS: the launch path wires the refresh gate (preview advisory, start refusal)", async () => {
  // Behavioural coverage of substrateRefreshInFlight is above; this pins the
  // wiring the behaviour depends on, since validateStart reads the real bench
  // root and a live fixture cannot be planted there.
  const validateSrc = readFileSync(join(HERE, "lib", "validate.mjs"), "utf8");
  assert.match(validateSrc, /substrateRefreshInFlight/, "validateStart must consult the job store");
  assert.match(validateSrc, /refresh_in_flight/, "the refusal code is refresh_in_flight");
  assert.match(validateSrc, /allowRefresh/, "preview must be able to bypass the gate (advisory, not refusal)");

  const runSrc = readFileSync(join(HERE, "routes", "run.mjs"), "utf8");
  assert.match(runSrc, /allowRefresh:\s*true/, "preview passes allowRefresh, like the serial gate's override");
  assert.match(runSrc, /refresh_now/, "preview surfaces the refresh advisory");
});
