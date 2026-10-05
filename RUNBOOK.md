# RUNBOOK.md — the operative run card
**Version:** 8 · **Status:** OPERATIVE · **Supersedes:** v7 (2026-09-04) · **Amended:** 2026-09-22 (concurrency + median baselines landed: N-concurrent cells, per-cell live-view port, batch-median baseline with fingerprint + operator selection — §0/§3/§7/§10; the live N=1-vs-N=8 contention measurement remains PENDING, §11)

> This is the authoritative operations reference for the benchmark; where another document disagrees, this one governs.

---

## WHAT YOU ARE MEASURING

Read this before the procedures. Every rule below exists to protect it.

**The measurement is an INFORMATION DELTA:** how much a memory system's
accumulated knowledge is worth to a given model on a controlled task, and the
iteration at which more knowledge stops helping.

**The knowledge is DURABLE SOLUTIONS** — not preferences. Extraction harvests
FAILURES-TO-GREEN from the session record: the dead ends and the fixes, each
carrying what was done, why, and grounded evidence. Later ON cells carry that
forward.

**The cycle:**

    OFF baseline -> extract -> ON with knowledge injected -> read four signals
    (less context? fewer turns? faster? better results?)
    still improving -> run ON again against the larger corpus
    degrading       -> STOP. That turn is the delta.

That turning point is the information delta for THAT model on THAT memory system.

**Every model is its own control.** The same model runs both arms, so its context
window, its speed and its raw ability cancel out of its own delta. This benchmark
does not rank models against each other on score — it compares their deltas. The
injected block is a fixed character budget, identical for every model, so a larger
context window does not buy a model more memory. This is why the picker offers
every model the provider lists and badges narrow-context ones rather than hiding
them: a narrow window is a runnability caveat, not a source of bias.

**Substrate-neutral by intent:** any provider, any memory system. OrcaRouter is
the pinned default so a public checkout runs unconfigured — a default, not a
requirement.

---

> **What changed from v5.**
> (1) **`TESTING.md` is absorbed and deleted.** There is now exactly one operative document (RC-8).
> (2) **The wipe was dangerously incomplete (§2).** A chain wipe destroys the org's epoch key, so the
> local master key in the bench keystores goes stale and **must be cleared in the same step**, or the
> first ON cell fails to decrypt. The mandatory residue check and the re-baseline exception are now
> stated too.
> (3) **New §7 (the stack), §8 (measurement integrity), §9 (extraction and review), §10 (variance
> policy).** These absorb the recall topology, clone bring-up, oracle isolation, the extraction
> integrity correlation mechanics, the smart-leader procedure and the full variance triggers — all of
> which previously existed only in documents now deleted.
> (4) **The harness version is no longer asserted.** Two documents disagreed about it. The card
> records the worker image fingerprint measured at run time instead (§1, RC-5, §6).
> (5) **Rule 5.7 is reconciled with Option A** — published requirements are deliberate; hidden
> constants are the defect (§8).
> (6) **The 900 s hung-process rule is defined** and re-based on the status stream (rule 5.15).

> **NOTATION RULE — absolute.** Never emit literal angle-bracket thinking tags in any chat response,
> commit message, log line, report, or config comment. Write `OPEN_THINK` / `CLOSE_THINK` in prose.
> Emitting the literal tag desyncs the streaming parser and terminates the turn.

---

## 0. OPERATOR QUICKSTART — start one cell (or N concurrent)

Everything an operator needs to launch a run. Rationale and rules live in the sections cited.

### THE SHORT VERSION — preflight, then start

**Do not hand-run the checks below. Run preflight, then run what it prints.**

```bash
# LOCAL cell (`--model` = bench alias):
.venv/bin/python scripts/bench_preflight.py --model qwen3.6-35b-a3b-bench
# CLOUD cell (`--model` = the MODEL HALF of the `{provider}/{model}` roster key):
.venv/bin/python scripts/bench_preflight.py --cloud --provider deepseek --model deepseek-chat --mode off
```

It performs EVERY check in this section — the local model relay port, worker-image
staleness, the campaign slot (active-tree-aware: `runs/<tree>/…/<model>`; the legacy flat
`runs/cumulative-<model>` slot only when no tree pointer exists), disk — then prints **GO** with
the exact launch command (correct flag order, `< /dev/null` included), or **NO-GO** naming the fix.
Exit 0 = GO, 1 = NO-GO.

Added 2026-08-11 because doing this by hand cost a full discovery pass every run: the
steps were spread across §0/§2.1/§7. A memory system's own services (its MCP, hub and identity)
are NOT checked here: that belongs to whoever manages the memory system, and a baseline uses none
of them. **It only reads and reports** — it never archives, wipes, or
launches; those stay operator decisions (step 3a, §2).

**Start — PRIMARY: the control plane** (`127.0.0.1:8718`). It owns backgrounding, stdin
discipline, log placement and run state — no `nohup`, no `< /dev/null`, no hand-placed log.
Preview, read the restatement, confirm:

```bash
curl -s -X POST 127.0.0.1:8718/api/run/preview \
  -d '{"model":"qwen3.6-35b-a3b-bench","arm":"off"}'
# CLOUD payload: {"model":"deepseek/deepseek-chat","arm":"off","kind":"cloud"}
# (model = the {provider}/{model} roster key; ON cells add "org":"<org>")
# N concurrent cells: add "concurrency":<N> (default 1) — the control plane sequences all N
# → {"token":…, "restatement":…} — read the restatement, then confirm:
curl -s -X POST 127.0.0.1:8718/api/run/start -d '{"confirm":"<token>"}'
```

The control plane spawns `run_cumulative.py [--cloud --provider <vendor> --model <model> |
--model <alias>] [--org <org>] run --mode <arm>` and writes the launch log IN-TREE at
`runs/<tree>/<arm>-cell-<stamp>-s<NNNN>.log` plus a durable per-cell launch record at
`runs/<tree>/launches/<run_id>.json` (the record's `log_path` keys the log; enumeration and
STOP read the records, not the logs — §7). The direct `nohup` CLI launch (step 3 below)
remains a valid SECONDARY path.

The manual equivalents below are reference for debugging a NO-GO.

```bash
# 1. Preflight — the local model relay must answer (§7 for bring-up):
nc -z 127.0.0.1 4545   # local relay (session + extraction models)

# 2. Worker image — rebuild when images/worker/ CHANGED since the last build
#    (the plugin tree BENCH_PLUGIN_DIR names is baked in at build time; unset
#    builds vanilla — no plugin; a stale image runs the stale plugin silently). Freshness is a content question, not a
#    timestamp one: the build bakes a digest of its own source and preflight
#    reads it back. Compare by hand with:
docker image inspect bench-worker:v1 --format '{{index .Config.Labels "okp.worker.source_digest"}}'
#    vs .venv/bin/python -c 'from harness.worker_image import *; from pathlib import Path; print(source_digest(Path("images/worker")))'
#    Rebuild (this is the ONLY build that records what it was built from):
.venv/bin/python scripts/rebuild_worker_image.py

# 3. Run one cell — SECONDARY PATH. The control plane (127.0.0.1:8718) is the
#    recommended start (above): it owns backgrounding, stdin discipline and log
#    placement, and writes the log IN-TREE at runs/<tree>/<arm>-cell-<stamp>-s<NNNN>.log —
#    NOT runs/off-cell-$TS.log. This direct launch places its own log via the
#    shell redirect below. (OFF; ON cells add `--mode on`, §2).
#    `--model <alias>` pins the subject: the proxy makes that exact model
#    resident on the first request (exclusive load on call — no manual load
#    step). Flags before the subcommand are main-parser flags — argparse
#    rejects them after `run` (verified 2026-08-10: exit 2).
#    --model is REQUIRED — the auto-resident roster rung is retired
#    (run_cumulative.py exits 2 without it).
TS=$(date +%Y%m%dT%H%M%S) && nohup .venv/bin/python scripts/run_cumulative.py \
  --model qwen3.6-35b-a3b-bench run --mode off \
  < /dev/null > "runs/off-cell-$TS.log" 2>&1 & disown
#    `< /dev/null` is MANDATORY: without it zsh suspends the job the instant the
#    process touches stdin ("suspended (tty input)"), leaving a half-built
#    manifest and a live container behind. Set TS in the SAME command as the
#    launch — a separately-pasted $TS is empty in the next command.

# 3a. Model switch mid-campaign: --model changes the roster hash, so the
#     existing manifest rejects the run ("roster hash drift detected").
#     This is BY DESIGN — one manifest = one subject model, so OFF/ON pairing
#     inside a manifest is always same-model. Archive (never delete) via the
#     control-plane TREE RESET (§7) and rerun:
curl -s -X POST 127.0.0.1:8718/api/tree/reset/preview   # → token + restatement + moves/keeps
curl -s -X POST 127.0.0.1:8718/api/tree/reset -d '{"confirm":"<token>"}'
#     The reset rolls forward: the results tree + active-tree.json +
#     baselines.json (+ pre-tree cumulative-* folders, cell logs)
#     move into runs/backups/<unix-seconds>/ and a fresh tree is minted.
#     NOTHING IS DELETED. The server corpus is untouched (§2 wipe rules still
#     govern that).

# 4. Watch + attach. The runner logs the session id and attach command itself
#    (status stream `step=live-view`) and writes them to the cell's live-view
#    marker. One copy-paste that prints the FULL attach command for the live
#    cell (tree layout: runs/<tree>/<substrate>/<router>/<provider>/<model>/
#    memory<ARM>/cell-NNNN/live-view.txt):
sed -n 's/^attach_cmd=//p' runs/*/*/*/*/*/memory*/cell-*/live-view.txt
#    (equivalently, from the launch log — in-tree for control-plane starts:)
grep -E 'attach_cmd|session_id' runs/<tree>/<arm>-cell-<stamp>-s<NNNN>.log | tail -5
#    then attach to the cell's live worker serve — the id is per-run, e.g.:
opencode attach http://127.0.0.1:<port> --session ses_00b54ddb7ffemO5eRSBu0ni034
#    Each cell's live view is published on its OWN host port — free-port allocated
#    per run-instance (2026-09-22; supersedes the fixed :8719). Read the port from
#    the cell's `cell.start` record (surfaced on the board) or the attach_cmd in
#    live-view.txt; do not assume a fixed port. `--session` is NOT optional:
#    without it the terminal UI opens its own new-session view instead of the live
#    worker session.
```

**Control plane (recommended) and cloud cells.** A cell may also be started through the control
service (`127.0.0.1:8718`) — `POST /api/run/preview` → confirm token → `POST /api/run/start` with
body `{"confirm": "<token>"}`; it owns backgrounding, stdin discipline, log placement and run state.
A CLOUD cell (OrcaRouter, BILLED) takes the main-parser flags `--cloud --router orcarouter
--provider <vendor> --model <model>` (e.g. `--provider deepseek --model deepseek-chat` = DeepSeek
V3); the local `--model <bench-alias>` shape above does NOT apply to cloud.

**Optional — hold the stack for UI review.** Set `BENCH_HOLD_UI=1` on the
run environment. At benchmark end (all attempts + gates done) the cell is NOT torn down: the
artifact's server boots host-side from the bind-mounted worktree on `http://localhost:8002` —
the exact code the model wrote, via the same boot the gates perform — and the run waits. The log
carries a loud `HOLD-UI ACTIVE` line with the URL, the held container name, and the release
command; machine-readable state is `<run_dir>/hold-ui.json`. Browse the UI (the live view
also stays up), then release: `touch <run_dir>/RELEASE_HOLD`. Teardown + reap then run
unconditionally as always (RC-6); heartbeat progress lines keep the status stream live during
the wait (rule 5.15 is not tripped). Never set this on an unattended cell — the run waits until
released or killed, and a kill still tears the stack down.

**Recovery — "roster hash drift detected ... start a fresh run":** the manifest pins the
model roster; a provider/model migration invalidates it. Archive (never delete) via the
control-plane TREE RESET — `POST /api/tree/reset/preview` → confirm token →
`POST /api/tree/reset` (§7) — and rerun. The reset rolls forward: the results tree,
`active-tree.json`, `baselines.json` (+ pre-tree `cumulative-*` folders, cell
logs) move into `runs/backups/<unix-seconds>/` and a fresh tree is minted; nothing is
deleted. This is a harness-level reset only; the server corpus is untouched (§2 wipe rules
still govern that).

Auth: no key setup needed for the local path — `LOCAL_LLM_PROXY_API_KEY` resolves from
`.env`, the environment, or `opencode.json` provider config, in that order (spend_key.py).
Extraction is a separate invocation after the cell (§9), never folded into the run.

---

## 1. THE CAMPAIGN

**Goal:** measure lift on whatever model is resident — does an accumulated corpus from The Open Knowledge Project make the
same model resolve more of the same problem set, in fewer attempts, on a later run.

**Claim being made (do not overstate):** the corpus was taught durable **solutions to shared
problems**. A compiled-solutions system. **NOT** a capability-lift claim. Held-out variants are
required before any "models get better" statement, internal or external.

**The honest limit (2026-08-07):** this campaign cannot measure the human gate, restraint
under the real governor, stranger-contributed memory, real outcome lag, production coverage, corpus
scale, adversarial behaviour, or portability across people and machines. It proves that an
accumulated corpus makes the same model resolve more of the same problem in fewer attempts, under
ideal conditions with the human removed. **That is not a claim about the product.** (Also recorded
where the claim is stated in `BENCHMARK-DIARY.md` §1.1/§1.2 — deliberate dual carriage, an exception to
the anti-bloat rule (2026-08-07): a claim appearing anywhere without its limit is the failure
this fixes.)

| | |
|---|---|
| Subject model | **operator-selected via `--model <alias>`** (2026-08-10): the flag names a pinned proxy bench alias; the proxy makes that exact model resident on the first request. `--model` is REQUIRED — the auto-resident roster rung is retired (exit 2 without it). Cloud mode is distinct: `--cloud --provider <vendor> --model <model>` selects a `{provider}/{model}` key from the OrcaRouter provider block, not a local bench alias. Identity is always read from the API response and recorded (RC-7) |
| Org | **one org for the entire campaign**, recorded in the manifest; pre-provisioned via the dashboard (`okp-org-0`), leader Ed25519 fingerprint `aa2aa706` |
| Runtime | **oMLX (the local model runtime).** The `--model` alias pins which checkpoint the proxy loads. Identity is read from the API response and recorded in the manifest, so this row is documentation, never a gate |
| Transport | session production model AND session extraction model → local relay proxy `:4545` → resident oMLX model. **ONLY** the embedding/vector-dim path bypasses the proxy to the local embedding endpoint directly |
| Harness | OpenCode in a Docker worker image + plugin. **The version is not asserted here** — the worker image fingerprint is measured at run time and recorded in the manifest (RC-5); the operator confirms it matches the commit under test before the campaign (§0 step 2) |
| Task | the LOCKED backgammon prompt — unstructured, no requirements checklist |
| Oracle | deterministic: Playwright conformance + Vitest backend + Playwright chromium. **No LLM judge exists anywhere in scoring.** |

**Do not touch the frozen direct entry.** The proxy-bypass entry under `provider.lmstudio` serves
the maintainer's live interactive session so the proxy container can restart without cutting the maintainer off. Only
its `name` field may change.

---

## 2. THE SEQUENCE AND THE ENTRYPOINTS

**The campaign sequence, in full:**

> **test** (all green) → **wipe** (once) → **OFF cell** → **extract** →
> **first scored ON cell** → **extract** → continue

Each stage is **its own invocation**. Nothing here is nested inside anything else. If a procedure
cannot be expressed as one of the stages below, it is not a procedure — it is drift, and it gets
deleted rather than documented.

**There are no smoke stages (2026-08-11).** A smoke that proves the recall seam
requires a full session, an extraction, and an approval first — and that can only be produced by
running a session in full. A standalone smoke therefore proves nothing and has never worked. Delivery
verification is **in-band**: the first post-wipe OFF cell builds the corpus, its extraction commits
it, and the first ON cell's status stream either carries non-null injection seams
(`injected_count`, `injected_block_chars`, `injected_block_est_tokens`, `consumer_injected_count`) —
delivery proven on the built artifact through the real transport — or it does not, which is the
rule-18 walk-back class. The first ON cell IS the delivery verification.

**TEST**
1. Start the stack.
2. Run the tests.
3. Tear down the stack.
4. Reap — leftover processes and leaked memory.

Gate: all green. Nothing proceeds on a red suite, and nothing proceeds on an *unverified* one.
Targets and conventions: §14.

**Scope (2026-08-07):** TEST means the bench pytest suite (§14). The dev integration
suite is **not** part of the pre-campaign stage: its suites POST `/v1/test/reset` — a route the hub
build does not register (`cmd/hub/main.go:390-397` vs `dev/tests/lib/hub-client.ts:95`)
— and its mutating tests would create orgs and memories on the live campaign's hub and chain, the
same hazard class as a second wipe. The reset route must NOT be registered to accommodate it. The
suite is restored behind a guard after the campaign, not before. Recorded as the
integration-suite quarantine (§11).

