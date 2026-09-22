// TUI MIRROR — read-only capture of an `opencode attach` screen.
//
// opencode has no endpoint that returns the rendered screen, so this runs
// `opencode attach` in a pseudo-terminal and interprets what it paints. Strictly
// read-only: nothing is ever written to the PTY (a keystroke could submit a
// prompt or abort a live cell). A second attach is a second client with its own
// scroll position, not a screen-share. The TUI uses only SGR (colour) and CUP
// (cursor position) in practice, so a small cell-grid emulator suffices;
// unimplemented sequences are skipped, never printed. The capture starts on
// demand and stops itself when nothing has polled it for a while.

import { spawn } from "node:child_process";

/** Fixed grid, so the board gets a predictable frame shape. */
const TUI_ROWS = 40;
const TUI_COLS = 130;

/**
 * How long a capture survives with no reader. Must exceed first paint (~10s),
 * or the capture is killed just before it renders.
 */
const TUI_IDLE_STOP_MS = 30000;

/** No first byte after this long is a real fault, and reported as one. */
const TUI_FIRST_PAINT_TIMEOUT_MS = 25000;

/**
 * Bound on concurrent captures (one per mirrored cell). Each capture holds a
 * PTY child process, so the map is capped: past this many, the least-recently
 * polled capture is stopped and dropped (Map insertion order is the LRU order —
 * every poll re-inserts its key at the end).
 */
export const MAX_CAPTURES = 16;

const DEFAULT_ATTACH_BIN = "opencode";

// ── the screen ───────────────────────────────────────────────────────────────

/** A cursor-addressable cell grid, style per cell (CUP can paint anywhere). */
class Screen {
  constructor(rows = TUI_ROWS, cols = TUI_COLS) {
    this.rows = rows;
    this.cols = cols;
    this.row = 0;
    this.col = 0;
    this.fg = null;
    this.bg = null;
    this.bold = false;
    this.dirty = true;
    this.cells = new Array(rows * cols);
    this.clear();
  }

  clear() {
    for (let i = 0; i < this.cells.length; i += 1) {
      this.cells[i] = { ch: " ", fg: null, bg: null, bold: false };
    }
    this.dirty = true;
  }

  put(ch) {
    if (this.row < 0 || this.row >= this.rows) return;
    if (this.col < 0 || this.col >= this.cols) return;
    const cell = this.cells[this.row * this.cols + this.col];
    cell.ch = ch;
    cell.fg = this.fg;
    cell.bg = this.bg;
    cell.bold = this.bold;
    this.col += 1;
    this.dirty = true;
  }

  /** Rows of runs: adjacent same-style cells collapse into one run. */
  serialise() {
    const out = [];
    for (let r = 0; r < this.rows; r += 1) {
      const runs = [];
      let cur = null;
      for (let c = 0; c < this.cols; c += 1) {
        const cell = this.cells[r * this.cols + c];
        if (cur && cur.fg === cell.fg && cur.bg === cell.bg && cur.bold === cell.bold) {
          cur.t += cell.ch;
        } else {
          cur = { t: cell.ch, fg: cell.fg, bg: cell.bg, bold: cell.bold };
          runs.push(cur);
        }
      }
      // Trailing blank space is dropped.
      while (runs.length && runs[runs.length - 1].t.trim() === "" && runs[runs.length - 1].bg === null) {
        runs.pop();
      }
      out.push(runs);
    }
    return out;
  }
}

// ── the parser ───────────────────────────────────────────────────────────────

/**
 * Feed bytes, mutate the screen. A PTY read can split an escape sequence, so a
 * partial one is kept for the next chunk.
 */
class AnsiParser {
  constructor(screen) {
    this.s = screen;
    this.pending = "";
  }

