// `api()` must never consume a non-2xx body as a successful response.
//
// Measured on a real conformance run: the candidate's server 500s on cold
// start ("no active game") when /api/debug/state is seeded before /api/new.
// The 500's JSON body was returned to callers as if it were a state object,
// so the pregate's field-loop emitted ~20 phantom "missing field" complaints
// while the one accurate gate (REQ-DEBUG/debug.setState) never fired.
//
// This is a grader self-test: it grades the grader, never the candidate, and
// lives in meta/ which is excluded from the roster.

import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/harness.ts";

function stubFetch(status: number, body: string, contentType = "application/json") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status, headers: { "content-type": contentType } })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api() non-2xx handling", () => {
  it("throws on a 500, carrying the HTTP status and the body's error detail", async () => {
    stubFetch(500, JSON.stringify({ error: "no active game" }));
    await expect(api("/api/debug/state", { turn: "white" })).rejects.toThrow(
      /HTTP 500 .*no active game/,
    );
  });

  it("keeps the raw body as the detail when the error body is not JSON", async () => {
    stubFetch(502, "Bad Gateway", "text/plain");
    await expect(api("/api/roll")).rejects.toThrow(/HTTP 502 .*Bad Gateway/);
  });

  it("still returns the parsed JSON body on a 2xx", async () => {
    stubFetch(200, JSON.stringify({ dice: [6, 1] }));
    await expect(api("/api/roll")).resolves.toEqual({ dice: [6, 1] });
  });
});
