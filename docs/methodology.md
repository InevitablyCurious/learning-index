# Methodology

> **Status: proof of concept.** The no-memory baseline runs today, and memory-on runs are built,
> with Honcho as the first memory system ([memory systems](memory-systems.md)). Changing the task
> between runs is designed here but not built yet — see [Not built yet](#not-built-yet).

## Why this exists

People change what they want. A requirement is rewritten, a team adopts a new way of working, a
library ships a new version. For an agent with memory, every change turns part of what it
remembers into advice that is now wrong — and memory delivers wrong advice with the same
confidence as right advice. A fix that worked last month is replayed against code it no longer
fits. An old preference overrides a new instruction. A note that "this doesn't work here" keeps the
agent away from what now works best.

Memory products say they handle this. Honcho describes itself as memory for agents that understand
"changing people, agents, groups, projects, and ideas over time". Zep is built as a temporal
knowledge graph. Mem0 updates or deletes memories that conflict with new information. None of
these claims can be checked where it matters: in an agent's working sessions, with memory the
system learned itself, at the moment the job changes underneath it.

Memory benchmarks do not measure this. Most ask questions about long conversations. The few that
test stale memory do it with question-and-answer or decision tests, or with stale memories written
by hand — never with memory a system built from real work, and never by running the work that
follows.

Learning-Index is built to measure it. The challenge is configurable, so the task can be changed
on purpose between runs. The memory system plugs in unchanged. And the grader runs what the agent
builds, so a memory that pulls the agent back to the old way shows up as failing checks and wasted
turns, not as a wrong answer to a quiz.

## The questions

For one model, in one harness, on one challenge:

1. **Does a memory system make the agent's work better?**
2. **As memory keeps growing, is there a point where it stops helping and starts to hurt?** The
   answer is the memory system's **index**: the point where its gains turn into losses.
3. **When the job changes — a preference, a way of working, a dependency — does the memory system
   adapt, or does it keep steering the agent the old way?** How hard does the change hit, and how
   quickly does the agent recover?

Questions 1 and 2 come first, because question 3 is measured against their answers: a memory that
never helped has nothing to lose when the job changes. The proof of concept answers questions 1
and 2. Question 3 is why the benchmark exists, and its pieces are being built alongside.

Running the same protocol for different memory systems, with everything else held fixed, puts them
on one scale.

## What is held fixed

Everything except the memory system — and, for question 3, the one change made on purpose.

| Fixed | Current setup |
|---|---|
| Model | Qwen3.6-35B-A3B-MTPLX-Optimized-Speed, served locally on a Mac Studio (M3 Ultra, 256 GB) |
| Harness | opencode, at the version pinned in the worker image |
| Challenge | Build a playable backgammon game in five build chunks, graded by more than 150 checks in seven stages |
| Grader | Deterministic: it runs the built game. No language model judges anything |
| Run rules | How a run is driven (below): one session, a compaction after each chunk, no round or time cap |

Every run records a fingerprint of fourteen inputs. The first eight are the build prompts, the
grader, the model, the challenge, whether the harness compacts at each chunk boundary, the starter
files, the reference solution and the worker image.

The other six are the harness code itself; the source commit the run stood on and whether that tree
was dirty; what was baked into the worker image from that tree; the opencode version; and the grader
image. They are recorded only when they were observed — an input nobody could read is absent, never
filled with a placeholder, so a later change to it reads as "not recorded" rather than as a match.

Runs are compared only when their fingerprints match. Changing any input starts a new baseline.

## The run: the unit of measurement

One click on Run is one run, and one run is one opencode session.

Runs of one model are serial: a click for a model that already has a run in flight is refused, not
queued. Different models may run at the same time, because nothing in one model's run determines
another's.

The model builds the game in five chunks in that session, and the harness compacts the context after
each chunk so the next one starts with room. It then troubleshoots in the same session: the grader
runs the game after every round, and the model is told what is still broken — the earliest stage
that fails, written the way a player would complain.

A chunk is over when the session goes idle and the drive exits zero. That is the transport's
verdict, not the model's. No marker string ends a chunk: a model could print one having written
nothing, and withhold one having written everything.

Troubleshooting has no round cap and no time cap. The rounds continue until every check passes, and
opencode's own compaction stays on at its vanilla default, so a long troubleshooting history is
summarised as it fills rather than dropped.

One limit does end a run: two compactions completing before one grade. That is a run compacting
instead of fixing, and it ends under that name, in troubleshooting only.

A run can also end without passing. Out of context is a real ending: the session grew past what the
model could compact at all. It is recorded as that ending, and never repaired by starting a second
session on a saved copy of the code. A dead worker, a harness fault and an operator stop are endings
too, each recorded by name.

Dev mode pauses after every grade, and once at the end; normal mode never pauses. A pause boots the
artifact inside the grader image so the operator can play it and read the lines the model is about to
be told, then waits — polling for a `RELEASE_HOLD` file in the run's directory. Paused time is
excluded from the run's wall time and recorded beside it.

Stopping a run keeps its tree. The launch record is ended as "stopped by operator", `cost.json` is
still written, and the run stays on disk. What disappears is the preview, because the play container
is removed and the build loop feeding it stops with the run; a build a person started by hand is
left alone.

Play containers are named for the run they belong to, so two runs can never share one.
Starting a build reaps every other, and a finished run's are cleaned up.

## Two arms

| Arm | Memory recall | Memory accrual | Role |
|---|---|---|---|
| **off** | off | off | The baseline: what the model does alone |
| **on** | on | on | Real use: memory is read and written as runs go |

**Off.** The arm is picked on the click, and an off run has no memory at all: it neither reads nor
writes one.

Every off run that finishes and is not void is one more baseline for its fingerprint. There is no
picked floor and no selection: the numbers an on run is measured against are the average over every
baseline sharing its fingerprint, so baselines are never rationed, and adding one is the only thing
that moves the comparison.

**On.** A run with the memory system switched on. It reads what the memory system has kept, and the
memory system learns from it. The first run of a series starts from empty memory; each later one
reads what the earlier ones wrote ([memory systems](memory-systems.md)).

Two other arrangements may be added later as cross-checks, for memory systems that support them:
reading from a frozen copy of the memory without learning, which measures one memory state several
times; and learning without reading, which measures what writing memory costs on its own. Neither
is part of the core protocol.

## What "memory on" means — Honcho as the example

A memory system plugs into opencode through opencode's own plugin mechanism. The benchmark defines
no memory interface of its own.

[Honcho](https://github.com/plastic-labs/honcho) (Plastic Labs, AGPL-3.0) is the first system,
and it publishes an opencode plugin. It shows the three parts every memory system has:

- **Store.** The session's messages are stored in Honcho, a server with a Postgres database, run on
  the same machine.
- **Reason, in the background.** Outside the agent's session, Honcho calls a language model to draw
  conclusions from those messages, write summaries, and periodically consolidate what it holds
  (which it calls "dreaming").
- **Recall.** What Honcho knows is put back in front of the agent.

Two rules follow.

1. **The memory system uses the same model as the agent.** Each of Honcho's background jobs can be
   pointed at any OpenAI-compatible endpoint, so they run on the same local Qwen. (Search
   embeddings come from a local embedding model.) Only the memory system differs between the arms,
   never the model.
2. **Memory's own work is a cost.** Background model calls spend tokens and time that the agent's
   session never sees. They are counted separately and added to memory's cost. Honcho's own
   telemetry records the tokens of each of its model calls.

The memory system's configuration — which background jobs run, how often, and how much it may
inject — is part of what is measured. It is recorded and held fixed for a whole series.

## What is measured per run

Every run writes `cost.json`, and it writes it on every exit — a run that was stopped, crashed or
cut short still carries its cost, which is the run an operator most needs priced.

It records three phases — build, troubleshooting and the total — and each carries:

- Tokens by kind: input, output (reasoning included), cache read and cache write.
- Turns, compactions and grades.
- Wall time with paused time removed, and the peak context the model was sent.

A field the harness never observed is absent, never zero, so a partial phase reads as missing rather
than as a phase that cost nothing.

**Guardrail: passing or not.** A memory that makes runs cheaper but stops them passing has not
helped. A run that ends without every check passing is recorded with how far it got, and never
counts as a success.

Cost is measured in tokens. A local model is never billed, so `cost_usd` is absent, not zero; a
cloud run is billed and carries `cost_usd` beside the same tokens.

**Also recorded:**

- Problems after the build (the first grading).
- Problems fixed, and problems broken that had been working, in each round.
- The size of the run's first model request, in both arms. What an on run's carries beyond the off
  range is the memory delivered into the agent's context.
- On only: whether the plugin reached its memory server, and how those requests ended.
- On only: the memory system's background cost — its own model calls' tokens, and the time that
  background work took.

## Reading the results

1. **The baseline average.** Every off run sharing a fingerprint is averaged — turns, tokens, wall —
   and an on run is read against that average rather than against a single off run, whose luck would
   be built into every comparison.
2. **The spread.** The same off runs give the range that chance alone produces, because the model
   does not do the same thing twice. An on run inside that range is not evidence of anything.
3. **The comparison is per fingerprint.** Change one input and the average no longer belongs to the
   run: a new fingerprint starts a new baseline.
4. **The index.** The point where memory's gains turn into losses. It is read off the order in which
   the runs of a series accumulated memory, and reported only when two separate series, each started
   from empty memory, show the turn in the same place.
5. **The bridge.** The first run of a series starts with empty memory, so any gain it shows comes
   from memory written and read back inside that same run. It is reported as its own number.

## Memory under change (question 3)

A memory serving a working agent has to survive change. Five of the conditions it meets — among
many more:

- **Preference drift.** What the user wanted last month is wrong today. A memory that appends
  instead of superseding turns yesterday's instruction into today's contradiction.
- **Working-style drift.** How the user works — test-first or prototype-first, their commit and
  review habits — changes. Procedural memory learned from the old style keeps steering the agent
  the old way.
- **Dependency drift.** A fix holds for a version range. Coding knowledge has preconditions —
  library versions, environment, configuration — and a memory that stores the fix without its
  preconditions cannot tell when it has expired; applied to the next version, it is a regression
  delivered with confidence.
- **The false-fix dichotomy.** Memory learns from outcomes, and outcomes are binary: the error went
  away, or it did not. A change that suppresses a symptom and a change that removes its cause
  produce the same outcome, so a memory that records "this fixed it" cannot tell a mask from a
  repair — and replays the mask with the confidence of a verified solution. A passing test is
  evidence, not a diagnosis.
- **Negative-knowledge consensus deviation.** "X doesn't work here" is among the most valuable
  things a memory can hold, and the hardest to keep true. When a stored prohibition departs from
  what other sources, newer evidence or common practice now say — because it was wrong, was local,
  or was overtaken by an upstream change — the agent keeps avoiding what now works. And a
  prohibition is self-sealing: an agent that obeys it never produces the evidence that would
  overturn it.

The challenge is configurable, so the benchmark can make these changes happen on purpose and watch
what the memory system does.

- **The switch.** Run an on series on version A of a challenge until memory has built up, then
  switch to version B for the runs that follow. Each version has its own off baseline.
- **The hit.** How much worse the first runs after the switch are than version B's off runs:
  memory carrying the old way into the new task.
- **The recovery.** How many runs it takes to get back inside version B's normal range.
- **Old-way checks.** Each change comes with checks that recognise the old behaviour, so the grader
  shows directly when memory pulls the agent back to version A, rather than leaving it to be
  inferred from slower runs.

A change is only measurable if it follows these rules:

1. **One change at a time,** so the result can be traced to it.
2. **Gradable:** the grader can tell the old behaviour from the new.
3. **Stated or unstated, chosen per experiment.** Stating the change in the prompt tests whether
   memory overrides an instruction. Letting it show only through the grader's complaints tests
   whether memory adapts from feedback.
4. **Late enough:** the switch comes after memory has clearly built up, past its benefit on
   version A.

Patterns: a single switch (A→B), a reversal (A→B→A), and a slow drift through several small
changes.

| Kind of change | What changes | In the backgammon challenge |
|---|---|---|
| Preference drift | A requirement | A field name, the board's layout, a rule of the doubling cube |
| Working-style drift | How the work must be done | Tests required with every change |
| Dependency drift | The environment | The Node version, or a library the build relies on |
| False-fix dichotomy | What counts as fixed | A check that passes only when the cause is fixed, not when the symptom is masked |
| Negative-knowledge deviation | What works | Something that failed under version A works under version B |

## Rules that keep the numbers honest

- **No language model judges anything.** The grader runs the game; each check passes or fails.
- **Void, not failed.** A run spoiled by the instrument — a provider cut-off, a grading fault —
  is listed as void and left out. It is never scored as a failure.
- **Unverified memory is not memory on.** An on run whose memory delivery cannot be verified is
  listed as unmeasured and left out.
- **Three kinds of nothing.** "Not measured", "not connected" and "measured, and zero" are reported
  separately, never merged.
- **Delivered is not used.** Memory put in front of the agent is recorded as delivered. Only the
  difference between the arms counts as an effect.

## Limits

- **One model, one harness, one challenge.** Results describe this setup. They are not claims about
  memory, or models, in general.
- **The same task every time.** Until the task is changed on purpose (question 3), every run builds
  the same game, so memory from earlier runs holds fixes for the same problems. Questions 1 and 2
  therefore measure how well a memory system carries fixes forward and keeps them useful as they
  pile up. Learning that transfers to new tasks needs varied challenges.
- **The specification comes from a stronger model.** The reference game, and the checks built
  around it, started from a solution a frontier model wrote in close to one pass. Some requirements
  may be that solution's choices rather than rules of backgammon; the reference is reviewed by
  play to catch them.
- **Chance.** The model samples, and its serving varies with load, so no run can be reproduced
  exactly. The baseline average and the off range are the guard against reading chance as an
  effect.
- **Shared hardware.** The agent and the memory system's background jobs share one machine, so
  memory's work can slow the agent down. That is part of memory's real cost on local hardware, but
  it makes wall time noisier than turns or tokens.

## Not built yet

- Memory under change: challenge versions, a schedule saying which version each run builds, and
  old-way checks.

