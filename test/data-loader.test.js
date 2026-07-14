import test from "node:test";
import assert from "node:assert/strict";

import {
  loadValidatedJson,
  requestPersistentStorage,
} from "../data-loader.js";

const baseUrl = "https://example.test/mandarin-hakka/";
const canonicalUrl = "./data/dictionary-core.json?v=3";
const canonicalHref = `${baseUrl}data/dictionary-core.json?v=3`;
const primaryUrl = "https://cdn.example.test/pinned/dictionary-core.json";
const cacheName = "mandarin-hakka-data-v3";

function cacheKey(input) {
  return new URL(typeof input === "string" ? input : input.url).href;
}

function createCacheStorage() {
  const stores = new Map();
  const puts = [];
  const deletes = [];
  const store = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  return {
    puts,
    deletes,
    async open(name) {
      const entries = store(name);
      return {
        async match(request) {
          return entries.get(cacheKey(request))?.clone();
        },
        async put(request, response) {
          puts.push(cacheKey(request));
          entries.set(cacheKey(request), response.clone());
        },
        async delete(request) {
          deletes.push(cacheKey(request));
          return entries.delete(cacheKey(request));
        },
      };
    },
    seed(name, url, body) {
      store(name).set(cacheKey(url), new Response(body, {
        headers: { "content-type": "application/json" },
      }));
    },
    async text(name, url) {
      return store(name).get(cacheKey(url))?.clone().text();
    },
  };
}

function validateRevision(value) {
  if (value?.revision !== "wanted") throw new TypeError("wrong revision");
  return { ...value, validated: true };
}

function loaderOptions(overrides = {}) {
  return {
    canonicalUrl,
    primaryUrl,
    cacheName,
    baseUrl,
    validate: validateRevision,
    ...overrides,
  };
}

test("an already validated canonical payload opens locally with zero network requests", async () => {
  const cacheStorage = createCacheStorage();
  cacheStorage.seed(cacheName, canonicalHref, JSON.stringify({ revision: "wanted", from: "local" }));
  let fetches = 0;

  const result = await loadValidatedJson(loaderOptions({
    cacheStorage,
    fetchImpl: async () => {
      fetches += 1;
      throw new Error("network must not run");
    },
  }));

  assert.equal(result.source, "cache");
  assert.equal(result.stored, true);
  assert.equal(result.value.from, "local");
  assert.equal(result.value.validated, true);
  assert.equal(fetches, 0);
  assert.equal(cacheStorage.puts.length, 0, "cache hits must not rewrite the payload");
});

test("a pinned CDN payload is validated and stored under the same-origin canonical key", async () => {
  const cacheStorage = createCacheStorage();
  const requests = [];
  const result = await loadValidatedJson(loaderOptions({
    cacheStorage,
    fetchImpl: async (request) => {
      requests.push(request);
      return new Response(JSON.stringify({ revision: "wanted", from: "cdn" }));
    },
  }));

  assert.equal(result.source, "primary");
  assert.equal(result.stored, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, primaryUrl);
  assert.equal(requests[0].credentials, "omit");
  assert.equal(cacheStorage.puts[0], canonicalHref);
  assert.equal(
    await cacheStorage.text(cacheName, canonicalHref),
    JSON.stringify({ revision: "wanted", from: "cdn" }),
  );
});

test("a failed CDN request falls back to GitHub Pages and stores the verified result", async () => {
  const cacheStorage = createCacheStorage();
  const requests = [];
  const result = await loadValidatedJson(loaderOptions({
    cacheStorage,
    fetchImpl: async (request) => {
      requests.push(request.url);
      if (request.url === primaryUrl) throw new TypeError("CDN unavailable");
      return new Response(JSON.stringify({ revision: "wanted", from: "pages" }));
    },
  }));

  assert.equal(result.source, "fallback");
  assert.deepEqual(requests, [primaryUrl, canonicalHref]);
  assert.equal(result.value.from, "pages");
  assert.equal(await cacheStorage.text(cacheName, canonicalHref), JSON.stringify({ revision: "wanted", from: "pages" }));
});

test("a stalled CDN request is aborted before the Pages fallback runs", async () => {
  const cacheStorage = createCacheStorage();
  const requests = [];
  const result = await loadValidatedJson(loaderOptions({
    cacheStorage,
    primaryTimeoutMs: 5,
    fetchImpl: async (request) => {
      requests.push(request.url);
      if (request.url === primaryUrl) {
        return new Promise((resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return new Response(JSON.stringify({ revision: "wanted", from: "timeout-fallback" }));
    },
  }));

  assert.equal(result.source, "fallback");
  assert.deepEqual(requests, [primaryUrl, canonicalHref]);
  assert.equal(result.value.from, "timeout-fallback");
});

test("a corrupt local payload is deleted and replaced only after validation", async () => {
  const cacheStorage = createCacheStorage();
  cacheStorage.seed(cacheName, canonicalHref, JSON.stringify({ revision: "stale" }));

  const result = await loadValidatedJson(loaderOptions({
    cacheStorage,
    fetchImpl: async () => new Response(JSON.stringify({ revision: "wanted", from: "replacement" })),
  }));

  assert.equal(result.source, "primary");
  assert.deepEqual(cacheStorage.deletes, [canonicalHref]);
  assert.equal(result.value.from, "replacement");
});

test("an invalid primary response is never cached and the fallback can recover", async () => {
  const cacheStorage = createCacheStorage();
  let request = 0;
  const result = await loadValidatedJson(loaderOptions({
    cacheStorage,
    fetchImpl: async () => {
      request += 1;
      return new Response(JSON.stringify({
        revision: request === 1 ? "wrong" : "wanted",
        from: request === 1 ? "bad-primary" : "fallback",
      }));
    },
  }));

  assert.equal(result.source, "fallback");
  assert.equal(result.value.from, "fallback");
  assert.equal(cacheStorage.puts.length, 1);
});

test("persistent storage reports granted, denied, and unsupported states", async () => {
  assert.equal(await requestPersistentStorage(undefined), "unsupported");
  assert.equal(await requestPersistentStorage({
    persisted: async () => true,
    persist: async () => assert.fail("already persistent"),
  }), "persistent");
  assert.equal(await requestPersistentStorage({
    persisted: async () => false,
    persist: async () => true,
  }), "persistent");
  assert.equal(await requestPersistentStorage({
    persisted: async () => false,
    persist: async () => false,
  }), "best-effort");
});
