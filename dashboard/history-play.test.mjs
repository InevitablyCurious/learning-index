// The /history "view result" control.
//
// The page is the only surface from which a person can PLAY what a model built,
// and playing it is the only check the system has on whether the grading is
// telling the truth. So these cover both halves the traps file warns about: the
// pure renderer, AND the delegated click that has to reach it — a renderer
// covered by tests while nothing ever drives the dispatch is how a dead button
// ships green.

import assert from "node:assert/strict";
import test from "node:test";

import {
  boot,
  loadControlBase,
  loadPlaying,
  playUrl,
  renderPlayNote,
  renderRunRow,
  startPlay,
  stopPlay,
} from "./history.js";

const RUN = {
  benchmark_id: "1789023699",
  cell: "local/prov/campaign/memoryOFF/cell-0000",
  dev_mode_enabled: false,
  checkpoints_dir: "/runs/x/checkpoints",
  transcript_file: "/runs/x/transcript.md",
};

// ── renderer ────────────────────────────────────────────────────────────────

test("renderRunRow: the play control is a SIBLING of the row, never nested", () => {
  const html = renderRunRow(RUN);
  assert.match(html, /class="hist-rowwrap"/);
  assert.match(html, /data-play-run="1789023699"/);
  assert.match(html, /data-play-cell="local\/prov\/campaign\/memoryOFF\/cell-0000"/);
  assert.match(html, /view result/);
  // A <button> inside a <button> is invalid markup and the inner click is
  // never delivered — so the row button must be CLOSED before the play one.
  const rowClose = html.indexOf("</button>");
  const playOpen = html.indexOf("data-play-run");
  assert.ok(rowClose < playOpen, "the row button must close before the play button opens");
});

test("renderRunRow: escapes identifiers into the data attributes", () => {
  const html = renderRunRow({ ...RUN, cell: 'a"b<c' });
  assert.ok(!html.includes('data-play-cell="a"b<c"'), "raw quotes must not reach the attribute");
  assert.match(html, /data-play-cell="a&quot;b&lt;c"/);
});

test("renderPlayNote: nothing playing renders nothing at all", () => {
  assert.equal(renderPlayNote({}), "");
  assert.equal(renderPlayNote(null), "");
});

test("renderPlayNote: a refusal is shown verbatim, in an alert", () => {
  const html = renderPlayNote({ error: "this build ignores the PORT it is given" });
  assert.match(html, /role="alert"/);
  assert.match(html, /ignores the PORT it is given/);
});

test("renderPlayNote: a live game offers its link and a stop", () => {
  const html = renderPlayNote({
    playing: { run: "r", cell: "c", url: "http://localhost:51234/" },
  });
  assert.match(html, /href="http:\/\/localhost:51234\/"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener"/);
  assert.match(html, /data-play-stop="1"/);
});

// ── loaders ─────────────────────────────────────────────────────────────────

function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return fn(calls).finally(() => {
    globalThis.fetch = real;
  });
}

const json = (status, body) => ({
  ok: status < 400,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

// The play URL is rebuilt from the browser's own hostname, so a test that
// drives that path has to say which host the "browser" is on. Node has no
// location; install one for the call and put things back afterward, the same
// way withFetch swaps fetch.
function withLocation(hostname, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "location");
  const real = globalThis.location;
  globalThis.location = { hostname };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (had) globalThis.location = real;
      else delete globalThis.location;
    });
}

test("startPlay: posts to the control plane the BOARD named, not a guessed port", async () => {
  await withFetch(
    async (url) => {
      if (url.endsWith("/api/control-base")) {
        return json(200, { ok: true, base_url: "http://bench-host:7718" });
      }
      return json(200, { ok: true, url: "http://localhost:51234/", port: 51234, pid: 7 });
    },
    async (calls) => {
      const opened = [];
      const r = await startPlay("1789023699", "cell-0000", (u) => opened.push(u));
      assert.equal(r.port, 51234);
      const post = calls.find((c) => c.url.endsWith("/api/play/start"));
      assert.ok(post, "must post to /api/play/start");
      assert.equal(post.url, "http://bench-host:7718/api/play/start");
      assert.equal(post.init.method, "POST");
      assert.deepEqual(JSON.parse(post.init.body), {
        run: "1789023699",
        cell: "cell-0000",
      });
      // Node has no location, so there is no hostname to swap in: the
      // spawner's url passes through verbatim — the playUrl fallback.
      assert.deepEqual(opened, ["http://localhost:51234/"]);
    },
  );
});

