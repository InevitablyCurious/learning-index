# The live event stream

**One append-only file per run. The benchmark's only live surface for a UI.**

```
runs/<tree>/<...campaign...>/memory<ARM>/cell-<seq>/live.jsonl
```

**One stream per CELL, beside that cell's own artifacts** — the harness opens it
in `ChallengeRunner.run_cell` via `LiveStream.for_run(run_dir)`, where
`run_dir` is the cell directory. This file said `runs/<run-id>/live.jsonl` until
2026-08-29, and both dashboard readers believed it: they joined the filename
onto the CAMPAIGN directory (the one holding `manifest.json`, one level above
the arm), opened a path that never exists, and reported *"no live.jsonl yet"* for
the entire life of every run — a reason indistinguishable from a run that never
wrote one. **Readers must resolve the path, never construct it**;
`control/board/sources/_runtime.mjs::liveStreamPath` is the one resolver, and
`scripts/bench_preflight.py::check_live_stream` blocks a launch when it stops
finding what the harness writes.

Every panel that wants to show something *while a run is happening* reads this
file and nothing else. It exists because the alternative — reading
`manifest.status.jsonl` and `predicate-outcomes.jsonl` — cannot work: the first
is appended once per **completed cell**, and the second is written after the
**whole campaign exits**. Both are post-mortem artifacts. Asking them to be live
is what made the learning panel read `unresolved` for entire runs and held the
gate wall to one update per cell.

## The contract is backend-neutral

This benchmark is meant to ship as something **any memory system can plug
into** — but today that is a *wire contract*, not an adapter interface. The
former `MemoryBackend` adapter abstraction is retired (removed in the
2026-09-03 cleanup); a different memory system answers by implementing the
recall wire contract over the `BENCH_MCP_RECALL_URL` seam. The Open
Knowledge Project is the first implementation of this contract, not the definition
of it. So the benchmark owns a small set of `kind`s describing what the
*harness* did, and everything backend-specific travels as an `ext` record under
a namespace the backend owns. **The harness never parses `data`.**

## Envelope

Every line is one JSON object.

| Field | Always | Meaning |
|---|---|---|
| `v` | yes | Envelope version. `1`. Bumped only for a breaking change. |
| `ts` | yes | Unix ms when the record was emitted. |
| `kind` | yes | One of the core kinds, or `ext`. |
| `run_id` | when known | The run this belongs to — the harness `run_label` (`cumulative-{seq:04d}-{arm}-{model}`), NOT the control-plane ledger `run_id` (a separate in-memory uuid) nor `manifest.run_id` (the manifest parent-dir basename). |
| `cell_seq` | on cell-scoped records | Which cell in the campaign. |
| `session_id` | on cell-scoped records | **The join key.** Present from `cell.start`. |

Unknown fields are ignored by readers. Adding a field or a core kind is **not**
a breaking change; readers must tolerate both.

## Core kinds — the harness owns these

| `kind` | Emitted when | Carries |
|---|---|---|
| `run.start` | campaign opens | `task`, `roster` |
| `cell.start` | before any work in a cell | `session_id`, `arm`, `model` |
| `phase.start` | a build chunk or feedback round opens | `phase` |
| `gate.result` | **one gate produces a verdict, at the moment it does** | `id`, `status`, `attempt`, `duration_ms` |
| `attempt.end` | a feedback round closes | `attempt`, `verdict`, `conformed`, `failed` |
| `cell.end` | cell reaches a terminal state | `verdict`, `terminal_reason` |
| `backend` | a backend announces itself | `ns`, `name`, `version` |
| `heartbeat` | **every 15s while a cell is live** | `phase`, `attempt`, `since_ms` |

`gate.result` is per gate, per attempt, **as it happens** — that is what lets a
gate wall fill in during a run rather than snapping to a finished state at cell
end.

## Liveness comes from `heartbeat`, and from nothing else

Every other kind marks a **transition**, and transitions are precisely what a
wedged cell stops producing. A stream of them can say what happened; it cannot
say whether anything is still happening. One build phase has been observed
running **86 model turns** without emitting a transition record of any kind.

Before this kind existed, four surfaces each invented their own liveness proxy
out of whatever was within reach:

| Surface | Proxy it invented | How it lies |
|---|---|---|
| header status | harness log mtime | silent for whole build phases |
| Episode ticker | serve event feed | gaps between mapped events; reconnects |
| `can_start` gate | `ps` scan | cannot tell working from wedged |
| TUI mirror | `Boolean(this.child)` | its own source calls this "a fact about the MIRROR, not about the session" |

