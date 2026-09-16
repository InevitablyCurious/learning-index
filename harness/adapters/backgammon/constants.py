"""Module-level constants for the backgammon adapter.

Extracted verbatim from harness/adapters/backgammon/__init__.py
(WO-LI15-I1B STAGE 1B) and re-exported there, so every name stays
resolvable as harness.adapters.backgammon.<NAME>. Comments travel with
their constants. Deliberately NOT here: _LOG (a logger, not a constant),
DECLARED_TEST_COMMANDS and _MODEL_PRICING_USD_PER_1M (annotated
grading/pricing leaves -- a later stage).
"""

import os
from pathlib import Path


# ── BUILD-CHUNK COMPLETION: OPERATOR TELEMETRY, NEVER A GATE ────────────────
#
# WO-CHUNKVIS-1 (2026-08-26). `chunk_reports` has always been assembled per
# chunk and then dropped — populated here, asserted in tests, read by nothing.
# This turns it into something the operator can see.
#
# READ-ONLY BY CONSTRUCTION, EXCEPT FOR WO-ABORT. Nothing here reaches the
# model and nothing here nudges: a chunk row is telemetry, plus the one
# all-or-nothing build gate that refuses to grade a build with a chunk missing.
#
# THE CLAIM AND THE FILE, SIDE BY SIDE. A chunk that ran to completion while
# the file it owns still holds its scaffold stubs did not do its work, so the
# FILE is reported beside the outcome — `state: complete` next to
# `stubs_remaining: 5` is a visible discrepancy rather than a silent one.
_STUB_SENTINEL = 'throw new Error("not implemented")'
# Chunk -> the scaffold file that chunk is responsible for emptying of stubs.
# Chunks 1, 5 and 6 own no stub file: 1 is structure/types, 5 is the frontend
# (whose scaffold carries no sentinels), 6 is a verification pass.
_CHUNK_STUB_FILE = {2: "src/game.ts", 3: "src/ai.ts", 4: "src/server.ts"}


# THE REPO ROOT — the one place this package counts folders up from itself.
# The package split moved these modules one level deeper (the old single
# backgammon.py sat in harness/adapters/), and every copy of
# `Path(__file__).resolve().parents[2]` silently started landing in harness/:
# build snapshots, cell telemetry, the grading cwd and the grader lookup all
# pointed at the wrong place. Anything that needs the repo root imports this.
# This module sits at harness/adapters/backgammon/, so the root is parents[3].
_REPO_ROOT = Path(__file__).resolve().parents[3]

# WHERE THE GRADER LIVES — the one place the harness names it. The gate code,
# its feedback lines (feedback.json) and the grader identity hash all resolve
# from here, so they cannot drift apart again. The restructure moved them out
# of task/backgammon/gates/ into grader/, and four call sites kept looking in
# the old place.
_GRADER_DIR = _REPO_ROOT / "grader"


_RESERVATION_SAFETY_FACTOR = 1.10
# A STALLED TURN IS NOT A CAPABILITY RESULT. `turn_stalled` joins the harness
# limits so a wedged tool call is never scored as the model failing.
_HARNESS_LIMIT_REASONS = {
    "run_timeout",
    "max_steps_per_attempt",
    "token_cap",
    "turn_stalled",
}


# How long a turn may make NO transcript progress before the harness ends it.
#
# Bounded separately from the run budget because `session_busy` cannot tell
# "working hard" from "wedged" — a hung tool call stays busy forever, and the
# drive passes the whole-run budget as its idle timeout, so one wedged command
# used to burn the entire cell (2026-08-24: 40 minutes of silence, on course
# for the full 90).
#
# 10 minutes is deliberately generous. This task has ZERO external runtime
# dependencies, so there is no `npm install` leg — a legitimate single tool
# call here is a file write or a short node run, orders of magnitude under the
# bound. Streaming generation advances the progress token continuously and is
# never mistaken for a stall.
DEFAULT_TURN_STALL_TIMEOUT_S = float(
    os.environ.get("BENCH_TURN_STALL_TIMEOUT_S", "600")
)
_PROXY_CHECKPOINT_ENV = "BENCH_PROXY_CHECKPOINT"
_REASONING_EFFORT_ENV = "BENCH_REASONING_EFFORT"


