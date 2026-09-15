/**
 * Benchmark-native self-compaction (moved here from the dev plugin shim,
 * 2026-09-15). Compaction is a benchmark run condition, not a memory-system
 * feature, so it is baked into EVERY worker image at /opt/bench/self-compact.ts,
 * with or without a memory plugin: the memory-OFF and memory-ON arms compact
 * identically.
 *
 * `import type` only: the plain worker image carries no @opencode-ai packages,
 * and a type-only import is erased before the file runs.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Inside opencode's DATA dir, because that is the one directory a bench cell
 * exports at teardown (the session DB volume). Resolved per call so a test can
 * point XDG_DATA_HOME somewhere else.
 */
function logDir(): string {
  const dataHome =
    process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "/tmp", ".local/share")
  return join(dataHome, "opencode", "self-compact")
}

/**
 * Phase sentinel (A2). The harness publishes the CURRENT DRIVE PHASE to a file
 * on a read-only bind mount before it sends each prompt; this plugin reads it
 * on every idle and fires only while the phase is BUILD.
 *
 * THE SENTINEL IS THE WHOLE GATE (WO-MARKER-RIP, 2026-09-09). This arm used to
 * require a second condition: that the just-completed assistant turn carried
 * the literal string `CHUNK FINISHED`, which the six build prompts instructed
 * the model to print. That condition is DELETED. It was a string the MODEL
 * emitted standing in for an event the HARNESS already knows, and it leaked —
 * the instruction lives only in the build prompts, but repair rounds run in the
 * SAME session, so the convention survived summarization and the model kept
 * printing it while fixing gate failures. On 2026-09-02 that fired a compaction
 * ~80s before the end of `feedback-2` in run 1788462647.
 *
 * So the trigger is now: session.idle, phase says build, budget left, debounce
 * clear. The harness decides WHICH drive in a chunk carries the build phase, so
 * exactly one idle per chunk boundary qualifies.
 *
 * FAIL-CLOSED. Unset env, unreadable file, or any phase other than `build`
 * means DO NOT FIRE. Refusing is loud by construction: the harness's
 * `_settle_after_chunk` wait finds no compaction part at the first chunk
 * boundary and aborts the cell on `no_compaction_evidence`.
 */
const PHASE_FILE_ENV = "BENCH_COMPACT_PHASE_FILE"
const BUILD_PHASE = "build"

/**
 * HARD CEILING ON FIRES PER SESSION. The corpus is six build chunks, so six
 * boundaries exist and a seventh fire is by definition not a boundary.
 *
 * The phase sentinel already restricts firing to the boundary drives, and this
 * counter is the independent backstop underneath it: if the sentinel is ever
 * left stale on `build` — the exact failure the harness aborts on — a runaway
 * compaction loop is bounded at six instead of running for the life of the
 * session. Two mechanisms, two failure modes, neither trusted alone.
 */
const MAX_FIRES_PER_SESSION = 6

function log(line: string, fields: Record<string, unknown> = {}): void {
  const ts = new Date().toISOString()

  // ── THE FILE IS THE RECORD THAT SURVIVES THE CELL ─────────────────────────
  //
  // Every decision this plugin makes — why it fired, why it skipped — has to be
  // readable after the run. It used to live under $HOME/.local/state, a tmpfs
  // discarded when the container exits, and the stderr mirror did not rescue
  // it: opencode does NOT copy plugin stderr into `opencode.log` (run
  // 1789474325's exported logs held zero self-compact lines; stderr went to the
  // serve's /tmp log). The file now lives in opencode's data dir, which the cell
  // exports to session-db/ and worker-logs/opencode/.
  //
  // The stderr mirror stays for a live container. Neither may throw —
  // compaction must never fail because logging did.
  try {
    console.error(`[self-compact] ${JSON.stringify({ msg: line, ...fields })}`)
  } catch {
    // A console that refuses is not a reason to skip the file below.
  }
  try {
    const dir = logDir()
    mkdirSync(dir, { recursive: true })
    appendFileSync(
      join(dir, `${ts.slice(0, 10)}-self-compact.log`),
      JSON.stringify({ ts, msg: line, ...fields }) + "\n",
    )
  } catch {
    // Compaction must never fail because logging failed.
  }
}

