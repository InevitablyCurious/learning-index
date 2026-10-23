# Security sweep, October 2026

A sweep against the week of 2026-10-19's advisories and supply-chain
incidents. The first pass (2026-10-22) fixed what does not touch the
measurement and held six changes that do. An impact assessment (opencode on
DeepSeek, 2026-10-22) judged the six; the ones it cleared landed on
2026-10-23, adjusted where the assessment or a measurement said so; the one
it held (Play on the host) landed the same day, contained in the grader image.

## Fixed, 2026-10-22

| What | Why |
|---|---|
| Control plane refuses writes carrying an `Origin`, and non-loopback `Host` names | Any web page on the operator's machine could POST to 127.0.0.1:8718 (no preflight for text/plain; routes parse any body as JSON): start runs, delete history, reset the tree, replace the router key. |
| Dashboard refuses `Host` names that are not an IP or localhost (`OKP_DASH_ALLOWED_HOSTS` to add one) | DNS rebinding: a page whose domain re-resolves to 127.0.0.1 passed both the peer and the same-origin check. |
| CI: `permissions: contents: read`, `persist-credentials: false` | A compromised dependency installed by CI finds no token that can push. |
| grader `source-map-js` 1.2.2 | CVE-2026-93749, inside the existing range. |

Checked and clean: no planted workflows, `.claude/settings.json` or
`.vscode/tasks.json` (GhostAction, Shai-Hulud/tensorlake), no MALFEX or
SAP-worm packages, no secrets in history, no `curl | sh`, vendored xterm.js
6.0.0 and diff2html have no advisories.

The same day's `litellm!=1.107.0` guard and transitive floors (certifi,
cryptography, urllib3, aiohttp, multidict) lived in `requirements.txt`, which
is now gone; see change 4.

## Landed, 2026-10-23

Changes 1–3 each move the fingerprint (`worker_image` for 1 and 3,
`grader_hash` for 2), so they landed together: one supersession, one fresh
baseline. 4 and 6 do not touch the measurement.

### 1. Worker and grader Node 22.12.0 → 22.23.4

- `node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d`
  in `images/worker/Dockerfile` and `images/grader/Dockerfile` (digest checked
  against Docker Hub). Fixes the 2026-10-21 Node release (CVE-2026-111497
  Brotli decoder RCE, CVE-2026-105483/106069 TLS hostname bypasses,
  CVE-2026-105482 DNS truncation, and every 22.x fix since 22.12.0).
- `HOST_NODE_FLOOR` is 22.23.4. `--experimental-strip-types` stays in the
  start command: it is the published contract and is accepted (redundant) on
  22.18+.
- Effect on what is measured: one-directional. A candidate that forgets the
  flag now boots where it used to fail; no gate, told line or prompt depends on
  that failure.
- The first pass said a meta test kept the two Dockerfiles equal. None did;
  `grader/meta/runtime-contract.test.ts` now does ("the grader image runs the
  same Node as the worker, digest and all").

### 2. Grader vitest 2.1.9 → 4.1.12

- Clears GHSA-5xrq-8626-4rwp, GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr,
  GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8, the vite and esbuild advisories:
  `npm audit` reports 0. Lock resolved with npm 11.21.1 (npm 10.9 crashes in
  arborist) and `--before=2026-10-21`.
- vitest 4 removed `poolOptions`. Both `vitest.config.ts` and
  `vitest.quarantine.config.ts` (the first pass missed the second) now say
  `maxWorkers: 1, isolate: false`, the migration guide's equivalent of v2's
  `singleFork`, which per the v2 docs already disabled module isolation.
- Measured, gate for gate (title, status, first line of the failure):
  golden 50/50 and scaffold 1 pass / 49 fail under 2.1.9 and 4.1.12, zero
  differences; the same with `isolate` on. Meta 84/84. The grader still runs
  each backend file as its own vitest process (`grader/lib/backend.mjs`).
- Stayed on 4.x: 4.1.12 clears every advisory; 5.x is a further major (its
  json reporter changes defaults) with nothing more to fix.

### 3. Worker Playwright 1.48.0 → 1.64.1

- GHSA-7mvr-c777-76hp affects only macOS; the worker is Linux, so this is
  currency, not a fix. It changes the browser the model checks its own work
  with, which is why it rode the same supersession.

### 4. Python: one dependency truth, CI installs from the lock

- `pyproject.toml` is the truth (`harness`: psycopg, plus the `test` extra).
  `uv.lock` described the pre-rename `bench` project and `requirements.txt`
  listed eight packages nothing imports (mini-swe-agent, and through it
  litellm). The lock was regenerated for `harness` (19 packages, hash-pinned,
  newest upload 2026-08-27) and `requirements.txt` was deleted, so litellm is
  no longer installed by this repo at all.
- CI: `uv sync --locked --extra test` (uv 0.10.12 via `astral-sh/setup-uv`
  v10.3.0 by SHA), then `.venv/bin/ruff` and `.venv/bin/python -m pytest`. A
  newly published release cannot reach CI until the lock moves.

### 6. GitHub Actions to current majors, by SHA

- checkout v7.0.1 (`3d3c42e5…`), setup-python v7.0.0 (`5fda3b95…`; v7.1.0 was
  under a day old), setup-node v7.1.0 (`949feb24…`). All three still declare
  the inputs the workflow passes (`persist-credentials`, `python-version`,
  `node-version`).

### 5. Play runs inside the grader image (landed 2026-10-23)

`/api/play/start`, the live build's auto-play and the hold-review OPEN used to
start the candidate's server on the host, as the operator, with the control
plane's full environment: it could read `~/.ssh`, the model keys and the Docker
socket. All three now go through `harness/play_container.py`: the candidate runs
in the grader image as uid 1000 on a per-session `--internal` network (no
internet, no host gateway), from a read-only worktree copied into tmpfs, with no
host environment, caps dropped, PID/memory/CPU limits and a 6 h lifetime; a
forwarder container publishes `127.0.0.1:<port>` and nothing else. The board
reaps only its own sessions, so its Stop never ends a hold review a run still
serves. `control/lib/loopback-shim.mjs` is gone. Proven: an integration test
boots the golden and shows the control plane, the LLM proxy and the internet
unreachable from inside, the worktree read-only and nothing left after stop;
a past cell played from the board's route renders and responds to Roll Dice.

## Verified on 2026-10-23

`ruff format --check .` clean; `pytest -m "not slow"` 4840 passed; dashboard
`node --test` 414/414; control `node --test` 528/528 (three stale pins fixed:
the golden hash, the wall row's keys, a hard-coded checkout path); grader
`test:meta` 84/84; backend vs golden 50/50.

On the rebuilt images: the worker runs Node v22.23.4 and Playwright 1.64.1,
and its Chromium (156) launches; the grader runs Node v22.23.4 and vitest
4.1.12, and its build-time proof passes the reference on every check
(frontend 87/87); `tests/test_docker_isolation.py` 19/19 against the new
worker; board preflight passes both images. CI is green on the new install
path.
