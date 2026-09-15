import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// @ts-expect-error tsx test runner resolves .ts extension imports.
import SelfCompactPlugin from './self-compact.ts';

// The plugin is opt-in behind the bench env flag; tests exercise the enabled
// path unless a test says otherwise.
process.env.BENCH_SELF_COMPACT = '1';

// The plugin logs into opencode's data dir; keep the suite's logs off the host's
// real one.
const DATA_HOME = mkdtempSync(join(tmpdir(), 'self-compact-data-'));
process.env.XDG_DATA_HOME = DATA_HOME;

// The A2 phase sentinel. In a real cell the harness writes this file on a
// read-only bind mount before every prompt; here a temp file stands in for it.
// The arm is FAIL-CLOSED on it, so the default for the suite is the build
// phase and tests that care set it explicitly.
const PHASE_DIR = mkdtempSync(join(tmpdir(), 'self-compact-phase-'));
const PHASE_FILE = join(PHASE_DIR, 'phase');
process.env.BENCH_COMPACT_PHASE_FILE = PHASE_FILE;

function setPhase(phase: string): void {
  writeFileSync(PHASE_FILE, `${phase}\n`, 'utf8');
}
setPhase('build');

type SummarizeCall = {
  path: { id: string }
  body: { providerID: string; modelID: string; auto: boolean }
}

function makeClient(
  opts: {
    summarizeError?: unknown
    turnID?: string
    summarizeDelayMs?: number
    /** Serve a transcript with NO assistant message (unreadable / empty session). */
    noAssistantTurn?: boolean
  } = {},
) {
  const summarizeCalls: SummarizeCall[] = []
  // Mutable so ONE client can serve a different turn after an event — the
  // established pattern builds a fresh client, which also resets the plugin's
  // own state, and some guards can only be tested across a state boundary.
  let servedTurnID = opts.turnID ?? "msg_turn_1"
  // THE TEXT IS DELIBERATELY IRRELEVANT (WO-MARKER-RIP). The arm reads no
  // model output at all; a turn qualifies on the phase sentinel, the budget
  // and the debounces. This string exists only so the transcript is realistic.
  const assistantText = 'wired up the board renderer and the dice roller'
  const client = {
    session: {
      messages: async () => ({
        data: opts.noAssistantTurn
          ? [
              {
                info: {
                  role: 'user',
                  model: { providerID: 'local-llm-proxy', modelID: 'kimi/kimi-k3' },
                },
                parts: [{ type: 'text', text: 'chunk prompt' }],
              },
            ]
          : [
              {
                info: {
                  role: 'user',
                  model: { providerID: 'local-llm-proxy', modelID: 'kimi/kimi-k3' },
                },
                parts: [{ type: 'text', text: 'chunk prompt' }],
              },
              {
                info: { role: 'assistant', mode: 'build', id: servedTurnID },
                parts: [{ type: 'text', text: assistantText }],
              },
            ],
      }),
      summarize: async (req: SummarizeCall) => {
        summarizeCalls.push(req)
        if (opts.summarizeDelayMs) {
          await new Promise((r) => setTimeout(r, opts.summarizeDelayMs))
        }
        return { error: opts.summarizeError }
      },
    },
  }
  return { client, summarizeCalls, setTurnID: (id: string) => { servedTurnID = id } }
}

async function makeHooks(client: unknown) {
  // The plugin factory receives { client, directory } and returns the hooks.
  return await (SelfCompactPlugin as any)({ client, directory: '/tmp' })
}

function idleEvent(sessionID = 'ses_test') {
  return { type: 'session.idle', properties: { sessionID } }
}

// The cooldown is wall-clock based, so tests that need to look PAST it move
// the clock instead of sleeping through a real minute.
let clockOffsetMs = 0
const realNow = Date.now.bind(Date)
Date.now = () => realNow() + clockOffsetMs

function advanceClock(ms: number): void {
  clockOffsetMs += ms
}

test.beforeEach(() => {
  setPhase('build')
  process.env.BENCH_COMPACT_PHASE_FILE = PHASE_FILE
  clockOffsetMs = 0
})