/**
 * Read the harness's phase sentinel. Returns true ONLY for an explicit
 * `build` phase; every other outcome (env unset, file missing, read error,
 * any other phase name) returns false and says why in the log.
 *
 * Read FRESH on every idle — the file is rewritten between phases and a
 * cached value would reintroduce exactly the staleness the sentinel exists
 * to remove.
 */
function inBuildPhase(sessionID: string): boolean {
  const path = (process.env[PHASE_FILE_ENV] ?? "").trim()
  if (!path) {
    log("fire-skipped-no-phase-transport", { sessionID, env: PHASE_FILE_ENV })
    return false
  }
  let phase: string
  try {
    phase = readFileSync(path, "utf8").trim()
  } catch (err) {
    log("fire-skipped-phase-unreadable", { sessionID, path, error: String(err) })
    return false
  }
  if (phase !== BUILD_PHASE) {
    log("fire-skipped-non-build-phase", { sessionID, phase })
    return false
  }
  return true
}

/**
 * Bench-worker self-compaction. Fires on session.idle, gated by the harness's
 * phase sentinel and bounded by a per-session budget.
 *
 * WHY THIS SHAPE
 * - The bench drives one serve session through N chunk prompts. Between
 *   chunks the context window only grows; compacting at each chunk boundary
 *   keeps every chunk's window small (fewer stalls, no overflow compaction
 *   mid-chunk).
 * - THE TRIGGER IS session.idle AND NOTHING THE MODEL WROTE (WO-MARKER-RIP,
 *   2026-09-09). Idle is an event the runtime publishes; the deleted
 *   `CHUNK FINISHED` condition was prose the model chose to emit, which it
 *   could print having done nothing and withhold having done everything — and
 *   which leaked into repair rounds because nothing ever told it to stop. The
 *   predecessor arm before that was a model-CALLED tool, which is worse still:
 *   an arm that only fires when the model remembers to call it never fires.
 *   The model is now out of the trigger entirely.
 * - PHASE-GATED (A2), and the phase gate is the whole gate. The harness
 *   publishes the current drive phase to a bind-mounted sentinel file before
 *   every prompt and flags exactly one drive per chunk as `build`; the arm
 *   fires only while that file reads `build`. Fail-closed in every direction —
 *   see the PHASE_FILE_ENV block above.
 * - BUDGETED: at most MAX_FIRES_PER_SESSION fires, ever. Six chunks, six
 *   boundaries. This is the backstop for a stale sentinel, independent of the
 *   sentinel itself.
 * - DEBOUNCED THREE WAYS, three distinct windows. The in-flight lock covers
 *   concurrent idles (taken synchronously, before the first await — every
 *   other guard here is stamped after one, so a second idle arriving
 *   mid-handling would sail past all of them, which is what produced two
 *   compactions at the chunk-2 and chunk-3 boundaries). The cooldown covers
 *   the minute after a fire. The turn id covers the same assistant turn
 *   forever: compaction does not delete that turn from the transcript, so it
 *   is still the newest one on the next idle and elapsed time alone was never
 *   sufficient. lastFired is stamped AT FIRE TIME, not on summarize success,
 *   because a summarize is in flight for seconds and an idle arriving inside
 *   that window must find the cooldown already closed.
 * - Autocontinue is suppressed for self-fired compactions ONLY: the harness
 *   sends the next chunk prompt itself, so the synthetic continue turn would
 *   burn worker tokens on nothing. Overflow auto-compaction keeps its
 *   default autocontinue (it is what keeps a mid-chunk turn alive).
 * - No backstop: this plugin fires its own summarize or does nothing.
 */
