// The /history delete control.
//
// Delete is PERMANENT — unlike reset, which moves everything into
// runs/backups/ and can be undone. So what these cover is the gate: the
// restatement comes from the SERVER verbatim, the token binds the confirm to
// what is on disk, and every refusal reaches the operator as a pasteable
// reason rather than as a silent no-op.

import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelDelete,
  confirmDelete,
  currentToasts,
  dismissToast,
  previewDelete,
  renderDeleteConfirm,
  renderRunRow,
  toastText,
} from "./history.js";

const clear = () => { for (const t of [...currentToasts()]) dismissToast(t.id); };

function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return fn(calls).finally(() => { globalThis.fetch = real; });
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

const PLAN = {
  ok: true,
  tree_id: "1788976174",
  archived: true,
  target: "/runs/backups/1789023699",
  files: 412,
  bytes: 90_000,
  bytes_human: "88 KB",
  token: "delete-run|1788976174|files=412|bytes=90000",
  restatement:
    "Permanently delete run 1788976174. 412 files (88 KB) under /runs/backups/1789023699 " +
    "will be REMOVED FROM DISK. THIS IS NOT A RESET.",
};

test("the row offers delete, carrying the resolvable pair", () => {
  const html = renderRunRow({ benchmark_id: "backups", cell: "a/b/c", tree_id: "b", archived: true });
  assert.match(html, /data-del-run="backups"/);
  assert.match(html, /data-del-cell="a\/b\/c"/);
  assert.match(html, /class="hist-del"/);
});

test("preview shows the SERVER's restatement verbatim — the browser never rewords it", async () => {
  clear();
  await withFetch(
    async (url) => json(200, PLAN),
    async (calls) => {
      const p = await previewDelete("backups", "1789023699/1788976174/x");
      assert.equal(p.token, PLAN.token);
      const post = calls.find((c) => c.url.endsWith("/api/history/delete/preview"));
      assert.equal(post.init.method, "POST");
      // Preview must not be the thing that deletes.
      assert.ok(!calls.some((c) => c.url.endsWith("/api/history/delete")), "preview only previews");

      const html = renderDeleteConfirm({ plan: { ...PLAN, run: "r", cell: "c" } });
      assert.ok(html.includes("THIS IS NOT A RESET"), "the server's own sentence");
      assert.match(html, /data-del-go="1"/);
      assert.match(html, /data-del-cancel="1"/);
    },
  );
});

test("nothing is confirmable until a preview has been taken", async () => {
  clear();
  cancelDelete();
  await withFetch(
    async (url) => json(200, { ok: true }),
    async (calls) => {
      assert.equal(await confirmDelete(), null);
      assert.equal(calls.length, 0, "no request at all without a plan");
    },
  );
});

test("confirm sends the preview's token, and reports what was removed", async () => {
  clear();
  await withFetch(
    async (url) =>
      (url.endsWith("/preview")
        ? json(200, PLAN)
        : url.endsWith("/api/history/delete")
          ? json(200, {
              ok: true, tree_id: "1788976174", files: 412,
              bytes_human: "88 KB", deleted: "/runs/backups/1789023699",
            })
          : json(200, { ok: true, runs: [] })),
    async (calls) => {
      await previewDelete("backups", "1789023699/1788976174/x");
      await confirmDelete();
      const del = calls.find((c) => c.url.endsWith("/api/history/delete"));
      assert.deepEqual(JSON.parse(del.init.body).confirm, PLAN.token);
      const t = currentToasts().at(-1);
      assert.equal(t.code, "deleted");
      assert.equal(t.bad, false, "a success is not styled as a failure");
      assert.match(t.reason, /412 files \(88 KB\)/);
      // The list is re-read so the page cannot keep showing a run that is gone.
      assert.ok(calls.some((c) => c.url.endsWith("/api/history")), "history is reloaded");
    },
  );
});

test("cancel drops the plan and deletes nothing", async () => {
  clear();
  await withFetch(
    async (url) => json(200, PLAN),
    async (calls) => {
      await previewDelete("backups", "x");
      cancelDelete();
      assert.equal(renderDeleteConfirm({ plan: null }), "");
      assert.equal(await confirmDelete(), null);
      assert.ok(!calls.some((c) => c.url.endsWith("/api/history/delete")));
    },
  );
});

test("a refused preview toasts the reason and offers NO confirmation", async () => {
  clear();
  await withFetch(
    async (url) =>
      json(422, {
        ok: false,
        code: "unrecognised_layout",
        reason:
          "/runs/backups/x holds 1788111111, 1788976174 — expected exactly one. Nothing was deleted.",
        found: ["1788111111", "1788976174"],
      }),
    async () => {
      assert.equal(await previewDelete("backups", "x/y/z"), null);
      const t = currentToasts().at(-1);
      assert.equal(t.code, "unrecognised_layout");
      assert.match(t.reason, /Nothing was deleted/);
      assert.match(toastText(t), /found: 1788111111, 1788976174/);
      assert.equal(renderDeleteConfirm({ plan: null }), "", "no confirm button for a shape we refuse");
    },
  );
});

test("the live-tree refusal reaches the operator with what to do instead", async () => {
  clear();
  await withFetch(
    async (url) =>
      json(409, {
        ok: false,
        code: "active_tree",
        reason:
          "1789023699 is the LIVE tree — deleting it would leave active-tree.json pointing at nothing. " +
          "Reset the bench from the board first.",
      }),
    async () => {
      await previewDelete("1789023699", "x");
      const t = currentToasts().at(-1);
      assert.equal(t.code, "active_tree");
      assert.match(t.reason, /Reset the bench from the board first/);
    },
  );
});

test("a stale token is refused at confirm and surfaces as its own toast", async () => {
  clear();
  await withFetch(
    async (url) =>
      (url.endsWith("/preview")
        ? json(200, PLAN)
        : json(400, {
            ok: false,
            code: "bad_confirmation",
            reason: "the confirmation did not match what is on disk — it changed after the preview was shown.",
          })),
    async () => {
      await previewDelete("backups", "x");
      assert.equal(await confirmDelete(), null);
      const t = currentToasts().at(-1);
      assert.equal(t.code, "bad_confirmation");
      assert.match(t.reason, /changed after the preview/);
    },
  );
});