test('a build-phase idle fires summarize once with the session model and auto:true', async () => {
  const { client, summarizeCalls } = makeClient()
  const hooks = await makeHooks(client)

  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 1)
  assert.deepEqual(summarizeCalls[0].body, {
    providerID: 'local-llm-proxy',
    modelID: 'kimi/kimi-k3',
    auto: true,
  })

  // The autocontinue hook must suppress the synthetic continue turn for the
  // compaction this plugin fired (the harness sends the next chunk itself).
  const cont = { enabled: true }
  await hooks['experimental.compaction.autocontinue'](
    { sessionID: 'ses_test', agent: 'build' },
    cont,
  )
  assert.equal(cont.enabled, false)
})

// WO-MARKER-RIP. There is no longer any text the model can write, or fail to
// write, that changes whether this arm fires. A turn that says nothing about
// finishing fires exactly like one that does — the phase sentinel decides.
test('decisions are logged inside opencode\'s data dir, the one a cell exports', async () => {
  // Run 1789474325: the log lived on a tmpfs and its stderr mirror never reached
  // opencode.log, so no record of any fire or skip survived the cell.
  const { client } = makeClient()
  const hooks = await makeHooks(client)
  await hooks.event(idleEvent())

  const dir = join(DATA_HOME, 'opencode', 'self-compact')
  const files = readdirSync(dir).filter((f) => f.endsWith('-self-compact.log'))
  assert.equal(files.length, 1)
  assert.match(readFileSync(join(dir, files[0]), 'utf8'), /"msg":"firing-summarize"/)
})

test('the turn text is not read: an ordinary working turn still fires', async () => {
  const { client, summarizeCalls } = makeClient()
  const hooks = await makeHooks(client)
  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 1)
})

test('no assistant turn in the transcript does not fire', async () => {
  const { client, summarizeCalls } = makeClient({ noAssistantTurn: true })
  const hooks = await makeHooks(client)
  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 0)
})

test('a second build-phase idle inside the cooldown window does not fire', async () => {
  const { client, summarizeCalls } = makeClient()
  const hooks = await makeHooks(client)
  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 1)
  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 1) // cooldown: no second fire
})

test('autocontinue hook ignores compactions it did not fire (overflow stays on)', async () => {
  const { client } = makeClient()
  const hooks = await makeHooks(client)
  const cont = { enabled: true }
  await hooks['experimental.compaction.autocontinue'](
    { sessionID: 'ses_never_fired', agent: 'build' },
    cont,
  )
  assert.equal(cont.enabled, true)
})

test('summarize failure still resolves and clears the self-fired flag', async () => {
  const { client, summarizeCalls } = makeClient({ summarizeError: { message: 'boom' } })
  const hooks = await makeHooks(client)
  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 1)
  // A failed fire clears firedSelf: a later overflow compaction's autocontinue
  // must NOT be suppressed by this plugin's stale suppression entry.
  const cont = { enabled: true }
  await hooks['experimental.compaction.autocontinue'](
    { sessionID: 'ses_test', agent: 'build' },
    cont,
  )
  assert.equal(cont.enabled, true)
})

test('env flag off: a build-phase idle does not fire (opt-in gate)', async () => {
  const { client, summarizeCalls } = makeClient()
  const hooks = await makeHooks(client)
  const saved = process.env.BENCH_SELF_COMPACT
  delete process.env.BENCH_SELF_COMPACT
  try {
    await hooks.event(idleEvent())
    assert.equal(summarizeCalls.length, 0)
  } finally {
    process.env.BENCH_SELF_COMPACT = saved
  }
})

// ── A2 phase sentinel — now the WHOLE gate ─────────────────────────────────
// The arm is decided by the HARNESS-KNOWN phase and nothing else. It used to
// also require a model-emitted string, which the model kept printing during
// repair rounds (run 1788462647, a compaction inside feedback-2); the harness
// knows the phase exactly, and the model knows nothing about it.

test('repair phase: an idle does not fire', async () => {
  const { client, summarizeCalls } = makeClient()
  const hooks = await makeHooks(client)
  setPhase('repair')
  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 0)
})

test('unknown phase value does not fire (only an explicit build phase arms)', async () => {
  const { client, summarizeCalls } = makeClient()
  const hooks = await makeHooks(client)
  setPhase('feedback-2')
  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 0)
})