# WO-HOLD-UI-1: opt-in post-cell observation window. When BENCH_HOLD_UI=1,
# the cell's stack (container + worktree) is NOT torn down at benchmark end; the
# artifact's UI server is booted host-side from the bind-mounted worktree on
# :8002 — the exact bytes the model wrote, the same boot the gates perform
# (grader/lib/harness.ts). The port MUST equal PORT there.
# Release is operator-explicit: `touch <run_dir>/RELEASE_HOLD`. Teardown then
# proceeds through the normal unconditional path (RC-6 is preserved — the hold
# sits INSIDE the cell context, so every abort/interrupt still tears down).
_HOLD_UI_ENV = "BENCH_HOLD_UI"
_HOLD_UI_PORT = 8002
_HOLD_UI_RELEASE_FILE = "RELEASE_HOLD"
_HOLD_UI_STATE_FILE = "hold-ui.json"
_HOLD_UI_SERVER_LOG = "hold-ui-server.log"
_HOLD_UI_HEALTH_TIMEOUT_S = 15.0
_HOLD_UI_POLL_S = 2.0
_HOLD_UI_HEARTBEAT_S = 30.0


# ── THE NUDGING PROTOCOL — ITS ENTIRE TRIGGER SET ──────────────────────────
#
# THE PROTOCOL FIRES ON UPSTREAM PROXY TERMINALS AND NOTHING ELSE
# (WO-MARKER-RIP, 2026-09-09). Three conditions, all of them raised by the
# relay, none of them by the model:
#
#   relay LOOP kill      -> _LOOP_RECOVERY_NUDGE      (anti-repetition)
#   relay STREAM DEATH   -> _FINALIZE_RECOVERY_NUDGE  (resume; covers both
#                           relay_stream_finalize_timeout and
#                           relay_stream_incomplete)
#   provider outage      -> _PROVIDER_RECOVERY_NUDGE  (resume, after a backoff;
#                           the relay is relaying someone else's outage)
#
# There is NO fourth trigger and there must never be one derived from what the
# model wrote. The deleted one — a missing `CHUNK FINISHED` string — is the
# reason this list is now stated as a closed set: a nudge keyed on model prose
# re-drives a model that is not stuck, and re-drives it into a context it just
# filled. The relay's terminals are facts about the transport; everything else
# the harness observes is either a measurement (recorded, never acted on) or a
# hard failure (abort, never nudged).
#
# HISTORY. WO-LOOPREC-1: a relay StreamLoopGuard kill used to meter as
# completed work (2026-08-10 live cell: a loop kill on the repair leg metered
# as a turn, no recovery, gates ran on an unrepaired worktree).
# WO-FINALIZE-REC-1 (Walter 2026-08-10) gave the relay's 30s stream-finalize
# watchdog the same recovery with a resume-style nudge (the turn was cut off,
# not looping). WO-NUDGE-INF-1 (Walter 2026-08-11) made recovery UNBOUNDED;
# the 2026-09-02 compaction-looping incident (126+ recovery events, no exit)
# ended that era — recovery is now BOUNDED by _MAX_SERVE_RECOVERY_NUDGES and
# fails closed on exhaustion.
#
# Stalls, loops, and oversized generations are still NORMAL agentic behaviour
# under measurement: a nudged phase is never voided for having been nudged
# within the budget. Nudge turns are excluded from scoring turns (see
# scoring_turns in _run_opencode_serve) so recovery cannot inflate the
# measurement; their tokens stay fully metered — real burn is never hidden.
#
# No nudge restates the original prompt — for a loop kill, the same prompt into
# the same context is the loop's fuel.
#
# Applies to every serve-driven phase (chunked building leg AND repair leg
# alike — RC-4: no mode branch). The proxy guard itself is never reconfigured.
#
# The chunking reminder (Walter 2026-08-10): the finalize kills that day were
# oversized single generations (one 32000-token write; ~4900-token writes) —
# the model tried to emit whole files in one call. Only the cut-off nudge
# carries the write-in-chunks directive (Jerry, 2026-09-15: each nudge names
# only the situation that just happened, or the model is left guessing what a
# write limit has to do with a loop, a stall or a dropped connection), so a
# re-driven turn retries at safe granularity
# (~150 lines ≈ 1.5K output tokens; every observed sub-1K-token generation
# finalized cleanly, the killed ones were ~4.9K+). ONE NUMBER, EVERYWHERE:
# ~150 lines is also what the six chunk prompts and AGENTS.md say, so the model
# is never handed two different limits by two different voices.
_WRITE_CHUNKING_DIRECTIVE = "Keep writes under ~150 lines."
_LOOP_RECOVERY_NUDGE = (
    "You were going in circles, so I stopped you. "
    "Pick up from the next unfinished step. No recap."
)
_FINALIZE_RECOVERY_NUDGE = (
    "Your last message got cut off. Continue from where it stopped. "
    + _WRITE_CHUNKING_DIRECTIVE
    + " No recap."
)