**SMOKE — REMOVED (2026-08-11).** Both former smoke stages (stack smoke, ON
smoke) are deleted from the campaign. The ON smoke purported to verify recall delivery before the
first scored ON cell, but verifying recall requires a full session, an extraction, and an approval —
obtainable only by running a session in full — so the smoke could never certify anything and has
never worked. Delivery verification is in-band (see the sequence above): the first ON cell's
injection-seam values are the proof, and null injection values on an ON cell remain a rule-18
walk-back class.

**WIPE — the full procedure, and it is not one command**

A wipe is destructive across three separate stores, and doing only the first is the failure that
silently ruins a campaign.

1. **Run the wipe target** (it lives outside this repo). It stops the bench MCP, brings the compose
   project down destroying its volumes, wipes bench state, wipes host state, brings the stack back
   up, rebuilds, restarts the bench MCP and verifies clean. Gate is the final line
   `=== VERIFY-CLEAN: PASS (13/13) ===`.
2. **The leader keystore is cleared by the wipe target** (`bench-wipe` removes
   `~/.okp/bench/leader-keystore` + `bench/.okp`). **Never `~/.okp/keys`** — that is
   the maintainer's canonical key directory. The leader seed + mnemonic (`~/.okp/bench/leader-seed.txt` /
   `leader-mnemonic.txt`) survive every wipe; `bench-mcp-start` re-commissions the keystore from the
   bench identity seed (`~/.okp/bench/bench-identity-seed.txt`, distinct from the leader wallet).
   **The retired `~/.okp/bench/contrib-keystore/` is NOT auto-wiped** — the maintainer deletes it
   manually (residue from the deleted two-clone model).
3. **Run the residue check.** All four must hold before anything proceeds:
   Qdrant memory collections empty or absent · chain and Postgres state fresh · served cache cleared
   · the bench keystore gone (absent or fresh). **Any residue: STOP and FIX.** Do not proceed.
4. **Start the bench MCP** (§7). `bench-mcp-start` re-commissions the keystore from the bench
   identity seed and seam-asserts the served fingerprint (`22f765e8`).

**The wipe is sanctioned only BEFORE THE FIRST CELL — a wipe AFTER THE FIRST CELL is barred.** The
boundary is the first cell, not "exactly once, ever": a genesis wipe at campaign start, when zero
cells have run and the corpus is empty, destroys nothing measurable and is the sanctioned wipe. A
wipe after even one cell has run destroys the accumulated corpus the ON arm exists to measure. It
does not fail loudly — it silently converts every subsequent ON cell into an OFF cell with extra
steps, and the campaign reports no lift. That silent-corruption protection is exactly why the
boundary is the first cell: the rule protects against a wipe once cells exist, and protects nothing
when the corpus is empty. **Reasoning (recorded, 2026-08-07):** the older "exactly
once, ever" phrasing forbade a legitimate second genesis wipe that occurs before the first cell;
the hazard the rule guards against — silently corrupting ON measurement — cannot arise until a cell
has run, so the bar is correctly placed at the first cell, not at "ever."

**The one exception (rule 5.13):** only a **true regression or total benchmark failure** justifies
re-baselining. That is a deliberate, declared act — never a casual re-wipe, never a "let's try it".
A re-baseline wipes the corpus and so is a walk-back (rule 18) — declared, never hidden.

**A failed cell needs an ARCHIVE, not a wipe (2026-08-11).** When a cell dies (`harness_error`, void
instrument, an aborted launch), the manifest still pins that cell's `sequence_index`, and
`build_off_order` emits exactly one OFF slot per roster entry — so a one-model roster has no second
OFF slot to run. The correct move is the §0 step 3a archive — the control-plane TREE RESET
(`POST /api/tree/reset/preview` → confirm token → `POST /api/tree/reset`, §7), which rolls the
results tree forward into `runs/backups/<unix-seconds>/` and mints a fresh one, deleting nothing —
and it costs nothing measurable. **This is NOT a wipe and does not touch the server
corpus**; the wipe rules above still govern that. Do not reach for a wipe because a cell failed —
check whether the corpus is actually non-empty first (`memory_standing`, `extracted_sessions`,
`pending_submissions` in `okp_hub`). A cell that died before extraction committed anything leaves
the corpus empty, so a wipe would destroy nothing AND still be barred.

**BENCH `MODE=on|off`** — one cell. See §3.

**`--org`** — an optional label recorded with the run's cells, in both arms; omitted, the run
falls back to `okp-org-0`. It does not configure memory: a memory-ON cell's memory is set by the
memory system's own settings (`BENCH_MEMORY_UPSTREAM`, `BENCH_MEMORY_ENV` — ENV-VARS.md).
**CLI syntax:** `--org`, `--model`, `--roster-model`, `--task`, `--seed`, `--manifest` are
MAIN-parser flags and must precede the subcommand
(`run_cumulative.py --model <alias> run --mode on`). argparse rejects them after `run`
with exit 2 (verified 2026-08-10). `--until-review` is DEAD (removed by `ba2947a`).

**EXTRACT** — two distinct surfaces, both separate from the bench command, never folded inside it.

1. **In-session extraction (the harvest)** runs DURING the cell: the worker plugin — the tree
   `BENCH_PLUGIN_DIR` baked into the image at `/opt/bench-plugin` — exposes a capture tool, and the
   model CALLS it (one call per knowledge claim) to record failures-to-green — `traj_label` /
   `polarity` (`negative`|`positive`) / `statement` / `did_what` / `did_why` / `evidence[]`. Capture
   lands in `<stateDir>/insession/<sessionId>/{master.json, changed-lines.json}` at `session.idle`,
   and the harness harvests it at cell end (`_export_cell_telemetry`). The capture tool is PLUGIN
   surface, built outside this repo: the benchmark loads whatever plugin the pointer names, defines
   no memory-system interface of its own, and never ships memory-system code in the public repo.

2. **Leader-side extraction** is now **dashboard-driven**: point the dashboard at the cell's exported
   session DB (`OPENCODE_DB_PATH=<cell>/session-db/opencode.db`) → Sessions page → "Extract with this
   model" → `/v1/extract`. The CLI `extract` subcommand is DEAD (removed by `ba2947a`). The integrity
   gate and the smart-leader procedure are §9.

### Consequences — these follow from the sequence and are not separately negotiable

- **The first bench after the wipe is necessarily OFF — and it is UNSCORED.** The corpus is empty
  by construction. This first OFF cell exists to build a non-empty corpus so the first ON cell
  (which follows its extraction) has something to recall.
- **One org for the whole campaign.** Any scheme assigning an org per arm or per model is stale and
  wrong: it breaks corpus accumulation, which is the only thing being measured. The maintainer's 2026-08-07
  reasoning, transcribed: someone must be responsible for a corpus, and the org focuses context for
  retrieval and extraction alike.
- **Mode toggles exactly one thing** — whether injection runs before attempt 1 (RC-4).
- **Wipe and extract are separate invocations, never nested inside `bench`.** The operator runs each
  stage.

**Not every entrypoint above exists yet.** This section is the contract they are built to. See §11.

---

## 3. THE CELL — N concurrent cells per start, one per invocation

> **Concurrency landed (2026-09-22).** This section once read "one per invocation, always — the
> harness never runs cells concurrently." That is superseded. The control plane's `/api/run/start`
> now accepts a `concurrency` count N (default 1) and launches N cells at once; the harness itself
> still runs **one cell per invocation** and never loops, pairs arms, or decides what runs next. A
> live cell blocks only **its own model's** next launch (per-model gate), so different models run
> concurrently.

**The first pass is chunked (2026-08-09).** Attempt 1 is a
sequence of chunk prompts (`task/backgammon/prompts/chunk-01..06.md`), driven in order through
the one serve session. Per chunk: drive → settle compaction → next
chunk.

- **A CHUNK IS OVER WHEN THE SESSION GOES IDLE. Nothing else (WO-MARKER-RIP, 2026-09-09).**
  The harness reads NOTHING the model wrote to decide a chunk is done. It used to: every chunk
  prompt instructed the model to print `CHUNK FINISHED`, the harness scanned that chunk's own
  messages for the string, and a chunk that went idle without it was re-driven with a nudge up to
  ten times before failing the attempt on `marker_nudge_exhausted`. **All of that is deleted** —
  the instruction is out of the six prompts, the scan and its nudge are out of the driver, the
  `_MAX_MARKER_NUDGES` budget is gone, and `serve_client.last_assistant_text` /
  `assistant_texts_since` (which existed only to serve it) are gone with them. The marker was a
  SELF-REPORT standing in for an event the transport already reports: a model could print it
  having written nothing, withhold it having written everything, and — because the instruction
  lived only in the build prompts while repair runs in the SAME session — kept printing it out of
  habit while fixing gate failures. Do not reintroduce a completion string, in any wording, for
  any phase.
- **Chunk state is the transport's verdict.** `build_chunk_completion` reports `complete` when the
  drive returned exit 0, `died` when it did not (with the named `killed_reason`), and
  `not_reached` for every chunk after a death. `stubs_remaining` beside it is what says whether the
  work was actually done — a `complete` chunk whose owned file still holds scaffold stubs is
  flagged on the board. The rows no longer carry a `marker` field, and the `nudges` column now
  counts UPSTREAM RECOVERIES (see below), the only re-drives that still exist.
- **Inter-chunk compaction — RESTORED (2026-09-03), worker-side self-fire.** Removed by W1
  (2026-08-27) and restored by WO-COMPACTION-RESTORE: the benchmark's own `images/worker/self-compact.ts`
  (benchmark-native since 2026-09-15 — baked into EVERY worker image at `/opt/bench/self-compact.ts`,
  with or without a memory plugin, so both arms compact identically) is wired into the image's
  opencode plugin array with a hard-assert on its presence (`images/worker/Dockerfile`). **The trigger is `session.idle` and nothing the model wrote (2026-09-09).** There is no
  model-called tool and no model-emitted string: on `session.idle`, when `BENCH_SELF_COMPACT=1` AND
  the harness's phase sentinel reads `build` AND the session's fire budget is not spent AND a 60 s
  cooldown has elapsed AND no fire is already in flight AND this assistant turn has not already
  fired, the plugin fires `session.summarize({auto:true})` — disarm-first, model resolved from the
  session. **Budget: 6 fires per session** (`MAX_FIRES_PER_SESSION`) — six build chunks, six
  boundaries; a seventh fire is by definition not a boundary. The budget is the independent
  backstop under the sentinel: if the sentinel were ever left stale on `build`, a runaway
  compaction loop is bounded at six instead of running for the life of the session. It is spent at
  FIRE TIME and is not refunded by a failed summarize.
  Autocontinue is suppressed for self-fired compactions only (the harness sends the next chunk
  prompt itself); overflow auto-compaction keeps its default autocontinue. Opt-in behind the
  `--compact` flag (flag/UI passing unchanged) — the flag flows to the cell as env
  `BENCH_SELF_COMPACT=1`. The harness only OBSERVES the fire: at each chunk boundary it runs a
  bounded fail-closed wait (`_settle_after_chunk`, `_COMPACT_SETTLE_TIMEOUT_S=300` with a 20 s
  start-grace) for the worker's own summarize to land a compaction part; no part within the wait
  is `no_compaction_evidence` and aborts the cell. No fallback, backstop, or substitute summarize
  exists anywhere — the harness never fires compaction itself.
- **BUILD-PHASE-ONLY is enforced by a harness PHASE SENTINEL — and since 2026-09-09 the sentinel
  is the WHOLE gate.** This line once read "the marker lands only at the end of each of the 6 build
  steps, so compaction fires there and never during troubleshooting/repair." THAT WAS FALSE, and
  run 1788462647 falsified it: the worker-side arm fired 9 times, and the 9th landed ~80 s before
  the end of `feedback-2`. `CHUNK FINISHED` was a MODEL-EMITTED convention, not a harness event;
  the instruction lived only in the six chunk prompts, but repair rounds run in the SAME session
  with no system prompt and no phase framing, so the convention survived every compaction and the
   model kept printing it while fixing gate failures (its own capture-tool labels read
   `chunk7-*`/`chunk8-*`). It was also INVISIBLE: `_settle_after_chunk` runs only at build
  boundaries, and VOID-INSTRUMENT (`run_artifacts.py`) catches only a compaction that was KILLED,
  so a stray one that COMPLETED scored as a normal cell. Both arms were equally exposed, so the ON
  leg was measuring "chunk compaction + stochastic repair compaction". **The marker condition is
  now deleted, so there is no second gate to fall back on and the sentinel has to be exact.**
  THE MECHANISM (A2): the phase is knowable exactly on the harness side, so the harness declares
  it. `_run_opencode_serve` — the single choke point every scoring attempt passes through — writes
  the current phase (`build` or `repair`, per `compact_phase_for`) to a host file before every
  prompt; the file is bind-mounted READ-ONLY at `/okp-compact/phase` (outside `/work`, so the model
  never sees it and the gates never score it) and the plugin re-reads it on every `session.idle`.
  **EXACTLY ONE DRIVE PER CHUNK IS FLAGGED `build`**, which is what the plugin's six-fire budget
  assumes: the chunk drive itself carries `build`. `feedback-*` and any
  unrecognised phase map to `repair`. Mounted for BOTH arms whenever `--compact` is set.
  FAIL-CLOSED IN EVERY DIRECTION: unset env, unreadable file, or any value other than `build`
  means DO NOT FIRE, and a cell armed with `--compact` but no sentinel path refuses to launch.
  A broken sentinel therefore surfaces as `no_compaction_evidence` at the first chunk boundary.
  Preflight asserts the BAKED plugin actually reads `BENCH_COMPACT_PHASE_FILE`, so a stale image
  cannot run an older arm.
- **One fire per boundary (2026-09-03).** The arm previously stamped its cooldown on summarize
  SUCCESS, so an idle arriving while a summarize was still in flight passed the 60 s cooldown and
  re-fired off the same turn still in retained history — chunks 2 and 3 each compacted twice in
  run 1788462647. Three debounce guards now cover three distinct windows: a synchronous in-flight
  lock (concurrent idles), the cooldown stamped AT FIRE TIME rather than on success (the minute
  after a fire), and the message id of the assistant turn that fired (that same turn, forever — a
  compaction does not delete that turn from the transcript, so the cooldown alone was never
  sufficient). A failed summarize keeps all three stamps AND its spent budget: the fail-closed
  settle wait is what turns a genuinely absent compaction into an abort.
- **THE NUDGING PROTOCOL FIRES ON UPSTREAM PROXY TERMINALS AND NOTHING ELSE (WO-MARKER-RIP,
  2026-09-09).** A closed set of three conditions, every one of them raised by the relay and none
  of them by the model:

  | Condition | Relay terminal | Nudge |
  |---|---|---|
  | repetition loop kill | `relay_loop_detected` | `_LOOP_RECOVERY_NUDGE` (anti-repetition) |
  | stream death | `relay_stream_finalize_timeout` **or** `relay_stream_incomplete` | `_FINALIZE_RECOVERY_NUDGE` (resume) |
  | provider outage | the relay relaying someone else's 5xx/"temporarily unavailable" | `_PROVIDER_RECOVERY_NUDGE` (resume, after a backoff) |

  There is no fourth trigger, and none may be derived from what the model wrote. The deleted
  fourth — a missing `CHUNK FINISHED` — is why this is now stated as a closed set: a nudge keyed on
  model prose re-drives a model that is not stuck, into a context it just filled.
  **Matching keys on the relay's typed `type`/`code`, not its prose.** `extract_transcript_metrics`
  prefixes an assistant error's `name`/`data.type`/`data.code` onto its message before
  classification, so a relay build that reworded a message is still classified correctly; the prose
  strings remain as a fallback for older builds.
  **`relay_stream_incomplete` joined the recoverable set on 2026-09-09.** It previously fell
  through to the generic `error_event`, which is NOT recoverable — so a stream that died mid-flight
  ended the phase unretried and climbed the cell ledger as an unrecovered anomaly, i.e. voided a
  cell for a transport fault. It is a relay terminal exactly like the finalize watchdog and is
  recovered exactly like one; the reason recorded on the anomaly stays the precise one that fired.
  **ONE BUDGET, fail-closed.** Recovery re-drives at most `_MAX_SERVE_RECOVERY_NUDGES=20` times per
  phase, then stops — the anomaly stays unretried and the drive ends exactly as a non-recoverable
  terminal would. There is no longer a second, per-chunk budget. The zero-tool resume is gone
  entirely: the stdout fallback transport that hosted it was purged 2026-09-03 — one transport
  (the serve session), no second route. The WO-NUDGE-INF-1 unbounded era ended with the 2026-09-02
  compaction-looping incident, which rode the recovery loop to 126+ events with no exit.
  Stalls, loops and oversized generations remain NORMAL agentic behaviour under measurement — the
  price of benchmarking, not a fault that invalidates it.
  **Consequence to plan for:** a permanently wedged relay IS self-terminating — budget exhaustion
  fails the drive closed with a named cause; hang detection on the status stream remains the
  operator's sensor, but is no longer the only exit.
