// RESUME FROM A CHECK-POINT (dev loop step 6): the control plane's half.
// Dev mode only; a real check-point under the runs root; a known phase; bound
// into the confirmation token so a preview for one check-point cannot start
// another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { confirmationToken, restatement } from "../contract.mjs";
import { resolveResume } from "../lib/validate.mjs";

function runsWithCheckpoint(meta) {
  const runs = mkdtempSync(join(tmpdir(), "resume-"));
  const cp = join(runs, "backups", "1794311852", "cell-0000", "checkpoints", "cp-01");
  mkdirSync(join(cp, "tree"), { recursive: true });
  writeFileSync(join(cp, "cp.json"), JSON.stringify({ attempt: 1, phase: "initial", ...meta }));
  return { runs, rel: join("backups", "1794311852", "cell-0000", "checkpoints", "cp-01") };
}

test("RESUME: refused outside dev mode", async () => {
  const { runs, rel } = runsWithCheckpoint({ build_phase: 4 });
  const out = await resolveResume({ checkpoint: rel }, { runsRoot: runs, devPause: false });
  assert.equal(out.refused?.code, "resume_needs_dev_mode");
});

test("RESUME: absent is no resume", async () => {
  const out = await resolveResume(undefined, { runsRoot: "/x", devPause: true });
  assert.deepEqual(out, { resume: null });
});

test("RESUME: the phase comes from the check-point, and a contradicting one is refused", async () => {
  const { runs, rel } = runsWithCheckpoint({ build_phase: 4 });
  const ok = await resolveResume({ checkpoint: rel }, { runsRoot: runs, devPause: true });
  assert.equal(ok.resume.phase, 4);
  assert.equal(ok.resume.rel, rel);
  const bad = await resolveResume({ checkpoint: rel, phase: 5 }, { runsRoot: runs, devPause: true });
  assert.equal(bad.refused?.code, "resume_phase_conflict");
});

test("RESUME: an old check-point needs its phase named", async () => {
  const { runs, rel } = runsWithCheckpoint({});
  const missing = await resolveResume({ checkpoint: rel }, { runsRoot: runs, devPause: true });
  assert.equal(missing.refused?.code, "resume_phase_unknown");
  const named = await resolveResume({ checkpoint: rel, phase: 4 }, { runsRoot: runs, devPause: true });
  assert.equal(named.resume.phase, 4);
});

test("RESUME: a path outside the runs root, or not a check-point, is refused", async () => {
  const { runs } = runsWithCheckpoint({ build_phase: 4 });
  const outside = await resolveResume({ checkpoint: "/etc" }, { runsRoot: runs, devPause: true });
  assert.equal(outside.refused?.code, "resume_checkpoint_outside");
  const notCp = await resolveResume({ checkpoint: "backups" }, { runsRoot: runs, devPause: true });
  assert.equal(notCp.refused?.code, "resume_checkpoint_invalid");
});

test("RESUME: bound into the token and stated in the restatement", () => {
  const base = { model: "m", arm: "off", org: null, kind: "local", compact: true, devPause: true };
  const resume = { rel: "backups/x/cp-01", phase: 4 };
  const plain = confirmationToken(base);
  const resumed = confirmationToken({ ...base, resume });
  assert.notEqual(plain, resumed);
  assert.match(resumed, /resume=backups\/x\/cp-01@4/);
  assert.match(restatement({ ...base, resume }), /NOT a measurement/);
});