# STALLED TOOL CALL RECOVERY (2026-09-11).
#
# A wedged tool call used to END THE CELL. The stall watchdog caught it — that
# part always worked — but catching was all it did: `killed_reason` was set,
# the drive died, the chunk was marked `died`, and the build aborted with
# `IncompleteBuildError`. Three hours of work lost to one command that did not
# exit.
#
# The un-wedging machinery was already right there. A loop kill is the same
# shape — a turn wedged by something the model did — and it rides a recovery
# nudge back into the drive. A stall now does too.
#
# WHAT THIS SAYS THE MODEL IS OWED. Not a second chance at a wrong answer: the
# command is CANCELLED and the model is told, which is what a colleague sharing
# a terminal would do. Whether it then adapts is a capability observation, and
# one of the more interesting ones — it is certainly more informative than the
# cell dying with no verdict at all.
_STALL_RECOVERY_NUDGE = (
    "That command ran ten minutes, so I cancelled it. Try another way. No recap."
)

# PROVIDER OUTAGE RECOVERY (2026-08-24). A live cell lost 8 turns to stream
# deaths, two of them the provider answering "The upstream provider is
# temporarily unavailable"; only 2 of the 8 were ever retried, because the
# recoverable set covered loop kills and finalize timeouts and nothing else.
#
# The same reasoning that put guard kills and finalize timeouts in the
# recoverable set applies with more force here: a provider being down is not
# agentic behaviour at all, and scoring a cell lower because the provider
# blipped is a straightforward false negative. The model is told nothing
# about providers — from its side a message simply did not go through.
_PROVIDER_RECOVERY_NUDGE = (
    "My connection dropped. Continue from where you stopped. No recap."
)


# Wait before re-prompting a provider that just said it was unavailable —
# retrying instantly just spends another turn to be told the same thing. The
# schedule escalates and then holds; within the recovery budget an outage
# longer than the schedule is ridden out at the cap rather than giving up.
PROVIDER_BACKOFF_SCHEDULE_S = (15.0, 30.0, 60.0, 120.0)


# ── TERMINATING RECOVERY BUDGET (WO-COMPACTION-RESTORE C5A, 2026-09-03) ────
#
# WO-NUDGE-INF-1 (Walter 2026-08-11) made recovery UNBOUNDED: a repeating kill
# was re-nudged for as long as it repeated. The 2026-09-02 compaction-looping
# failure showed the cost of that design: one wedged session rode the loop to
# 126+ recovery events with no exit. It is now BOUNDED and fails closed on
# exhaustion. Nothing else changed: the recoverable classification, the nudge
# texts, the watermark windowing and the metering discipline (recovered turns
# excluded from scoring turns, burned tokens fully metered) are all intact.
#
# ONE BUDGET, NOT TWO (WO-MARKER-RIP, 2026-09-09). There used to be a second,
# per-chunk budget (`_MAX_MARKER_NUDGES = 10`) governing re-drives of a chunk
# whose `CHUNK FINISHED` string had not landed. That trigger is deleted, so its
# budget is deleted with it — there is exactly one recovery budget, and it
# governs the only thing that can now cause a re-drive: an upstream proxy
# terminal.
#
# Budget value (judgment call, 2026-09-03): normal runs see ~6-16 guard aborts
# PER CELL, spread across the ~6 build chunks plus repair phases; the worst
# observed SINGLE-PHASE burst is 3 consecutive finalize kills (the 2026-08-11
# incident). 20 recoveries in ONE phase absorbs even a fully concentrated
# normal worst case with margin, and stays ~6x below the 126-event storm scale.
#
# Exhaustion semantics (fail-closed): a recovery-budget exhaustion ends the
# drive exactly like a NON-recoverable terminal — the anomaly stays unretried,
# the loop breaks, the drive returns, and the unretried anomaly climbs the cell
# ledger.
_MAX_SERVE_RECOVERY_NUDGES = 20


