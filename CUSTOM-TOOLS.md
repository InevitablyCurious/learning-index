# Custom tools

The board's tool drawer (the menu button) shows two kinds of tool:

- **Built-in** — the benchmark's own, defined in `control/tools.mjs`: the four
  refresh buttons (**Refresh worker**, **Refresh grader**, **Refresh control
  plane**, **Refresh board**), one for each part that keeps running old code
  after an edit. Preflight names the one to press.
- **Custom** — served by a separate custom-tools service that you run: for
  example a memory system's own operations, such as joining an org or
  restarting its services. The benchmark ships none of them and knows none of
  them by name.

## Attaching a service

Give the control plane the service's address:

```bash
BENCH_TOOLS_URL=http://127.0.0.1:8720 node control/server.mjs
```

## What the benchmark promises

- **It runs the same with or without the service.** Preflight never consults
  the service and no run depends on it. Checking and testing the custom tools —
  and any memory system behind them — is the service's job, not the
  benchmark's.
- **Unset:** the drawer shows only the built-in tools.
- **Set, but unreachable or not answering this contract:** the drawer shows one
  blocked row, `custom tools unavailable at <address> — <reason>`. Nothing else
  changes.
- **Built-ins win a name collision.** A custom tool that reuses a built-in id is
  shown blocked and does nothing.
- **A tool marked `refuse_while_running` is refused while a cell is live**,
  because changing the substrate mid-cell would change what is being measured.
  Symmetrically, a cell launch is refused while such a tool is running.
- **Only declared arguments are sent**, as strings.

## How a run is shown

A tool run is a tracked background job (`control/tooljobs.mjs`), not a held
request: pressing run starts the job and the board answers at once; the job's
live output, elapsed time and verdict arrive with the board frame and survive
closing the drawer or reloading the page. A second press while the job runs
joins it instead of starting an overlapping one.

For a custom tool this means: the card shows the elapsed clock and a "waiting
for the service" line while `POST /tools/run` is in flight (the service's
contract streams nothing), then the service's own output and verdict when it
answers. Keep `timeout_ms` honest — it is still the hard bound.

## The contract

JSON over HTTP. Bind the service to loopback.

### `GET /tools`

Answer within 3 seconds.

```json
{
  "tools": [
    {
      "id": "join-org",
      "name": "Join org",
      "blurb": "What pressing it does, in a sentence or two.",
      "seams": ["step one", "step two"],
      "args": [
        { "name": "org", "label": "org id", "required": true, "default": "my-org", "help": "the org to join" }
      ],
      "success_note": "Sent, NOT accepted — the org's leader still has to accept it.",
      "refuse_while_running": false,
      "timeout_ms": 30000
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable identifier. Must not reuse a built-in id. |
| `name` | yes | The label shown in the drawer. |
| `blurb` | no | When and why to press it. |
| `seams` | no | The steps it performs, shown on request. |
| `args` | no | Input boxes: `name`, `label`, `required`, `default`, `help`. |
| `success_note` | no | A caveat shown on success, when "it worked" is not the whole truth. |
| `refuse_while_running` | no | Default `true`. Refused while a cell is live. |
| `timeout_ms` | no | How long the benchmark waits for `POST /tools/run`. Default 900000. |

### `POST /tools/run`

Request:

```json
{ "id": "join-org", "args": { "org": "my-org" } }
```

Response:

```json
{ "ok": true, "code": "ok", "reason": null, "stdout": "…", "stderr": "…", "result": null }
```

`ok: false` is shown as a failure with the tool's own `code`, `reason` and
output — never rewritten. The benchmark waits the tool's `timeout_ms` plus ten
seconds before reporting a timeout of its own.

### `GET /health`

Optional, for your own tooling. The benchmark does not call it.
