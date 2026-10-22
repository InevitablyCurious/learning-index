# Security sweep, October 2026

A sweep against the week of 2026-10-19's advisories and supply-chain
incidents. The fixes in the first table are merged on this branch. The
second table lists changes that alter what the benchmark measures, held for
an impact assessment (opencode on DeepSeek) before they land.

## Fixed

| What | Why |
|---|---|
| `litellm!=1.107.0` in `requirements.txt` | Backdoored on PyPI 2026-10-21 (credential stealer + hourly loader). Reaches us via `mini-swe-agent`. CI did not run in the exposure window. |
| certifi 2026.10.19, cryptography 50, urllib3 2.8.0, aiohttp 3.14.5, multidict 6.9.1 | GHSA-6q48-6c7w-9gw2 (emSign roots with compromised intermediates), CVE-2026-69247, CVE-2026-97687/97689, aiohttp and multidict advisories. Floors in `requirements.txt`, upgrades in `uv.lock`. |
| grader `source-map-js` 1.2.2 | CVE-2026-93749, inside the existing range. |
| Control plane refuses writes carrying an `Origin`, and non-loopback `Host` names | Any web page on the operator's machine could POST to 127.0.0.1:8718 (no preflight for text/plain; routes parse any body as JSON): start runs, delete history, reset the tree, replace the router key. |
| Dashboard refuses `Host` names that are not an IP or localhost (`OKP_DASH_ALLOWED_HOSTS` to add one) | DNS rebinding: a page whose domain re-resolves to 127.0.0.1 passed both the peer and the same-origin check. |
| CI: `permissions: contents: read`, `persist-credentials: false` | A compromised dependency installed by CI finds no token that can push. |

Checked and clean: no planted workflows, `.claude/settings.json` or
`.vscode/tasks.json` (GhostAction, Shai-Hulud/tensorlake), no MALFEX or
SAP-worm packages, no secrets in history, no `curl | sh`, vendored xterm.js
6.0.0 and diff2html have no advisories.

## Held for assessment

Each changes the runtime or the instrument a benchmark run is measured with,
so runs before and after are not directly comparable.

### 1. Worker and grader Node: 22.12.0 → 22.23.4

- Why: the 2026-10-21 Node release (CVE-2026-111497 Brotli decoder, possible
  RCE; TLS hostname bypasses CVE-2026-105483/106069; DNS truncation
  CVE-2026-105482; permission-model bypass in `fs.realpathSync`), plus every
  22.x fix since 22.12.0.
- Image: `node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d`
  in both `images/worker/Dockerfile` and `images/grader/Dockerfile` (a meta
  test requires the two to match).
- Measured on 22.23.4: grader meta 83/83, backend gates vs golden 50/50,
  dashboard 414/414, control plane same as on 22.22.0, Python 4834 passed.
- Behaviour change: 22.18+ strips TypeScript without a flag, so a candidate
  that forgets `--experimental-strip-types` boots in the worker where it
  used to fail. `grader/lib/entrypoint.mjs`, `grader/meta/runtime-contract.test.ts`,
  `harness/grader_image.py` and `docs/system-map.md` name 22.12.0 and reason
  about the flag; they need the same update.
- Residual risk if held: low in practice. Candidate code is untrusted and
  already sandboxed; nothing feeds it outside Brotli input.

### 2. Grader vitest: 2.1.9 → 4.1.12

- Why: GHSA-5xrq-8626-4rwp (critical, UI server), GHSA-5gmw-xhrv-c9v3 and
  GHSA-85c8-ppgw-ccpr (critical, tinypool), GHSA-82fw-gwwq-j7x9,
  GHSA-qxg6-89mg-rqv8, eight vite advisories, esbuild GHSA-67mh-4wv8-2f99.
  None is reachable by `vitest run` in the sealed grader container.
- Measured with 4.1.12 (lock resolved with npm 11; npm 10.9 crashes in
  arborist's peer-set loading): 0 advisories across 73 packages; meta 83/83;
  backend vs golden 50/50; backend vs scaffold 1 pass / 49 fail under both
  versions with **zero per-gate differences** and the same JSON report shape.
- Required with it: vitest 4 removed `poolOptions`, so
  `vitest.config.ts`'s `poolOptions.forks.singleFork` would be silently
  ignored. Migrate to the v4 top-level equivalent (`maxWorkers: 1`,
  `isolate: false`) and update the RPC-timeout note in `grader/lib/backend.mjs`.

### 3. Worker Playwright: 1.48.0 → current

- GHSA-7mvr-c777-76hp affects only the macOS `*_mac.sh` reinstall scripts;
  the worker is Linux and installs Chromium only, so it is not exploitable
  there. Bumping changes the browser the model verifies with.

### 4. CI installs from a hash-locked set

- CI runs `pip install -r requirements.txt` unpinned, so any future
  backdoored release lands in CI the moment it is published. `uv.lock`
  still locks the pre-rename "bench" definition while `pyproject.toml`
  declares only psycopg; reconcile the two, then install with
  `uv sync --locked` (or hashed requirements).

### 5. Play runs candidate code on the host

- `/api/play/start` spawns the candidate's server with the operator's
  permissions; the loopback shim limits only network exposure. Running it
  inside the grader image would contain it.

### 6. GitHub Actions on Node 20

- `actions/checkout`, `setup-python` and `setup-node` are pinned to
  Node-20 releases that the runner now forces onto Node 24. Not a
  vulnerability; move to current majors by SHA.

## Running the assessment

```sh
npm i -g opencode-ai@1.18.20
# DEEPSEEK_API_KEY set as an environment secret, never on the command line
opencode run -m deepseek/deepseek-v4-pro \
  "Read docs/security-sweep-2026-10.md and the files it names. For each held change, assess what could break in the benchmark and in comparability with past runs, and recommend land / land with changes / hold."
```
