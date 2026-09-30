# Reference, not given to the model

`CONTRACT.md` was the master specification for the backgammon task: the full
interface and every behavioural requirement. It moved out of `scaffold/` on
2026-09-15 and was retired entirely on 2026-09-19, when its rules were
relocated into the five build prompts in `../prompts/`.

The five build prompts in `../prompts/` are now the complete specification —
file and function names, board and state shapes, routes, page tags, the exact
wording tests search for, and the full rules of backgammon (movement, hitting,
bar entry, bear-off, dice usage, the higher-die rule, the doubling cube, win
classification). There is no separate spec file any more.

If you change what the tests require, change the prompts too.

## Authoring a check — gotchas (2026-09-29)

Three traps when writing a new grader check for this task, earned the hard way.

**Testid enumeration misses runtime-assigned testids.** A `grep -rn "data-testid"` over the golden finds only literal HTML attributes — the board's `checker` testid has no such attribute; it is assigned at runtime via `dataset.testid` (`golden/public/app.js:82` and `:166`, `el.dataset.testid = "checker"`), and the only `data-testid="checker"` a grep returns is a comment (`app.js:163`). Enumerate testids by reading the code, not by grepping for `data-testid=`.

**`grader/feedback.json` and `failures/*.md` are two hand-maintained copies.** The `.md` files are the runtime source; `feedback.json` is a byte-mirror read by preflight/tests. There is no committed sync script — a check that adds complaint text must write BOTH (294 gates / 588 one-line files as of 2026-09-29), or the mirror test desyncs preflight from the runtime.

**`[aspect: X]` / `[needs: ids]` are assertion-message tokens, not file headers.** They live inside the `.spec.ts` assertion message (e.g. `core.spec.ts:1029`); a `failures/*.md` file is a single one-line complaint with the aspect encoded in the filename (`F-47.undo.md` → key `F47.undo`, transform at `harness/adapters/challenge/feedback.py:119-134`). A new check therefore touches several surfaces at once: the `.spec.ts` assertion, `failures/<GATE>.md` + `-repeat.md` (plus `<GATE>.<aspect>.md` + `-repeat.md` for a new aspect), `feedback.json`, and a `checks.json` stage for a new token.