test("startPlay: a refusal reason reaches the page and no tab is opened", async () => {
  await withFetch(
    async (url) =>
      url.endsWith("/api/control-base")
        ? json(200, { ok: true, base_url: "http://c:7718" })
        : json(409, { ok: false, code: "port_ignored", reason: "this build ignores the PORT" }),
    async () => {
      const opened = [];
      const r = await startPlay("r", "c", (u) => opened.push(u));
      assert.equal(r, null);
      assert.deepEqual(opened, [], "a refused start must not open a tab");
      assert.match(renderPlayNote({ error: "this build ignores the PORT" }), /ignores the PORT/);
    },
  );
});

test("startPlay: says so plainly when the board cannot name a control plane", async () => {
  await withFetch(
    async () => json(500, {}),
    async (calls) => {
      // Clear any base learned by an earlier test: a failed read sets it to
      // null, which is exactly the state this case is about.
      await loadControlBase("");
      calls.length = 0;
      const r = await startPlay("r", "c", () => {});
      assert.equal(r, null);
      assert.ok(
        !calls.some((c) => c.url.includes("/api/play/start")),
        "must not post into the void",
      );
    },
  );
});

test("stopPlay: posts stop and never throws when the control plane is unreachable", async () => {
  await withFetch(
    async (url) => {
      if (url.endsWith("/api/control-base")) return json(200, { ok: true, base_url: "http://c:7718" });
      throw new Error("connection refused");
    },
    async () => {
      await stopPlay(); // must resolve
    },
  );
});

// ── the url must be openable from the device the operator is on ─────────────
//
// The control plane reports http://localhost:<port>/ — correct on the bench
// host, and on an iPad it is the iPad. The artifact binds every interface, so
// the browser's own hostname plus the spawner's port is the reachable address.

test("playUrl: keeps the spawner's port, swaps in the browser's host", async () => {
  await withLocation("192.168.50.140", () => {
    assert.equal(playUrl(51234, "http://localhost:51234/"), "http://192.168.50.140:51234/");
  });
});

test("playUrl: an IPv6 host is bracketed exactly once", async () => {
  await withLocation("fe80::1", () => {
    assert.equal(playUrl(5, "http://localhost:5/"), "http://[fe80::1]:5/");
  });
  await withLocation("[fe80::1]", () => {
    assert.equal(playUrl(5, "http://localhost:5/"), "http://[fe80::1]:5/");
  });
});

test("playUrl: no usable port, or no hostname, falls back to the spawner's url", async () => {
  await withLocation("192.168.50.140", () => {
    // A refusal carries no port; anything undialable is not a port either.
    assert.equal(playUrl(undefined, "http://localhost:5/"), "http://localhost:5/");
    assert.equal(playUrl(null, "http://localhost:5/"), "http://localhost:5/");
    assert.equal(playUrl("nope", "http://localhost:5/"), "http://localhost:5/");
  });
  // No location at all (Node, or a page with no hostname to trust): verbatim.
  assert.equal(playUrl(5, "http://localhost:5/"), "http://localhost:5/");
});

test("startPlay: the tab it opens is reachable from the operator's device", async () => {
  await withLocation("192.168.50.140", () =>
    withFetch(
      async (url) =>
        url.endsWith("/api/control-base")
          ? json(200, { ok: true, base_url: "http://c:7718" })
          : json(200, { ok: true, url: "http://localhost:51234/", port: 51234, pid: 7 }),
      async () => {
        const opened = [];
        await startPlay("r", "c", (u) => opened.push(u));
        // The spawner said localhost — but the device this page was opened
        // on is not the bench host, so the tab must carry the LAN host.
        assert.deepEqual(opened, ["http://192.168.50.140:51234/"]);
      },
    ),
  );
});

test("loadPlaying: the stored game keeps the spawner's port but this browser's host", async () => {
  await withLocation("192.168.50.140", () =>
    withFetch(
      async () =>
        json(200, {
          ok: true,
          playing: {
            pid: 7,
            port: 51234,
            url: "http://localhost:51234/",
            run: "r",
            cell: "c",
            started_at: "2026-09-17T00:00:00Z",
          },
        }),
      async () => {
        const p = await loadPlaying("");
        assert.equal(p.url, "http://192.168.50.140:51234/");
        assert.equal(p.port, 51234);
        assert.equal(p.pid, 7);
        // The anchor and the re-open-saved-url path both read this stored
        // url, so the LAN host has to be what they render and re-open.
        assert.match(renderPlayNote({ playing: p }), /href="http:\/\/192\.168\.50\.140:51234\/"/);
      },
    ),
  );
});