- **Relay-killed turns are recovered — never counted as scoring turns.** A relay loop-guard kill (`guard_abort`) or
  stream-finalize-watchdog kill is metered (tokens burned — true burn is never hidden), then
  re-driven (anti-repetition nudge for a loop kill, resume nudge for a finalize kill). **Both**
  kinds of killed turn are subtracted from scoring turns and reported on `guard_aborted_turns` /
  `finalize_timeout_turns` — that exclusion is what keeps repeated nudging from inflating the
  measurement: a phase nudged N times scores exactly what an un-nudged phase scores. The anomaly
  classification is **watermark-windowed**: a killed message's `info.error`
  persists in the transcript forever, so each drive classifies only the messages produced since the
  last classification point — a stale kill can never re-trip a recovered, completed drive
  (2026-08-10 chunk-2 defect). Cross-reference (rule 5.10): recovered turns never count as
  scoring turns, and a cell whose anomalies were ALL recovered is still scored, not voided —
  only an unrecovered anomaly (a false phase end the harness graded on) voids the cell.

Attempts 2+ remain the error-only feedback loop.
Chunk content is arm-identical (mode toggles only injection, RC-4). Editing any chunk changes the
manifest's `chunk_plan_hash` → the roster-drift recovery applies (§0): tree-reset archive
(`POST /api/tree/reset/preview` → confirm → `POST /api/tree/reset`, §7), rerun. Serve-phase
metering is per-phase **delta** against a pre-send baseline; a phase that ends
with zero new turns AND zero new tokens is a loud `silent_phase` failure, never a clean zero.

1. **Select ON or OFF.** Passed as a parameter.
2. **Watch progress** from the status stream the run publishes (RC-5). Deterministic sensor only —
   no poller, no LLM judge.
3. **The cell ends.** Extraction is the next invocation, not part of this one.

**One cell per invocation; N concurrent per start (2026-09-22, supersedes "never runs cells
concurrently").** The control plane sequences and tracks all N cells itself — the dashboard sends ONE
"run N cells" request, and the control plane allocates N distinct `sequence_index` values, opens N
per-cell logs, and spawns N detached harnesses. The harness never loops over cells, never pairs arms,
never pre-runs a baseline set, never decides what runs next. A cell of a given model blocks only that
model's next launch (per-model gate, `models-ledger.mjs`); the baseline is no longer a single OFF run —
it is the operator's chosen run out of an N-cell batch, reported as the batch median (see §10).

**What a cell does internally:** build from the fixture → gates run host-side regardless of how the
worker terminated → problems-only feedback (§8) → repeat, `max_attempts` 5 → resolved problems →
publish status → done.

**Resolution happens ACROSS attempts, not within one.** Attempt 1 builds; attempts 2–5 repair
against problems-only feedback. That repair is what produces `resolved_count`, and `resolved_count`
is what produces memories. A cell that cannot reach attempt 2 produces nothing, however good the
artifact is.

**The code fixture resets every run. The memory corpus persists.** Source edits are not
organizational learning; corpus growth is. Per-run reset is **code fixture only** — never re-wipe
chain, Postgres or Qdrant, never reset corpus state.

**Extraction runs in both modes.** An OFF cell is how the corpus gets built in the first place.

---

## 4. THE INVARIANTS THAT MAKE THIS HOLD

**RC-4 · Mode toggles exactly one thing.** `MODE` governs whether the recall/injection step runs
before attempt 1. **Nothing else in the codebase may branch on mode.** Gates, feedback, attempt
ceiling, extraction, teardown and scoring are byte-identical across ON and OFF. Fields that are null
by contract on OFF cells are not a branch; anything else is. This is enforceable by a test that
fails on any mode-conditional branch outside the injection call site, and that test closes the
entire class of "the arms were not comparable" defects that has voided runs before.

ON delivery verification is **reader-side, not a writer gate** — there is no `index_ready` symbol in
the code (the stage machine carries no such stage, pinned by
`tests/test_cumulative_sequencer.py::test_stage_machine_has_no_extract_review_commit_or_index_ready_stages`).
A fail-closed `delivery_state=="unverified"` delivery record — written for an ON cell whose injection
seams did not prove non-null — EXCLUDES that cell from the scored set at read time
(`run_artifacts.py:335-348`; only `"unverified"` excludes, any other value is ignored). This is not a
second branch on mode: OFF has no delivery record by design, and the exclusion changes no computed
metric — it only marks which ON cells are `not_scored`, so the per-arm numbers stay comparable.

**RC-5 · One run directory, one manifest, one status stream.** Every run writes a manifest — model
identity as reported by the API, mode, org, commit, **worker image fingerprint**, seed, template
hash — and an append-only status file. The watcher reads **only** the status file. The scorecard is
generated **only** from the manifest plus the status file. No other artifact is a source of truth.
The status stream carries, per attempt: served model identity as reported by the API; the progress
vector; token accounting with **injected-memory-block tokens counted separately from work tokens**;
the injection observability values; extraction-attempt observability; and the terminal outcome with
its reason.

**RC-5a · Task-template freeze (scaffold hash).** Re-frozen 2026-09-29 to
`55743d5e9e0826b2ead2d92e291c6ddb33117dfd15fa36a7d97e0e654f767a34` (WO-GOLDEN-V2-B3): the scaffold's
`src/game.ts` gained `"openingRoll"` in the phase union and `createGame` now says the new game starts
in phase "openingRoll" (white to move). The frozen value is now DERIVED — `FROZEN_TASK_TEMPLATE_HASH
= default_spec().scaffold_hash`, read from `task/backgammon/challenge.json` — so re-freezing updates
`challenge.json` (via `scripts/freeze_challenge.py --write`) plus the test `FROZEN` literal, never a
literal in `run_cumulative` (see the procedure below). Two intervening re-freezes (2026-09-24 scaffold
comments = chunk-01 listing; 2026-09-25 header no longer names each side's home points) were recorded
only in `tests/test_template_freeze_guard.py`. The 2026-09-15 freeze (`d7088d77…`) this section
formerly declared is now historical: CONTRACT.md left the scaffold for `task/backgammon/reference/`,
so the model is given the six build prompts and nothing else, and the prompts were rewritten to carry
the graded contact points without the rules and design hints a candidate should supply itself. **Retired 2026-09-19:** `reference/CONTRACT.md` was DELETED and its
29 `REQ-*` rules relocated into the six chunk prompts (engine rules + G05 higher-die → chunk-02; cube
state → chunk-04; difficulty wiring → chunk-05; REQ-COMPLETE → chunk-06), reversing the 2026-09-15
rule-thinning — the six prompts are now the complete specification and `reference/` holds only a
README. This changes `chunk_plan_hash` (over `prompts/`), NOT the scaffold hash below. The published-surface guard
(`tests/test_instruction_surface_consistency.py`) now reads the prompts. Prior freeze history:
the hash was `d2d2f0b798f586101bb34a698235eb1dea691b1ed760f66a316a53fd6ae42928` (re-baselined
2026-08-30 by `2314693`: gate E08's `allSequences` + `REQ-SEQ-DEDUP` requirement published into
`scaffold/CONTRACT.md` + `prompts/chunk-02.md`, superseding the `9391d77d…` freeze — the
ease-of-use calibration that cut `public/style.css` to a placeholder and moved package.json +
CONTRACT.md's Node clause to `--experimental-strip-types`; which in turn superseded `1ed04db2…`, a
2026-08-24 blinding-pass re-freeze, and `08afc8011cde5b81e6e158def2bc040f42372bbc1e32e7ca125382c27031cdb1`,
the 2026-08-10 feedback-contract baseline that moved CONTRACT.md into the scaffold so the
published requirements seed every worker worktree; supersedes `a68ff9cb…`, whose cells are walked
back by the declared re-baseline), computed as SHA-256
over the live `task/backgammon/scaffold/` directory (sorted relative path + raw bytes per file) —
the exact bytes the harness hashes at runtime (`compute_task_template_hash` / `_compute_task_template_hash`,
scripts/run_cumulative.py). Any change to the scaffold invalidates this hash and therefore every
previously scored cell; the run path fails closed (`verify_task_template_frozen`, wired at the start
of `prepare_fixture`). This is the **task template** (backgammon scaffold) — distinct from the agent
reasoning template referenced in §12/§17.

**Re-freeze procedure (all four, in one change).** Any scaffold edit that changes the file set or
its bytes must: (1) recompute `compute_task_template_hash` (SHA-256 over sorted relative path + raw
bytes of every file under `task/backgammon/scaffold/`); (2) update `task/backgammon/challenge.json`'s
`scaffold_hash` via `scripts/freeze_challenge.py --write` — `FROZEN_TASK_TEMPLATE_HASH` in
`scripts/run_cumulative/template.py` is DERIVED (`default_spec().scaffold_hash`) and follows it
automatically — AND `FROZEN` in `tests/test_template_freeze_guard.py` **together**; the freeze-guard
test pins `MODULE.FROZEN_TASK_TEMPLATE_HASH == FROZEN` (`test_template_freeze_guard.py:84-85`), so a
one-sided update fails the suite; (3) refresh the
RC-5a hash line above; (4) declare it a **re-baseline** — a re-freeze invalidates comparability of
every previously scored cell, never silent bookkeeping.

**RC-6 · Teardown and reap are unconditional.** They run on success, on failure, on abort and on
operator interrupt. The reaper kills the run's process group, reaps orphaned Playwright/node
children, brings the compose project down, asserts no listener remains on the bench ports, and
**reports what it killed.** A silent reaper is not a reaper. The gate path spawns real
`node report.mjs` Playwright subprocesses at `backgammon.py:2213` (`_run_gate_report`; definition `:3441`, spawn `:3468-3475`).

**RC-7 · The harness never selects a model; the operator does, by flag.** Amended 2026-08-10:
the subject is chosen per run by the operator's `--model <alias>` flag, which names
a pinned proxy bench alias — the proxy then makes that exact model resident on the first request
(exclusive load on call; the swap is refused with retryable 409 while another stream is in flight).
The harness still never decides anything about identity: it is read from the API response and
recorded in the manifest and per-attempt status stream. No identity gate. A served-model change is
**observed and recorded, never aborted on**. Because the flag changes the roster hash, switching
models invalidates the manifest (§0 archive-and-rerun) — one manifest = one subject model, so
OFF/ON pairing inside a manifest is always same-model.

**The corpus is model-agnostic and switching models is expected.** It accumulates knowledge
regardless of which model produced an entry, which model consumes it, in what order, or how often.
Rule 5.2 binds a single cell and says nothing about the campaign. Nothing in this system ties a
corpus to one model, and no rule may be written that does.

**After any model load, before any scored run:** verify the loaded context length is what you
intend, verify parallelism, and get **one real completion through the transport**. **Never accept a
TTL'd load** — a load that auto-unloads mid-campaign voids the cell it was serving. The mechanism is
the operator's; the check is not optional.

**RC-8 · One operating document.** This one: `RUNBOOK.md`, the file you are reading. Anything else
is deleted or demoted to history with no authority over what runs.

**RC-9 · Open-source usability.** The bench must plug into a user's own provider module. It may
never carry hard constraints that force a user to configure their whole provider backend to fit the
benchmark. If it is designed that way, it is wrong.

**RC-10 · Simplify the bench before re-complicating the stack.** If the benchmark needs something
the simplified proxy does not give, first ask whether the benchmark can be simplified instead.

**RC-11 · Docker is the ONLY worker path.** If Docker is unavailable the adapter raises a clear
error and stops. **There is no silent host-side fallback run**, and none may be added: a host-side
run has none of the isolation guarantees in §8 and would be scored as though it did.

---

## 5. BINDING RULES

1. **R-BENCHMARK-INTEGRITY.** End-to-end delivery verification is **in-band**
   (2026-08-11): the first post-wipe ON cell's status stream must carry non-null injection seams
   (`injected_count`, `injected_block_chars`, `injected_block_est_tokens`,
   `consumer_injected_count`) — observed on the built artifact through the real transport. Null
   values there are the rule-18 walk-back class. After **any** pipeline change, the next ON cell
   re-proves delivery the same way before its result is counted.
2. **Extraction model equals producer model.** `extractor ≠ producer` is not a valid arm. This binds
   one cell. It says nothing about the campaign.
3. **Extraction-integrity hard abort.** See §9 — the condition, the discovery path and the
   correlation keys. This is the only extraction condition that aborts a run.
4. **A duplicate denial is never a failure.** The smart leader has exactly one question: *is this a
   duplicate of knowledge already in the corpus?* Not quality. Not novelty. Not usefulness. Not
   safety. Denying one, several, or all candidates aborts nothing.
5. **Quantity mapping.** One resolved problem ≈ one atomic memory candidate. A cell resolving N
   problems that emits ≈0 or ≫N candidates is a **measurement red flag to investigate**, not an
   auto-abort. This mapping stays diagnostic forever.
6. **No LLM judge in scoring. No LLM judge at injection.** The oracle is deterministic, and stays so.
7. **Do not change the task prompt.** It stays unstructured: no requirements checklist, no required
   filenames. **Reconciliation with Option A — read this before "fixing" anything:** pass-required
   behaviour *is* deliberately published in the worktree contract artifact, so a worker can derive
   what is required. That is intentional and does not weaken the instrument. What is withheld from
   the worker is **the oracle itself and the expected/observed values** (§8), never the
   requirements. Do not "restore" hidden constants — that is the defect class Option A fixed.
8. **VARIANCE-POLICY.** Full policy at §10. Never claim inside the noise floor.
9. **Set the seed. Do not rely on it.** It reaches the runtime and reduces variance, and it is free.
   But floating-point non-associativity means kernel reduction order varies with batch shape and MoE
   routing adds load-dependent variability, so determinism must never be claimed.
10. **VOID-INSTRUMENT classes — never scored as capability FAIL:** `finish_reason=length` with
    visible tokens < 100 · any cell run with an unproven seam (§6) · any cell run under a template
    configuration differing from its paired arm · any **unrecovered** provider-side truncation —
    one the harness could NOT recover, so it registered a false phase end and graded the session
    on it (`truncated_no_signal`, `transport_error`/`error_event`, `observation_lost`). A
    truncation the nudging protocol DID recover (guard loop-kill `guard_abort`,
    `provider_unavailable`, `stream_finalize_timeout`) is metered and re-driven and does **not**
    void — that cell is still scored. Since `9786da4`, provider-side truncated turns are
    **recorded as first-class outcomes** in the manifest (`truncated_turns` /
    `truncated_turns_retried`), not dropped — observable, metered, retry-linked — and the
    producer states the void-relevant subset directly as `unrecovered_anomaly_turns`
    (non-recoverable anomalies only, regardless of retry status).
11. **Never infer a pass from the absence of a violation flag.** A clean `invariant_violation:
    false` cannot distinguish "extraction never invoked" from "invoked and cut off by the gate."
12. **A safety mechanism firing is not automatically a pass.** Ask what evidence it destroyed.
13. **Wipe only BEFORE THE FIRST CELL; a wipe after the first cell is barred** — full procedure and
    the single re-baseline exception at §2. The boundary is the first cell, not "exactly once ever":
    a genesis wipe at campaign start (no cells run, corpus empty) is sanctioned; a wipe after any
    cell has run is barred. Reasoning: the protection the wipe rule exists for (a wipe silently
    corrupting ON measurement by destroying the corpus) cannot arise until a cell exists.
14. **Local runs are unmetered by construction.** Disclose that. Never synthesize a cost figure.
    There are no budget kills and no cost gates anywhere in the system.
15. **A run ends only on:** natural completion, variance-policy completion, extraction-integrity
    abort, a hung-process kill per the 900 s rule, or an explicit maintainer stop order.
    **The 900 s rule, defined:** the signal is the status stream (RC-5), not a session database. If a
    run publishes no progress for **900 s** after a **180 s warmup grace**, a hung-process kill is
    authorized, and only then. **Log the evidence line first.** The kill is **process-scoped only** —
    kill the worker process inside the container. **Never tear the container down mid-attempt.** If
    the signal is absent or unreadable rather than stalled, the run is blind: **escalate, never
    kill.**
16. **Never emit literal thinking tags.** See the notation rule at the head of this file.
17. **The maintainer decides; agents do the work.** The maintainer does not run commands, paste files, or perform worker
    tasks. Escalate decisions, never chores.
18. **Walk-back versus rerun (2026-08-07).** A **walk-back** is forced by: a serve that never
    reaches chain · an outcome that never pairs · standing moving with no human signal and no observed
    transition · the arms differing in anything but injection (RC-4) · a second org or manifest (§1,
    §2) · extraction from a session that resolved nothing (the §9 abort class) · injected-block tokens
    null on an ON cell (the §2/§6 in-band delivery-verification class) · a wipe after the first cell
    (rule 13, §2). A break confined to
    **one cell** is a **rerun** (§10 — a new disclosed run, never a merge). The distinction: anything
    breaking a pairing is a walk-back; anything breaking one cell is a rerun.

---

## 6. PREFLIGHT — checks

A run launched with an unproven seam is **VOID-INSTRUMENT by construction** and is never counted in
N, however clean its output looks. Proven means **observed emitting a real value, on the built
artifact, through the real transport.** Never compile-green. Never "it was dispatched." Never a code
reading. With the smoke stages removed (2026-08-11), seam proof is delivered in-band:
the injection seams are proven by the first ON cell's status-stream values (rule 5.1), and the
progress-vector and extraction-observability seams are proven by the first post-wipe OFF cell's.

**Before any scored run, three checks:**

1. **Policy anchor.** The hub's own log must show `status=anchor_verified` for
   `policy_version=edge-policy-v1`. **`anchor_absent`, `anchor_mismatch` or `anchor_unreachable`
   means STOP** — do not run the bench. An anchor mismatch is fatal to the hub at startup, so a
   drifted policy file takes the stack with it.
2. **Both tiers healthy** on their correct paths (§7). Confusing the two is the single most common
   bench failure.
3. **Model load verified** — context length, parallelism, one real completion, no TTL (RC-7).

### Reasoning controls — verified 2026-08-10, oMLX 0.5.7 (live probes, Qwen3.6-35B-A3B)

What each knob ACTUALLY does on this stack, measured — not assumed:

| Knob | Where set | Verified behaviour |
|---|---|---|
| `max_tokens` | request (proxy clamps to alias `limits.output`) | The ONLY hard ceiling. Reasoning and visible content share this one budget; exhaustion = `finish_reason: length`, possibly severed tool-call JSON (the VOID-INSTRUMENT class of rule 5.10) |
| `max_reasoning_tokens` | bench alias `requestDefaults` (forced 8192; client value stripped) | **ACCEPTED but NOT enforced by oMLX 0.5.7.** Probe: `max_reasoning_tokens: 50` → full reasoning still flowed (284 completion tokens). Treat it as a PRESENCE marker only (proxy fills it, oMLX accepts it) — it is NOT an enforced clamp. Do not rely on it as one |
| `reasoning_effort` | request; **stripped by bench aliases** (`forbiddenRequestParams`) | Accepted by oMLX (no 400). Qualitative level (low/medium/high; DeepSeek V4 publishes effort levels). Not a token cap |
| `chat_template_kwargs.enable_thinking: false` | request | The real OFF switch, verified: zero reasoning, answer-only (3 tokens vs 200) |
| thinking on/off + `preserve_thinking` defaults | oMLX admin per-model settings | Native, apply at load. `preserve_thinking_default: true` is set for both Qwen3.6 models (2026-08-10) — the BENCH aliases override per-request with `preserve_thinking: false` (§12 remediation item 1) |
| `thinking_budget_enabled` | oMLX admin per-model settings | Exists in the schema; UNVERIFIED — do not enable mid-campaign |

**Frozen for the campaign: MAX reasoning — what that means, and why (2026-08-10).**

*What "reasoning" is, plainly.* These models can think before they answer: they generate a
chain-of-thought that costs output tokens but is not part of the visible reply (it streams as
`reasoning_content` and is metered separately as `reasoning_tokens` in the status stream). The one
budget that matters mechanically is `max_tokens`: thinking and the visible answer **share** it. If
thinking eats the whole budget the turn ends `finish_reason: length`, possibly with severed
tool-call JSON — the VOID-INSTRUMENT class of rule 5.10.

*Why MAX is the posture.* "Max" on this stack means: **thinking ON, and no client reasoning
parameters at all** — the model thinks as long as it natively wants, bounded only by the output
budget. This is not a vibes choice; it is the only setting that survives scrutiny:

1. **There is no enforceable middle.** `max_reasoning_tokens` is accepted but NOT enforced by oMLX
   0.5.7 (probe: cap 50 → full reasoning flowed anyway). A token "cap" we cannot enforce is an
   assumption, not a control.
2. **`reasoning_effort` is an unverified dial.** Accepted (no 400), qualitative (low/medium/high),
   and its behavioural effect has never been measured on this stack. Pinning it would put an
   unproven knob inside the instrument — indefensible.
3. **The claim only needs frozen, not tuned.** The campaign's claim is a *within-model* OFF-vs-ON
   delta. Reasoning depth is identical in both arms by construction (RC-4: arms differ only in
   injection), so it cancels out of the comparison. What would break the claim is the two arms
   thinking *differently* — which is why the posture is frozen, not why it is large.
4. **Max gives each attempt its best shot** on a multi-hour agentic build task; the cost is bounded
   by the attempt ceiling and the 900 s rule, not by reasoning length.

*Why MAX does not endanger the instrument.* Its one failure mode — reasoning eating the shared
budget — is defended structurally, not by hope: bench aliases carry **output 32768** (2× the
interactive 16384, the clamp-guillotine fix: thinking cannot starve the visible answer),
`failOnFinishReasonLength: true` so any truncation is flagged loud, and `truncated_turns` /
`truncated_turns_retried` are first-class manifest fields (rule 5.10). A tripped guard does NOT
void the cell — the loop-kill is metered, nudged, and re-driven, and the cell is still scored;
only an unrecovered (false-phase-end) anomaly voids instead of scoring as a capability FAIL, so
the claim stays clean even when the posture bites.

*The mechanics.* The bench aliases own every reasoning-adjacent parameter
(`max_reasoning_tokens: 8192` as a presence-marker, `preserve_thinking: false`,
`reasoning_effort` client-stripped via `forbiddenRequestParams`). The worker sends none. Keep it
that way: the bench's request shape is byte-identical across cells, arms, and models.

*The change rule.* Frozen for the campaign. Touch only between campaigns, and declare it when you
do — a mid-campaign change makes the arms differ in something other than injection (rule 5.18
walk-back class).

*Benching a new model — ONE block, in the proxy.* The benchmark has no model list of its own: it reads
the proxy's `GET /v1/models` (`harness/model_catalog.py` for the worker's opencode.json and context budget,
`control/roster.mjs` for the board). Every row with `purpose: okp-bench` is a runnable worker model, named
and sized exactly as the proxy serves it.

1. **Proxy** (`Local LLM Proxy/config/models.yaml`): copy the `qwen3.6-35b-a3b-bench` block, set
   `upstreamModel` to the model's exact oMLX id and `displayName` to the name the worker config should
   carry. Keep the bench contract untouched: `guarded: true`, `limits.output: 32768`,
   `preserve_thinking: false`, the `forbiddenRequestParams` pair, `concurrency.queueDepth: 0`,
   `loopPolicy.failOnFinishReasonLength: true`. The context window is not typed anywhere: the proxy
   reports the model's oMLX `max_context_window` as `context_length`. **The proxy reads this file once
   at boot: rebuild and restart it with an idle gate (operator step).** Never point the bench at an
   interactive alias: those are lean pass-throughs without the loop guard, clamp output to 16384, and
   queue behind interactive traffic.
2. Confirm it appears: `curl -s localhost:4545/v1/models` lists the alias with `purpose: okp-bench`, and
   the board's roster shows it. The proxy being unreachable is a hard error for the harness, never a
   fallback.
3. Run with `--model <alias>`. Roster hash changes → tree-reset archive (§0 step 3a), rerun.

**The maintainer's personal opencode sessions are deliberately UNCAPPED** (OMLX-REASON-1, proxy
`config/models.yaml`): the interactive aliases send no reasoning parameters at all, so thinking runs
as long as it needs inside the 16384 output budget. The maintainer's control, when wanted, is per-model
`options.reasoningEffort` in `opencode.json` — the proxy passes it through untouched on interactive
aliases. Never add a reasoning default to an interactive alias.

