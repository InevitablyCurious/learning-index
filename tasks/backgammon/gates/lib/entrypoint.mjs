// ─────────────────────────────────────────────────────────────────────────────
// ENTRYPOINT RESOLUTION — one implementation, three spawners.
//
// The gate harness, the Playwright launcher, and the board's "view result" play
// server all have to start the SAME file the same way. If they disagree, the
// artifact a person plays is not the artifact that was graded, and the whole
// point of being able to play it — an independent check on what the grading
// says — is gone.
//
// It lives in `.mjs` rather than in `harness.ts` because the control plane is a
// long-lived plain-ESM host process and must not depend on TypeScript stripping
// to resolve a path. `harness.ts` re-exports it, so every existing importer is
// unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";

// ── THE RUNTIME FLAGS TRAVEL WITH THE FILE ──────────────────────────────────
//
// The scaffold's start command is `node --experimental-strip-types src/server.ts`,
// and the flag is not decoration: the worker image is node:22.12.0, and flagless
// TypeScript stripping needs >= 22.18. The model builds and self-verifies inside
// that container, so without the flag its own server does not start.
//
// Grading then ran `node <entrypoint>` with the flags DISCARDED, and worked only
// because the operator's host Node (22.23.2) is past the threshold and strips
// types natively. On any host below 22.18 the spawn throws, `pregate.ts` records
// `REQ-BIND/boot` as a PROBLEM — a gate failure attributed to the candidate —
// and every cell certifies a capability deficit that does not exist, at 100% of
// runs, in the tester's voice ("the game doesn't start up"). That is the
// false-certification class `07`(d) records from the origin seam.
//
// So the flags are returned with the file and passed to the spawn. The grader
// then starts the artifact the way the ARTIFACT says to start itself — the
// producer-states principle — and one command works on 22.12 and 22.23 alike.
//
// This does NOT close the deeper gap: the model still verifies on 22.12 and is
// graded on 22.23. Only grading inside the same image closes that.

/** The start command an artifact declares: `{ entrypoint, flags }`.
 *
 *  `flags` are the runtime flags between the executable and the script in
 *  `package.json`'s start script, in order, and is empty whenever the entrypoint
 *  came from the glob fallback (nothing declared how to start it).
 */
export function resolveStartCommand(targetDir) {
  const pkgPath = path.join(targetDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const startCmd = pkg?.scripts?.start;
      if (typeof startCmd === "string" && startCmd.trim().length > 0) {
        const parts = startCmd.trim().split(/\s+/);
        for (let i = 0; i < parts.length; i++) {
          if (!RUNTIMES.has(parts[i])) continue;
          let j = i + 1;
          const flags = [];
          while (j < parts.length && parts[j].startsWith("-")) flags.push(parts[j++]);
          const file = parts[j];
          if (file && /\.(ts|js|mjs|cjs|tsx|jsx)$/i.test(file)) {
            return { entrypoint: path.resolve(targetDir, file), flags };
          }
        }
      }
    } catch {
      // Unparseable package.json: fall through to the glob, flagless.
    }
  }
  return { entrypoint: resolveEntrypoint(targetDir), flags: [] };
}

const RUNTIMES = new Set(["node", "tsx", "deno", "bun", "next", "ts-node", "esrun"]);

// ── THE HOST MUST BE ABLE TO DO WHAT THE CONTAINER DOES ─────────────────────
//
// Asserted rather than assumed, because the failure it prevents is invisible:
// a host that cannot run the artifact produces 118 graded capability failures
// and no error anywhere. `07`(c) — a degraded run must be LOUD.
//
// The floor is the worker image's own version (docker/worker/Dockerfile), since
// the host has to be at least as capable as the runtime the model built in.
export const HOST_NODE_FLOOR = [22, 12, 0];

export function assertHostNodeFloor(version = process.version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!m) {
    throw new Error(`oracle: could not read the host Node version from ${version}`);
  }
  const got = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (got[i] > HOST_NODE_FLOOR[i]) return;
    if (got[i] < HOST_NODE_FLOOR[i]) {
      throw new Error(
        `oracle: host Node ${version} is below the floor v${HOST_NODE_FLOOR.join(".")} — `
          + "the candidate is built inside node:22.12.0 and graded here, so this host must be "
          + "at least as capable. Grading now would fail every candidate's server to boot and "
          + "record it as the candidate's failure. Upgrade Node and re-run.",
      );
    }
  }
}

/** Resolve the server entrypoint artifact-driven (no hardcoded filename).
 *  Priority: 1) package.json scripts.start  2) glob src/server.{ts,js,mjs,cjs}  3) throw.
 */
export function resolveEntrypoint(targetDir) {
  // 1) package.json scripts.start
  const pkgPath = path.join(targetDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const startCmd = pkg?.scripts?.start;
      if (typeof startCmd === "string" && startCmd.trim().length > 0) {
        // Extract the node/tsx/deno/bun executable + file from the start script.
        // Common patterns: "node src/server.js", "tsx src/server.ts", etc.
        const parts = startCmd.trim().split(/\s+/);
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          if (
            p === "node" ||
            p === "tsx" ||
            p === "deno" ||
            p === "bun" ||
            p === "next" ||
            p === "ts-node" ||
            p === "esrun"
          ) {
            // Skip runtime flags between the executable and the script —
            // `node --experimental-strip-types src/server.ts` is the scaffold's
            // own start command, and taking parts[i + 1] blindly reads the flag
            // as the filename, matches nothing, and silently falls through to
            // the glob. That only looks harmless while the file is still called
            // src/server.ts; rename it and this throws instead of resolving.
            let j = i + 1;
            while (j < parts.length && parts[j].startsWith("-")) j++;
            const file = parts[j];
            if (file && /\.(ts|js|mjs|cjs|tsx|jsx)$/i.test(file)) {
              return path.resolve(targetDir, file);
            }
          }
        }
      }
    } catch {
      // ignore parse errors, fall through to glob
    }
  }

  // 2) glob src/server.{ts,js,mjs,cjs}
  const srcDir = path.join(targetDir, "src");
  if (fs.existsSync(srcDir)) {
    const candidates = ["server.ts", "server.js", "server.mjs", "server.cjs"];
    for (const c of candidates) {
      const fp = path.join(srcDir, c);
      if (fs.existsSync(fp)) {
        return fp;
      }
    }
  }

  // 3) fail loudly — distinct failure class, never a gate failure
  throw new Error(
    `oracle: no entrypoint resolved — searched package.json scripts.start and src/server.{ts,js,mjs,cjs} in ${targetDir}`,
  );
}