// ── the delegated click actually reaches it ─────────────────────────────────

test("boot: clicking the play control starts a play and does NOT select the row", async () => {
  const handlers = [];
  const runEl = {
    getAttribute: (k) => ({ "data-run": "R", "data-cell": "C" })[k] ?? null,
  };
  const playEl = {
    getAttribute: (k) => ({ "data-play-run": "R", "data-play-cell": "C" })[k] ?? null,
  };
  // A click on the play button: `closest` finds the play hooks, and would also
  // find the row's if the markup nested them — the dispatch order is what makes
  // the play branch win.
  const target = {
    closest: (sel) => {
      if (sel === "[data-play-stop]") return null;
      if (sel === "[data-play-run]") return playEl;
      if (sel === "[data-run]") return runEl;
      return null;
    },
  };

  const realDoc = globalThis.document;
  const toastHandlers = [];
  // TWO roots now: the page, and the fixed toast layer that lives outside it.
  // A toast's copy button is not inside #history-root, so its clicks would
  // never reach the page listener — hence a listener of its own.
  globalThis.document = {
    getElementById: (id) => ({
      addEventListener: (_type, fn) => (id === "toasts" ? toastHandlers : handlers).push(fn),
      set innerHTML(_v) {},
      get innerHTML() { return ""; },
    }),
  };
  try {
    await withFetch(
      async (url) =>
        url.endsWith("/api/control-base")
          ? json(200, { ok: true, base_url: "http://c:7718" })
          : json(200, { ok: true, playing: null, url: "http://localhost:1/", port: 1, pid: 2 }),
      async (calls) => {
        boot();
        assert.equal(handlers.length, 1, "exactly one delegated listener on the page");
        assert.equal(toastHandlers.length, 1, "and one on the toast layer");
        handlers[0]({ target });
        await new Promise((r) => setTimeout(r, 20));
        assert.ok(
          calls.some((c) => c.url.endsWith("/api/play/start")),
          "the click must reach /api/play/start",
        );
        assert.ok(
          !calls.some((c) => c.url.includes("/api/history/checkpoints")),
          "and must not also select the row",
        );
      },
    );
  } finally {
    globalThis.document = realDoc;
  }
});

// ── the two defects found on first real use (2026-09-10) ────────────────────

test("renderPlayNote: a build that answers /health but not / says so", () => {
  // The scaffold ships a working /health and a serveStatic that throws, so a
  // seeded-not-yet-built cell boots perfectly and serves a raw 500. The first
  // real click produced exactly this and no way to tell what it meant.
  const html = renderPlayNote({
    playing: {
      run: "r",
      cell: "c",
      url: "http://localhost:5/",
      page_status: 500,
      page_excerpt: '{"error":"Error: not implemented"}',
    },
  });
  assert.match(html, /answered HTTP 500/);
  assert.match(html, /not implemented/);
  assert.match(html, /still be building/);
});

test("renderPlayNote: a healthy page carries no warning at all", () => {
  const html = renderPlayNote({
    playing: { run: "r", cell: "c", url: "http://localhost:5/", page_status: 200, page_excerpt: "<html>" },
  });
  assert.ok(!html.includes("hist-warn"), "200 must not warn");
});

test("renderPlayNote: an unreadable page is reported, never treated as fine", () => {
  const html = renderPlayNote({
    playing: { run: "r", cell: "c", url: "http://localhost:5/", page_status: null, page_excerpt: "fetch failed" },
  });
  assert.match(html, /could not be read/);
  assert.match(html, /fetch failed/);
});

test("renderRunRow: shows the run's OWN id, not the resolvable half", () => {
  // Every archived row carries benchmark_id "backups"; labelling a dozen runs
  // "backups" is how this page showed one entry and looked broken.
  const html = renderRunRow({
    ...RUN,
    benchmark_id: "backups",
    tree_id: "1788804359",
    archived: true,
    cell: "1788842999/1788804359/local/x/memoryOFF/cell-0000",
  });
  assert.match(html, /1788804359/);
  assert.match(html, /archived/);
  // …but the resolvable pair is still what the click carries.
  assert.match(html, /data-play-run="backups"/);
  assert.match(html, /data-play-cell="1788842999\/1788804359\//);
});

test("renderRunRow: the live tree is marked as such", () => {
  const html = renderRunRow({ ...RUN, tree_id: RUN.benchmark_id, archived: false });
  assert.match(html, /live tree/);
});