**The injection-seam delivery check (in-band).** The four injection values — `injected_count`,
`injected_block_chars`, `injected_block_est_tokens`, `consumer_injected_count` — are **null BY
CONTRACT on OFF cells** (`memory_mode != "on"` ⇒ `None`). An OFF cell therefore proves nothing about
them, and a null there is not a defect. They are proven on the **first ON cell** (rule 5.1): non-null
values on the actual worker image through the real transport = delivery proven; null = rule-18
walk-back. A pre-wipe ON cell proves a seam the wipe then destroys, so no ON cell runs pre-wipe.

**The `missing_telemetry_seams` list is itself an instrument.** It once named seven seams, four of
which had real values in the same record. A list that over-reports trains the operator to ignore it.

**Latency is a hard, measured seam (recorded 2026-08-08).** Latency on the critical path is
a **hard blocker, not a budget with an escape hatch** — the gate blocks with **no timeout and no
fallthrough**, and a serve that exceeds the latency bound is a defect, not a degraded-but-acceptable
run. Latency is a **standing objective** and IS one of the seams the bench's seam scanners scan and
that production measures. Treat it as part of the seam set alongside `missing_telemetry_seams`, and
apply the same VOID-INSTRUMENT rule here: a run launched with an unproven — unmeasured, assumed —
latency seam is VOID-INSTRUMENT by construction. **Latency must be measured, never assumed.**

---

## 7. THE STACK — topology and bring-up

### The two tiers. Confusing them is the #1 bench failure mode.

The recall data path is: **bench script → MCP `/v1/recall` (`:4550`) → hub
`/v1/orgs/{org}/query` (`:4440`)**. These are two separate services with **different ports,
different health paths and different auth**.

| Tier | What it is | Address | Health | Auth |
|---|---|---|---|---|
| **Hub** | Docker container `hub` — the ONE hub, normally already running | `127.0.0.1:4440` | `GET /health` | none |
| **Bench MCP** (recall client) | commissioned `client` — managed service, seed-derived identity `22f765e8` | `127.0.0.1:4550` | `GET /v1/health` (401 = up) | bearer token |

**The bench MCP is a managed service started by `make redeploy`** (`bench-mcp.sh start`). The harness
CONNECTS to it; it never spawns it — the cumulative run path never calls `bring_up()`. `:4450` is the
operator's daily-driver host MCP and is **never** part of the bench identity path; pointing any bench
component at it mints orgs under the operator's keychain identity (§7 Cause B).

- **The hub is a container, not a host process.** `ps`/`lsof` finding nothing is **normal** and is
  not evidence the hub is down. Check `GET :4440/health`.
- The health paths are **not** the same path.
- In config, `hub_url` is the hub and `mcp_recall_url` is the recall client; the recall backend
  posts to `{mcp_recall_url}/v1/recall`.
- **Every recall, seed or measure path calls the preflight helper before any recall operation.** It
  checks both tiers on the correct paths and raises a loud error naming the exact remediation.
  **Read the error — do not work around it.**

### THE HARD RULE

**Never build, compile or start your own hub or MCP. They already exist.** If a recall fails: read
the preflight error, bring the named service up, and if you cannot — **STOP and report.** Do not
improvise infrastructure. Do not compile a new hub or MCP. Do not invent a fallback.

### Bringing up the bench MCP

The preferred path is the lifecycle bring-up (`bench-mcp.sh start`), which commissions from the seed
for you. A standalone start must reproduce the same environment exactly. **The identity seed must be
the bench identity seed** (`~/.okp/bench/bench-identity-seed.txt`, distinct from the leader
wallet) or recall cannot decrypt the seeded corpus. Six requirements are non-obvious,
and each has a known failure mode:

| Requirement | What breaks without it |
|---|---|
| `OKP_GUARD_BIN`, derived from the workspace root | Guard scanning fails. The plugin normally injects it; a manual start does not. **Umbral no longer belongs in this row** — it ships as WASM inside `client` and needs no variable. The 2026-07-13 cell-1 abort and the 2026-08-14 recurrence were both caused by the old `OKP_UMBRAL_SIDECAR_BIN` requirement, which no longer exists |
| `OKP_MCP_HTTP_ONLY=1` | The bench MCP also runs the stdio server, which treats a backgrounded stdin-EOF as shutdown. Required for any backgrounded start |
| `< /dev/null` on the launch | Belt-and-braces so the stdio path never sees an open-then-closed stdin |
| Recall-governor mode `OKP_RECALL_MODE=test` — the recall stack's OWN env (plugin-side, built outside this repo), never a bench config var; the bench only RECORDS it as the `L4_OKP_RECALL_MODE` run-context lever (now read from operator-supplied `BENCH_RECALL_MODE`, default `prod`) | Recall is prod-governed (floor 0.55, budget 3) and a fresh low-trust memory is filtered out — **prove-delivery and the ON recall arm both return nothing.** Test mode also **auto-approves** recalled memories; prod or unset **headless injects NOTHING**, because it waits on a human approval popup that no headless run can answer |
| `OKP_KEYSTORE_PATH="$BENCH_LEADER_KEYSTORE"` | The org master-key envelope is written by the MCP and read by the invite and provision-recall subprocesses. Omit it and the writer uses the default directory while the readers look in the bench keystore — `decrypt_failed` on recall, `no master key found` on invite. **Writer and readers must share this path.** This was the other half of the 2026-07-13 blocker |
| `OKP_BENCH_ENDPOINTS=1` | The bench-only `/v1/submit` and `/v1/identity/pubkeys` endpoints are absent. `/v1/health` is always present |

**The bench MCP serves from its build output.** Code changes require a rebuild **and a restart** before
they take effect. **Decryption happens in the bench MCP, not in the worker plugin** — the worker needs
only HTTP to the bench MCP, and no host keys or corpus ever enter the container.

To measure *filtered* recall headless, override the relevance floor and injection cap in the plugin
config while keeping test-mode auto-approve. That is the clean way; changing the mode is not.

### Post-reboot / power-failure recovery

After a reboot or power failure, bring the stack back up in this order. Do NOT run `make redeploy` for recovery — it wipes the bench MCP and identity.

- **(a) Bench MCP `:4550`** — `dev/scripts/bench-mcp.sh start` (managed service). Never `make redeploy`.
- **(b) Control plane `:8718`** — `cd control && env -u BENCH_PLUGIN_DIR nohup node server.mjs --port 8718 > ../../dev/.logs/bench-control.log 2>&1 < /dev/null &`. `env -u BENCH_PLUGIN_DIR` keeps the control plane from inheriting a bench plugin pointer; add `BENCH_TOOLS_URL=http://127.0.0.1:8720` for the custom-tools drawer and `BENCH_STATS_MANIFEST` for the run-stats manifest when those surfaces are used.
- **(c) Live view (per-cell host port)** — each cell's live-view serve is published on its OWN host
  port, free-port allocated per run-instance (2026-09-22; the old fixed `:8719` is retired). The port
  is recorded on the cell's `cell.start` record and surfaced on the board; the egress sidecar forwards
  host `<port>` → cell `:4096`. The worker cell itself stays on the internal-only network and publishes
  no host ports. If a cell's live view is unreachable, the worker image is stale — rebuild with
  `.venv/bin/python scripts/rebuild_worker_image.py` from the repo root and relaunch the run.
- **(d) Stale session-db volumes** — `docker volume rm -f` on any leaked `{container}-session-db` volumes (manual only; the harness does not auto-purge them).

### Completion detection — one transport, bounded recovery

There is exactly one drive: the serve session over `:4096`. The legacy stdout subprocess transport —
and the unbounded zero-tool resume loop it hosted — was purged 2026-09-03 (WO-COMPACTION-RESTORE
C5B); the serve transport is the sole path into the worker, so completion detection is no longer
drive-dependent and losing `:4096` is a loud transport error, never a silent drive switch:

- **Serve drive (`:4096`)** — completion = session **busy→idle**, and nothing else (§3). It used
  to be busy→idle PLUS a per-chunk `CHUNK FINISHED` readback; that second condition was deleted
  2026-09-09 (WO-MARKER-RIP) — the harness reads no model output to decide a drive is done. It
  **never** classifies zero-tool turns either: the serve path
  hardcodes `terminal_zero_tool_turn=False` (`backgammon.py:4497`) — `extract_transcript_metrics`
  does not compute zero-tool counts from the transcript — so a text-only "done" turn completes
  normally and the gates run. That detection lived only on the removed stdout transport; no
  zero-tool resume exists anywhere in the harness.

