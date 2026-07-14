import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = readFileSync(resolve(repositoryRoot, "sw.js"), "utf8");
const scope = "https://example.test/mandarin-hakka/";
const shellCache = "mandarin-hakka-shell-v1";
const audioCache = "mandarin-hakka-audio-v1";
const officialAudio = "https://hakkadict.moe.edu.tw/static/audio/hk0000014108-1-1.mp3";

class OpaqueResponse {
  constructor(label = "opaque") {
    this.label = label;
    this.type = "opaque";
    this.status = 0;
    this.ok = false;
    this.headers = new Headers();
  }

  clone() {
    return new OpaqueResponse(this.label);
  }

  async arrayBuffer() {
    throw new TypeError("opaque body is unreadable");
  }
}

function cacheKey(input) {
  const url = new URL(typeof input === "string" ? input : input.url);
  url.hash = "";
  return url.href;
}

function createWorker(fetchImplementation, { openFails = false, putFails = false } = {}) {
  const listeners = new Map();
  const stores = new Map();
  const puts = [];
  const fetchCalls = [];
  let clientsClaimed = false;

  const getStore = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };

  const cacheFor = (name) => ({
    async match(request) {
      const response = getStore(name).get(cacheKey(request));
      return response?.clone();
    },
    async put(request, response) {
      if (putFails) throw Object.assign(new Error("cache quota unavailable"), { name: "QuotaExceededError" });
      puts.push({ name, key: cacheKey(request) });
      getStore(name).set(cacheKey(request), response.clone());
    },
  });

  const caches = {
    async open(name) {
      if (openFails) throw new Error("CacheStorage unavailable");
      getStore(name);
      return cacheFor(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
  };

  const self = {
    registration: { scope },
    location: new URL(scope),
    clients: {
      async claim() {
        clientsClaimed = true;
      },
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };

  const context = vm.createContext({
    self,
    caches,
    URL,
    Request,
    Response,
    Headers,
    Promise,
    fetch: async (...args) => {
      fetchCalls.push(args);
      return fetchImplementation(...args);
    },
  });
  vm.runInContext(workerSource, context, { filename: "sw.js" });

  return {
    stores,
    puts,
    fetchCalls,
    get clientsClaimed() {
      return clientsClaimed;
    },
    seed(name, url, responseOrBody, init) {
      const response = responseOrBody instanceof Response || responseOrBody instanceof OpaqueResponse
        ? responseOrBody
        : new Response(responseOrBody, init);
      getStore(name).set(cacheKey(url), response.clone());
    },
    cached(name, url) {
      return getStore(name).get(cacheKey(url));
    },
    async cachedText(name, url) {
      const response = getStore(name).get(cacheKey(url));
      return response ? response.clone().text() : undefined;
    },
    async dispatchFetch(url, { mode = "cors", method = "GET", headers = {} } = {}) {
      const lifetimePromises = [];
      let responsePromise;
      const event = {
        request: { url, mode, method, headers: new Headers(headers) },
        respondWith(value) {
          responsePromise = Promise.resolve(value);
        },
        waitUntil(value) {
          lifetimePromises.push(Promise.resolve(value));
        },
      };

      listeners.get("fetch")(event);
      if (!responsePromise) return { handled: false };
      const response = await responsePromise;
      await Promise.all(lifetimePromises);
      return { handled: true, response };
    },
    async dispatchActivate() {
      const lifetimePromises = [];
      listeners.get("activate")({
        waitUntil(value) {
          lifetimePromises.push(Promise.resolve(value));
        },
      });
      await Promise.all(lifetimePromises);
    },
    async dispatchInstall() {
      const lifetimePromises = [];
      listeners.get("install")({
        waitUntil(value) {
          lifetimePromises.push(Promise.resolve(value));
        },
      });
      await Promise.all(lifetimePromises);
    },
    async dispatchMessage(data, { usePort = false } = {}) {
      const replies = [];
      const lifetimePromises = [];
      const receiver = { postMessage(value) { replies.push(value); } };
      listeners.get("message")({
        data,
        source: usePort ? null : receiver,
        ports: usePort ? [receiver] : [],
        waitUntil(value) {
          lifetimePromises.push(Promise.resolve(value));
        },
      });
      await Promise.all(lifetimePromises);
      return replies;
    },
  };
}

test("document, modules, and complete dictionary stay on one immutable v1 shell", async (t) => {
  const indexUrl = `${scope}index.html`;

  await t.test("app navigation uses the installed document", async () => {
    const worker = createWorker(async () =>
      new Response("new deployment", { headers: { "content-type": "text/html" } }),
    );
    worker.seed(shellCache, indexUrl, "installed shell", { headers: { "content-type": "text/html" } });

    const { response } = await worker.dispatchFetch(scope, { mode: "navigate" });
    assert.equal(await response.text(), "installed shell");
    assert.equal(worker.fetchCalls.length, 0);
  });

  await t.test("dictionary is served from the matching installed release", async () => {
    const dataUrl = `${scope}data/dictionary.json?v=1`;
    const worker = createWorker(async () => new Response('{"version":2}'));
    worker.seed(shellCache, dataUrl, '{"version":1}', {
      headers: { "content-type": "application/json" },
    });

    const { response } = await worker.dispatchFetch(dataUrl);
    assert.equal(await response.text(), '{"version":1}');
    assert.equal(worker.fetchCalls.length, 0);
  });

  await t.test("other navigation paths never receive the app fallback", async () => {
    const worker = createWorker(async () => new Response("host 404", { status: 404 }));
    worker.seed(shellCache, indexUrl, "installed shell", { headers: { "content-type": "text/html" } });

    const { response } = await worker.dispatchFetch(`${scope}missing`, { mode: "navigate" });
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "host 404");
  });
});

test("install reuses immutable v1 HTTP responses instead of redownloading the dictionary", async () => {
  const worker = createWorker(async (request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/") || url.pathname.endsWith("index.html")) {
      return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
    }
    if (url.pathname.endsWith("dictionary.json")) {
      return new Response('{"entries":[]}', { headers: { "content-type": "application/json" } });
    }
    return new Response("asset", { headers: { "content-type": "application/octet-stream" } });
  });

  await worker.dispatchInstall();

  const dictionaryCall = worker.fetchCalls.find(([request]) => request.url.includes("dictionary.json"));
  const rootCall = worker.fetchCalls.find(([request]) => new URL(request.url).pathname.endsWith("mandarin-hakka/"));
  assert.equal(dictionaryCall[0].cache, "force-cache");
  assert.equal(rootCall[0].cache, "reload");
  assert.ok(worker.cached(shellCache, `${scope}data/dictionary.json?v=1`));
});