# Turn-terminal taxonomy (WO-TRUNC-1). A turn is one model generation step,
# delimited by step_start/step_finish on the worker's JSON event stream.
# step_finish reasons that mean "the provider stream ended without a finish
# reason" — the turn's content and usage frame were lost in transit.
TRUNCATED_STEP_FINISH_REASONS = frozenset({"unknown", "stream-incomplete"})
# Substring signatures in `error`-event payloads that classify a turn aborted
# by transport/guard rather than by the model. Guard trips and upstream drops
# both surface to the client as terminal error events (see the loopguard
# diagnostic report); the open step they interrupt never gets a step_finish.
# The loop-guard shapes (live + legacy) live in serve_client.LOOP_GUARD_SIGNATURES.
# The relay finalize-watchdog shape leads this list (RC-4 taxonomy parity:
# every observation point names it exactly as the serve path does).
_TRANSPORT_ERROR_SIGNATURES = (
    ("stream_finalize_timeout", "did not finalize"),
    ("stream_incomplete", "stream incomplete"),
    ("idle_timeout", "idle timeout"),
    ("provider_error", "provider returned error"),
    ("unexpected_server_error", "unexpected server error"),
    ("corrupted_thought_signature", "corrupted thought signature"),
)
# Anomaly terminal classes recorded on turn_terminal records.
TURN_TERMINAL_TRUNCATED = "truncated_no_signal"
TURN_TERMINAL_GUARD_ABORT = "guard_abort"
TURN_TERMINAL_TRANSPORT_ERROR = "transport_error"
# D-SERVE-MESSAGE-500: the transcript read failed past every transient retry,
# so the harness lost its window onto a session that may still be alive. The
# phase carries no trustworthy measurement — an instrument failure, never a
# capability FAIL (RUNBOOK rule 5.10).
TURN_TERMINAL_OBSERVATION_LOST = "observation_lost"
# A TOOL CALL THAT NEVER RETURNED. The model ran something that does not exit —
# measured 2026-09-11: `node -e "import './src/server.ts'"`, which STARTS the
# server, so the command hung and took the whole cell with it after 10 minutes
# of silence.
TURN_TERMINAL_STALLED = "turn_stalled"
REASON_TOOL_CALL_TIMEOUT = "tool_call_exceeded_stall_timeout"
REASON_OBSERVATION_LOST = "transcript_read_failed_past_retries"
# WO-WATCH-1E evidence file name, written next to the cell's events file under
# the run dir (``<worktree>.events.jsonl`` -> ``<worktree>.parent/...``). Lazily
# created: only a real truncation/transport anomaly ever opens it.
TRUNCATION_EVIDENCE_FILENAME = "truncation-evidence.jsonl"


# Canonical attempt ceiling. Raised 8 -> 10 (WO-BENCH-ATTEMPTS-3-TO-10): the
# commissioned solve-attempt count is now 5 (config.py max_attempts), so the
# hard ceiling must be >= 10 or the clamp at `min(requested, ceiling)` silently
# caps a 10-attempt request at 8. 10 == the default; the ceiling stays a single
# knob with no hidden cap below the commissioned count.
DEFAULT_ATTEMPT_HARD_CEILING = 10

# Canonical per-attempt step cap (runaway-loop guard, NOT a budget instrument).
# Budget enforcement is the accrued usage.cost kill plus the proxy's hard-cap
# reservation; this cap exists only to stop a fast runaway tool-call loop.
# Evidence for 100: the healthy 15-07 un-clamped baseline used 77 turns across a
# full run (~25-40 per attempt; 19b initial attempt = 37), while the clamp-era
# value of 40 killed smoke 19c at turn 41 mid-work, UNGRADED. 100 = baseline +
# margin. Programmatic `max_steps_per_attempt=None` still means "no cap"; the
# CLI driver defaults to this constant.
DEFAULT_MAX_STEPS_PER_ATTEMPT = 100

# Canonical per-attempt wall-clock timeout (guard, NOT a scoring signal).
# Evidence for 5400: smoke 19d observed ~3060s wall on a healthy 68-turn Opus
# PASS. Stage-4 at the old 1800s default killed converging near-pass runs
# (kimi-k2.7-code: 52 turns with 26/29 gates green; mimo-v2.5-pro: 35 turns).
# int4/fp8 pins run slower than Opus, so the canonical default carries ~1.75x
# headroom over the slowest healthy observed wall (3060 * 1.75 ~= 5355 -> 5400).
DEFAULT_RUN_TIMEOUT_S = 5400