**The terminal that ends a successful run is `gates_green`, and it is reachable.** The grader is the
175-gate `report.mjs` runner — enumerated by `grader/roster.mjs` `enumerateGates()` (conformance 68 · backend 47 · frontend 60; never count the gate total from `grader/checks.json` keys, which miss the `{x}`-template-expanded and multi-test gates); its verdict is `"PASS"` when all three phases
(conformance/backend/frontend) pass (`report.mjs:831`; per-phase `ok = status===0 && !error` at
`report.mjs:364`). The run's ONLY success terminal is `termination_reason = "gates_green"`
(`backgammon.py:2640`, set when the attempt verdict is `"PASS"`); all other `termination_reason`
values are FAIL / BUDGET class (the CHEAT class was removed with the scan, 2026-09-04). The grader runs only **after** the agent drive returns its
run stats — and since the 2026-09-03 purge the drive ALWAYS returns: every recovery path is bounded
(`_MAX_SERVE_RECOVERY_NUDGES=20` per phase — the only recovery budget there is,
`backgammon.py:502-503`) and fails closed on exhaustion, ending the drive exactly as a
non-recoverable terminal would. The pre-purge deadlock — a wedged stdout drive that never returned,
leaving the existing `gates_green` terminal unreachable — no longer exists; there is no second drive
to wedge on.

Losing `:4096` is now a transport error with a named cause, never a silent degradation: session
creation fails closed to a `ServeTransportError` cell abort (`backgammon.py:2263-2276`), and a
mid-run serve death is either recovered by the bounded transport-recovery budget or fails the drive
closed (below). The `:4096` publication path is still worth knowing because it is subtle: `67a7aa6`
(sandbox hardening → cell on the `--internal` network) silently killed the host publish — docker
**silently drops** `-p` on a gateway-less `--internal` endpoint
(`NetworkSettings.Ports={"4096/tcp":[]}`). There is no diff that "removed the publish"; the damage
is the network change, not a code deletion. The `--internal` network was **never reverted** —
`:4096` is restored by the egress **sidecar** publishing host `:4096` and forwarding to the cell's
internal `:4096` (`docker_worker.py:376-382`); the cell itself publishes nothing
(`docker_worker.py:285-286`, `:1438-1440`) — the original publish was routed around, never
restored.

**If a run dies on a transport error, the first question is not the model — it is whether `:4096`
was reachable.** Verify `:4096` (recovery step (c) above) before diagnosing model behaviour.

**There is no fallback route — a serve failure is a transport error with two shapes:**

- **Cell start** — if `:4096` is unreachable at cell open (stale worker image, missing sidecar, port
  misconfig), `create_session` fails and the cell aborts with `ServeTransportError`
  (`backgammon.py:2263-2276`) — a scored abort with a named cause, never a cell run down a second
  route. It used to be survivable (the session id stayed `None` and the whole cell ran down the
  stdout subprocess path instead); there is one transport now, so no session means no cell.
- **Mid-run** — serve/sidecar deaths inside a phase are re-driven in place by the bounded transport
  recovery nudge (`_MAX_SERVE_RECOVERY_NUDGES=20` per phase, budget check at `backgammon.py:4355`);
  budget exhaustion fails the drive closed exactly as a non-recoverable terminal would. A failed
  phase-baseline read aborts the phase rather than degrade its metering (`backgammon.py:4051-4062`),
  and an undeliverable attempt raises `ServeTransportError` and aborts the cell
  (`backgammon.py:3195-3216`) — nothing re-routes the work.

**Residual silent-degradation risks (all unwatched; none surfaces as a distinct scored cause):**
C1 the `-p` silent-drop itself — a publish request vanishes with no error on a gateway-less internal
net · C2 `--proxy-base-url` replaces the egress URL with no deviation warning (network isolation
still holds — the override cannot route around the internal net, only redirect within it) · C3
preflight's `assert_no_docker_residue` checks the cell container, never a stale sidecar
(`cell_isolation.py:195-217`) · C4 the sidecar runs `--restart unless-stopped`
(`docker_worker.py:374-375`) with no watcher, so a silently-restarted sidecar goes unnoticed.

**Why no run can hang forever on a nudge loop anymore.** The pre-purge stdout transport re-spawned
a fresh subprocess per zero-tool resume, so neither the control-plane stall detector (every nudge
wrote a PROGRESS line, keeping the launch log fresh — liveness is now the per-cell heartbeat
`cellHeartbeatAge`, `control/runstate.mjs:76-80`; log mtime is informational-only `log_silent_s`,
`runstate.mjs:541-542`) nor the
run-level `run_timeout_s` (default `5400`, `backgammon.py:641`) could bound it: each respawn reset
the clock, and a text-only "done" ran forever with no automatic kill. That loop is gone. Every
surviving nudge path has a budget that fails closed (`_MAX_SERVE_RECOVERY_NUDGES=20` per phase —
one budget, since the per-chunk marker nudge and its budget were deleted 2026-09-09), and the
serve attempt itself runs under `run_timeout_s`
(`backgammon.py:3226`), so a wedged drive now self-terminates with a named cause. Hang detection on
the status stream (§3) remains the operator's sensor, but is no longer the only exit.

**Image rebuild is the single re-entry point for both regressions.** The sandbox hardening deployed
through an image rebuild, and both regressions entered through it: the rebuilt image pulled a
drifted opencode binary (floating `ARG OPENCODE_VERSION=1.18.1` → `npm i -g
"opencode-ai@${OPENCODE_VERSION}"`, `images/worker/Dockerfile:4`/`:20`), which dropped the worker
`--config`; AND the new `--internal` net dropped the host `:4096` publish. After **any** image
rebuild, verify BOTH the launch surface (per-cell config delivery — the `8c43a20` `OPENCODE_CONFIG`
env workaround) AND the serve-drive preconditions (`:4096` reachable via `GET /session` → 200)
before trusting a run; a rebuild can silently re-introduce either. The CLI binary is pinned at
`1.18.20` (`images/worker/Dockerfile:25` → `npm i -g "opencode-ai@${OPENCODE_VERSION}"` at `:45`;
pinned by `409733d`/`3798ac2` after the floating-`1.18.1` drift above), and the plugin tree baked
in via `BENCH_PLUGIN_DIR` is built outside this repo against the same opencode SDK — the two must
move together on any bump.

**Known broken — do not be surprised (the integrity inventory; none surfaces as a distinct scored
cause):**
- The serve-session lifecycle is never end-to-end smoke-verified on the rebuilt image: the `137b025`
  cure rests on `_serve_reachable`'s `GET /session` → 200 (`docker_worker.py:638-640`), not a
  `POST /session → prompt_async → idle` round-trip. If the HTTP surface regressed the way `--config`
  did, the next run aborts at session creation with a fail-closed `ServeTransportError`
  (`backgammon.py:2263-2276`) — loud, but it produces **zero measurements**.
- The sidecar is unguarded: `assert_no_docker_residue` checks the cell only
  (`cell_isolation.py:195-217`), and the sidecar's `--restart unless-stopped`
  (`docker_worker.py:374-375`) has no watcher (no `RestartCount` consumer anywhere).
- The reaper's dead filter never matches real cells (cells named `bench-cell-cumulative-…`,
  `backgammon.py:2176-2177`; reaper filters `bench-cell-<task-label>`,
  `process_reaper.py:296-311`). The launch-log-mtime stall detector is likewise blind while nudges write
  PROGRESS lines (liveness is now the per-cell heartbeat, `control/runstate.mjs:76-80`) — but since the 2026-09-03 purge every nudge
  budget is bounded and fails closed, so there is no longer an infinite deadlock for either to hide;
  the reaper gap still leaks containers, just not runs.
- Stray containers are unwatched: the reaper never matches auto-named leftovers (a
  `bench-worker:v1` container has been observed up for hours with no owner).

### Bench board operations — RESET, RESTORE and STOP

The bench board (dashboard `:8717`) drives three operations through the control service
(`127.0.0.1:8718`); there is no CLI for any of them, and each refuses while a cell is in
flight.

- **RESET** — backs up first, then mints a fresh tree. Everything currently under `runs/` that is
  benchmark data (the `active-tree.json` pointer and any `runs/<unix-seconds>/` trees) is swept into
  `runs/backups/<unix-seconds>/` (one folder per reset, names preserved); only then is a new tree
  minted at `runs/<unix-seconds>/`. The ordering is deliberate — a failure cannot leave the bench
  half-reset reading as clean. `POST /api/tree/reset` (preview: `POST /api/tree/reset/preview`).
  Two-step confirm-token flow: `POST /api/tree/reset/preview` returns `token` + `restatement` +
  `moves`/`keeps`; the commit `POST /api/tree/reset` requires the body `{"confirm": "<token>"}`.
  **`runs/snapshots/` is NOT swept** — `isBenchmarkData` (`control/tree.mjs:271-296`) has no
  `snapshots` case, so snapshots survive a reset unarchived and owner-less (§18 cleanup).
- **RESTORE** — parks the live bench first, then restores. The current live tree is swept into its
  own fresh backup (so nothing is overwritten), then the chosen backup's contents are moved up into
  `runs/` and the emptied folder is removed. Reversible: the state you leave becomes the newest
  backup. `POST /api/backups/restore` (preview: `POST /api/backups/restore/preview`). Same
  preview → confirm flow: the preview returns `token` + `restatement`; the commit requires
  `{"id": "<backup-id>", "confirm": "<token>"}`.
- **STOP** — aborts every live cell, found from the SAME enumeration the board shows (the durable
  launch records + process scan — never the launch logs, which may already be deleted). Two-step
  confirm: `POST /api/run/stop/preview` (returns `token` + restatement) → `POST /api/run/stop`
  `{"confirm":"<token>"}`; both refuse 409 while no cell is in flight. `stopAll` sends each harness
  one SIGINT so it tears its own cell down, then records each stopped cell as
  `ended "stopped by operator"` on its durable launch record — a stopped cell is listed ENDED,
  never dropped, and never deleted.

Run-tree layout:

    runs/
      active-tree.json                # the pointer — one line of truth
      <unix-seconds>/                 # a TREE, minted on RESET
        launches/                     # durable per-cell launch records (<run_id>.json)
        <arm>-cell-<stamp>-s<NNNN>.log # launch logs live at the TREE ROOT, not in run_dir
        local|cloud/                  # substrate
          <router>/                   # local-llm-proxy (local) or orcarouter (cloud)
            <provider>/
              <model>/                # the campaign home (manifest.json lives here)
                memoryOFF/            # cell-NNNN/ hangs below the mode dir
                memoryON/
      backups/<unix-seconds>/         # one folder per RESET

A mode value other than on/off yields `memoryUNKNOWN/` in place of `memoryOFF`/`memoryON`.

### Dashboard deployment

The dashboard container (`:8717`) holds no run data: it serves the page and
relays `/api/*` to the control plane (`:8718`, host, loopback), which reads the
run files and assembles the board. A new data source is a reader in
`control/board/sources/` and needs a control-plane restart
(`cd dev && make control-restart`, never mid-run); a page change needs
`dashboard/redeploy.sh`.

### Remote viewing (LAN access)

Two lines in `dashboard/.env`, then `dashboard/redeploy.sh`. Procedure and
security notes: `dashboard/README.md` → "Remote viewing".

### Worker isolation boundary

- The worktree is mounted read-write as the worker's only view.
- **Gate and golden material is NEVER mounted.** Gates run host-side after the worker exits.
- The worker reaches the bench MCP, and through it the hub and the embedding service, on the recall path
  only, and only on ON cells.
- Egress has **no domain allowlist** — the sidecar forwards a fixed upstream set — but the worker
  cell itself has **no general outbound access**: it runs on the `--internal` network (no gateway, no
  route) and reaches the model/MCP/hub only through the per-run egress sidecar. The residual is that
  the sidecar's upstream set is a fixed host:port list, not a domain policy — a known, accepted
residual, not an oversight to rediscover. **Maintainer hazard:** egress wiring is THREE
`if config.egress_host:` branches that must move in lockstep — sidecar launch
(`docker_worker.py:380`), network selection (`:1290`), and host `:4096` publish (`:1487`) — gating
network without publish silently kills the host `:4096` publish (the exact `67a7aa6` state, with
zero diff evidence at the `-p` line itself). There is no MCP/hub URL-rewrite branch under
`egress_host` (superseded 2026-09-22: the prior "four branches / MCP/hub URL rewrite" claim was
stale).

### Known failure signature — org bootstrap (TWO distinct causes, same symptom)

> **READ BOTH CAUSES BEFORE DEBUGGING.** A fresh-stack org-bootstrap failure has had two entirely
> separate root causes. Cause A was fixed 2026-08-07; Cause B was fixed 2026-08-11. They present
> almost identically, and the earlier text here — which said "do NOT re-investigate an identity
> mismatch … do not re-open this" — actively delayed the Cause-B diagnosis by a full day. That
> instruction was correct **only** for the narrow claim it disproved (see Cause A) and is NOT a
> general ban on identity investigation. Full incident record:
> `dev/workspace/reports/1786461718-WO-ORG-BOOTSTRAP-IDENTITY.md`.

#### Cause A — leader-membership sequencing race (FIXED 2026-08-07, commit `e2b4562`)

**Symptom.** Fresh post-wipe first OFF cell fails `run_m1` bootstrap in ~8s with a hub HTTP 403 at
`seed_keywords`: `{"error":"not a member of this org"}`, arriving ~3ms after `create_org`.

**Root cause.** `seed_keywords` fired immediately after `create_org` with no confirmation that the
leader's `members.active=true` row existed. The route `POST /v1/orgs/{org}/keywords` is gated by
`RequireVerifiedMembership` (hub/internal/auth/middleware.go:38, 403 at line 62,
existence check at lines 55-62). The only membership poll ran for the *contributor*, after seeding.

**Narrow disproven hypothesis (still disproven).** That a wipe regenerating the bench keystore
changes the bench MCP's identity. It does not: identity is seed-derived — `load_bench_identity_seed()`
(`lib.sh:106-123`) reads `BENCH_MCP_SEED` (priority) or `~/.okp/bench/bench-identity-seed.txt`,
and the keystore is re-commissioned from that seed on every `bench-mcp-start`. A wipe regenerating
the keystore does NOT change the identity. **This disproves one specific mechanism — it does NOT
mean "identity can never be the problem" (see Cause B).**

**Fix.** `poll_leader_membership` between `create_org` and `seed_keywords` (orchestrator.py), raising
`RuntimeError("leader membership did not include org_id=...")` before seeding, plus regression tests.
A silent 403 became an early, diagnosable failure. **It fixed the symptom's timing, not any identity
source** — which is exactly why Cause B could still occur and surface through this same message.

#### Cause B — the org was minted under the WRONG MCP's identity (FIXED 2026-08-11)

**Symptom.** `RuntimeError: leader membership did not include org_id=okp-org-0` — the Cause-A
guard firing, ~30 s after `create_org` returned ok. Often preceded by an **unexpected Touch ID
prompt**.

**Root cause.** `lconfig.py` defaulted `leader_mcp_url` to `:4450` — the **real host okp-mcp**,
which has no seed support and always loads the operator's biometric keychain identity `05c4b8cb…`.
`create_org` hands that URL to leader-signer as its MCP-endpoint env; `POST /v1/org-setup` stamps *that
MCP's* pubkey as the org leader; the hub writes it as the org's only `members` row. The harness then
polls for its own membership (Ed25519 pubkey fingerprint `aa2aa706`) and never finds it.

**Why it hid for weeks.** Every earlier run took the `reuse` path (`phase=reuse`,
`tx_hash=reuse-existing`) and never called org-setup. The first true fresh-create after a genuine
wipe triggered it — and the Touch ID prompt appearing "randomly" was the same defect, not a separate
annoyance.

**Vocabulary trap that misled the earlier diagnosis:** `0e93b599` is `fingerprint(seed_bytes)` and `aa2aa706`
is `fingerprint(ed_pubkey_bytes)` — **the same leader identity, two different hashed inputs.** Seeing an
unfamiliar fingerprint does not by itself indicate a different identity. Always state which input a
fingerprint hashes.

**Fix.** Default is now `:4550` (the seed-derived bench MCP), plus a fail-fast guard in
`create_org` that probes `GET /v1/identity/pubkeys` and refuses to register unless the org-setup
MCP's ed25519 key IS the harness leader's. Unreachable is also a hard failure — a run on an
unverified seam is VOID-INSTRUMENT (§6).

**Healthy bootstrap looks exactly like this:**

```
phase=org_setup_mcp_identity_verified mcp_url=http://127.0.0.1:4550 leader_ed_fp=aa2aa706 status=ok
step=create_org status=ok
step=poll_leader_membership status=ok dur_ms=7
```

#### Cause C — contributor MCP `:4451` not running (SUPERSEDED — contributor clone retired)

**Symptom.** `step=contributor_pubkeys err=mcp unreachable for /v1/identity/pubkeys`.

**Root cause.** The cumulative run path **never calls `bring_up()`** — it only connects to MCPs it
assumes are running. Only `:4550` was a managed service; `:4451` was started by hand. The campaign
had been silently relying on an **Aug-7 orphan process** that survived every wipe and predated the
clone dist by days.

**Superseded (2026-08-16).** The two-clone model is deleted (`27aeb07`/`ba2947a`/`d7ae146`); there
is no contributor MCP and no `contributor_pubkeys` step. The ONE bench MCP on `:4550` is a managed
service (`bench-mcp.sh start`); verify-clean check 11 (`mcp-fresh-4550`) asserts its served
fingerprint `22f765e8` against the bench identity seed's.

