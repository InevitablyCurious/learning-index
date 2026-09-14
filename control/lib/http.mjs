// ─────────────────────────────────────────────────────────────────────────────
// CONTROL PLANE — HTTP HELPERS
//
// Split out of server.mjs (LI-14 phase 1), byte-verbatim: the three functions
// every route shares — JSON out, text out, and a capped body read. The routes
// themselves stay in server.mjs until phase 2.
// ─────────────────────────────────────────────────────────────────────────────

export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendText(res, status, text, contentType) {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

export async function readBody(req, cap = 64 * 1024) {
  return await new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) {
        rejectBody(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}