test("official opaque audio is cached after playback and served offline", async () => {
  const worker = createWorker(async () => new OpaqueResponse("full official audio"));

  const first = await worker.dispatchFetch(officialAudio, { mode: "no-cors" });
  assert.equal(first.handled, true);
  assert.equal(first.response.type, "opaque");
  assert.equal(worker.cached(audioCache, officialAudio).type, "opaque");

  const second = await worker.dispatchFetch(officialAudio, { mode: "no-cors" });
  assert.equal(second.response.type, "opaque");
  assert.equal(worker.fetchCalls.length, 1);
});

test("a cached opaque full file is returned untouched for an offline Range request", async () => {
  const worker = createWorker(async () => {
    throw new TypeError("offline");
  });
  worker.seed(audioCache, officialAudio, new OpaqueResponse("cached full audio"));

  const { response } = await worker.dispatchFetch(officialAudio, {
    mode: "no-cors",
    headers: { range: "bytes=2-5" },
  });
  assert.equal(response.type, "opaque");
  assert.equal(worker.fetchCalls.length, 0);
});

test("online Range playback is not cached as a hidden partial opaque response", async () => {
  const worker = createWorker(async (input) => {
    if (input.headers?.get?.("range")) return new OpaqueResponse("possibly partial playback");
    return new OpaqueResponse("known full fetch");
  });

  const { response } = await worker.dispatchFetch(officialAudio, {
    mode: "no-cors",
    headers: { range: "bytes=0-99" },
  });

  assert.equal(response.label, "possibly partial playback");
  assert.equal(worker.fetchCalls.length, 2);
  assert.equal(worker.cached(audioCache, officialAudio).label, "known full fetch");
  const fullRequest = worker.fetchCalls[1][0];
  assert.equal(fullRequest.mode, "no-cors");
  assert.equal(fullRequest.headers.get("range"), null);
});