# Canonical gate-oracle wall-clock timeout (harness guard, NOT a scoring signal).
# The gate is graded work, not model work: a healthy grade is fast. Measured
# 2026-08-12 on the backgammon task: 45s and 113s for two clean attempts, and
# 1918s for one starved by an orphaned gate tree competing for CPU. 3600s is
# ~1.9x the worst OBSERVED (already-pathological) wall and ~32x the healthy
# baseline, so it can only fire on a genuine hang, never on a slow-but-working
# grade. A gate that exceeds it fails its attempt WITH evidence (the streamed
# log is already on disk) instead of hanging the campaign indefinitely, which is
# what happened before this existed.
#
# NOT the same threshold as the board's stall ALARM: the alarm is a visual
# signal that must fire early (minutes) so an operator can look; this is a
# destructive kill that must fire late. Alarm << timeout, by construction.
DEFAULT_GATE_TIMEOUT_S = 3600

# Ceiling on the bounded wait for the WORKER'S OWN compaction at a chunk
# boundary. The harness only observes — it never fires a substitute — so a
# compaction that does not land within this window is no_compaction_evidence
# and the cell aborts (fail-closed); the bound exists so that abort happens
# in bounded time rather than hanging.
_COMPACT_SETTLE_TIMEOUT_S = 300.0
# How long to wait for it to START. The plugin fires on idle, so there is a gap
# between this drive returning and the generation appearing. Short: if nothing
# has begun in this window the plugin did not fire, and the parts check at the
# end of the wait decides the outcome.
_COMPACT_SETTLE_GRACE_S = 20.0


# ── A2 PHASE SENTINEL — THE ONLY COMPACTION TRIGGER ─────────────────────────
#
# The worker plugin fires its own compaction on `session.idle`. WHICH idles it
# may fire on is decided HERE, by the harness, and published as one file on a
# read-only bind mount that the plugin re-reads on every idle. The cell env is
# written once at `docker run` and cannot carry something that changes between
# phases, so a file is the transport.
#
# WHY THE HARNESS OWNS THIS (WO-MARKER-RIP, 2026-09-09). The arm used to ALSO
# require the model to have printed `CHUNK FINISHED` on the turn that just
# ended. That was a model-emitted string standing in for a harness-known fact,
# and it leaked: the instruction lives only in the six build prompts, but repair
# rounds run in the SAME session, so the convention survived every compaction
# and the model kept printing it while fixing gate failures — in run 1788462647
# that fired a compaction ~80s before the end of `feedback-2`. The marker is
# gone. The sentinel is now the WHOLE gate, which means it has to be exact.
#
# EXACTLY ONE BUILD-FLAGGED DRIVE PER CHUNK. The plugin fires at most once per
# flagged idle and is hard-capped at six fires per session, so the sentinel's
# job is to make sure the six idles it flags are the six CHUNK BOUNDARIES: the
# chunk drive itself is flagged build and its idle is the boundary.
#
# Recovery nudge re-drives are ALWAYS HELD (repair): a nudge is not a chunk
# boundary — the boundary idle already fired at the abort that triggered the
# nudge — so holding the re-drive is what keeps it from double-firing the
# plugin's six-fire budget.
#
# FAIL-CLOSED IN BOTH DIRECTIONS. Everything not named here is repair, and
# repair is the measurement — it never compacts. An unknown phase name resolves
# to repair, not build: a phase this function has never heard of is not one that
# has been shown to be a safe compaction point.
_COMPACT_PHASE_BUILD = "build"
_COMPACT_PHASE_REPAIR = "repair"
_COMPACT_PHASE_FILENAME = "phase"


# How many fixed complaints the pass verdict names before it summarises the
# rest. Naming them is what stops the model undoing its own working changes;
# the cap is only there so a mass pass cannot turn one message into a wall.
_PASS_VERDICT_MAX_LISTED = 10