  write(str) {
    const buf = this.pending + str;
    this.pending = "";
    let i = 0;
    while (i < buf.length) {
      const ch = buf[i];

      if (ch !== "\x1b") {
        i += this.text(buf, i);
        continue;
      }

      // An ESC at the very end of a chunk is an incomplete sequence.
      if (i + 1 >= buf.length) { this.pending = buf.slice(i); return; }

      const next = buf[i + 1];

      if (next === "[") {
        // CSI = ESC [ params intermediates final. The intermediate bytes matter:
        // DECRQM (`ESC[?2026$p`) carries `$`, and missing it once swallowed the whole
        // stream as one incomplete sequence.
        const m = /^\x1b\[([0-9;:?<>!]*)([ -\/]*)([@-~])/.exec(buf.slice(i));
        if (!m) {
          // Incomplete only if it could still become valid; bounded.
          if (buf.length - i < 32) { this.pending = buf.slice(i); return; }
          i += 2;
          continue;
        }
        // Sequences with intermediates are queries/reports: ignore.
        if (m[2]) { i += m[0].length; continue; }
        this.csi(m[1], m[3]);
        i += m[0].length;
        continue;
      }

      // OSC/DCS/APC (terminated by BEL or ST) paint nothing: discard.
      if (next === "]" || next === "P" || next === "_" || next === "^") {
        const rest = buf.slice(i);
        const end = /\x07|\x1b\\/.exec(rest);
        if (!end) { this.pending = rest; return; }
        i += end.index + end[0].length;
        continue;
      }

      // Two-byte escapes (charset selection, keypad mode). No visual effect.
      if (next === "(" || next === ")" || next === "=" || next === ">" || next === "<") {
        i += 2;
        continue;
      }

      i += 1;
    }
  }

  /** Consume a run of printable text, honouring the control chars that matter. */
  text(buf, i) {
    const ch = buf[i];
    if (ch === "\n") { this.s.row += 1; this.s.col = 0; return 1; }
    if (ch === "\r") { this.s.col = 0; return 1; }
    if (ch === "\t") { this.s.col = Math.min(this.s.cols - 1, (Math.floor(this.s.col / 8) + 1) * 8); return 1; }
    if (ch === "\b") { this.s.col = Math.max(0, this.s.col - 1); return 1; }
    if (ch === "\x07") return 1;
    if (ch < " ") return 1;
    this.s.put(ch);
    return 1;
  }

  csi(params, final) {
    const s = this.s;
    // DEC private modes paint nothing.
    if (params.startsWith("?")) return;
    const nums = params.split(";").map((x) => (x === "" ? null : Number.parseInt(x, 10)));
    const n = (idx, dflt) => (Number.isFinite(nums[idx]) ? nums[idx] : dflt);

    switch (final) {
      case "H": case "f": // CUP — the workhorse: 1-based row;col
        s.row = n(0, 1) - 1;
        s.col = n(1, 1) - 1;
        return;
      case "A": s.row = Math.max(0, s.row - n(0, 1)); return;
      case "B": s.row = Math.min(s.rows - 1, s.row + n(0, 1)); return;
      case "C": s.col = Math.min(s.cols - 1, s.col + n(0, 1)); return;
      case "D": s.col = Math.max(0, s.col - n(0, 1)); return;
      case "G": s.col = n(0, 1) - 1; return;
      case "d": s.row = n(0, 1) - 1; return;
      case "J": { // ED
        const mode = n(0, 0);
        if (mode === 2 || mode === 3) { s.clear(); return; }
        const from = mode === 0 ? s.row * s.cols + s.col : 0;
        const to = mode === 0 ? s.cells.length : s.row * s.cols + s.col;
        for (let k = from; k < to; k += 1) s.cells[k] = { ch: " ", fg: null, bg: null, bold: false };
        s.dirty = true;
        return;
      }
      case "K": { // EL
        const mode = n(0, 0);
        const start = mode === 0 ? s.col : 0;
        const end = mode === 1 ? s.col + 1 : s.cols;
        for (let c = start; c < end; c += 1) {
          if (c >= 0 && c < s.cols) s.cells[s.row * s.cols + c] = { ch: " ", fg: null, bg: null, bold: false };
        }
        s.dirty = true;
        return;
      }
      case "X": { // ECH
        const count = n(0, 1);
        for (let c = s.col; c < Math.min(s.cols, s.col + count); c += 1) {
          s.cells[s.row * s.cols + c] = { ch: " ", fg: null, bg: null, bold: false };
        }
        s.dirty = true;
        return;
      }
      case "m": this.sgr(nums); return;
      default: return; // unimplemented — skipped, never printed as literal text
    }
  }

  sgr(nums) {
    const s = this.s;
    if (!nums.length || (nums.length === 1 && (nums[0] === null || nums[0] === 0))) {
      s.fg = null; s.bg = null; s.bold = false;
      return;
    }
    for (let i = 0; i < nums.length; i += 1) {
      const v = nums[i];
      if (v === null || v === 0) { s.fg = null; s.bg = null; s.bold = false; continue; }
      if (v === 1) { s.bold = true; continue; }
      if (v === 22) { s.bold = false; continue; }
      if (v === 39) { s.fg = null; continue; }
      if (v === 49) { s.bg = null; continue; }
      // 24-bit colour (38;2;r;g;b), which is what this TUI emits.
      if ((v === 38 || v === 48) && nums[i + 1] === 2) {
        const hex = rgb(nums[i + 2], nums[i + 3], nums[i + 4]);
        if (v === 38) s.fg = hex; else s.bg = hex;
        i += 4;
        continue;
      }
      if ((v === 38 || v === 48) && nums[i + 1] === 5) {
        const hex = xterm256(nums[i + 2]);
        if (v === 38) s.fg = hex; else s.bg = hex;
        i += 2;
        continue;
      }
      if (v >= 30 && v <= 37) { s.fg = BASIC[v - 30]; continue; }
      if (v >= 40 && v <= 47) { s.bg = BASIC[v - 40]; continue; }
      if (v >= 90 && v <= 97) { s.fg = BASIC_BRIGHT[v - 90]; continue; }
      if (v >= 100 && v <= 107) { s.bg = BASIC_BRIGHT[v - 100]; continue; }
    }
  }
}

const BASIC = ["#000000", "#cc5555", "#5ad27a", "#d7b562", "#82aaff", "#c792ea", "#5fb3b3", "#aeb9cc"];
const BASIC_BRIGHT = ["#43506a", "#ff6b6b", "#7ee08f", "#ffcb6b", "#9dbcff", "#e0b0ff", "#7fd8d8", "#e6edf6"];

function rgb(r, g, b) {
  const h = (x) => Math.max(0, Math.min(255, Number.isFinite(x) ? x : 0)).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function xterm256(i) {
  if (!Number.isFinite(i)) return null;
  if (i < 8) return BASIC[i];
  if (i < 16) return BASIC_BRIGHT[i - 8];
  if (i < 232) {
    const n = i - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    return rgb(steps[Math.floor(n / 36) % 6], steps[Math.floor(n / 6) % 6], steps[n % 6]);
  }
  const g = 8 + (i - 232) * 10;
  return rgb(g, g, g);
}

// ── the capture ──────────────────────────────────────────────────────────────

/**
 * One live capture of one session. Owns the child process, the screen, and the
 * idle timer that stops it.
 */
class Capture {
  constructor({ sessionId, serveUrl, bin }) {
    this.sessionId = sessionId;
    this.serveUrl = serveUrl;
    this.bin = bin;
    this.screen = new Screen();
    this.parser = new AnsiParser(this.screen);
    this.child = null;
    this.startedAt = null;
    this.lastReadAt = null;
    this.lastPollAt = Date.now();
    this.bytes = 0;
    this.error = null;
    this.exited = null;
    this.frame = null;
  }

  start() {
    if (this.child) return;
    // A fresh attach is not detached.
    this.detached = false;
    // `script -q /dev/null <cmd>` gives a PTY without a native dependency; the
    // child's stdin is ignored, so nothing can reach the session. The PTY size must
    // be set inside it with `stty` before exec: apps read the size via ioctl, not
    // from COLUMNS/LINES (kept anyway, harmlessly), and without stty the PTY is 80×24.
    const inner =
      `stty rows ${TUI_ROWS} cols ${TUI_COLS} 2>/dev/null; ` +
      `exec ${shQuote(this.bin)} attach ${shQuote(this.serveUrl)} --session ${shQuote(this.sessionId)}`;
    const argv = ["-q", "/dev/null", "sh", "-c", inner];
    try {
      this.child = spawn("script", argv, {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLUMNS: String(TUI_COLS),
          LINES: String(TUI_ROWS),
          // Stop the client adapting to the terminal it thinks it has.
          NO_COLOR: "",
          CI: "",
        },
      });
    } catch (err) {
      this.error = `could not spawn capture: ${String(err?.message ?? err)}`;
      return;
    }

    this.startedAt = Date.now();

    this.child.stdout.on("data", (chunk) => {
      this.bytes += chunk.length;
      this.lastReadAt = Date.now();
      this.parser.write(chunk.toString("utf8"));
    });
    // stderr is for diagnosis only, never screen content.
    this.child.stderr.on("data", (chunk) => {
      const s = chunk.toString("utf8").trim();
      if (s) this.error = s.slice(0, 300);
    });
    this.child.on("error", (err) => { this.error = String(err?.message ?? err); });
    this.child.on("exit", (code, signal) => {
      this.exited = { code, signal: signal ?? null, at: Date.now() };
      this.child = null;
    });
  }

  stop() {
    const c = this.child;
    this.child = null;
    // Detached is set at once (the exit handler lands later), so a torn-down mirror
    // never reports live.
    this.detached = true;
    if (!c) return;
    // SIGTERM first so the client drops its session cleanly.
    try { c.kill("SIGTERM"); } catch { /* already gone */ }
    setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* already gone */ } }, 1500);
  }

  /** Serialise only when the screen changed since the last poll. */
  read() {
    this.lastPollAt = Date.now();
    if (this.screen.dirty || !this.frame) {
      this.frame = this.screen.serialise();
      this.screen.dirty = false;
    }
    // A blank screen has distinct causes (starting vs died) with opposite remedies.
    const waited = this.startedAt ? Date.now() - this.startedAt : 0;
    let status = "live";
    let reason = null;
    if (this.detached) {
      // Checked first: torn down with the cell, not crashed. The last frame is kept
      // and labelled as history.
      status = "detached";
      reason = "the cell was stopped and the mirror was closed with it — this is the last frame, not a live view";
    } else if (this.exited) {
      status = "exited";
      reason = `capture client exited (code ${this.exited.code ?? "?"}${this.exited.signal ? `, ${this.exited.signal}` : ""})`;
    } else if (this.error && this.bytes === 0) {
      status = "failed";
      reason = this.error;
    } else if (this.bytes === 0 && waited < TUI_FIRST_PAINT_TIMEOUT_MS) {
      status = "starting";
      reason = "attaching — the client connects and loads history before it paints";
    } else if (this.bytes === 0) {
      status = "silent";
      reason = `no output after ${Math.round(waited / 1000)}s — the attach client produced nothing`;
    }

    return {
      session_id: this.sessionId,
      running: Boolean(this.child),
      status,
      reason,
      rows: this.screen.rows,
      cols: this.screen.cols,
      frame: this.frame,
      bytes: this.bytes,
      started_at: this.startedAt,
      last_data_at: this.lastReadAt,
      painted: this.bytes > 0,
      error: this.error,
      exited: this.exited,
    };
  }

  idleFor(now) {
    return now - this.lastPollAt;
  }
}