test('phase file missing does not fire (fail-closed, not fail-open)', async () => {
  const { client, summarizeCalls } = makeClient()
  const hooks = await makeHooks(client)
  process.env.BENCH_COMPACT_PHASE_FILE = join(PHASE_DIR, 'no-such-file')
  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 0)
})

test('phase transport unset does not fire (fail-closed)', async () => {
  const { client, summarizeCalls } = makeClient()
  const hooks = await makeHooks(client)
  delete process.env.BENCH_COMPACT_PHASE_FILE
  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 0)
})

test('build phase resumes firing after a repair-phase refusal', async () => {
  const { client, summarizeCalls } = makeClient()
  const hooks = await makeHooks(client)
  setPhase('repair')
  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 0)
  setPhase('build')
  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 1)
})

// ── E: the double-fire race ─────────────────────────────────────────────────

test('two idles racing a slow summarize fire exactly once', async () => {
  // lastFired used to be stamped on summarize SUCCESS, so an idle arriving
  // while the summarize was still in flight passed the cooldown and fired
  // again off the same turn still in retained history — the paired
  // 19:29:53+19:30:45 and 19:39:25+19:40:28 compactions at chunks 2 and 3.
  const { client, summarizeCalls } = makeClient({ summarizeDelayMs: 50 })
  const hooks = await makeHooks(client)
  await Promise.all([hooks.event(idleEvent()), hooks.event(idleEvent())])
  assert.equal(summarizeCalls.length, 1)
})

test('the same assistant turn never fires twice, even past the cooldown', async () => {
  // A compaction does not remove that turn from the transcript, so the
  // cooldown alone would let the same turn re-qualify once it lapsed.
  const { client, summarizeCalls } = makeClient()
  const hooks = await makeHooks(client)
  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 1)
  advanceClock(120_000) // pretend two minutes passed: cooldown is over
  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 1) // turn id still consumed
})

test('a NEW assistant turn fires again once the cooldown has passed', async () => {
  const { client, summarizeCalls } = makeClient({ turnID: 'msg_turn_1' })
  const hooks = await makeHooks(client)
  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 1)

  const next = makeClient({ turnID: 'msg_turn_2' })
  const nextHooks = await makeHooks(next.client)
  await nextHooks.event(idleEvent())
  assert.equal(next.summarizeCalls.length, 1)
})

test('a failed summarize does not re-fire against the same turn', async () => {
  const { client, summarizeCalls } = makeClient({ summarizeError: { message: 'boom' } })
  const hooks = await makeHooks(client)
  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 1)
  advanceClock(120_000)
  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 1)
})

// ── The per-session fire budget ─────────────────────────────────────────────
//
// Six build chunks, six boundaries, six fires. The phase sentinel is what
// SHOULD keep the count at six on its own; this budget is the independent
// backstop for the case it is left stale on `build` — the exact misconfiguration
// the harness aborts on. Two mechanisms, two failure modes, neither trusted
// alone.

test('fires at most six times per session, however many build idles arrive', async () => {
  const summarizeCalls: SummarizeCall[] = []
  let turn = 0
  const client = {
    session: {
      // A FRESH TURN ID EVERY TIME, so neither debounce can be what stops it.
      // Only the budget can.
      messages: async () => ({
        data: [
          {
            info: {
              role: 'user',
              model: { providerID: 'local-llm-proxy', modelID: 'kimi/kimi-k3' },
            },
            parts: [{ type: 'text', text: 'chunk prompt' }],
          },
          {
            info: { role: 'assistant', mode: 'build', id: `msg_turn_${++turn}` },
            parts: [{ type: 'text', text: 'more work done' }],
          },
        ],
      }),
      summarize: async (req: SummarizeCall) => {
        summarizeCalls.push(req)
        return { error: undefined }
      },
    },
  }
  const hooks = await makeHooks(client)

  for (let i = 0; i < 10; i++) {
    await hooks.event(idleEvent())
    advanceClock(120_000) // past the cooldown every time
  }
  assert.equal(summarizeCalls.length, 6)
})

test('the budget is per session, not global', async () => {
  const first = makeClient({ turnID: 'a1' })
  const firstHooks = await makeHooks(first.client)
  await firstHooks.event(idleEvent('ses_one'))
  assert.equal(first.summarizeCalls.length, 1)

  // A different session id on the SAME plugin instance starts from a full
  // budget: one wedged cell must not spend another cell's boundaries.
  await firstHooks.event(idleEvent('ses_two'))
  assert.equal(first.summarizeCalls.length, 2)
})