# THE EXCUSE ELIMINATOR (2026-09-04). Measured on OFF-cell run 1788499216
# (qwen3.6-35b-a3b, memoryOFF): after 456 turns across five flat-failing
# attempts, the model's terminal deflection was that the still-failing frontend
# gates were a stale page on the grader's side — "the user needs to hard-refresh
# (Ctrl+Shift+R) to clear browser cache" — for a defect none of the 10 remaining
# failures had any relation to browser caching. Every failure verdict therefore
# opens with the harness-side freshness FACT, in the player's voice, so the
# stale-page / hard-refresh / saved-session excuse class is pre-empted before
# the model can reach for it. It is present BYTE-IDENTICAL on the first report
# and on every repeat: it is a constant of how grading happens, not a sighting,
# so it carries no gradient by design. It is absent from the pass verdict,
# which lists no problems to excuse.
_EXCUSE_ELIMINATOR = (
    "One thing before the list: I check in a clean browser every time. I load "
    "your latest code with the cache cleared and no saved session carried over "
    "(the equivalent of a hard refresh), and I always start from a brand-new "
    "game. So none of what follows is a stale page or leftover files on my end "
    "— if it's still there, it's in the code you changed."
)

# ── THE SECOND DEFLECTION, CLOSED BEFORE IT IS USED ─────────────────────────
#
# Introducing the software team (see `_build_feedback_prompt`) hands the model a
# new party to blame, and the excuses write themselves: they're calling it
# wrong, they're on an old build, that field is optional, their selector is
# wrong. `_EXCUSE_ELIMINATOR` above closes exactly one deflection — the stale
# page — because that is the one that was measured (run 1788499216, ten
# failures deflected onto "the user needs to hard-refresh").
#
# CONSTANT, LIKE THE FIRST. It is a fact about how the checking happens, not a
# sighting, so it carries no gradient and is identical on every pass.
#
# ⚠ WATCH THIS AFTER IT SHIPS. The excuse class is only knowable from
# transcripts. Read the first two repair rounds of the next few cells: if the
# model argues with the team instead of changing the code, this wording is the
# lever, not the routing.
_TEAM_EXCUSE_ELIMINATOR = (
    "They work from the written spec for this app, against the code exactly as "
    "it is right now, on a clean checkout — so if they can't find something, "
    "it isn't there to find."
)

# The team's opener. DELIBERATELY NOT "conformance checks" — that is the
# grader's word for the gate, a team integrating an app would never say it, and
# it tells the model it is being measured. Same class of tell as the `FAILING`
# label that was removed from the old bullet list.
_TEAM_HEADER = (
    "Also, my software team is trying to integrate your app into their own "
    "software and they hit some problems on their side:"
)


# WO-ERRDATA-C1: the max per-error-type total allowed per benchmark before
# fast-fail abort — the 21st instance of any one type aborts the run.
ERROR_CAP_PER_TYPE = 20


# Worker-facing AGENTS.md, written into every cell worktree at seed time. The
# only .md files that reach the isolated docker worker are this one (opencode
# auto-loads /work/AGENTS.md as project instructions) and CONTRACT.md (seeded
# from the scaffold, WO-FEEDBACK-CONTRACT 2026-08-10); the repo-level AGENTS.md
# never enters the container.
#
# THERE IS NO ANTI-CHEAT RULE IN THIS FILE, and there must never be one. This
# comment used to call the two scope lines below "the explicit anti-cheat rule
# (WO-ANTICHEAT-1)", which was stale and actively misleading: the words were
# stripped long ago because `tests/test_blinding.py` FORBIDS "cheat", "grader",
# "oracle" and the rest from anything the model can read — a model that knows it
# is being measured is not the model this run is measuring. What survives reads
# as ordinary onboarding ("accept a denial and find another way", "stay in
# this folder") and earns its place as working guidance, not as a deterrent.
#
# Cheating is prevented STRUCTURALLY, never by instruction: the gates, the
# golden tree and the gate runner are not on the container's filesystem at all,
# the worktree is the only mount, and the container has no internet route
# (`egress.py`, four allowlisted upstreams). You cannot read what is not there.
# Do not add a "do not cheat" line here to shore that up — it would weaken the
# measurement and fail the blinding test.
#
# The other rule this file carries is the chunked-write rule, which exists
# because the model writes code in very large single generations, and one
# oversized stream can be killed mid-flight by the transport — losing the whole
# write (2026-08-09).
_WORKER_AGENTS_MD = """\
# Notes

- Everything you need is in this folder; stay in it.
- If a tool call is denied, accept it and find another way.
- Keep each write or edit under ~150 lines; build big files in several passes.
- Start servers detached: `node -e "require('node:child_process').spawn('node',['src/server.ts'],{stdio:'ignore',detached:true}).unref()"`. Stop them with `kill <pid>`.
- Playwright and Chromium are installed globally: use `require('playwright')` and the bare `playwright` command. There is no network, so never install packages.
- Give every test and server run a timeout.
"""
