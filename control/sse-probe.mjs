// LIVE SSE PROBE — a real socket, no mocks.
//
//   node sse-probe.mjs
//
// Checks what unit tests can't: a frame split across TCP writes is parsed
// whole, and the subscriber reconnects after the server dies mid-stream (as a
// cell's serve does at teardown). Payloads are the worker's real schema shapes.

import { createServer } from "node:http";
import { EventRing, subscribe } from "./events.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

async function main() {
  const ring = new EventRing(100);
  let connections = 0;
  let openRes = null;

  const server = createServer((req, res) => {
    if (req.url !== "/event") {
      res.writeHead(404).end();
      return;
    }
    connections += 1;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    openRes = res;

    sse(res, { id: "evt_conn", type: "server.connected", properties: {} });

    if (connections === 1) {
      // A real tool call, exactly as the worker's schema declares it.
      sse(res, {
        id: "evt_tool",
        type: "session.next.tool.called",
        properties: {
          timestamp: Date.now(),
          sessionID: "ses_probe",
          assistantMessageID: "msg_1",
          callID: "call_1",
          tool: "edit",
          input: { filePath: "/work/src/game.ts" },
        },
      });
      sse(res, {
        id: "evt_file",
        type: "file.edited",
        properties: { file: "/work/src/game.ts" },
      });

      // ── SPLIT FRAME ── two TCP writes with a gap.
      const frame = `data: ${JSON.stringify({
        id: "evt_split",
        type: "session.next.reasoning.delta",
        properties: {
          timestamp: Date.now(),
          sessionID: "ses_probe",
          assistantMessageID: "msg_1",
          reasoningID: "r1",
          delta: "the doubling cube must be owned before it can be offered",
        },
      })}\n\n`;
      const cut = Math.floor(frame.length / 2);
      res.write(frame.slice(0, cut));
      setTimeout(() => res.write(frame.slice(cut)), 120);

      // Kill the stream to force a reconnect.
      setTimeout(() => res.destroy(), 400);
    } else {
      // Traffic after the reconnect proves recovery.
      sse(res, {
        id: "evt_after",
        type: "session.next.step.ended",
        properties: {
          timestamp: Date.now(),
          sessionID: "ses_probe",
          assistantMessageID: "msg_2",
          finish: "stop",
          tokens: { input: 1200, output: 340, reasoning: 88 },
        },
      });
    }
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  console.log(`live SSE probe on 127.0.0.1:${port}\n`);

  const stop = subscribe(`http://127.0.0.1:${port}/event`, ring, {
    minBackoffMs: 200,
    maxBackoffMs: 400,
  });

  await sleep(900);
  const first = ring.snapshot({ limit: 50 });

  check("connected to a real socket", ring.total > 0, `total=${ring.total}`);
  check(
    "tool call mapped with its tool name",
    first.events.some((e) => e.kind === "tool" && e.tool === "edit"),
  );
  check(
    "file edit mapped with its path",
    first.events.some((e) => e.kind === "file" && e.file === "/work/src/game.ts"),
  );
  check(
    "FRAME SPLIT ACROSS TCP CHUNKS was reassembled",
    first.events.some((e) => e.kind === "thinking" && /doubling cube/.test(e.text ?? "")),
    "(a chunk-per-frame parser fails exactly here)",
  );
  check(
    "server.connected is counted as unmapped, not rendered",
    ring.unmapped > 0 && !first.events.some((e) => e.type === "server.connected"),
    `unmapped=${ring.unmapped}`,
  );

  // Wait out the backoff.
  await sleep(1400);
  const after = ring.snapshot({ limit: 50 });

  check("RECONNECTED after the stream died", connections >= 2, `connections=${connections}`);
  check("feed reports itself connected again", ring.connected === true);
  check(
    "ingested events after the reconnect",
    after.events.some((e) => e.type === "session.next.step.ended"),
  );

  // Bounding must hold on a real feed.
  const small = new EventRing(3);
  for (let i = 0; i < 10; i += 1) {
    small.push({ id: `e${i}`, type: "file.edited", properties: { file: `/f${i}` } });
  }
  const snap = small.snapshot();
  check(
    "ring stays bounded and admits it capped",
    snap.retained === 3 && snap.total === 10 && snap.capped === true,
    `retained=${snap.retained} total=${snap.total}`,
  );

  stop();
  try {
    openRes?.destroy();
  } catch {
    /* already gone */
  }
  server.close();

  console.log(failures === 0 ? "\nSSE PROBE PASSED" : `\nSSE PROBE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