test("readable local learning audio can satisfy byte ranges offline", async () => {
  const audioUrl = `${scope}assets/hakka-audio/sixian/hk0001.mp3`;
  const worker = createWorker(async () => {
    throw new TypeError("offline");
  });
  worker.seed(audioCache, audioUrl, "0123456789", {
    headers: { "content-type": "audio/mpeg" },
  });

  const { response } = await worker.dispatchFetch(audioUrl, {
    headers: { range: "bytes=2-5" },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await response.text(), "2345");
  assert.equal(worker.fetchCalls.length, 0);
});

test("first online local Range playback fills the cache with a separate full response", async () => {
  const audioUrl = `${scope}assets/hakka-audio/dapu/hk0002.mp3`;
  const worker = createWorker(async (request) => {
    if (request.headers?.get?.("range")) {
      return new Response("01", {
        status: 206,
        headers: { "content-type": "audio/mpeg", "content-range": "bytes 0-1/10" },
      });
    }
    return new Response("0123456789", { headers: { "content-type": "audio/mpeg" } });
  });

  const { response } = await worker.dispatchFetch(audioUrl, { headers: { range: "bytes=0-1" } });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), "01");
  assert.equal(worker.fetchCalls.length, 2);
  assert.equal(worker.fetchCalls[1][0].headers.get("range"), null);
  assert.equal(await worker.cachedText(audioCache, audioUrl), "0123456789");
});

test("bulk learning-pack download accepts only same-origin curated audio and resumes", async () => {
  const firstUrl = `${scope}assets/hakka-audio/sixian/hk0001.mp3`;
  const secondUrl = `${scope}assets/hakka-audio/sixian/hk0002.mp3`;
  const worker = createWorker(async (request) =>
    new Response(`downloaded ${new URL(request.url).pathname}`, {
      headers: { "content-type": "audio/mpeg" },
    }),
  );
  worker.seed(audioCache, firstUrl, "already cached");

  const replies = await worker.dispatchMessage({
    type: "CACHE_HAKKA_AUDIO",
    accent: "sixian",
    urls: [firstUrl, secondUrl],
  });

  assert.equal(worker.fetchCalls.length, 1);
  assert.ok(worker.cached(audioCache, secondUrl));
  assert.equal(replies[0].type, "HAKKA_AUDIO_PROGRESS");
  assert.deepEqual(
    JSON.parse(JSON.stringify(replies.find((reply) => reply.type === "HAKKA_AUDIO_COMPLETE"))),
    {
      type: "HAKKA_AUDIO_COMPLETE",
      accent: "sixian",
      accentLabel: "",
      completed: 2,
      total: 2,
      downloaded: 1,
      cached: 1,
      failed: 0,
    },
  );
});

test("bulk download rejects arbitrary cross-origin and official remote URLs", async () => {
  const worker = createWorker(async () => new Response("must not fetch"));
  for (const url of [officialAudio, "https://evil.test/audio.mp3"]) {
    const replies = await worker.dispatchMessage({
      type: "CACHE_HAKKA_AUDIO",
      accent: "sixian",
      urls: [url],
    });
    assert.equal(replies.at(-1).type, "HAKKA_AUDIO_ERROR");
  }
  assert.equal(worker.fetchCalls.length, 0);
});

test("bulk download rejects a pack whose folder does not match its accent key", async () => {
  const worker = createWorker(async () => new Response("must not fetch"));
  const replies = await worker.dispatchMessage({
    type: "CACHE_HAKKA_AUDIO",
    accent: "sixian",
    urls: [`${scope}assets/hakka-audio/hailu/hk0001.mp3`],
  });
  assert.equal(replies.at(-1).type, "HAKKA_AUDIO_ERROR");
  assert.equal(worker.fetchCalls.length, 0);
});

test("an explicitly mismatched app release cannot start a bulk download", async () => {
  const worker = createWorker(async () => new Response("must not fetch"));
  const replies = await worker.dispatchMessage({
    type: "CACHE_HAKKA_AUDIO",
    release: "0",
    accent: "sixian",
    urls: [`${scope}assets/hakka-audio/sixian/hk0001.mp3`],
  });
  assert.equal(replies.at(-1).type, "HAKKA_AUDIO_ERROR");
  assert.match(replies.at(-1).message, /網站已更新/);
  assert.equal(worker.fetchCalls.length, 0);
});