All four answer a different question from the one being asked, and the first
one put `CELL STALLED — SILENT 21:49` in the header of a cell that was mid-turn
with its own event ticker scrolling beside it.

**The harness is the only component that knows whether it is mid-drive,
mid-grade, or stuck.** So it says so on a fixed clock, and every consumer reads
that one record. `stalled` then means *the heartbeat stopped*, which is true by
construction.

> **Resolved (WO-HDR-FIX-01) — the dashboard migrated.** The topbar was the one
> documented exception, and it is gone. The dashboard no longer derives
> `stalled` from the launch log's mtime: `control/board/sources/run-log.mjs` now sets
> `state: terminal ? "complete" : "running"` and keeps `log_silent_s` as a debug
> fact with **no rendering verdict**. `reconcileRunLiveness`
> (`control/board/run-liveness.mjs`) now consumes the producer's `state` in both
> directions — a stated stall lands carrying `heartbeat_age_s` as the verdict
> evidence, a live verdict corrects a board-claimed stall, and a dead process
> still overrides — and the STALLED chip renders `heartbeat_age_s`, never
> `log_silent_s`. A live-but-quiet cell (a long build phase) now stays `running`
> while its log silence climbs. The prior defect is traced in
> `dev/workspace/reports/1788591600-WO-HDR-01-trace-stalled-header.md`.

Three rules for a reader:

1. **A fresh heartbeat means alive.** No other signal may override it.
2. **A stale heartbeat means stalled.** 15s against a 900s threshold is 60
   missed beats — a slow disk or a GC pause cannot reach it.
3. **NO heartbeat in the stream means UNKNOWN — never stalled.** A cell from a
   harness that predates this kind, or one whose stream could not be written,
   has not reported anything. Asserting a wedge from its absence is how the
   defect above happened. Absence is its own state, exactly as it is for
   `state: "unavailable"` on the stats surface.

## Extension records — anyone owns these

```json
{"v":1,"ts":1787938355696,"kind":"ext","ns":"okp.plugin",
 "type":"insession.capture","session_id":"ses_abc",
 "data":{"marks":3,"trajectories":1}}
```

- `ns` — your namespace. Use a dotted name you control (`okp.plugin`,
  `acme.recall`). Two backends can run side by side without collision.
- `type` — your event name, scoped inside your `ns`.
- `data` — **opaque**. The harness does not read, validate, or promise anything
  about it. That opacity is what lets you ship telemetry the benchmark has never
  heard of.

A UI renders namespaces it recognises natively and unknown ones generically, so
a third-party backend gets on screen without patching the benchmark **or** the
dashboard.

## How a backend joins

The harness exports the path into the cell environment. Anything that can append
a line can participate, in any language:

| Variable | Meaning |
|---|---|
| `BENCH_LIVE_STREAM` | Absolute path to the stream. **Absent means no telemetry is wanted — carry on, do not error.** |
| `BENCH_LIVE_STREAM_NS` | The namespace to stamp. Lets an operator run two backends without either hardcoding a name. |

```python
import json, os, time

path = os.environ.get("BENCH_LIVE_STREAM")
if path:
    rec = {
        "v": 1,
        "ts": int(time.time() * 1000),
        "kind": "ext",
        "ns": os.environ.get("BENCH_LIVE_STREAM_NS", "acme.recall"),
        "type": "recall.served",
        "data": {"hits": 3},
    }
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")
```

Python callers inside the harness can use `harness.live_stream.LiveStream`
(`LiveStream.from_env()` returns `None` when the variable is absent).

## Rules that are not negotiable

1. **Telemetry never kills a run.** Every write is best-effort. A failed write is
   dropped and counted, never raised.
2. **Append-only, one JSON object per line.** No rewrites, no truncation, no
   seeking. A run that dies mid-cell leaves a valid prefix, not a corrupt file.
3. **One line per write**, opened `O_APPEND` and flushed, so the harness and any
   number of backends interleave whole lines instead of shredding each other's.
4. **`session_id` is on the first line of a cell.** It is the join key for every
   consumer, and consumers guessing it is the exact defect this replaces.
5. **The stream lives with the run artifacts, never inside a backend's state
   directory.** Open Knowledge scopes its state under `.okp/` and deliberately leaves
   the control arm unbound — hosting the stream there would make the OFF arm go
   dark and stop the two arms being comparable on the one surface meant to
   compare them.