**Value.** The next benchmark start recognizes these signatures by name and proceeds to the known
fix instead of re-deriving it. **Liveness is not identity** — a process being up, a port answering,
and health returning 200 proved nothing in either Cause B or C.

### Known failure signature — silent startup crash (start returns `ok`, nothing runs)

**Symptom.** `POST /api/run/start` returns `ok:true` (with a pid), but no cell appears and the
dashboard renders "no run observed". The launch log ends in a traceback ~11 s after spawn.

**Root cause.** The run was launched into the SAME tree as an already-completed seq-0 run — no
reset in between. `resume_or_create` (`harness/cumulative/manifest.py:196-205`) tried to
resume the stale manifest; `validate_or_fail` raised
`ValueError: cannot resume: chunk-plan hash drift detected (manifest=… expected=…); start a fresh run`
(`manifest.py:175-180`). `chunk_plan_hash` is a LIVE SHA-256 over `task/backgammon/prompts/`
(`scripts/run_cumulative.py:1388`, via `compute_task_template_hash`) — recomputed every launch,
drift-checked at resume, with **no re-baseline mechanism** — so **any** edit to a prompt file
(e.g. commit `2314693` editing `chunk-02.md`) changes it. The guard fail-closed as designed. The
failure was SILENT because `/api/run/start` returned `ok:true` immediately after `spawn` with zero
liveness check.

**Fix.** (1) Operational — reset to a fresh tree before a new run (`POST /api/tree/reset/preview`
→ confirm → `POST /api/tree/reset`, §0 step 3a / §7 RESET). This is a harness-level reset, never a
wipe — the §2 wipe rules still govern the server corpus. (2) Code — `e30ad29` added
startup-liveness confirmation: `/api/run/start` now polls signal-0 liveness (`confirmAlive`,
`control/runstate.mjs:267-280`) for a bounded 20 s window and, if the child dies inside it, refuses
with code `launch_crashed` carrying the log tail (`control/server.mjs:1262-1280`,
`control/contract.mjs:451`) instead of a false `ok:true`.

**Do not re-silence this.** The startup liveness check — `confirmAlive` wired into
`/api/run/start` BEFORE `launcher = {` — must stay wired in the control plane. It exists precisely
because a crash-only log renders as "no run observed": returning `ok:true` over a process that
already died is the lie that hid this defect. The regression tests
(`control/__tests__/terminal-notices.test.mjs` `confirmAlive` death→tail / survive→ok) pin it; do not remove them.

### data/ — centralized telemetry sink and retention layer

**The problem it solves.** The plugin's observable recall surface (funnel snapshot + plugin error log)
is container-side and is destroyed at teardown today. OFF-arm cells strip the plugin
recall substrate entirely (no org marker, no MCP/hub env; state lives on a dedicated blind mount
outside the worktree — container `/okp-state`, host `<cell>/extraction-state`), so the four diagnostic
questions (distinct failureKeys, repeats, registry survival across compactions, recall round-trip
latency) are unanswerable from OFF runs — and even ON-cell telemetry is lost when the container dies.

**Propagation contract (LIVE).** At cell end the harness exports the funnel snapshot — from
`worktree/.okp/state/funnel-snapshot.json` on ON cells, from the dedicated blind mount
(`<cell>/extraction-state/funnel-snapshot.json`, container `/okp-state`) on OFF cells — plus
`.okp/logs/okp-plugin-errors.log` host-side into
`data/cells/<unix_ts>-<run_label>/` (`_export_cell_telemetry`, `harness/adapters/challenge/telemetry.py:133`).
It runs for **BOTH arms** — an OFF cell is the baseline the ON arm is measured against, so exporting
only on injection-record cells would rebuild the blind spot this sink exists to close. Fail-open by
contract: a missing surface is a silent no-op and an unwritable sink is logged and swallowed, so
telemetry export can never fail a scored cell. `data/extract/` is a **documented-but-unwired
placeholder** — extraction-side wiring still pending; the in-session extraction capture does NOT land
there (it lives in the per-cell state dir at `insession/master.json` + `changed-lines.json`, exported
into `data/cells/<unix_ts>-<run_label>/insession/` by `_export_cell_telemetry`, §7 above).

**`data/` is a TELEMETRY/RETENTION layer, never a source of truth.** RC-5's manifest + status stream
under `runs/` stay authoritative. `data/` never duplicates or competes with `runs/` content.

**Retention: exactly 7 days** on `data/cells/` and `data/extract/` entries; enforced by
`scripts/cleanup_data.py` (run fail-open at the start of each run via `_handle_run`;
`BENCH_SKIP_CLEANUP=1` disables). It deletes only under `data/cells/` and `data/extract/`; it
never touches `runs/`. The 7-day window exceeds a full OFF+ON pair, so no scored cell's telemetry is
aged out mid-campaign.

---

## 8. MEASUREMENT INTEGRITY — three layers, all mandatory

**The invariant:** workers must never read or access gate oracle or test sources, and worker
feedback must be problems-only.

**Layer 1 — physical isolation.** Oracle material is never copied into the worker worktree: gates,
golden, judge, the gate runner and gate test sources all stay outside it. The worker's directory is
seeded only from the scaffold stubs. The gate runner executes from its own directory and reaches the
worker's output only through an environment variable.

**Layer 2 — permission deny.** The worker launches **without** any skip-permissions flag. A
worktree-local config grants autonomy inside the worktree and denies external reads, with targeted
denies for oracle paths. **Permissions are allow/deny only — never `ask`.** A headless run has no
human to answer a prompt and `ask` can hang forever; `deny` fails fast and the model continues.
Verified: a denied external read returns a tool error and exits cleanly in seconds.
**What this layer can and cannot do:** path-pattern denies alone cannot close every shell
indirection, which is why they are NOT what makes cheating impossible — Layer 1 is. Inside the
container there are no oracle files to reach by any indirection, and no route out: the worktree is
the only mount and the network is `--internal` with four allowlisted upstreams (`harness/egress.py`).
This layer is defence in depth over a filesystem that already does not hold the answer.

**No instruction tells the model not to cheat, and none may be added.** `tests/test_blinding.py`
forbids "cheat", "grader", "oracle", "benchmark" and the rest from every surface the model can read.
A model that knows it is being measured is not the model the run is measuring, so a deterrent would
cost more measurement than it could ever buy. Prevention is structural.

**Layer 3 — operator live view (the ONLY backstop).** Amended 2026-08-10, corrected 2026-09-03,
settled 2026-09-04: the maintainer watches the live worker session (`opencode attach` to the cell's
serve, §0 step 4) and IS the Layer-3 backstop — a cheat ATTEMPT the operator witnesses is noted,
never an automated verdict flip; PASS/FAIL is never gated on the anti-cheat rule.

**The automated transcript hard gate is REMOVED** (`cheat_detector.py`, `scan_events_for_oracle_access`,
the `CHEAT` verdict and `CHEAT.json`, all deleted 2026-09-04). It is not disabled, not dormant, and
there is no revival condition. Its only input was `{worktree}.events.jsonl`, written by the stdout
transport purged 2026-09-03 — and on a missing input the scan returned `cheated=False`, so it wrote
"CLEAN: no oracle access detected" onto every cell it ever graded after the purge. A check that
cannot run must not issue an all-clear; keeping the code so it could "revive unchanged" is what let
it keep signing off. **There is no automated anti-cheat detection in this benchmark.** Say so
plainly rather than implying a dormant one.

What remains is the RULE, not a detector: the worker prompt still carries the explicit anti-cheat
instruction (WO-ANTICHEAT-1, `backgammon.py`, pinned by `tests/test_blinding.py`), and Layers 1-2
(worktree isolation, permission denies) are unchanged.

**Feedback content limits.** Worker-facing feedback carries **only the failing gate's ID and human
title**, in the form `- [G02] pip count: FAILING`. **Forbidden in worker-facing feedback:** expected
values, observed output, file paths, stack traces, oracle snippets. The rich detail stays in
host-side logs and is stripped before the worker sees anything. A failure points the worker at a
**public requirement**, never at a hidden value.