/**
 * POSIX single-quote escaping: the capture execs through `sh -c` (for stty),
 * so every interpolated value crosses a shell.
 */
function shQuote(s) {
  return `'${String(s ?? "").replace(/'/g, `'\\''`)}'`;
}

// ── the manager ──────────────────────────────────────────────────────────────

/** One bounded capture per mirrored cell, keyed on the run identity. */
export class TuiMirror {
  constructor({ serveUrl, bin = DEFAULT_ATTACH_BIN }) {
    this.serveUrl = serveUrl;
    this.bin = bin;
    /** runId → Capture, bounded by MAX_CAPTURES with LRU eviction. */
    this.captures = new Map();
    this.sweeper = setInterval(() => this.sweep(), 2000);
    // Never hold the process open on this timer alone.
    if (this.sweeper.unref) this.sweeper.unref();
  }

  /**
   * Poll a frame of the cell identified by `runId`, starting its capture if
   * needed. Polling is the keepalive. `serveUrl` is that cell's own serve URL
   * (each concurrent cell has its own port); it falls back to the process
   * default only when unresolved. The payload carries `run_id` so downstream
   * can key on it.
   */
  pollFor(runId, sessionId, serveUrl) {
    if (!sessionId) {
      return {
        running: false,
        run_id: runId ?? null,
        session_id: null,
        frame: null,
        reason: "no session observed yet — the TUI mirror attaches to the running cell's session.",
      };
    }

    let capture = this.captures.get(runId);
    if (capture && capture.sessionId !== sessionId) {
      // The cell moved to a new session: drop the old view.
      capture.stop();
      this.captures.delete(runId);
      capture = null;
    }

    if (!capture) {
      capture = new Capture({
        sessionId,
        serveUrl: serveUrl ?? this.serveUrl,
        bin: this.bin,
      });
      this.captures.set(runId, capture);
      capture.start();
      this.evict();
    }

    // LRU touch: re-inserting moves this runId to the end of the Map order.
    this.captures.delete(runId);
    this.captures.set(runId, capture);

    return { ...capture.read(), run_id: runId };
  }

  /** Enforce MAX_CAPTURES by stopping the least-recently-polled captures. */
  evict() {
    while (this.captures.size > MAX_CAPTURES) {
      const lru = this.captures.keys().next().value;
      this.captures.get(lru).stop();
      this.captures.delete(lru);
    }
  }

  /** Stop captures nobody is reading. */
  sweep() {
    const now = Date.now();
    for (const [runId, capture] of this.captures) {
      if (capture.idleFor(now) > TUI_IDLE_STOP_MS) {
        capture.stop();
        this.captures.delete(runId);
      }
    }
  }

  shutdown() {
    clearInterval(this.sweeper);
    for (const capture of this.captures.values()) capture.stop();
    this.captures.clear();
  }
}
