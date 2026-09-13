#!/usr/bin/env node
/*
 * okp-bench supervised shell — process-group reaper for tool commands.
 *
 * PURPOSE. opencode's bash tool runs `shell -c "<command>"` and waits for EOF
 * on the stdout pipe. A command that backgrounds a child (`node … &`) leaves
 * that child holding the pipe open after the command itself exits, so EOF
 * never arrives and the turn stalls until opencode's ~600s watchdog aborts
 * it. This wrapper runs the command in its OWN process group (detached spawn
 * → setsid) and SIGKILLs the ENTIRE group when the command exits — on normal
 * exit as well as on timeout — so no descendant can outlive the turn holding
 * a pipe.
 *
 * INVOCATION CONTRACT. Drop-in shell replacement:
 *   supervised-shell -c "cmd" …   →   bash -c "cmd" …
 * All argv after the wrapper name are passed to bash verbatim; stdin/stdout/
 * stderr are inherited (byte-transparent pass-through). Exit status mirrors
 * bash: the command's code on normal exit, 128+signo when signalled, 127 when
 * bash itself cannot spawn, 124 when this wrapper's timeout fires (GNU
 * timeout convention).
 *
 * TIMEOUT CONSTRAINT [HARD]. The default 90s timeout (BENCH_TOOL_TIMEOUT_S
 * overrides) MUST stay BELOW opencode's ~120s binary-internal bash cap. That
 * cap is not settable, and when it fires it force-kills only the DIRECT child
 * — leaving backgrounded grandchildren alive and re-introducing exactly the
 * orphan this wrapper exists to prevent. This wrapper must always cut first.
 *
 * On timeout, if BENCH_TOOL_TIMEOUT_MARKER_DIR is set, ONE marker file
 * `timeout-<wrapper pid>` is written there: "<unix seconds> <command, first
 * 200 chars>\n" — the same best-effort forensic-marker pattern as
 * loop-kill-scanner.cjs.
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');

const args = process.argv.slice(2);

// Timeout: BENCH_TOOL_TIMEOUT_S seconds when it is a positive finite number,
// else the 90s default (see the HARD constraint in the header comment).
const DEFAULT_TIMEOUT_S = 90;
const parsedTimeoutS = Number.parseFloat(process.env.BENCH_TOOL_TIMEOUT_S || '');
const timeoutS =
  Number.isFinite(parsedTimeoutS) && parsedTimeoutS > 0 ? parsedTimeoutS : DEFAULT_TIMEOUT_S;
const timeoutMs = timeoutS * 1000;

const markerDir = process.env.BENCH_TOOL_TIMEOUT_MARKER_DIR;

let timedOut = false;

// detached:true → libuv calls setsid() on POSIX, so the child is a session
// and process-group leader and `-child.pid` names the WHOLE group (bash plus
// every descendant) on both macOS and Linux. stdio:'inherit' is the
// byte-transparent pass-through for stdout/stderr/stdin.
const child = spawn('bash', args, { detached: true, stdio: 'inherit' });

function killGroup() {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Group already gone (ESRCH) or pid unavailable — nothing left to reap.
  }
}

// Backstop: cut the whole group at timeoutMs. unref() so this timer alone
// never keeps the wrapper alive — the child handle owns the event loop.
const timer = setTimeout(() => {
  timedOut = true;
  killGroup();
}, timeoutMs);
timer.unref();

child.on('error', (err) => {
  process.stderr.write(`supervised-shell: ${err.message}\n`);
  clearTimeout(timer);
  process.exit(127); // bash could not spawn
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  // THE ESSENTIAL FIX: reap the WHOLE group on NORMAL exit too, not only on
  // timeout — a backgrounded grandchild holding the stdout pipe is killed
  // here, so the caller sees EOF the moment the command itself finishes.
  killGroup();

  if (timedOut) {
    if (markerDir) {
      try {
        fs.mkdirSync(markerDir, { recursive: true });
        const command = args.join(' ').slice(0, 200);
        fs.writeFileSync(
          `${markerDir}/timeout-${process.pid}`,
          `${Math.floor(Date.now() / 1000)} ${command}\n`
        );
      } catch {
        // Marker is best-effort forensics; never mask the 124.
      }
    }
    process.exit(124); // GNU timeout convention
  }

  if (signal) {
    const SIGNO = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
    process.exit(128 + (SIGNO[signal] ?? 1));
  }

  process.exit(code == null ? 1 : code);
});
