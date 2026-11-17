# Learning-Index

**A test bench for the systems around a model.** Hold the model and the task still, swap in one
layer — a harness, a memory system, an orchestration loop — and measure what it changes.

> **Status, 12 November 2026: proof of concept.** The bench runs a model with nothing swapped in,
> and its grader is being made trustworthy round by round. Nothing has yet been measured with a
> layer swapped in. See the [roadmap](#roadmap).

## What it is designed to do

Most agent benchmarks rank models, or model-and-agent pairs. Learning-Index is built for the other
question: with the model held still, what is a given harness, memory system or orchestration loop
worth? It answers that the way a test bench does — every condition pinned but one, the same
measurement every time, and the result read against the same model's own baseline.

- **The model is pinned, and is its own control.** A series runs one model throughout. Its
  context window, speed and raw ability cancel out of its own result: deltas compare across
  models, scores never do.
- **The task is pinned.** One challenge — a complete backgammon game — built from the same written
  spec every run, from starting files frozen by hash.
- **The problem set is deterministic.** The grader runs what the agent built — its engine, its API,
  and a real browser playing it like a person — with the dice fixed for every check. A reference
  solution passes every check. No language model judges anything.
- **The model hears people, never tests.** After each grade the agent is told what went wrong by the
  two people who would really report it: a **player**, for what anyone sees on the page, and the
  player's **software team**, for what the code answers and what exact measurements show. Never a
  test name, an expected value or a line of grader code. Every line it hears must be true of the
  build it describes; a false line is the bench's fault, and is fixed before any result counts.
  [How the agent is told what's wrong](#how-the-agent-is-told-whats-wrong).
- **Every run is fingerprinted,** and compared only with runs whose fingerprint matches.
- **One layer varies.** Each run with a layer swapped in is measured against the average of the
  matching baseline runs — whether the app works, how far it got, and what it cost in tokens
  (cache included), turns and time. Everything else stays pinned.

What it is designed to answer, with the same model on the same task:

- **Harnesses.** Does a different agent harness get more of the app built, and what does it spend
  getting there?
- **Memory systems.** Does memory learned from the agent's own work make the next build better —
  and as it grows, where does it stop helping and start to hurt (its **index**)? When the job
  changes, does it adapt, or keep steering the agent the old way?
- **Orchestration loops.** Does a different loop around the model — how the work is split up, when
  the context is compacted, how problems are reported back — change what gets finished, and what
  it costs?

How a run is measured: [methodology](docs/methodology.md). What existing benchmarks measure, and
the closest project: [related work](docs/related-work.md). How it was built, and the choices behind
it: [notes from the operator](docs/operator-notes.md).

## How the agent is told what's wrong

The agent never sees a test. After each grade it hears what went wrong the way a real project hears
it — from the people using the software. Two people speak, and each says only what they could truly
know.

| | The player | The software team |
|---|---|---|
| **Who** | A person playing the game on an ordinary laptop screen | The player's own developers, integrating the app into their software |
| **What they report** | What anyone sees and does on the page: what is drawn, a click that does nothing, a game that freezes, a message that never appears | What a player can't see, or can't state exactly: what the engine and the server answer, the names and routes their software relies on, and precise measurements of the page — sizes, colours, timings — quoted with the value the grader read |
| **In their words** | *"I clicked my checker on the bar and no hints appeared showing where it could come back in."* | *"Their measurements of the page: the off tray is 112 px wide; a point is 71 px. The brief has the off tray at least as wide as a piece and no wider than one and a half points."* |

**Who speaks is decided by where the check looks — never by hand.** A check that plays the page in
a browser speaks as the player. A check that calls the engine or the server speaks as the team. A
measurement of the page judged against a close limit — a tray a few pixels too wide, a bar a shade
too faint, a pause 200 ms short — is the team's as well: no sentence in a player's mouth stays true
at every value such a check can fire on, while the team quotes the number the grader actually
measured. The player carries what a person would notice; the team carries the exact, technical
detail a person couldn't supply. Between them, the agent hears every finding a real user or a real
team would raise, and every line is held to being true.

**In the order a real user would raise it.** The checks fall into stages, from the first look at
the page to the end of a game. Each round only the earliest failing stage is told — every problem
in it — and a problem that can't be reached until an earlier step works waits behind that step.
When a whole part is badly wrong, the player first describes the whole picture they expect; while it
stays wrong, each remaining finding gets its own line. Each fault has its own words, with a first
version and an "Again…" for one still open. A message says what got fixed since last time, what
broke that used to work — first, when it broke something an earlier phase had finished — and what
is still wrong.

**Only what is true.** Every line must be true of the build it is told about, at every value its
check can fire on. A check that never reached its subject is not told. A check that ran out of time
is scored as not passing and told to no one. Where a build misses a house preference — a number or
a wording no one could guess — the spec's own passage is handed back word for word.

**Why it is built this way.** Coding benchmarks usually either show the agent its failing tests
([SWE-bench](https://www.swebench.com), [Web-Bench](https://arxiv.org/abs/2505.07473)'s retry with
the error) or ask a language model to play the user ([MINT](https://arxiv.org/abs/2309.10691),
[ColBench](https://arxiv.org/abs/2503.15478), [τ-bench](https://arxiv.org/abs/2406.12045)). Failing
tests teach to the test; a simulated user sounds human but answers differently from run to run.
Learning-Index grades with a program, not a language model, and turns what it finds into the words
of the two people who would really report it. The agent has to work out the cause, as it would with
a real user and a real team, and every run draws on the same written lines. For a bench that
measures what a memory system, a harness or a loop is worth, both halves matter: the feedback is the
same channel for every run being compared, and it is the kind of feedback real use produces.

## Roadmap

**The instrument**
- [x] Sealed agent cells, a deterministic grader, a control plane and a live board
- [x] A fingerprint and a cost record for every run
- [x] A development mode that pauses after every grade, so an operator can play the build and check
  what the model is about to be told
- [ ] The baseline: every line the model hears true, then the grader frozen — *in progress*

**Swapping a layer in**
- [x] The way in for memory systems — opencode's plugin mechanism — and a first kit,
  [Honcho](https://github.com/plastic-labs/honcho)
- [ ] A replaceable harness: opencode as one harness among several; the first replacement is Hermes
  Agent (Nous Research), with its own memory switched off for a clean baseline
- [ ] Memory-system series: does memory help, and where does its index fall
- [ ] Orchestration loops swapped in
- [ ] Memory under change: the job changed on purpose, to see whether memory adapts — *designed*

**Sharing results**
- [ ] Fingerprints for the swapped layer itself — the memory system and its memory state, the
  harness, the loop — with a memory series chained run to run, so anyone can check it ran in order
  from the memory it claims
- [ ] A way to submit results to a shared record, with minimum run counts

**Challenges**
- [x] An open challenge format, with a template to start from
- [x] Backgammon, the reference challenge
- [ ] More challenges

## How to measure

A measurement is a comparison: the same model on the same challenge, run with nothing swapped in
(the baseline, OFF on the board) and with one layer swapped in (the test, ON). Every number is read
against that model's own baseline.

### Recording a baseline

A baseline run is one complete build of the challenge with nothing swapped in. Every valid baseline
that shares a fingerprint is averaged — turns, tokens (cache included) and wall time — and the
spread of those runs is the range chance alone produces. More runs make a stronger baseline; there
is no cap. The bench runs one model's runs one at a time, local or cloud; different models may run
side by side.

**Local models** — served on your own machine:
- Keep the serving fixed between runs: the weights, the quantisation, the context length, the
  sampling settings and the serving software. The fingerprint records the model's name, not these;
  change one and you need a new baseline, which only you can know.
- Don't run another model on the same machine while measuring: two models sharing one machine slow
  each other down.
- Compare wall time only between runs on the same machine. Turns and tokens can be pooled across
  machines.
- A local run has no price; its cost is reported in tokens.

**Cloud models** — a hosted endpoint:
- Wall time follows the provider's load, so it is noisy; read turns and tokens first.
- A provider can update a model behind the same name. Run the baseline and the test close together
  in time, and record the dates with your results.
- Rate limits can stall a run; a run cut off by the provider is void, not failed.
- A cloud run records its price beside its tokens; cache pricing differs between providers.

### Recording a delta

A delta is the test, read against the baseline average and its spread. A test inside the
baseline's spread is not evidence of anything. How the test runs relate to one another depends on
what is swapped in:

- **Memory systems** — open to experiment. We recommend accrual: a series starts from empty memory
  and each run reads what the earlier runs wrote, so each run's delta is credited to the memory as
  it stood when that run began. The index is the point where those deltas turn from gains to
  losses; report it only when two separate series, each started from empty memory, show the turn
  in the same place. The first run of a series starts empty, so any gain it shows came from memory
  written and read back within that run; report it on its own.
- **Harnesses** — a harness with no memory of its own gives independent runs: average them and
  compare with the baseline average. If it keeps memory, choose one and say which: carry a snapshot
  of that memory from run to run, or wipe it so every run starts fresh.
- **Orchestration loops** — tested with or without a memory system. Without one, the delta is
  simply loop on against loop off: the average of the test runs against the baseline average. With
  one, it is read like a memory series.

### What makes a run valid

A run counts towards a measurement only if:

- It ran in normal mode, start to finish. Development-mode runs and runs resumed from a checkpoint
  build the instrument; they do not measure.
- It finished and is not void. A run spoiled by the instrument — a provider cut-off, a grading
  fault — is void and left out, never scored as a failure. A run that ends without every check
  passing still counts, with how far it got.
- Its fingerprint matches the runs it is compared with.
- With a memory system, its delivery to the agent was verified; an unverified run is left out.

Report each run's fingerprint, its cost record and its final grade — all three are in the run's
folder. More runs make a stronger measurement; the board shows a difference only once each side has
three scored runs.

## Designing a challenge

A challenge is the task every run builds. It lives in its own repository, selected with
`BENCH_TASK_DIR`, and brings four things:

- **Build prompts** — the only specification the model sees, in plain prose, written as what a user
  expects. They name what a check has to find (files, routes, page elements) and leave the how to
  the model.
- **Starting files** — frozen by hash, so a run refuses to start if they drift.
- **A reference solution** — kept out of the model's reach. It passes every check, which proves the
  challenge can be built.
- **A grader** — two scripts: `roster.mjs --out` lists every check without running any, and
  `report.mjs --target --out` grades a built candidate — plus a line for each finding, in the voice
  of whoever would notice it: the player, or the software team
  ([how the agent is told](#how-the-agent-is-told-whats-wrong)).

Start from [challenges/TEMPLATE](challenges/TEMPLATE/).

**What makes a challenge measure well:**

- Every check is decided by running the built software. Nothing is judged by a language model.
- Anything random can be fixed from outside — backgammon's dice are set through a debug route — so
  every check sees the same situation every time.
- The checks fall into stages in the order a user meets them, and the model hears only the earliest
  failing stage, as complaints — never the checks themselves.
- Every complaint is true of every build it can be told about. One that isn't is a bug in the
  challenge, not the model's failure.
- It is too big for any model to build in one pass. The rounds of fixing are where a harness, a
  memory system or a loop shows what it is worth.

### The reference: backgammon

A complete, playable backgammon game — a person against the computer — in Node and TypeScript with
no dependencies, built in seven phases: the rules engine; the computer opponent; the server and its
API; the page in three layers — the board and its controls, then the pieces, then the gameplay; and
wiring it all together. More than 200 checks in three groups — the contract's shape, the engine and
API, and a real browser playing like a person — fall into 19 stages, from the first look at the
board to the end of a game.

What it asks of a model, as a programmer would see it:

| Capability | What backgammon demands |
|---|---|
| Modelling a rule-dense domain | A typed game state — 24 points, the bar, borne-off pieces, the doubling cube, whose turn and which phase — and rules that interact: entering from the bar first, using both dice when possible, the bigger number when only one can be used, exact and overshoot bearing off. |
| Algorithms | Generating every legal move and every whole turn, deduplicated by resulting position; detecting a race, a stuck turn, the end of a game and how it was won. |
| Search and evaluation | A computer opponent at three strengths that chooses among whole turns by evaluating positions, and a doubling-cube policy that follows published thresholds. |
| API design | An HTTP server with a fixed JSON contract, explicit state transitions (opening roll, turns, doubles, game over), a debug route to set positions and dice, and state that survives a page reload. |
| Front end | A page in plain HTML, CSS and JavaScript that draws the board geometrically at any window size, stacks pieces, turns clicks into moves, shows hints, and paces the computer's turn so a person can follow it. |
| Keeping two sides in step | The page and the server agreeing at every step: undo, a reload mid-turn, the computer's turn driven from the page, Fast Forward with pause. |
| Checking its own work | Neither the model nor the grader sees the screen: the model has to check what it drew by driving a real browser and measuring it. |
| Working over a long horizon | Fixing a stream of user complaints without breaking what already works; a fix that breaks something else is reported back as a regression. |

### How backgammon was designed

- **A game anyone can judge.** A person can play backgammon and see at once whether it works, yet
  its rules are dense enough to be hard to get completely right, its computer opponent needs real
  search, and its board has to be drawn and clicked. Every part can be checked by running it, and
  the only randomness — the dice — can be fixed from outside.
- **A reference first.** The reference game began as a solution a frontier model wrote in close to
  one pass, corrected since by playing it. The checks were built around it, so its passing every
  check is the proof the challenge can be built. The model never sees it.
- **The spec says what, not how.** Seven build prompts, given to the model one phase at a time, each
  with the spec up to that phase and nothing beyond it: the rules engine, the computer opponent, the server, the page in three
  layers, and wiring it together. They pin only what a check has to find — file and function names,
  the shape of the game state, the routes, the page's element tags, a debug route for setting
  positions and dice — and the few house preferences no player could guess, such as the doubling
  thresholds and the exact wording of messages. They do not teach backgammon, how to build an
  opponent or how to make move generation fast: a capable developer supplies those, and that is
  what is being measured. Where the spec describes behaviour, it says what a player expects to see.
- **The page in layers.** The page is built and checked in three layers — the board and its buttons
  with no pieces, then the pieces in their starting position, then the gameplay — so the first look
  at the board is right before any play is judged.
- **Preferences are handed back, not guessed.** When a check of a house preference fails, the
  passage of the spec it comes from is handed to the model again, word for word.
- **Shapes, not pixels.** Layout is stated in proportions — the whole board is 1.4 times as wide as
  it is tall, sized to the window — so every build is judged the same at any screen size.
- **Pace, not animation.** How things move is the model's choice. What is required is that a person
  can follow it: dice readable for about a second, the computer's moves about half a second apart,
  and a still second after every roll before anything else happens.
- **A scripted opening.** The dice are queued so the opening roll ties three times and then the
  computer wins, so one game exercises the tie, the computer's first turn and its pacing.

### How the grader works

- **It runs the build.** Every round, a sealed grader starts the model's latest code from scratch
  and runs 240 checks in three phases. The contract phase checks the names the spec promises —
  24 page element tags and the 20 keys of the game state, one check each; the files and exports
  the spec names are not yet checked as entries of their own. The engine is called directly for the
  rules and again through the server for the game's flow. The page is played in a real browser at
  1280×800 and 1440×900, clicking and reading the screen as a player would.
- **What may be set, and what never is.** The world is injected: positions and dice are set through
  the debug route. The action is the build's own wherever it matters — its roll, its turn hand-over,
  its computer's move — so a check does not test a state the game itself could never reach. The
  guarantee is about inputs, not the clock: several checks measure timing, and one geometry check
  waits 700 ms for the board to settle because the reference moves its pieces in 340 ms, so a build
  that animates more slowly can fail for being slow.
- **The page is judged by what it shows.** What it draws, where, and what a click does, read through
  the element tags the spec names — so any way of building the page is judged the same.
- **Stages, in the order a player meets them.** The checks fall into 19 stages, from the first look
  at the board to the end of a game. Each round, only the earliest failing stage is told — and every
  failure in it, not one. A check that cannot be reached until an earlier step works waits behind
  that step. Those are two separate silences, one by order and one by reachability, and together
  they keep the model from hearing about something a player could not get to.
- **Each way of failing has its own words.** A first version, and an "Again…" for a complaint still
  open. When a whole part is wrong — the board, the pieces, Fast Forward — one general line replaces
  its list of symptoms. Which parts get one is decided by a declared set of core findings per part,
  not by a count: on the saved builds, "any core finding" matched the operator's judgement 43 times
  in 44, against 37 at best for any count. A check with no written line stops the run; it is never
  told in silence.
- **What no player sees, the software team tells.** An engine answer, a server reply or an exact
  measurement of the page is reported by the team, with the value the grader read — never as
  something a player noticed. Each check records whether it looks at the page or at the code, and a
  test holds that record to where the check actually runs. The few things no one would raise — the
  exact words of an internal answer — still count against the build, but are never told.
- **A person checks every line.** In development the run pauses after every grade, and an operator
  plays the build and checks each line before the model hears it. The reference is not yet started
  beside the build at a pause; the operator compares it by hand.
- **The grader is tested, unevenly.** A change must still pass the reference on every check. It is
  run against 276 deliberately broken builds, though nothing yet asserts that each break flips
  exactly one check, and not every check has a break that proves it. And it is re-run on 72 saved
  first-look builds whose right lines were written down, compared by eye rather than automatically.
- **The wording guards are uneven too.** A guard against lines that state the rule exists, but today
  every line it matches is one a person approved word for word, so it blocks nothing.
- **Each run records its grader.** A run's fingerprint carries the grader's tree hash and its image
  identity. The image's name is reused on every rebuild, so a report read without its run's
  fingerprint does not say which grader produced it.

### How the agent is spoken to

Backgammon uses the two voices described in
[how the agent is told what's wrong](#how-the-agent-is-told-whats-wrong):

- **The player** plays white and says what happened, in plain words — "When I rolled a double, there
  were more than two dice on the screen." — never a test name, an expected value, a file or a line
  of code.
- **The software team** reports what the engine and the server answer — "They ask your engine where
  white's piece on the bar comes back in, and it names the wrong point — white comes in on the point
  in black's home that matches the number used, so a 2 enters on 23." — and what exact measurements
  of the page show, sizes and timings quoted as the grader measured them: "Their timing of the page:
  the computer's dice came up 63 ms after End Turn. The brief has a pause of about a second after End
  Turn before the computer's dice come up."
- **Each message reads like a real one:** what got fixed since last time, what broke that used to
  work, and what is still wrong. It opens by saying how the player checked — the latest code from
  scratch, a new game, an ordinary laptop screen, playing white — which answers the usual excuses
  (a stale page, an old server, a different screen) before they are made. It closes with the names
  and routes the team's software relies on, so that a fix never breaks them.
- **Why human prose.** The aim is that nothing inside the session marks it as a benchmark: as far as
  the agent can tell, it is coding for a person. A model handed failing test names can satisfy the
  tests without building what was asked; a model that hears a person describe what went wrong has
  to find the cause itself, as it would with a real user. That keeps the measurement about building
  software rather than passing tests, and it puts a harness, a memory system or a loop through the
  test real use would: turning an ordinary person's complaint into working code.
- **The wording rules.** Every line is true of every build it can be told about. It names one fault,
  and gives a count only when the count is exact. It reports what happened instead of stating the
  rule — "…and not four, as it should be" would hand over the fix. It never names an excuse the model
  could reach for. And no new line reaches a model until a person has approved it.
- **The big picture first.** When the board and its buttons are in the wrong places, the player says
  only that — the board on the left, the buttons on the right — and nothing about the details, which
  would change once the layout does.

### Lessons from running it

Each of these cost rounds before it was learned, and each applies to any challenge:

- **Name the spot.** Two lines that only imply the condition between them — "I could play them in
  either order" and "only one of them could be used" — read to a model as opposites, and it swung
  between two wrong fixes. Naming the position ("I rolled a 4 and a 3 and could play either one,
  but not both") ended the swing, and a line naming its spot from the start ("my pieces were on the
  6 and the 3 and I rolled a 5") was fixed in one round.
- **Name the moment.** "No Fast Forward button showed" was true only before the roll; the model
  tested after rolling, saw the button, and decided it was fixed. "At the start of my turn, before
  I'd rolled" fixed it in one round.
- **Reach the state the way the game does.** A check that sets up a position the game itself never
  produces — dice listed in an order its own roll never makes, a turn in a phase it never uses —
  tells the model about a problem it cannot reproduce, and the model searches for it for round after
  round.
- **What no player can see, no player says.** An engine answer the game itself never relies on,
  told as something a player saw, sends the model after a problem that is not there. A page that
  happened to enforce a rule its engine got wrong made "I was able to move another piece" false for
  anyone playing it; told by the team as what the engine answered, the same finding is true.
- **A number close to its limit belongs to the team.** "The off tray is far too wide" was told of a
  tray 5% over its limit, and "the bar blends in, I can't pick it out" of a bar plainly visible but
  pale. Quoted by the team with the value measured, each finding is true at any size it fires on.
- **A model going in circles is evidence against the line first.** Before deciding the model can't do
  something, read its own reasoning: every long loop so far traced back to a line that was vague,
  misleading or untrue.
- **The whole picture when it is badly wrong, the details when it is close.** One line describing a
  whole part fixed in one round what a single specific line had not fixed in three; on a nearly right
  part, the general line buried the one detail left.

### Other challenges worth building

Ideas, each chosen for what it would measure. Each still needs deterministic checks, a reference
solution and complaints in a user's words.

| Kind | Example | What it would test |
|---|---|---|
| Logic puzzles | A Sudoku or nonogram solver with a playable board | Search and pruning; correctness against a known unique solution |
| Front-end apps | A spreadsheet with formulas, a kanban board | Rendering, interaction, layout, recalculation |
| API services | A booking system, a ledger with transfers | Data integrity, validation, error handling, idempotency |
| Data analysis | Clean a messy dataset and produce a fixed report | Parsing, numerical correctness, reproducibility |
| Languages | A JSON parser, a regex engine, a small interpreter | Following a formal specification; edge cases |
| Systems | A key–value store that survives a crash | Persistence, recovery, concurrency |
| Other games | Chess, a card game | Rules plus an opponent, as in backgammon, in a new domain |

**To contribute one,** open an issue with the idea first: what a user would build, and what each
stage would check. A full challenge is the prompts, the starting files, a reference solution and a
grader with its complaints; any one of those is a useful start.

## Getting started

You need Docker, Python 3.11 or newer, Node, and a model: one served locally behind an
OpenAI-compatible endpoint, or a cloud provider. One-time installs, two image builds, then a
control plane and a board:

```bash
# 1. install the harness (once)
python -m venv .venv && . .venv/bin/activate && pip install -e '.[test]'

# 2. install the grader's test tools on the host (once); preflight refuses without them
(cd grader && npm ci)

# 3. build the worker and grader images (a run refuses without them)
#    set BENCH_PLUGIN_DIR=<abs path to plugin tree> first to install a plugin under test
.venv/bin/python scripts/rebuild_worker_image.py
.venv/bin/python scripts/rebuild_grader_image.py

# 4. preflight — prints GO with the exact launch command, or NO-GO naming the fix
.venv/bin/python scripts/bench_preflight.py --model <alias>

# 5. start the control plane (the only write-capable surface)
node control/server.mjs            # http://127.0.0.1:8718

# 6. start the read-only board (in another shell)
(cd dashboard && docker compose up -d)   # http://127.0.0.1:8717
```

**Record a baseline.** On the board, `[+ BASELINE]` picks local or cloud, the model and the
challenge, runs the preflight checklist and starts the run. Repeat it for as many baselines as you
want ([how to measure](#how-to-measure)).

**Swap a layer in.** Today the way in is a plugin for opencode, the harness every run uses: set
`BENCH_PLUGIN_DIR` to the plugin package, rebuild the worker image, and start a run with `[+ run]`
on a baseline row. The first kit is the memory system Honcho, in
[memory-systems/honcho](memory-systems/honcho/); its guide is
[docs/memory-systems.md](docs/memory-systems.md).

**Use your own challenge.** Point `BENCH_TASK_DIR` at its repository
([designing a challenge](#designing-a-challenge)).

**Read the results.** Each run writes a folder under `runs/` holding its fingerprint
(`fingerprint.json`), its cost record (`cost.json`), the grader's report for every round and its
live event record (`live.jsonl`).

**Watch it live.** The board at `http://127.0.0.1:8717` is read-only: every panel reads from the
control plane on `:8718`, the only process that reads run files or changes anything. It keeps "not
measured", "not connected" and "measured, and zero" apart, counts invalid runs as excluded rather
than as zero, and shows no difference between the arms below three scored runs per arm.

<details>
<summary>What each panel shows</summary>

| Panel | What it shows |
|---|---|
| **Runs strip** | One card per run, current and archived: status, problems before and after, peak context against the window, turns, loop and stall errors. Picks the cell the rest of the board shows. |
| **Gate wall** | Every check as a fixed square — passed, recovered, failed, not yet observed — with a card per check on hover. |
| **Baselines** | One row per model: every baseline on its fingerprint and the average the runs with a layer swapped in are measured against, with those runs nested beneath; a stats strip of scored, voided and unmeasured runs and error counts. |
| **Transfer curve** | Turns, tokens and wall time of the runs with a layer swapped in, against the baseline average, with stacked token bars; a line appears from two such runs. |
| **Learning** | A check-by-attempt matrix filling as the cell runs; the model's own account of its work beside the code-derived record of what it changed. |
| **Terminal mirror** | The running cell's terminal, live and read-only. |
| **Data feed** | The running cell's events — or a finished cell's frozen record — with filters, plus a backend feed beside it; a phase spine of one build and each grading round, with running token counters. |
| **Honesty rail** | Coverage, unresolved episodes, guard detections, recall overhead (p50/p95), turns burned, and memory serves labelled as delivery, not outcome. |
| **Recall** | Where a memory injection will be shown; today it shows its resting state. |
| **Hold / review** | When dev mode pauses a run, a link to play the built artifact and a release to continue. |
| **Challenges** | The challenges available to measure, ready or blocked with the reason. |
| **Startup feed** | The background processes behind a benchmark start, worst first, with reasons. |
| **Top bar and provenance strip** | Model, run state, stop, dev-mode mark, history link; policy, worker fingerprint, seed and source health. |
| **New baseline / new run** | The launch wizard: local or cloud, model, challenge, confirmation, preflight checklist. |
| **History page** (`/history`) | Every run with its checkpoints, the files each changed and side-by-side diffs; play any build; delete with confirmation. |
| **Settings drawer** | Refresh the worker, grader, control plane or board; custom tools; the machine share given to grading; dev mode; router credentials. |
| **Reset and restore** | Move all benchmark data into a backup and start clean, or bring a backup back — each with a preview and a confirmation. |

</details>


Full operations: [RUNBOOK.md](RUNBOOK.md).

## Repository layout

```
harness/     Python measuring instrument — sequencer, manifest, adapters, scoring, cell isolation,
             egress, fingerprints, image identity.
task/        The backgammon challenge — starting files, reference solution (never shown), prompts.
challenges/  Where your own challenge repositories go, and TEMPLATE/ to start one.
grader/      The check suite (conformance / backend / frontend) — the only component that sees the
             reference.
control/     Node control plane — the only process that reads run files or changes anything.
dashboard/   The read-only board.
images/      Worker and grader Dockerfiles; the egress and loop-kill sidecar.
scripts/     Entrypoints: run_cumulative.py, image rebuilds, preflight.
config/      bench.env and the benchmark's environment settings (see ENV-VARS.md).
docs/        Methodology, related work, memory systems, the operator's notes, and the system map.
memory-systems/
             One kit per memory system: its settings and its ready and cost commands.
data/        How each arm's memory-extraction state is stored.
runs/        Run output (not tracked).
tests/       The harness's own test suite — it tests the instrument, never the candidate.
```

Inside the code, `bench` / `BENCH_` is the benchmark's neutral name: image names, the environment
prefix and the harness package. No memory system is named in the public surface; one enters only
through `BENCH_PLUGIN_DIR`.

## Licence

MIT — see [LICENSE](LICENSE).
