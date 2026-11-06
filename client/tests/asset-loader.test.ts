import assert from "node:assert/strict";
import test from "node:test";
import {
  HttpError,
  fetchJson,
  loadAll,
  loadJson,
} from "../src/asset-loader.js";

test("fetchJson checks HTTP status and does not retry a 4xx response", async (t) => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response("missing", { status: 404, statusText: "Not Found" });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(fetchJson("/missing"), (error) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 404);
    return true;
  });
  await assert.rejects(loadJson("/missing"), HttpError);
  assert.equal(requests, 2);
});

test("loadAll starts assets concurrently and reports progress per file", async (t) => {
  const originalFetch = globalThis.fetch;
  const started = [];
  const releases = [];
  globalThis.fetch = (url) =>
    new Promise((resolve) => {
      started.push(String(url));
      releases.push(() =>
        resolve(new Response(JSON.stringify({ url }), { status: 200 })),
      );
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const progress = [];
  const loading = loadAll(
    {
      assets: [
        { key: "one", type: "json", url: "/one.json" },
        { key: "two", type: "json", url: "/two.json" },
      ],
    },
    { onProgress: (event) => progress.push(event) },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ["/one.json", "/two.json"]);
  for (const release of releases) release();
  const assets = await loading;
  assert.equal(assets.size, 2);
  assert.equal(progress.filter((event) => event.status === "loaded").length, 2);
});

test("loadAll aborts sibling requests when one asset fails", async (t) => {
  const originalFetch = globalThis.fetch;
  let siblingAborted = false;
  globalThis.fetch = (url, { signal }) => {
    if (String(url) === "/missing.json") {
      return Promise.resolve(
        new Response("missing", { status: 404, statusText: "Not Found" }),
      );
    }
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          siblingAborted = true;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    loadAll({
      assets: [
        { key: "missing", type: "json", url: "/missing.json" },
        { key: "pending", type: "json", url: "/pending.json" },
      ],
    }),
    (error) => error instanceof HttpError && error.status === 404,
  );
  assert.equal(siblingAborted, true);
});

test("broken JSON rejects cleanly without a retry loop when retries are disabled", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("{broken", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(loadJson("/broken.json", { retries: 0 }), SyntaxError);
});

test("a timed-out asset request is aborted and reported", async (t) => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (_url, { signal }) => {
    requests += 1;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    loadJson("/slow.json", { timeoutMs: 5, retries: 0 }),
    (error) => error.name === "TimeoutError",
  );
  assert.equal(requests, 1);
});