**Maintainer rules — each of these has already been violated once:**
- Never re-add a skip-permissions flag to worker launches.
- Never include expected, observed, path or stack detail in worker-facing feedback.
- Never copy oracle assets into a worker worktree.
- Keep the transcript hard gate enabled (it is dormant only because its sole input — the purged
  stdout transport's event log — no longer exists). On the serve transport the backstop is the
  operator's live view of the worker session.

**Option-A invariant:** no gate may require a constant, formula, string, count or mechanism that is
not published in the worktree contract artifact. Publishing requirements is orthogonal to all three
layers above and weakens none of them (rule 5.7).

**Observability-funnel identity (recorded 2026-08-08).** The PRODUCTION observability funnel
and the bench's seam scanners read the SAME counter set. The recall-trigger path is instrumented at
every seam, and every counter is readable per session — production observability and the bench's seam
scanners are **two readers of one counter set**, not two separate instrumentations. This ties the
bench's instrumentation to the recall-trigger funnel: what a seam scanner proves on a bench run
is the same signal production reads in the field. Corollary, cross-referenced only (already recorded
in RECALL-PIVOT-SPEC's funnel, not restated here): the normalizer is the sensitivity dial with a
silent failure mode, detectable only as a ratio between two seams (episodes opened vs repeats
detected); its counter is not optional instrumentation.

### Hard-won — MODEL-STUCK cell diagnosis (WO-ROUND-DIAGNOSIS-R4)

Three process-knowledge findings from the first scope-only cell diagnosis (run `1790196821`, seeded
from snapshot `1790178944418-0c648b67a802`; report
`dev/workspace/reports/1790204512-WO-ROUND-DIAGNOSIS-R4.md`). The cell verdict was **MODEL-STUCK** —
28/35 checks stuck, the 3 told checks (G01/G02/F06) all MODEL.

- **The backgammon knowledge gates are DELIBERATE, not spec omissions (commit `6eb5832`,
  2026-09-21).** The opening layout, pip formula, movement rules, and the higher-die rule were
  removed from `chunk-01.md` on the stated premise "the model should know it"; the commit message
  documents the intent ("now it has to know it, and it does not … the benchmark finally measuring the
  model rather than its reading") and the measured consequence (G05 higher-die went from 2/4 to 5/5
  failing). G01 (opening), G02 (pip), E06 (bar-pip), and G05 grade knowledge the spec deliberately
  withholds, while the grader still asserts the standard layout (`grader/backend/gates-01-08.test.ts:21-24`)
  and pip 167 (`:75-76`). **A cell stuck on G01/G02/E06/G05 is the benchmark measuring knowledge the
  spec withholds by design — read it as MODEL-STUCK, never "restore the rules."** This refines, not
  contradicts, the Option-A invariant and rule 5.7: the published "requirements" remain the
  *representation* (function names, data shapes, endpoints, test ids — still published); the *game
  knowledge* is withheld on purpose. (The 3 TOLD checks were G01/G02/F06 — F06 pip-UI *is* stated in
  the spec (`chunk-04.md:14,21`) but fails downstream of G02.)
- **Do not enumerate decoy candidates as a disjunction in a complaint line.** G01's line ("the
  pieces, the cube, or whose turn it is is off", `grader/feedback.json:71`) named three candidates;
  the model re-verified cube and turn ~6 times while the real defect (the black 8/15-point layout)
  went unexamined. A disjunction licenses the model to verify the easy named facets and skip the real
  one. Name the actual defect's facet first, or report a single accurately-located symptom. (G02's
  "moves are left" — `feedback.json:75` — mislabels the pip count and sent the model hunting a
  nonexistent counter; a second wording hazard.)
- **`live.jsonl` `attempt.end` carries `told`/`withheld`/`unevaluated` directly** — `failed` is the total
  failing-check count and `told` is the count of checks actually shown to the model, emitted side-by-side
  since `aab637a` (2026-09-23); `harness/adapters/challenge/runner.py:1647-1664` emits `verdict`, `conformed`,
  `failed`, `stage`, `stage_name`, `told`, `withheld`, `unevaluated`, `context_peak`, `context_window`. Do
  NOT derive `told = failed − withheld` — that is wrong for current code. The BOARD's live-stream source
  (`control/board/sources/live-stream.mjs:141-155`) maps only `verdict`/`failed`/`stage`/`stage_name`/`withheld`;
  `told`/`unevaluated` exist only in raw `live.jsonl` / `manifest.status.jsonl`.

---

## 9. EXTRACTION AND SMART-LEADER REVIEW

This section governs the **leader-side** extraction job (`/v1/extract` over the exported session DB,
§2 stage 2) and its integrity gate + smart-leader review. The **in-session** extraction (the
plugin's capture toolcall → `insession/master.json` harvest, §2 stage 1) is the producer of the
failures-to-green that this job distills; its mechanics and its known defect (evidence cap "1..5"
not enforced at the tool seam) are charted in `dev-benchmark.md` §12.

### The integrity gate — runs first, always

After **every** extraction, read the matching terminal integrity record from the ops integrity log
for that UTC day, under the configured log directory.

**Correlation keys.** The outer trace does not propagate into the MCP — each REST call mints its
own. The reliable keys are: **the `job_id` returned in the extract call's 202 response**, and
**`session_fp = sha256-first8(session_id)`**. `org_id` further scopes a match.

**Abort** — before any leader verify or commit — if the record is **missing**, **cannot be
correlated**, or reports `resolved_problem_count == 0 && emitted_memory_count > 0`
(`invariant_violation == true`). Preserve the run log and checkpoint, and escalate with the job id,
trace, session fingerprint and the resolved and emitted counts.

**Do not continue. Do not self-heal. Do not retry around it. Do not approve or commit the memory.**

A record that is `completed` but **lacks the episode-count fields or lacks the violation flag is
uncorrelatable-for-invariant**, and is abort-worthy under the missing-record rule. Resumed or parked
jobs may report their episode metadata as unavailable on resume.

### Smart-leader review — only after the integrity gate passes

The run advances one session to the review boundary, then pauses and yields, returning the sequence
index, job id, session fingerprint and candidate count. It resumes only with an explicit decision.

1. **Reconcile.** Reconcile the authoritative chain and hub inventory against the private benchmark
   catalog. Any authoritative committed item with no matching catalog text is reported as
   unavailable and **must never be guessed or fabricated**. Fail closed when the authoritative
   inventory is non-empty but the catalog is incomplete, so completeness is never silently assumed.
2. **Compare.** Compare every new candidate against the catalog using the implemented duplicate
   signals: exact content-hash match, exact submission-hash match, and a keyword-overlap advisory.
   Carry duplicate references into the decision evidence.
3. **Decide all.** Emit a versioned decision manifest with every candidate set to verify or deny,
   each with a non-empty reason. The manifest must carry integrity attestation: job id, session
   fingerprint, resolved count, emitted count, violation flag, and whether the integrity record was
   seen. The manifest gate rejects missing or uncorrelatable attestation — but it does **not** re-run
   the runtime integrity check. That already happened, above.
4. **Apply — real leader and hub paths only.** Verify goes through leader verify-and-commit; denial
   goes through the real hub deny route, body-signed. **No direct database, vector-store or chain
   writes, ever.** Reapplying the same decision manifest is idempotent; a conflicting re-decision is
   rejected.

**Denial is non-fatal curation** and must not abort the benchmark (rule 5.4).

### The privacy boundary — do not conflate the two "leaders"

The **cryptographic leader-signer** on the commit path sees **no plaintext** — only ciphertext, a
wrapped key and an embedding card. The **smart-leader coordinator** necessarily **does** read
candidate and prior-accepted comparison text to make semantic decisions. **This is by design and is
not a leak.**

That authorized plaintext lives **only** in the mode-0600 private review card, catalog and review
material. It must never be copied into logs, reports, decision ledgers, the manifest checkpoint or
git — all of which stay **hash-only**: fingerprints, sizes, counts and reasons, never plaintext,
secrets or raw keys.

### Injection cadence

A recalled and accepted memory is injected **once at acceptance**, in a stable early position after
the system instructions — **not re-pushed per turn**. The served set is hub-ranked top-K within a
fixed token budget. The injected block is preserved **verbatim** across compaction: restore
verbatim, never summarize through. **In every measurement arm the memory block's tokens are metered
and reported separately from the model's work tokens** — every progress vector that reports tokens
carries the injected-memory-token count as its own field. Progressive disclosure is parked as a
future seam, not a flag.

**Caveat, unverified:** if the plugin baked into the worker image (via `BENCH_PLUGIN_DIR`) predates
this cadence, the
plugin still re-injects every turn. **Do not report cadence effects as conformant until the image is
confirmed to carry the cadence code** — confirmed by comparing the manifest's recorded worker image
fingerprint against an image built from the commit under test (§0 step 2).

---

## 10. VARIANCE POLICY — in full

> **Two different N's (2026-09-22) — do not conflate them.** (a) **Baseline batch N** (§0
> concurrency): the OFF floor is no longer one run. The control plane runs N concurrent cells, the
> board reports the **median problem count over scored runs**, bound to a **fingerprint** of the eight
> inputs that determine what was measured (build prompts, grader, model, challenge, compaction,
> scaffold, golden, worker image), and the operator **picks** the artifact run — the record stores the
> pick's **signed deviation** from the median. Any fingerprint input change **voids** the batch. (b)
> **Scored-cell variance N** (this section): how a single scored cell's verdict is hardened against
> noise. Separate dials.

1. **Baseline: N=1 per scored cell.** (The scored cell itself starts at one run — the variance dial
   (b) above, distinct from the baseline batch N (a).)
2. **Borderline cells repeat to N=3.** If any trigger below fires for a cell, **that cell and only
   that cell** re-runs to a total of three. The reported verdict is the **majority** for discrete
   outcomes and the **median** for continuous metrics. All three runs' raw artifacts are retained.
3. **Every scorecard discloses N per cell. A cell reported without an explicit N is
   non-conforming.**

Repetition budget is spent exactly where uncertainty lives, instead of pretending N=1 is statistics.

**T1 — Gate margin ≤ 1.** The final attempt fails exactly one gate, or the cell passes only on its
last permitted attempt. Either way the verdict sits within one gate or one round of the boundary.

**T2 — Lift sign fragile.** For an ON/OFF pair: the relative token delta is **under 15%**, or the
attempts-to-green are equal so the sign rests on token and turn deltas alone. **A sign that flips
within ±15% single-run noise is not a reportable sign at N=1.** The 15% is a manager-set constant
and is vetoable.

**T3 — Instrument anomaly.** The run log shows a wall-clock kill or timeout, a nonzero worker exit
that was retried, or a mid-cell resume — while the cell still produced a scored verdict. Anomalous
instrumentation invalidates N=1 confidence regardless of the verdict.

**T4 — Classification flip.** The cell's result would re-classify the subject, or lands exactly on a
class boundary. **A single run never re-classifies on its own.**

**Procedure.** Triggers are evaluated **once, immediately after the N=1 run**, from the artifacts —
no judgment calls, no re-litigating afterwards. If fired, two more runs under the same config and
seed policy, then majority/median. **If the three runs disagree on class, escalate to the maintainer. Never
average across classes.**

**Rerun disclosure (locked): a rerun is a new disclosed run, never a merge.**

---

## 11. OPEN DEFECT REGISTER

Fixed defects are not listed. They are in git.

| ID | Status | Description | Blocks |
|---|---|---|---|
| **TEMPLATE-DESYNC** | 🔴 **top campaign risk** | The proof is partially executed. Low-context **PASSED** (two 105-turn sessions, 0 desyncs each); high-context (≥100K tokens) behaviour — what the §12 probe measures — remains **unverified**. Blocks every scored cell until high-context is proven. See §12. | every scored cell |
| **ENTRYPOINTS-MISSING** | 🟢 CLOSED by 09cab437 | `feat: split extraction invocation, add run --mode, unconditional reaper` makes test/wipe/bench/extract a coherent entrypoint set (smokes later removed, 2026-08-11). | §2 |
| **MODE-DRIFT** | 🟢 CLOSED by 09cab437 + 98a286b + 0141930 + e60ccc1 | The 13 drift branches are gone: the delivery-scan arm is keyed on the injection record not mode (`98a286b`), the telemetry seam on `injected_count` (`0141930`), and the scorecard is label-invariant under `e60ccc1`'s test. The only remaining mode branch is the legitimate injection call site. The arms are comparable. | every scored comparison |
| **RUN-STATUS-MISSING** | 🟢 CLOSED by 1a50ba9 + e60ccc1 | Write-once run manifest + append-only status stream + scorecard landed in `1a50ba9`; `e60ccc1` adds the scorecard test. | the contract itself |
| **NO-REAPER** | 🟢 CLOSED by 09cab437 | `process_reaper.py` (RC-6 unconditional reaper) wired into every exit path, with tests. | §2 TEST step 4, bench |
| **PRERUN-PAIRING** | 🟢 CLOSED by fd427759 + e285ece | `fd427759` retires the prerun arm-pairing + consumer-bridge paths; `e285ece` makes it strictly serial single-consumer with no concurrency. | §2, §3 |
| **MODEL-ALIAS-RESIDUE** | 🟢 CLOSED by 8bdcabc + 186d34c | `8bdcabc` removes 4 dead model-registry aliases; `186d34c` removes the dead paid-era alias. The mode-drift work that gated this is cleared. | RC-7 |
| **ALIAS-RESIDUE** | 🟡 OPEN | The proxy still ships a poller alias plus bench aliases referenced by no bench code. | deletion hygiene |
| **DOC-DRIFT** | 🟢 CLOSED by consolidation | `AGENTS.md` no longer carries the stale **org-per-arm** scheme or poller-era stanzas; it is now a pointer to the card (§2-consistent). | RC-8 |
| **TRACE-SEMANTICS** | 🟡 OPEN | Per-consumer attribution survives only as a random trace nanoid with no role semantics. | log-based attribution |
| **PROXY-UNTESTED** | 🟡 OPEN | The proxy has no git remote and no tests while sitting on the critical path for every bench call. | campaign safety |
| **RECALL-EMPTY-KEYWORDS** | 🟢 CLOSED by 33fe59a (hub) | Hub-side `fix(serves): accept vector-only serves with empty matched_keywords` — the serve endpoint now accepts vector-only serves with empty `matched_keywords`; the dead 400-mapping clause is removed. | ON-cell attribution |
| **STRAY-BENCH-KEY** | 🟡 OPEN — **maintainer only** | A mis-configured clone once wrote a bench org master-key envelope into the maintainer's canonical key directory. It **may collide with the maintainer's canonical org keys**. Not deleted, and **no agent may delete it** — the maintainer verifies and cleans deliberately. Bench now writes only to the bench keystores, so it will not recur. | nothing automated |
| **KV-PEAK-UNKNOWN** | 🟢 CURIOSITY | Peak resident footprint at full context is unknown. Not a threat given headroom. | nothing |
| **EMISSIONS-INERT-KEEPERS** | 🟡 OPEN | The emissions module carries an injected serve keeper and reputation keeper (`chain/x/emissions/types/expected_keepers.go`, wired at `keeper/keeper.go:35-47`) whose methods are never invoked outside tests — inert today, and exactly the seam an accidental change would activate. Serve credit touches no economics: emissions qualify contributors on approvals only (`x/emissions/keeper/keeper.go:233`). Recorded 2026-08-07; cross-posted to RECALL-PIVOT-SPEC §8.7 F5. | nothing today — silent-economics drift if activated unnoticed |
| **INTEGRATION-SUITE-QUARANTINE** | 🟡 OPEN — post-campaign | The dev integration suite is scoped out of the pre-campaign TEST stage (§2): it POSTs `/v1/test/reset`, a route the hub build does not register (`cmd/hub/main.go:390-397` vs `dev/tests/lib/hub-client.ts:95`), and its mutating e2e tests would write orgs and memories to the live campaign hub and chain — the same hazard class as a second wipe. The reset route must not be registered to accommodate it. Restored behind a guard after the campaign (2026-08-07). | nothing while quarantined — pre-campaign TEST is the bench pytest suite |
| **SERVE-MESSAGE-500** | 🟢 ROOT-CAUSED + FIXED 2026-08-11 | **NOT an opencode bug — the worker's SQLite session DB was CORRUPT.** `PRAGMA integrity_check` on the preserved DBs of BOTH 500-failing cells reports `database disk image is malformed`, with damaged pages in **tree 27 = the `part` table** — exactly the table in the failing `select … from "part" where "message_id" in (?×N)`. The 11:14 cell that never 500'd is **clean**. The IN-list size (36→50) was a **red herring**: a larger list touches more pages, so it meets a corrupt page sooner. **Cause:** the DB was bind-mounted from the macOS filesystem (osxfs/gRPC-FUSE), whose locking + fsync semantics SQLite cannot rely on. Pinning opencode never helped because the image was ALREADY pinned (`images/worker/Dockerfile:4`, 1.18.1). **Fix:** the session DB now lives on a **named Docker volume** (ext4 in the Linux VM), exported via `docker cp` at teardown to the same published host path; a per-cell volume is chowned to the worker uid (needs `--user 0:0` — the image bakes `USER worker`) and removed in a `finally` so a failed teardown cannot leak volumes. **Second defect closed:** extraction previously accepted any `is_file()` DB. SQLite corruption is PARTIAL — the corrupt DB answered `count(*)`=492 fine — so a corrupt substrate **silently under-reported memories** instead of failing. `harness/session_db_integrity.py` defines the fail-closed guard `require_sound_session_db` (`session_db_integrity.py:154-167`), which EXISTS but has NO non-test caller today — it is not wired into the run path, so a corrupt substrate is NOT caught. | was: intermittently, cell-voiding — now: cause removed, but a corrupt substrate is NOT caught today (the fail-closed guard `require_sound_session_db` exists but has no non-test caller — it is not on the run path) |
| **RECALL-SELECTION-BIAS** | 🟡 OPEN — known, stated limitation | Recall fires only after a repeat — the second failure under the same stable `failureKey` while still red — so every serve is conditioned on an already-hard problem. Standing therefore measures **"works on stuck problems," not "works."** Defensible, and arguably the population that matters, but a further departure from the sim's uniform-serving assumption (recorded 2026-08-08; claim and limit travel together — the §1.1/§1.2 dual-carriage principle). | every standing/recall conclusion — disclosed, not blocking |
| **CLOUD-MIRROR-DRIFT** | 🟢 CLOSED (reconciled, verified 2026-09-04) | The `control/cloud.mjs` `CLOUD_MODELS` mirror (`:114`) and `harness/config.py` `CLOUD_ORCAROUTER_PROVIDER["models"]` are now both **117** entries with identical key sets and matching context/output limits; the drift test `control/__tests__/models-ledger.test.mjs:329` (`DRIFT: the cloud catalogue matches CLOUD_ORCAROUTER_PROVIDER in config.py`) **passes**. The prior "87 mirrored vs 117" drift (30 refused models) is reconciled. Keep the drift test live — it is the guard that caught this class. | — |
| **CONCURRENCY-MEASUREMENT** | 🟡 OPEN — **PENDING** | The live N=1-vs-N=8 measurement (CONCURRENCY-SPEC §8) has **NOT been run**. The concurrency feature (8 commits, suites green) is built, but "verified concurrency safety" is **not yet a measured claim**: the three load-fragile in-gate timers (`grader/conformance/pregate.ts:563` 250 ms, `grader/frontend/core.spec.ts:54` 1.5 s, `grader/backend/gates-13-16.test.ts:372` 6 s) could fire more often under N=8 contention and convert contention into extra failures — the measured quantity. Run the same fingerprint at N=1 and N=8 and compare before advertising the feature as verified. | §8 measurement integrity |
| **STACK-LEDGER-FLOOR-DRIFT** | 🟡 OPEN — code-owner | `control/board/sources/stack-ledger.mjs:109-111` still picks `scorable[scorable.length - 1]` for the transfer-curve floor while `control/baselines.mjs` moved to batch-median + operator selection; its `:104` comment "Same rule as control/baselines.mjs" is now false. The card (baselines.mjs) and the curve (stack-ledger.mjs) will disagree until it too reads the batch. | transfer curve vs baseline card |

**Memory is not a constraint — CLOSED, do not re-investigate.** Zero swap, ~211 GB wired headroom.
The trap that misled two sessions is `top`'s "unused" line, which excludes inactive pages macOS
reclaims on demand. A memory-pressure report derived from `top` or `free`-style arithmetic is a
misread, not a finding. One real constraint: a transient ~62.6 GB spike occurs **during** model load,
so never load two instances simultaneously.

---

## 12. THE TEMPLATE DEFECT

**What it is.** On tool-enabled turns the installed template pre-fills an unclosed opening reasoning
tag; the model's own tool instructions demonstrate a format that opens another; the tags nest; the
first close closes the outer block; the streaming parser flips to content early and misattributes
everything after. The fallback extractor then splits assistant content on newline-plus-closing-tag,
so a desynced turn gets its history mangled on the next render. Reproduced six times on demand.
Degradation grows with context length.

**CLEARED as the cause of the dead 27B-model cell's turn 85** — that was a genuine transport drop. Do not
rediscover this.

**Why it is still the top risk.** ON cells inject a memory block; that block consumes context; so an
ON cell reaches any context-length degradation ridge **earlier than its paired OFF cell, by
construction.** The defect does not add noise — it systematically penalises the arm that is supposed
to win. If lift is real but modest, this erases it and you would conclude the memory system does not
work.

**Remediation ladder — stop at the first that passes the ≥100-turn proof:**
1. `preserve_thinking: false` — **already set, unproven.** Prove or disprove it first.
2. Swap to a self-healing template that inserts the missing close. A **template** swap, not a model
   swap.
3. Characterise and disclose as a bounded constant, with a measured desync rate per 100 turns,
   reported on every scorecard.

**Whichever lands is FROZEN for the campaign and must be byte-identical across OFF and ON.**

---

## 13. WALL-CLOCK

Measured locally on the 27B model: OFF cell attempt 1 = **4,369 s ≈ 72.8 min**. Full gate suite = **25.3
s**, negligible. Essentially all cost is model time.

A full 5-attempt cell's wall-clock is **unmeasured** — the prior 3-attempt cell ran **~2–3.5 h**;
repair attempts should be shorter than the initial build, but that is **unmeasured — measure, do not
assume.** OFF plus a handful of ON cells is
**days**. Size N from measured local numbers only. At ~72 min per attempt, an N=5 escalation is
several hours minimum, so a paired OFF/ON difference at N=1 is not a result.

---

## 14. TEST INFRASTRUCTURE

Config lives in `pyproject.toml` under `[tool.pytest.ini_options]` — there is **no `pytest.ini`**.
Addopts: `-n auto --dist=load --timeout=60 --strict-markers --tb=short -ra -m "not slow"`,
`timeout_method = "thread"`.

**Targets:** `test` (full suite) · `test-fast` (skips slow) · `test-file FILE=…` · `test-name
NAME=…` · `test-slowest` (ten slowest from the last run) · `test-all` (everything, including slow).

**Markers:** `slow` — excluded by default. `serial` — intended for tests that must not run in
parallel; NOTE: `tests/conftest.py` currently only WARNS on serial-marked tests and does not actually
force serialization (doc-vs-code drift) — do not rely on `serial` to order tests under `--dist=load`
until the conftest is fixed.

**`RealSessionRunner` test doubles bypass `__init__` via `__new__`.** The
`RealSessionRunner` fixtures in `tests/test_cumulative_wiring.py` (:27, :90) and
`tests/test_run_cumulative_run_artifacts.py` (:79) build the runner with
`RealSessionRunner.__new__(RealSessionRunner)` and hand-wire an attribute list,
skipping `__init__`. Any `__init__` attribute that `run_session` reads (e.g.
`_error_totals`, added 2026-09-08) must be hand-wired into EVERY such fixture in
the same commit or the suite goes red with `AttributeError`. Grep `__new__` over
`tests/` before adding such an attribute. (`test_cumulative_pacing_knobs.py`
instead builds a REAL runner via `__init__` — the exception, not the rule.)

**`--dist=load` (work-stealing) is the default.** Tests spread across the `-n auto` workers as they
free up. This was switched to cut the suite runtime from ~20s to ~10s:
the previous `--dist=loadfile` serialized the 8 subprocess-launching truncated-turn tests on a single
worker (the dominant cost, ~19.65s), while `--dist=load` scatters them across workers to run in
parallel. Trade-off: work-stealing can scatter tests that share a fixture, a port or a temp path.
Tests that must stay ordered/serialized must carry the `serial` mark (see below) or be kept in a
shared-state-safe pattern; verify the full suite is green before relying on this mode. The truncation
tests are safe under `--dist=load` because they use per-test `tmp_path` + read-only `TASK_DIR`.

**The 120 s agent shell limit is load-bearing.**
1. **Never pipe suite output through `tail`, `head` or `grep` alone.** They buffer until process
   exit, so a timeout kill produces **no output at all**. Redirect to a file and read the file.
2. `--timeout=60` is deliberately below the shell limit so a hung test yields a named timeout
   failure rather than dying silently. `timeout_method = "thread"` is set because the default signal
   method does not reach xdist worker processes.

**NEVER raise the timeout.** If a test consistently needs more than 60 s it gets marked `slow` and
runs only with `test-all`. To resolve a timeout: find the hung test in the run log, run just that
file, mark it `slow` if it is genuinely slow or a flaky network test — and never raise the ceiling
without understanding why it was slow.

**Log rotation:** timestamped logs per run, last ten kept, with a stable pointer to the newest.

**The gates oracle is not pytest.** It is a separate JS suite run through its own runner. The test
target does not exercise it.

**CI runs pytest only.** `.github/workflows/ci.yml` runs `ruff format --check` + `python -m pytest`;
the dashboard (`cd dashboard && node --test`) and control-plane (`cd control && node --test`) suites
are manual-only — a green CI does NOT cover `board.js`/`server.mjs`/panel changes. Run them yourself.

**`grader/gate-results.mjs` has an embedded NUL byte** — `file` reports `data`, `rg` skips it as binary,
and the Read tool refuses it. Read/search it with `rg -a` or `tr -d '\000'` (the gate-verdict vocabulary
`GATE_STATUSES` is at `gate-results.mjs:28`).

**Gates must resolve the entrypoint from the artifact**, never assume a fixed server filename — the
build pipeline may change it. A hardcoded filename here is what produced a whole dead campaign cell.

**Verified baseline: 2062 passed / 413 skipped** (full default suite, 2026-09-22, post-concurrency +
median-baselines; collect-only `2475/2477 collected, 2 deselected`). The 413 skips are the
docker-gated `@REQUIRES_DOCKER`/slow-marked tests (no container launched). Prior: 938 passed / 1
skipped on 2026-09-04, before the concurrency test additions. Any change must return to this or
account for the difference.

---

## 15. RULES FOR THE ORCHESTRATOR

1. **Report evidence, not conclusions.** Every factual claim carries `file:line` or a log path. If
   you cannot verify it, write **UNKNOWN**. Do not infer, do not fill gaps.
2. **Claims of a negative need evidence too.** "Pre-existing", "unrelated", "unchanged", "no longer
   referenced", "no artifacts present" are assertions, not observations. This is the class that has
   failed repeatedly.
3. **Contradiction rule.** A finding that contradicts an earlier report must quote the earlier claim
   verbatim, state which is wrong, and give the evidence. Never silently replace a prior finding.
4. **Confirm every distilled answer** with a gather against the content you previously found.
5. **Do not self-patch on a self-diagnosis.** Investigate and report; land fixes only when directed.
6. **One step at a time. Report after each. Never batch.** Do not proceed past a failure — escalate.
7. **Never close a defect on a configuration change without running its proof condition.**
8. **Encode fixes in the repo, not in directives.** If the next agent will hit the same wall, the fix
   goes in a committed file. That is why this card is rewritten rather than annotated.
9. **Never add a document.** Update this card. A companion report, a status file, a summary doc, a
   second runbook — each is a future reconciliation cost and a future contradiction. **Content walks
   backwards, never forwards.** This ban is on companion design docs, companion runbooks, and status
   or summary documents that drift from the card — never author those. It does NOT forbid delegate
   work reports: those ARE expected work product and belong in the normal reports location
    (`dev/workspace/reports/`).
10. **For any purge: classify before deleting, delete before running, diagnose before repairing.**
    Map the irrelevant, map the needed, map the remainder, decide the remainder, delete en masse,
    then run, then diagnose case by case, then fix. Never interleave delete-versus-fix decisions
    item by item.

---

## 16. WORKER RELIABILITY — assume these failure modes

The agent runs on a local model. It executes; it does not reason well. Recorded confident wrong
claims: an attempt ceiling of 1 when it is 3 · "the worktree has no compiled artifacts" when they
were intact and already scored · "the failures are pre-existing" when half were its own regressions
· "under the shell limit" when it was over · a memory-pressure report that was a tool misread · a
defect declared resolved on a config change whose proof was never run.

**Every one of these is a claim of a negative or of a bound, asserted without evidence.**

**Work-order format that works** (prescriptive step lists do not — they break on the first wrong
assumption about repo structure and fill context fast):

> **OBJECTIVE** · **WHY** · **HARD INVARIANTS** · **ACCEPTANCE CRITERIA** · **explicit autonomy to
> iterate without asking** · **a short named escalation list**

**Never reference a file that exists only as a chat artifact** — the worker cannot see those.

**Never specify where anything is saved.** No paths, no directories, no filenames, no naming
conventions in a work order. Objective and acceptance criteria only; placement is the worker's.

---

## 17. TRAJECTORY

Ordered. Each step gates the next. One work order each.

**Done.** Census · verified baseline (`41c4568`) · suite finalization, 317 dead tests removed
(`937d893`) · source deletion, 19 files (`8bdcabc`) · run status contract, manifest + append-only
status stream + scorecard (`1a50ba9`) · entrypoints + unconditional reaper (`09cab437`) · mode-drift
removal + model-alias residue cleared (`98a286b` + `0141930` + `e60ccc1` + `8bdcabc` + `186d34c`) ·
baseline reconciled to `350f899` · template low-context proof PASSED.

1. **Document consolidation.** This card absorbs everything binding; the remaining documents are
   deleted and `AGENTS.md` is amended to stop contradicting §2.
2. **High-context template probe to ≥100K tokens** (§12): the low-context proof passed; the
   high-context behaviour this probe measures is still unverified. Only after it passes does the
   template get FREEZEd.
3. **Preflight checks** (§6) before the campaign; delivery is then verified in-band by the first
   OFF cell + extraction + the first ON cell's injection seams (rule 5.1) — there are no smoke
   stages (2026-08-11).
4. **FREEZE the template** (§12), only after the high-context probe passes.

> **Terminology:** §12/§17 "template" = the **agent reasoning template** (a different artifact from
> the task prompt/scaffold). The **task-template freeze** — the backgammon scaffold hash that the
> run path fails closed on — is recorded separately at RC-5a above.
5. **Wipe before the first cell** — the full four-step procedure (§2). Then first OFF cell (unscored)
   → extract → first scored ON cell → extract, continuing until
   performance drops or something needs the maintainer. A model switch is one of the things
   that needs the maintainer. The corpus carries across it; the wipe does not run again after the first cell.

**The first ON cell is the delivery verification.** The injection seams are null by contract on OFF
cells, so no OFF cell can ever prove them — and no standalone smoke can either: proving
recall requires a full session + extraction + approval, which only a real cell produces. Read the
first ON cell's status stream: non-null `injected_count` / `injected_block_chars` /
`injected_block_est_tokens` / `consumer_injected_count` = delivery proven; null = rule-18 walk-back.

---

## 18. BUILD-SNAPSHOT REUSE (DEV MODE)

A **development** feature, never a measurement surface. It captures the finished
worktree after the first grade so a later cell can skip the build and iterate on
the prompt gradient fast. **A seeded cell is never a scorable floor** — it is a
fast-iteration tool, not a data point.

### Capture — two triggers

**Attempt-1 build-completion (automatic, every baseline).** At the attempt-1
grade boundary every baseline run captures its whole worktree into
`runs/snapshots/<id>/{tree/,snapshot.json}` (`capture_snapshot`,
`harness/snapshot.py`; boundary at `harness/adapters/challenge/runner.py:1602-1603`).
Capture can never fail the run: on failure it writes no `snapshot.json` (so the
snapshot is structurally ineligible) and emits a `notice`. Excluded: `.git/`,
`.okp/`, `AGENTS.md`, `opencode.json`, `test-results/`; `test/*.cjs` are included
(genuinely model-authored).

**End-of-run chaining (every stuck run).** A run that reaches the attempt
ceiling (`attempt_ceiling_reached`, regardless of verdict/void) or runs out of
context (`context_exhausted`) promotes its final graded worktree into a NEW
snapshot — `_capture_end_of_run_snapshot` (`harness/adapters/challenge/runner.py`,
one call at each of those two exits) — so the next run carries its accumulated
fixes forward instead of discarding them. Seeded and fresh runs alike: a fresh
baseline that never passes leaves its attempt-1 build snapshot (depth 1) AND its
end snapshot (depth 2), which is what continuous mode (§19) chains from after its
first run. Exits that leave no final checkpoint (`harness_error`,
`transport_incomplete`) and a run that passes (`gates_green`) capture no end. The
new snapshot's depth is the seed's depth + 1, a fresh run counting as depth 1.
Seeding FROM any snapshot stays dev-mode only.

### The chain model — `snapshot_depth`, not `cell_seq`

- **`cell_seq`** is the *authoring cell's per-campaign `sequence_index`* (0 for
  the first cell of a campaign), carried in `snapshot.json` — NOT a chain depth.
  It must never be repurposed as "n".