test("bulk download reports partial failure instead of claiming offline completion", async () => {
  const goodUrl = `${scope}assets/hakka-audio/hailu/good.mp3`;
  const badUrl = `${scope}assets/hakka-audio/hailu/missing.mp3`;
  const worker = createWorker(async (request) =>
    request.url === badUrl ? new Response("missing", { status: 404 }) : new Response("audio"),
  );

  const replies = await worker.dispatchMessage({
    type: "CACHE_HAKKA_AUDIO",
    accent: "hailu",
    urls: [goodUrl, badUrl],
  });
  const error = replies.find((reply) => reply.type === "HAKKA_AUDIO_ERROR");
  assert.equal(error.failed, 1);
  assert.equal(error.completed, 2);
  assert.equal(replies.some((reply) => reply.type === "HAKKA_AUDIO_COMPLETE"), false);
});

test("an in-progress learning-pack download can be cancelled without a false completion", async () => {
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  const worker = createWorker(async () => {
    await fetchGate;
    return new Response("audio");
  });
  const urls = Array.from(
    { length: 8 },
    (_, index) => `${scope}assets/hakka-audio/raoping/hk${index}.mp3`,
  );

  const pendingReplies = worker.dispatchMessage({
    type: "CACHE_HAKKA_AUDIO",
    accent: "raoping",
    accentLabel: "饒平",
    urls,
  });
  await Promise.resolve();
  await Promise.resolve();
  await worker.dispatchMessage({ type: "CANCEL_HAKKA_AUDIO" });
  releaseFetch();
  const replies = await pendingReplies;

  assert.equal(replies.some((reply) => reply.type === "HAKKA_AUDIO_COMPLETE"), false);
  const cancelled = replies.find((reply) => reply.type === "HAKKA_AUDIO_CANCELLED");
  assert.equal(cancelled.accent, "raoping");
  assert.equal(cancelled.accentLabel, "饒平");
  assert.ok(cancelled.completed < cancelled.total);
});

test("clear message removes only the Hakka audio cache", async () => {
  const worker = createWorker(async () => new Response("unused"));
  worker.seed(audioCache, `${scope}assets/hakka-audio/dapu/a.mp3`, "audio");
  worker.seed(shellCache, `${scope}app.js?v=1`, "app");

  const replies = await worker.dispatchMessage({ type: "CLEAR_HAKKA_AUDIO" }, { usePort: true });
  assert.equal(replies.at(-1).type, "HAKKA_AUDIO_CLEARED");
  assert.equal(worker.stores.has(audioCache), false);
  assert.equal(worker.stores.has(shellCache), true);
});

test("other cross-origin requests remain outside this worker", async () => {
  const worker = createWorker(async () => new Response("unused"));
  const result = await worker.dispatchFetch("https://example.net/not-audio.mp3", { mode: "no-cors" });
  assert.equal(result.handled, false);
  assert.equal(worker.fetchCalls.length, 0);
});

test("activation removes only obsolete mandarin-hakka caches", async () => {
  const worker = createWorker(async () => new Response("unused"));
  worker.seed("mandarin-hakka-shell-v0", `${scope}old.js`, "old");
  worker.seed(shellCache, `${scope}app.js?v=1`, "current");
  worker.seed("mandarin-hakka-audio-v0", officialAudio, new OpaqueResponse());
  worker.seed(audioCache, `${scope}assets/hakka-audio/zhaoan/a.mp3`, "current audio");
  worker.seed("mandarin-taigi-shell-v11", `${scope}unrelated`, "other app");

  await worker.dispatchActivate();

  assert.deepEqual(
    [...worker.stores.keys()].sort(),
    ["mandarin-taigi-shell-v11", audioCache, shellCache].sort(),
  );
  assert.equal(worker.clientsClaimed, true);
});

test("worker reports v1 release/cache and has no eager lifecycle takeover", async () => {
  const worker = createWorker(async () => new Response("unused"));
  const replies = await worker.dispatchMessage({ type: "GET_RELEASE" }, { usePort: true });
  assert.deepEqual(JSON.parse(JSON.stringify(replies)), [{ release: "1", audioCache }]);
  assert.doesNotMatch(workerSource, /skipWaiting\s*\(/);
  assert.doesNotMatch(workerSource, /location\.reload\s*\(/);
});

test("all required v1 modules and the complete dictionary are install-shell members", () => {
  for (const path of [
    "app.js",
    "search.js",
    "quiz.js",
    "learning.js",
    "offline.js",
    "data/dictionary.json",
  ]) {
    assert.match(workerSource, new RegExp(`"\\.\\/${path.replaceAll(".", "\\.")}\\?v=1"`), path);
  }
});
