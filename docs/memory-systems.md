# Memory systems

A memory system enters the benchmark the way it enters opencode for anyone: as an opencode plugin.
The benchmark adds no memory interface of its own. It gives the plugin what it needs to run, keeps
everything else the same between the arms, and measures what memory did from the outside.

[Honcho](https://github.com/plastic-labs/honcho) is the first system, through its opencode plugin
[opencode-honcho](https://github.com/plastic-labs/opencode-honcho). Its kit is in
[memory-systems/honcho](../memory-systems/honcho/), and it is the worked example below. Why memory is
measured this way is in the [methodology](methodology.md).

## How a memory system plugs in

| What | Setting | Reaches |
|---|---|---|
| The plugin | `BENCH_PLUGIN_DIR` (when the worker image is built) | the one worker image; loaded in memory-ON cells only |
| A route to its server | `BENCH_MEMORY_UPSTREAM` | memory-ON cells, through the cell's network sidecar |
| Its own settings | `BENCH_MEMORY_ENV` | memory-ON cells, by name |
| "Has it finished?" | `BENCH_MEMORY_READY_CMD` | runs on the host, around each memory-ON cell |
| "What has it spent?" | `BENCH_MEMORY_COST_CMD` | runs on the host, around each memory-ON cell |

Only the first is needed by every memory system. A system that keeps its memory in files needs no
route, and the last two are optional; a system with a server and background work — like Honcho —
uses all five.

**The plugin.** Any opencode plugin package works: its `package.json` names the file opencode loads
(`exports`, `module` or `main`), and that file must exist (built, not just source). Building the
worker image installs the package and prints it, for example
`plugin @honcho-ai/opencode-honcho@0.2.1, loaded from dist/index.js`; a package with no loadable
entry is refused before the build starts.

**One image for both arms.** The plugin is installed in the worker image, and both arms run on that
image. Only a memory-ON cell lists the plugin in its own opencode config; an OFF cell never loads
it. The image is part of every cell's fingerprint, so **the OFF baseline must run on the same image
as the ON series it is compared with**: rebuilding with a different plugin, or a different version
of it, changes the fingerprint, and an OFF baseline run on the old image no longer serves as the
floor. A memory-ON cell on an image without a plugin refuses to start, rather than run without
memory under an ON label.

**The same worktree in both arms.** Memory is switched on only in the cell's config, never by files
the model can see. Both arms start from the same files.

**The route.** Cells run on a network with no way out except their sidecar. `BENCH_MEMORY_UPSTREAM`
is the memory server's address as the sidecar reaches it (`scheme://host:port`); a memory-ON
cell's sidecar then forwards its port 4560 to that server. An OFF cell's sidecar has no such route.

**The settings.** `BENCH_MEMORY_ENV` names a file of the plugin's own settings, one `NAME=value` per
line (`#` comments, `export` and quotes are allowed; a relative path is read from the repository
root). `{memory_url}` in a value becomes the address the cell reaches the server at. The values are
handed to the worker by name, so they never appear in a command line or in `docker inspect`, and
values whose names look secret (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `AUTH`) are masked wherever
they are recorded. Names that decide what the cell is are refused: `HOME`, `PATH`, `XDG_*`,
`OPENCODE_*`, `BENCH_*`, `NODE_PATH`, `NODE_OPTIONS`, `PLAYWRIGHT_*`, `DOCKER_*`, the proxy
variables, and the model keys.

**Ready.** A memory system keeps working after a cell ends: Honcho turns the cell's messages into
memories in a background queue. `BENCH_MEMORY_READY_CMD` is a host command, run with `sh -c` from
the repository root, that exits 0 once that work is done. It is polled every 5 seconds before each
memory-ON cell, so every cell starts from memory that has finished with every earlier cell, and
again after the cell, so the cell's own processing is counted against it. Both waits are outside
the cell's wall time. If the memory system is still busy after `BENCH_MEMORY_READY_TIMEOUT_S`
(default 1800), the next cell is refused instead of starting against half-processed memory.

**Cost.** `BENCH_MEMORY_COST_CMD` prints one JSON object of the memory system's running counters,
for example `{"input_tokens": 120400, "output_tokens": 9310}`. It is read before and after each
memory-ON cell — the "after" read follows the ready wait — and the growth is recorded as the
memory system's own cost for that cell. A counter that went down means the memory system restarted
mid-cell; it is named under `reset` instead of guessed. A read that fails is recorded as an error,
and the cell goes on.

## What each cell records

Every cell writes `memory.json` beside its other records, in both arms, so an ON cell is always
read against OFF cells measured the same way.

| Field | Arm | What it is |
|---|---|---|
| `first_prompt_tokens` | both | Tokens in the cell's first model request, as opencode counts them (input + cache read + cache write). Both arms send the same task, so what an ON cell carries beyond the OFF range is what memory put in front of the model. |
| `tool_calls` | both | Tool calls by name, so a memory tool the model chose to use shows up beside the work tools. |
| `plugin` | ON | The baked plugin's name and version. |
| `memory_config` | ON | Where the plugin was pointed: the server, the cell's address for it, and its settings with secrets masked. |
| `memory_route` | ON | The sidecar's count of the plugin's requests to its server: how many, how they were answered (by status class), how many found the server unreachable, and the bytes each way. |
| `ready_before`, `ready_after` | ON | Each wait for the memory system: whether it became ready, after how many seconds and polls. |
| `cost_before`, `cost_after`, `cost` | ON | The memory system's counters around the cell, and what they grew by. |

A value that could not be read is `null`, never zero.

`memory_route` is the evidence for the rule that unverified memory is not memory on: a memory-ON
cell whose plugin sent no requests, or got no answers, ran without the memory it was labelled with.
The plugin carrying on silently when its server is down is exactly the failure this catches.

## Honcho, step by step

**What runs where.** Everything runs on the machine that runs the benchmark. Honcho is a server
(an API, a background worker called the deriver, Postgres with pgvector, and Redis), started with
Docker Compose from its own repository. Cells reach it through their sidecar at
`host.docker.internal:8000`. Honcho's background jobs call the same local model the worker uses,
through the local relay; its search embeddings come from a local embedding model on the runtime.
A small receiver started with Honcho totals Honcho's own model use for the cost record.

Honcho is AGPL-3.0 and runs as a separate service; the benchmark does not include or modify it.
opencode-honcho is MIT. The kit was written against Honcho `v3.2.2` and opencode-honcho `0.2.1`.

### 1. Give Honcho its own alias on the relay

In the relay's `config/models.yaml`, copy the bench alias block (`qwen3.6-35b-a3b-bench`) to a new
alias named `qwen3.6-35b-a3b-memory`, keeping its `upstreamModel` the same. Two changes: drop
`purpose: okp-bench`, so the board does not offer it as a worker model, and let it queue
(`concurrency.queueDepth` above 0), so Honcho's calls wait for the model instead of being turned
away. The relay reads the file once at boot: restart it with an idle gate (RUNBOOK §6, "Benching a
new model").

Same upstream model, so the relay never swaps models in the middle of a cell. Its own alias, so
Honcho's calls never take the bench alias's slot. The model is shared all the same: while Honcho
works, the worker's requests can wait. That is memory's real cost on one machine, and it shows in
wall time (methodology, [Limits](methodology.md#limits)).

### 2. Start Honcho

```bash
git clone --branch v3.2.2 https://github.com/plastic-labs/honcho ~/honcho
cd ~/honcho
cp docker-compose.yml.example docker-compose.yml
cp <learning-index>/memory-systems/honcho/honcho.env .env
cp <learning-index>/memory-systems/honcho/docker-compose.override.yml .
cp <learning-index>/memory-systems/honcho/telemetry_sink.py .
```

In `.env`, fill the three empty values: `LLM_OPENAI_API_KEY` (the relay's key),
`EMBEDDING_MODEL_CONFIG__MODEL` (the id of the embedding model loaded on the runtime) and
`EMBEDDING_VECTOR_DIMENSIONS` (that model's size). The size is fixed when Honcho's database is
created; changing embedding models means a fresh database. Then:

```bash
docker compose up -d --build
curl -s localhost:8000/health    # Honcho
curl -s localhost:8795/totals    # the receiver: {"calls": 0, "input_tokens": 0, "output_tokens": 0}
```

Both listen on localhost only.

### 3. Bake the plugin into the worker image

```bash
mkdir -p ~/bench-plugins/honcho && cd ~/bench-plugins/honcho
tar xzf "$(npm pack @honcho-ai/opencode-honcho@0.2.1)"    # unpacks to ./package
cd <learning-index>
BENCH_PLUGIN_DIR=~/bench-plugins/honcho/package .venv/bin/python scripts/rebuild_worker_image.py
```

The published package is already built. The build prints the plugin's name, version and entry file.
Rebuilding changes the worker image, so the OFF baseline is run on this image too.

### 4. Point the run at Honcho

In `config/bench.env`, or exported before the control plane starts:

```bash
BENCH_PLUGIN_DIR=/Users/<you>/bench-plugins/honcho/package
BENCH_MEMORY_UPSTREAM=http://host.docker.internal:8000
BENCH_MEMORY_ENV=memory-systems/honcho/memory.env
BENCH_MEMORY_READY_CMD=python3 memory-systems/honcho/hooks.py ready
BENCH_MEMORY_COST_CMD=python3 memory-systems/honcho/hooks.py cost
```

`memory.env` sets the plugin's server to `{memory_url}` and names its workspace. `hooks.py ready`
exits 0 when that workspace's queue holds no pending or in-progress work — every message turned into
memory, summaries and dreams included. `hooks.py cost` prints the receiver's totals of Honcho's
model calls: input and output tokens, overall and by job (`deriver.representation`,
`dialectic.answer`, `summary.short`, `dream.deduction` and the rest), errors, and embedding input.
Calls Honcho streams report no tokens, so they are counted as `streamed_calls`; above zero, the
token totals are short by those calls.

Memory-ON cells are then launched with `--mode on`.

### 5. A new workspace for every series

A series starts from empty memory only in a workspace no earlier series wrote to. Before each new
series, change `HONCHO_WORKSPACE_ID` in `memory.env`, and keep it for every cell of that series. The
ready and cost commands read the workspace from the same file, so they always watch the one the
cells write to.

### What the plugin does in a cell

Described from opencode-honcho `0.2.1`'s source; the benchmark changes none of it.

- It sends the session's messages to Honcho as they happen.
- It adds what Honcho knows to the system prompt, and to the summary when opencode compacts a
  session.
- It gives the model tools: `honcho_search`, `honcho_chat` (ask Honcho a question),
  `honcho_create_conclusion` (save a conclusion), `honcho_status`, and its setup and config tools.
- It copies its `honcho-memory` skill into opencode's skills, so the model can read how to use it.

Every cell starts from a fresh home directory, so the plugin starts each cell with its new-install
defaults: user peer `user`, agent peer `opencode`, the workspace from `memory.env`. By default Honcho
models the user, not the agent: what it derives comes from the user's messages — the task and the
team's feedback — while the agent's own findings enter memory when the model saves them as
conclusions.

### Honcho's settings, and why

The benchmark measures Honcho as configured, and the configuration is part of the result. Apart
from where its models run, `honcho.env` changes two things from Honcho's defaults:

- **`DERIVER_FLUSH_ENABLED=true`.** Honcho normally holds new messages until enough have collected,
  for up to 30 minutes, before processing them. With this on, it processes them at once, so the
  queue empties soon after a cell ends and the wait before the next cell stays short.
- **Telemetry to the local receiver.** Honcho reports every model call it makes to the receiver
  (`TELEMETRY_ENDPOINT`). Nothing leaves the machine.

Everything else is Honcho's default, dreams included: Honcho consolidates its memory on its own
schedule — once 50 new observations have collected and no message has arrived for an hour, and at
most every 8 hours. A dream joins the queue only when it is due; once queued or running, it is work
the ready check waits for.

## Adding another memory system

1. Package it as an opencode plugin, with `package.json` naming the built entry file. Bake it with
   `BENCH_PLUGIN_DIR`.
2. If it has a server, run it on the benchmark machine; set `BENCH_MEMORY_UPSTREAM` to the server as
   the sidecar reaches it, and put the plugin's settings in a file for `BENCH_MEMORY_ENV`, with
   `{memory_url}` where the server's address goes.
3. If it works in the background, write a ready command: exit 0 when the work is done, non-zero
   otherwise.
4. If it calls models of its own, write a cost command: print one JSON object of running counters.
5. Put the files in `memory-systems/<name>/`, beside Honcho's.

The harness never interprets any of it: what the plugin captures, recalls and injects is the memory
system's business. The benchmark keeps the arms the same and measures the difference.