- **`snapshot_depth`** is the chain-depth field. The attempt-1 capture omits it;
  only the end-of-run chaining capture writes it (`seed_depth + 1`,
  `runner.py:595`). The read side defaults it to 1 when absent
  (`harness/snapshot.py:165`); the control plane exposes
  `snapshot_depth: manifest.snapshot_depth ?? 1` and drops `cell_seq` on read
  (`control/snapshots.mjs:89`). The board sorts the armable seed list by depth
  descending and labels each row `n=<depth>`; the `n=` counter is the armed
  snapshot's real depth, not a hardcoded 1.
- **`produced_snapshot_id`** is the durable run→snapshot join key, written onto
  `manifest.session_records[]` (`harness/cumulative/types.py:582`) ONLY by the
  end-of-run chaining capture — never the attempt-1 capture, so a baseline that
  passed reports null even though its attempt-1 snapshot exists on disk. The run
  manifest is **campaign-nested**, NOT at run root:
  `<runs_root>/<treeId>/<substrate>/<router>/<provider>/<model>/manifest.json`
  (`control/campaign.mjs:72-73`), and under
  `runs/backups/<newTreeId>/<oldTreeId>/<…>/manifest.json` once archived.

### Cleanup — run deletion removes the produced snapshot, reset does not sweep

- **Run deletion** hard-deletes the snapshot(s) its manifest names via
  `session_records[].produced_snapshot_id` (`control/rundelete.mjs`), with NO
  cascade — downstream snapshots seeded from them are left untouched. A run with
  no `produced_snapshot_id` deletes only the run folder, no error, no guessing.
- **Reset** archives the run but leaves its snapshot behind permanently: the
  sweep is an allow-list (`isBenchmarkData`, `control/tree.mjs:271-296`) with NO
  `snapshots` case, so `runs/snapshots/` is neither swept into `runs/backups/`
  nor owner-recorded. Orphaned snapshots survive resets and must be reconciled by
  hand if undesired.

### Dev mode — control-plane state

The gate is `GET`/`POST /api/devmode` (`control/server.mjs:1076`, `:1086`),
persisted env → state file → default OFF (`control/devmode.mjs:75-162`). The
board never holds its own belief — it POSTs/reads the server and renders the
server's answer. A topbar marker shows while on.

### Seeding — the board step, or `--seed-snapshot`

Arm a snapshot from the board (dev mode on): the baseline sequence inserts a
step **"BASELINE · 2b — Seed from a build snapshot?"** (`dashboard/panels/create.js:630`)
between model selection and confirm; picking a row POSTs `/api/snapshots/arm`
(`control/server.mjs:1040`); the confirm frame shows the red caution
**"SEEDED FROM A BUILD SNAPSHOT — NOT A SCORABLE FLOOR"**
(`dashboard/panels/snapshot.js:268`). CLI equivalent: `--seed-snapshot <id>`
(`scripts/run_cumulative.py:1878`). Both plumb the id into the harness argv as
`--seed-snapshot` (`control/server.mjs:1814`).

The seed **skips the six build chunks** and re-grades before the first feedback
round. The list of armable snapshots is same-model only (`seedableBy`,
`control/snapshots.mjs:188-203`); `GET /api/snapshots` lists everything and
annotates per-row seedability (`control/server.mjs:1020`).

> Arming AND disarming are both gated behind dev mode (`dev_mode_off` 409 at
> `control/server.mjs:1046` — the gate precedes the disarm branch). To clear a
> stale armed snapshot while dev mode is off, delete `config/armed-snapshot.json`
> (or unset `BENCH_SEED_SNAPSHOT`) — the API cannot disarm it.

### The dev-mode validity exception (D-SNAP-DEVMODE-EXCEPTIONS)

`source_commit` / `chunk_plan_hash` / `template_hash` drift does **not** block
seeding — it is reported (`notice` `snapshot_validity_relaxed`) and proceeds
(`harness/snapshot.py:192-208`). Absent, unreadable, and model-mismatched
snapshots still refuse — one `SEED SNAPSHOT REFUSED:` line, exit 2, never a
scaffold fallback (`scripts/run_cumulative.py:1732-1744`).

### Why a seeded cell is not a floor

It sits on a different turn/token scale than a floor (it skipped the build), so
it folds `scorable:false` with a stated reason (`control/baselines.mjs:517-535`)
and is excluded from the transfer curve's baseline
(`control/board/sources/stack-ledger.mjs:106-108`). It never appears in the ledger's
`baseline_rows`.

### Honesty fields

A seeded run's status record carries `seeded_from_snapshot` (the id),
`build_phase_ran:false`, `skipped_build_cost` (the snapshot's `build_cost`), and
`dev_mode:true` — declared at one write seam (`scripts/run_cumulative.py:1400-1417`)
and carried through `SessionRecord` / `ConvergencePoint`
(`harness/cumulative/types.py:578-581`, `harness/cumulative/convergence.py:92-95`).
The chaining additions ride the same single-writer seam: `produced_snapshot_id`
(the run→snapshot join key, `SessionRecord`, `types.py:582`, end-of-run capture
only) and the seed's `snapshot_depth` threaded into the cell
(`scripts/run_cumulative/runner.py:1115`).

### The two env vars (also in ENV-VARS.md)

- `BENCH_SEED_SNAPSHOT` — pins the armed snapshot id; unset it to arm from the board.
- `BENCH_SEED_SNAPSHOT_FILE` — overrides the armed-state file (default `config/armed-snapshot.json`).
## 19. CONTINUOUS MODE

The way the benchmark is meant to be run once the system is judged healthy: the
operator starts ONE baseline with **CONTINUOUS: ON** (the + baseline sequence's
confirm frame), and from then on every run that ends stuck is followed by the next
run, started from its end snapshot (§18), until the model passes everything. There
is no analysis between runs and no judgement of faults — it only chains.

### What it does between runs (`control/continuous.mjs`)

A watcher in the control plane looks at the chain every 15 s. When the chain's run
is no longer in flight it writes down how the run ended — `verdict` and
`terminal_reason` from the cell's own `cell.end`, the end snapshot from the
campaign manifest's `produced_snapshot_id` — and then drives the control plane's
OWN routes in the order an operator's run takes:

1. `POST /api/tree/reset/preview` → `POST /api/tree/reset` (the finished run is
   archived into `runs/backups/`, as a hand reset does);
2. `POST /api/snapshots/arm` with the end snapshot;
3. `GET /api/preflight` (compaction checked unless the payload turned it off);
4. `POST /api/run/preview` — the token must carry `snapshotId=<that snapshot>`;
5. `POST /api/run/start` with the operator's original payload and that token.

So a chained run passes every gate a hand-started run does and is refused for the
same reasons. The outcome is written BEFORE the reset, so a restart mid-chain never
needs to read a run that has moved, and a restart after the reset does not reset
again.

### When it stops

It ENDS — never retries — and the board's banner says why:

| code | when |
|---|---|
| `passed` | the run's `cell.end` verdict is PASS (`gates_green`) — the model passed everything |
| `run_stopped` | the run's `cell.end` says `stopped` |
| `operator_stop` | the operator pressed STOP (the run stop ends the chain first) |
| `operator_end` | END AFTER THIS RUN on the banner — the run in flight finishes, no next run starts |
| `no_end_snapshot` | the run ended without an end snapshot (`harness_error`, `transport_incomplete`, a budget stop, …) |
| `dev_mode_off` | dev mode was turned off — every chained run is seeded |
| `cell_in_flight` | another cell is running — the chain never resets the tree under it |
| `reset_refused`, `arm_refused`, `preflight_failed`, `preview_refused`, `start_refused` | that step was refused; the server's own code and reason are kept |
| `not_seeded` | the preview was not seeded from the armed snapshot — the chain never starts a fresh build in its place |
| `chain_error` | anything that threw |

It only WAITS (the next tick) while a substrate refresh (a `blocks_runs` tool job)
is running; the banner shows what it is waiting for.

### Starting it

The start request carries `continuous: true`. The start refuses it on the MEMORY
ON arm (`continuous_baseline_only`), with more than one cell
(`continuous_one_cell`), with dev mode off (`dev_mode_off`), and while another
chain is active (`continuous_active`). It is in the confirmation token
(`continuous=on`) and the restatement, so a confirmation for one run never starts
a chain.

### State and routes

- State: `config/continuous.json` (override `BENCH_CONTINUOUS_FILE`), beside the
  armed snapshot, so a tree reset never moves it: `active`, the original
  `payload`, `links[]` (one per run: `run_id`, `run_dir`, `sequence_index`,
  `log_path`, `seeded_from`, `outcome`), `waiting`, `ended {at, code, reason}`.
- `GET /api/continuous` — the chain (null when none was ever started); the board
  carries the same object as `board.continuous`.
- `POST /api/continuous/stop` — END AFTER THIS RUN.