const SelfCompactPlugin: Plugin = async ({ client, directory }) => {
  /** sessionID -> arm metadata; one-shot, disarmed before firing. */
  const armed = new Map<string, { agent: string; reason: string; turnID: string | null }>()
  /** Sessions whose in-flight compaction was fired by THIS plugin (not overflow). TTL'd. */
  const firedSelf = new Map<string, number>()
  /** sessionID -> last self-compaction fire time, stamped AT FIRE (cooldown guard). */
  const lastFired = new Map<string, number>()
  /** sessionID -> message id of the assistant turn that already fired (one fire per turn). */
  const lastFiredTurn = new Map<string, string>()
  /** sessionID -> fires so far this session; hard-capped at MAX_FIRES_PER_SESSION. */
  const fireCount = new Map<string, number>()
  /** Sessions with an idle already being handled. Held ACROSS the awaits below. */
  const inFlight = new Set<string>()
  /**
   * The assistant turn that was in flight when the stream FAILED.
   *
   * ── WHY THIS EXISTS (measured 2026-09-11, run 1789125594) ─────────────────
   *
   * A stream died mid-chunk and this plugin summarized anyway, diverting the
   * agent into the compaction agent and stopping the drive. The log:
   *
   *     .703  stream error
   *     .714  session.error      <- this plugin was not listening
   *     .722  session.idle       <- phase=build, budget left -> FIRED
   *     .872  harness first LEARNS the turn died, publishes its hold
   *     .920  compacting ... agent=compaction
   *
   * The harness DOES hold the sentinel across a recovery nudge, and that wiring
   * is correct. It simply cannot be early enough: the harness learns a turn
   * died by reading the transcript, ~150ms after the idle this plugin already
   * fired on. No amount of care on that side wins the race.
   *
   * `session.error` is visible HERE, and it arrives BEFORE the idle. So the gate
   * belongs here.
   *
   * ── WHY A TURN ID AND NOT A FLAG OR A TIMER ───────────────────────────────
   *
   * A flag cleared on the next idle is wrong: a stream death emits SEVERAL
   * idles (.722 and .802 on that run), so the second would fire. A time window
   * is a guess that breaks on a slow host. The turn id is exact — the turn that
   * died is the newest assistant turn, and it stays newest until the nudge
   * produces a new one. Identity, not elapsed time, which is the same reasoning
   * `lastFiredTurn` already uses one guard below.
   */
  const diedTurn = new Map<string, string>()
  /** Stand-in when the transcript could not be read at error time. */
  const UNREADABLE = "\u0000unreadable"
  /** agent name -> "provider/model" captured from merged config (fallback resolution). */
  const agentModels = new Map<string, string>()
  /** "provider/model" main-model fallback captured from merged config. */
  let mainModel: string | null = null

  const FIRED_TTL_MS = 10 * 60 * 1000 // stale suppression entry must NEVER eat a later overflow autocontinue
  const COOLDOWN_MS = 60 * 1000 // compact-loop guard: refuse firing again too soon

  function firedSelfHas(sessionID: string): boolean {
    const t = firedSelf.get(sessionID)
    if (t === undefined) return false
    if (Date.now() - t > FIRED_TTL_MS) {
      firedSelf.delete(sessionID)
      log("firedSelf-expired", { sessionID })
      return false
    }
    return true
  }

  /**
   * Resolve the model the SESSION is actually running on: the model of the
   * last REAL user message (skipping synthetic compaction parents). Whatever
   * model we pass to summarize gets stamped on the compaction parent message,
   * so it must be the worker's own model.
   */
  async function resolveSessionModel(
    sessionID: string,
    agent: string,
  ): Promise<{ providerID: string; modelID: string } | null> {
    try {
      const res = await client.session.messages({
        path: { id: sessionID },
        query: { directory },
      })
      const messages: any[] = (res as any)?.data ?? []
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        const info = m?.info
        if (info?.role !== "user") continue
        if ((m?.parts ?? []).some((p: any) => p?.type === "compaction")) continue
        if (info?.model?.providerID && info?.model?.modelID) {
          return { providerID: info.model.providerID, modelID: info.model.modelID }
        }
      }
    } catch (err) {
      log("resolve-session-model-failed", { sessionID, error: String(err) })
    }
    const fallback = agentModels.get(agent) ?? mainModel
    if (fallback && fallback.includes("/")) {
      // Config strings are "provider/model" where the model ID may itself
      // contain slashes — split on the FIRST slash only.
      const slash = fallback.indexOf("/")
      return { providerID: fallback.slice(0, slash), modelID: fallback.slice(slash + 1) }
    }
    return null
  }

  async function fireSummarize(sessionID: string): Promise<void> {
    const meta = armed.get(sessionID)
    if (!meta) return
    armed.delete(sessionID) // disarm FIRST: summarize itself causes busy->idle again

    // providerID/modelID are REQUIRED by the summarize payload schema (a
    // body-less call 400s every time), and auto:true is REQUIRED for the
    // engine to run its compaction path at all.
    const model = await resolveSessionModel(sessionID, meta.agent)
    if (!model) {
      log("summarize-skipped-no-model", { sessionID, ...meta })
      return
    }

    // STAMP BEFORE THE AWAIT. summarize is in flight for seconds; an idle
    // arriving inside that window must find the cooldown already closed and
    // the turn already consumed. Stamping on success (the old shape) left the
    // whole in-flight window open and produced two compactions per boundary.
    firedSelf.set(sessionID, Date.now())
    lastFired.set(sessionID, Date.now())
    if (meta.turnID) lastFiredTurn.set(sessionID, meta.turnID)
    // COUNTED AT FIRE TIME, like the cooldown, and NOT refunded when the
    // summarize errors below. A failed summarize is not a free retry: the
    // budget exists to bound how many times this arm may act, not how many
    // times it may succeed.
    const fires = (fireCount.get(sessionID) ?? 0) + 1
    fireCount.set(sessionID, fires)
    log("firing-summarize", { sessionID, ...meta, ...model, fires, budget: MAX_FIRES_PER_SESSION })

    const result = await client.session.summarize({
      path: { id: sessionID },
      query: { directory },
      // The vendored SDK types predate the `auto` field (verified absent from
      // SessionSummarizeData in the pinned @opencode-ai/sdk 1.18.20); the
      // 1.18.x server accepts it (the autocontinue hook this plugin relies on
      // is part of the same auto-gated path — verified present in the pinned
      // opencode 1.18.20 binary).
      body: { providerID: model.providerID, modelID: model.modelID, auto: true } as any,
    })

    if (result.error) {
      // Nothing in flight after all. The cooldown, the consumed-turn stamp
      // and the spent budget all STAY: a failed summarize is not a licence to
      // retry against the same turn at full speed, and the harness's
      // fail-closed settle wait is what turns a genuinely absent compaction
      // into an abort.
      firedSelf.delete(sessionID)
    }

    log("summarize-result", {
      sessionID,
      ok: !result.error,
      error: result.error ? JSON.stringify(result.error) : null,
    })
  }

  /**
   * Read the just-completed assistant turn: the agent (message mode) that
   * produced it, and the message id that IDENTIFIES it. Null when the read
   * fails or the session has no assistant turn — both mean "do not fire".
   *
   * NOTHING HERE READS WHAT THE TURN SAID (WO-MARKER-RIP). It used to also
   * report whether the text carried `CHUNK FINISHED`, and that boolean was the
   * arm's second condition; it is gone. The text is not evidence about whether
   * a chunk is over — the session going idle is.
   *
   * The id is what makes "one fire per turn" enforceable. A compaction does
   * not remove that turn from the transcript, so after a fire this same turn
   * is still the last assistant message and would re-qualify on any later idle
   * once the cooldown lapsed.
   */
  async function readAssistantTurn(
    sessionID: string,
  ): Promise<{ agent: string; id: string | null } | null> {
    try {
      const res = await client.session.messages({
        path: { id: sessionID },
        query: { directory },
      })
      const messages: any[] = (res as any)?.data ?? []
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        const info = m?.info
        if (info?.role !== "assistant") continue
        const agent = typeof info?.mode === "string" && info.mode.length > 0 ? info.mode : "build"
        const id = typeof info?.id === "string" && info.id.length > 0 ? info.id : null
        return { agent, id }
      }
    } catch (err) {
      log("turn-read-failed", { sessionID, error: String(err) })
    }
    return null
  }

  return {
    config: async (cfg: any) => {
      mainModel = cfg?.model ?? null
      for (const [name, def] of Object.entries<any>(cfg?.agent ?? {})) {
        if (def?.model) agentModels.set(name, def.model)
      }
    },

    event: async (input: any) => {
      const e = input?.event ?? input
      const type = e?.type
      const sessionID = e?.properties?.sessionID
      if (type === "session.idle" && sessionID && process.env.BENCH_SELF_COMPACT === "1") {
        // PHASE GATE FIRST (A2). Cheapest check, and the one that decides
        // whether this session is allowed to compact AT ALL right now. The
        // harness flags exactly one drive per chunk as `build`; every other
        // idle in the session — repair rounds, and any drive the harness is
        // holding — reads something else and stops here.
        if (!inBuildPhase(sessionID)) return

        // BUDGET. Checked before the lock because it is cheaper still and can
        // never change back: six boundaries exist, so a seventh fire is not a
        // boundary whatever the sentinel says.
        const fired = fireCount.get(sessionID) ?? 0
        if (fired >= MAX_FIRES_PER_SESSION) {
          log("fire-skipped-budget-exhausted", {
            sessionID,
            fires: fired,
            budget: MAX_FIRES_PER_SESSION,
          })
          return
        }

        // IN-FLIGHT LOCK. Taken SYNCHRONOUSLY, before the first await, and
        // held until this idle is fully handled. Every other guard here is
        // stamped after an await (the transcript read, the model resolve), so
        // a second idle arriving mid-handling would sail past all of them —
        // which is exactly what produced two compactions at the chunk-2 and
        // chunk-3 boundaries. Three debounce layers, three distinct windows:
        // this lock covers concurrent idles, the cooldown covers the minute
        // after a fire, and the turn id covers the same turn forever.
        if (inFlight.has(sessionID)) {
          log("fire-skipped-in-flight", { sessionID })
          return
        }
        inFlight.add(sessionID)
        try {
          // There is no longer an arm step to enforce the cooldown, so the
          // fire enforces it: a session that fired within COOLDOWN_MS never
          // fires again.
          if (Date.now() - (lastFired.get(sessionID) ?? 0) < COOLDOWN_MS) {
            log("fire-skipped-cooldown", { sessionID })
            return
          }
          const turn = await readAssistantTurn(sessionID)
          // No assistant turn (or an unreadable transcript) means there is
          // nothing to summarize and no id to debounce on. Do not fire.
          if (!turn) return
          // ONE FIRE PER TURN. Independent of the clock: the turn survives its
          // own compaction and is still the newest assistant message
          // afterwards, so identity — not elapsed time — is what makes a
          // second fire off the same turn impossible.
          if (turn.id && lastFiredTurn.get(sessionID) === turn.id) {
            log("fire-skipped-turn-already-fired", { sessionID, turnID: turn.id })
            return
          }
          // A TURN THAT DIED IS NOT A BOUNDARY. This idle is the stream
          // failing, not the model finishing a chunk, and summarizing here
          // diverts the agent into the compaction agent just as the harness is
          // about to nudge the turn back to life.
          const died = diedTurn.get(sessionID)
          if (died === UNREADABLE || (turn.id && died === turn.id)) {
            // The UNREADABLE case UPGRADES to the turn id we can now read, so
            // it gates exactly this turn and not the rest of the session. A
            // sticky "never compact again" would be a worse failure than the
            // one being prevented: it would silently disable every remaining
            // chunk boundary because one transcript read failed once.
            if (died === UNREADABLE && turn.id) diedTurn.set(sessionID, turn.id)
            log("fire-skipped-turn-errored", { sessionID, turnID: turn.id })
            return
          }
          armed.set(sessionID, {
            agent: turn.agent,
            reason: "build-phase idle",
            turnID: turn.id,
          })
          await fireSummarize(sessionID)
        } finally {
          inFlight.delete(sessionID)
        }
      } else if (type === "session.error" && sessionID) {
        // Mark the turn that was in flight, so the idle that follows in a few
        // milliseconds is not mistaken for a chunk boundary. Read rather than
        // assumed: the failing turn is the newest assistant message, and it
        // stays newest until a nudge produces another one.
        const turn = await readAssistantTurn(sessionID)
        if (turn?.id) {
          diedTurn.set(sessionID, turn.id)
          log("turn-errored", { sessionID, turnID: turn.id })
        } else {
          // Unreadable transcript. FAIL CLOSED for this session: without a turn
          // id there is nothing to key the skip on, and firing a summarize into
          // a session that just errored is the failure this guard exists for.
          diedTurn.set(sessionID, UNREADABLE)
          log("turn-errored-unreadable", { sessionID })
        }
      } else if (type === "session.compacted" && sessionID) {
        log("session-compacted", { sessionID, selfFired: firedSelfHas(sessionID) })
      }
    },

    "experimental.compaction.autocontinue": async (input: any, output: { enabled: boolean }) => {
      // Only touch compactions THIS plugin fired; overflow auto-compaction
      // keeps its default autocontinue (it is what keeps a mid-chunk turn
      // alive). For self-fired compactions the autocontinue is ALWAYS
      // suppressed: the bench harness sends the next chunk prompt itself.
      if (!firedSelfHas(input.sessionID)) return
      firedSelf.delete(input.sessionID)
      output.enabled = false
      log("autocontinue-suppressed", { sessionID: input.sessionID, agent: input.agent })
    },
  }
}

export default SelfCompactPlugin
