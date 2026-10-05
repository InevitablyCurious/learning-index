# Methodology

> **Status: proof of concept.** The no-memory baseline runs today. Memory-on runs, scoring a whole
> chain, counting a memory system's background cost, and changing the task between runs are
> designed here but not built yet — see [Not built yet](#not-built-yet).

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
| Challenge | Build a playable backgammon game in five build steps, graded by more than 150 checks in seven stages |
| Grader | Deterministic: it runs the built game. No language model judges anything |
| Chain rules | How a chain is run (below), including where context is compacted and where it is cleared |

Every run records a fingerprint of eight inputs: build prompts, grader, model, challenge,
compaction, starting files, reference solution and worker image. Runs are compared only when their
fingerprints match; changing any input starts a new baseline.

## The chain: the unit of measurement

The model cannot build and fix the whole game inside one context window, so the work runs as a
**chain** of sessions:

1. **First cell.** A fresh build in five steps, with the context compacted at each step boundary.
   Then four troubleshooting rounds in the same context. After each round the grader runs the game,
   and the agent hears what is still broken: the earliest stage that fails, written the way a
   player would complain.
2. **Later cells.** The code is saved and the context is cleared. The next cell starts from the
   saved code with a fresh context and gets four more troubleshooting rounds.
3. **The end.** The chain ends when the game passes every check (**finished**) or when the operator
   stops it (**stopped**).

Every chain starts with a fresh build, and one chain is one data point.

The chain rules are part of the fixed setup, not a detail. Compacting and clearing at fixed points
is what stopped problems oscillating — fixed, broken, fixed again — when a single context carried
the whole troubleshooting history.

## Two arms

| Arm | Memory recall | Memory accrual | Role |
|---|---|---|---|
| **OFF** | off | off | The baseline: what the model and the chain do alone |
| **ON** | on | on | Real use: memory is read and written as the chains run |

**OFF.** Five chains with no memory. Their spread shows how much chains vary by chance alone:
the model does not do the same thing twice, so two chains under identical conditions can differ a
lot.

**ON.** A **series** of chains with the memory system switched on, starting from empty memory.
Each chain reads what the memory system has kept so far, and the memory system learns from it.
Chain 1 starts empty, chain 2 has memory from chain 1, and so on until the operator stops the
series.

Two other arrangements may be added later as cross-checks, for memory systems that support them:
reading from a frozen copy of the memory without learning, which measures one memory state several
times; and learning without reading, which measures what writing memory costs on its own. Neither
is part of the core protocol.

## What "memory on" means — Honcho as the example

A memory system plugs into opencode through opencode's own plugin mechanism. The benchmark defines
no memory interface of its own.

[Honcho](https://github.com/plastic-labs/honcho) (Plastic Labs, AGPL-3.0) is the first system
planned, and it publishes an opencode plugin. It shows the three parts every memory system has:

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

## What is measured per chain

**Primary: the effort to finish.**

- Turns (model calls).
- Tokens, by type: input, output (reasoning included), cache read and cache write.
- Wall time.

**Guardrail: finished or stopped.** A memory that makes chains cheaper but stops them finishing has
not helped. A stopped chain is recorded with how far it got, and never counts as a success.

**Also recorded:**

- Problems after the build (the first grading).
- Cells and rounds used.
- Problems fixed, and problems broken that had been working, in each round.
- ON only: the memory delivered into the agent's context — how many items, how many tokens.
- ON only: the memory system's background cost — its own model calls' tokens and time.

## Reading the results

1. **The normal range.** The OFF chains give the range that chance alone produces. An ON chain
   counts as better or worse only when it falls outside that range.
2. **Compare with OFF, not with the first ON chain.** The first ON chain is a single run, and its
   luck would be built into every comparison.
3. **Trends, not single chains.** Results are read in groups of consecutive chains — 1–3, 4–6,
   7–9 — so one lucky or unlucky chain cannot move the answer.
4. **The index.** The group where the trend turns from improving to getting worse. It is reported
   only when two separate series, each started from empty memory, show the turn in the same place.
5. **The bridge.** The first chain of a series starts with empty memory, so any gain it shows comes
   from memory written earlier in the same chain and carried across its own context resets. It is
   reported as its own number.

## Memory under change (question 3)

The challenge is configurable, so the benchmark can change the job on purpose and watch what the
memory system does.

- **The switch.** Run an ON series on version A of a challenge until memory has built up, then
  switch to version B for the chains that follow. Each version has its own OFF baseline.
- **The hit.** How much worse the first chains after the switch are than version B's OFF chains:
  memory carrying the old way into the new task.
- **The recovery.** How many chains it takes to get back inside version B's normal range.
- **Old-way checks.** Each change comes with checks that recognise the old behaviour, so the grader
  shows directly when memory pulls the agent back to version A, rather than leaving it to be
  inferred from slower chains.

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
| Preference | A requirement | A field name, the board's layout, a rule of the doubling cube |
| Working style | How the work must be done | Tests required with every change |
| Dependency | The environment | The Node version, or a library the build relies on |
| False fix | What counts as fixed | A check that passes only when the cause is fixed, not when the symptom is masked |
| Negative knowledge | What works | Something that failed under version A works under version B |

## Rules that keep the numbers honest

- **No language model judges anything.** The grader runs the game; each check passes or fails.
- **Void, not failed.** A chain spoiled by the instrument — a provider cut-off, a grading fault —
  is listed as void and left out. It is never scored as a failure.
- **Unverified memory is not memory on.** An ON chain whose memory delivery cannot be verified is
  listed as unmeasured and left out.
- **Three kinds of nothing.** "Not measured", "not connected" and "measured, and zero" are reported
  separately, never merged.
- **Delivered is not used.** Memory put in front of the agent is recorded as delivered. Only the
  difference between the arms counts as an effect.

## Limits

- **One model, one harness, one challenge.** Results describe this setup. They are not claims about
  memory, or models, in general.
- **The same task every time.** Until the task is changed on purpose (question 3), every chain
  builds the same game, so memory from earlier chains holds fixes for the same problems. Questions
  1 and 2 therefore measure how well a memory system carries fixes forward and keeps them useful
  as they pile up. Learning that transfers to new tasks needs varied challenges.
- **The specification comes from a stronger model.** The reference game, and the checks built
  around it, started from a solution a frontier model wrote in close to one pass. Some requirements
  may be that solution's choices rather than rules of backgammon; the reference is reviewed by
  play to catch them.
- **Chance.** The model samples, and its serving varies with load, so no run can be reproduced
  exactly. The OFF range is the guard against reading chance as an effect.
- **Shared hardware.** The agent and the memory system's background jobs share one machine, so
  memory's work can slow the agent down. That is part of memory's real cost on local hardware, but
  it makes wall time noisier than turns or tokens.

## Not built yet

- Scoring a whole chain. Today each cell is scored on its own, and continued cells are marked as
  not a measurement.
- Counting the memory system's background cost.
- Memory-on runs with a third-party memory system. The memory-on path still requires a setting
  (`--org`) left over from an earlier integration; it is being removed.
- Memory under change: challenge versions, a schedule saying which version each chain runs, and
  old-way checks.