test('a failed summarize spends budget (a failure is not a free retry)', async () => {
  const summarizeCalls: SummarizeCall[] = []
  let turn = 0
  const client = {
    session: {
      messages: async () => ({
        data: [
          {
            info: {
              role: 'user',
              model: { providerID: 'local-llm-proxy', modelID: 'kimi/kimi-k3' },
            },
            parts: [{ type: 'text', text: 'chunk prompt' }],
          },
          {
            info: { role: 'assistant', mode: 'build', id: `msg_turn_${++turn}` },
            parts: [{ type: 'text', text: 'more work done' }],
          },
        ],
      }),
      summarize: async (req: SummarizeCall) => {
        summarizeCalls.push(req)
        return { error: { message: 'boom' } }
      },
    },
  }
  const hooks = await makeHooks(client)
  for (let i = 0; i < 10; i++) {
    await hooks.event(idleEvent())
    advanceClock(120_000)
  }
  assert.equal(summarizeCalls.length, 6)
})

// ── A DEAD STREAM IS NOT A CHUNK BOUNDARY (2026-09-11) ──────────────────────
//
// MEASURED, run 1789125594. A stream died mid-chunk and this arm summarized
// anyway, diverting the agent into the compaction agent and stopping the drive:
//
//     .703  stream error
//     .714  session.error      <- this plugin was not listening
//     .722  session.idle       <- phase=build, budget left -> FIRED
//     .872  the harness first LEARNS the turn died, publishes its hold
//     .920  compacting ... agent=compaction
//
// The harness DOES hold the sentinel across a recovery nudge and that wiring is
// correct — it simply cannot be early enough. It learns a turn died by reading
// the transcript, ~150ms after the idle this plugin already fired on. The gate
// has to live here, where `session.error` is visible BEFORE the idle.

function errorEvent(sessionID = 'ses_test') {
  return { type: 'session.error', properties: { sessionID } }
}

test('a stream that died does not summarize the turn it killed', async () => {
  const { client, summarizeCalls } = makeClient()
  const hooks = await makeHooks(client)

  await hooks.event(errorEvent())
  await hooks.event(idleEvent())

  assert.equal(
    summarizeCalls.length,
    0,
    'the idle after a session.error is the stream failing, not the model finishing',
  )
})

test('EVERY idle a dead stream emits is skipped, not just the first', async () => {
  // The real failure emitted TWO idles (.722 and .802). A flag cleared on the
  // first idle would have let the second one fire — which is why the guard is
  // keyed on the turn's IDENTITY and not on a flag or a time window.
  const { client, summarizeCalls } = makeClient()
  const hooks = await makeHooks(client)

  await hooks.event(errorEvent())
  await hooks.event(idleEvent())
  await hooks.event(idleEvent())
  await hooks.event(idleEvent())

  assert.equal(summarizeCalls.length, 0)
})

test('the NEXT turn still compacts — the guard gates one turn, not the session', async () => {
  // A recovery nudge produces a new assistant turn. That turn is a real
  // boundary and must fire: a guard that stuck would silently disable every
  // remaining chunk boundary, which is worse than the fault it prevents.
  const { client, summarizeCalls, setTurnID } = makeClient({ turnID: 'msg_died' })
  const hooks = await makeHooks(client)

  await hooks.event(errorEvent())
  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 0, 'the killed turn must not fire')

  // The nudge lands and the model produces a different turn.
  setTurnID('msg_recovered')
  advanceClock(120_000) // past the cooldown, which is a different guard
  await hooks.event(idleEvent())

  assert.equal(summarizeCalls.length, 1, 'the recovered turn IS a boundary')
})

test('an unreadable transcript at error time fails CLOSED, then releases', async () => {
  // No turn id to key on, so the session is gated outright — firing a summarize
  // into a session that just errored is the failure this exists to prevent.
  // But it must not stick: once a turn is readable again the guard narrows to
  // that one turn and normal service resumes.
  const { client, summarizeCalls } = makeClient({ noAssistantTurn: true })
  const hooks = await makeHooks(client)

  await hooks.event(errorEvent())
  await hooks.event(idleEvent())
  assert.equal(summarizeCalls.length, 0)
})
