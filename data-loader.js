// Cache-first loading for versioned dictionary payloads.
//
// App releases and dictionary releases intentionally have independent versions:
// a CSS or UI update must not make an already-validated dictionary download again.

function resolveUrl(value, baseUrl) {
  return new URL(value, baseUrl || globalThis.location?.href || "http://localhost/").href;
}

function cacheRequest(url) {
  return new Request(url, { method: "GET", credentials: "same-origin" });
}

async function responseBytes(response, expectedBytes, onProgress, source) {
  if (source === "cache") {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress(bytes.byteLength, expectedBytes || bytes.byteLength, { source });
    return bytes;
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress(bytes.byteLength, expectedBytes || bytes.byteLength, { source });
    return bytes;
  }

  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, expectedBytes, { source });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function decodeAndValidate(response, options) {
  const bytes = await responseBytes(
    response,
    options.expectedBytes,
    options.onProgress,
    options.source,
  );
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  const value = await options.validate(parsed, { source: options.source });
  return { bytes, value };
}

async function startFetchWithTimeout(fetchImpl, request, timeoutMs) {
  if (!(timeoutMs > 0) || typeof AbortController !== "function") {
    return { response: await fetchImpl(request), finish: () => {} };
  }
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new Request(request, { signal: controller.signal }));
    return {
      response,
      finish: () => globalThis.clearTimeout(timer),
    };
  } catch (error) {
    globalThis.clearTimeout(timer);
    throw error;
  }
}

export async function storeDataBytes(
  canonicalUrl,
  bytes,
  {
    cacheName,
    cacheStorage = globalThis.caches,
    baseUrl = globalThis.location?.href,
  } = {},
) {
  if (!cacheName || !cacheStorage?.open) return false;
  try {
    const cache = await cacheStorage.open(cacheName);
    const request = cacheRequest(resolveUrl(canonicalUrl, baseUrl));
    const response = new Response(bytes, {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    await cache.put(request, response);
    return true;
  } catch {
    return false;
  }
}

export async function deleteStoredData(
  canonicalUrl,
  {
    cacheName,
    cacheStorage = globalThis.caches,
    baseUrl = globalThis.location?.href,
  } = {},
) {
  if (!cacheName || !cacheStorage?.open) return false;
  try {
    const cache = await cacheStorage.open(cacheName);
    return await cache.delete(cacheRequest(resolveUrl(canonicalUrl, baseUrl)));
  } catch {
    return false;
  }
}

export async function loadValidatedJson({
  canonicalUrl,
  primaryUrl = "",
  cacheName,
  expectedBytes = 0,
  onProgress = () => {},
  validate = (value) => value,
  primaryTimeoutMs = 12_000,
  cacheStorage = globalThis.caches,
  fetchImpl = globalThis.fetch,
  baseUrl = globalThis.location?.href,
} = {}) {
  if (!canonicalUrl) throw new TypeError("canonicalUrl is required");
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is unavailable");

  const canonicalHref = resolveUrl(canonicalUrl, baseUrl);
  const canonicalRequest = cacheRequest(canonicalHref);
  const errors = [];

  if (cacheName && cacheStorage?.open) {
    try {
      const cache = await cacheStorage.open(cacheName);
      const cached = await cache.match(canonicalRequest);
      if (cached) {
        try {
          const decoded = await decodeAndValidate(cached, {
            expectedBytes,
            onProgress,
            source: "cache",
            validate,
          });
          return { ...decoded, source: "cache", stored: true };
        } catch (error) {
          errors.push(error);
          await cache.delete(canonicalRequest);
        }
      }
    } catch (error) {
      // CacheStorage can be unavailable in private or quota-constrained contexts.
      // Network loading must remain usable in that case.
      errors.push(error);
    }
  }

  const candidates = [];
  if (primaryUrl) {
    candidates.push({
      source: "primary",
      request: new Request(resolveUrl(primaryUrl, baseUrl), {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "force-cache",
      }),
      timeoutMs: primaryTimeoutMs,
    });
  }
  candidates.push({
    source: "fallback",
    request: new Request(canonicalHref, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-cache",
    }),
    timeoutMs: 0,
  });

  for (const candidate of candidates) {
    let finishFetch = () => {};
    try {
      const pending = await startFetchWithTimeout(fetchImpl, candidate.request, candidate.timeoutMs);
      const response = pending.response;
      finishFetch = pending.finish;
      if (!response?.ok) throw new Error(`HTTP ${response?.status || 0}`);
      const decoded = await decodeAndValidate(response, {
        expectedBytes,
        onProgress,
        source: candidate.source,
        validate,
      });
      const stored = await storeDataBytes(canonicalUrl, decoded.bytes, {
        cacheName,
        cacheStorage,
        baseUrl,
      });
      return { ...decoded, source: candidate.source, stored };
    } catch (error) {
      errors.push(error);
    } finally {
      finishFetch();
    }
  }

  throw new AggregateError(errors, `Unable to load ${canonicalHref}`);
}

export async function requestPersistentStorage(storage = globalThis.navigator?.storage) {
  if (typeof storage?.persisted !== "function" || typeof storage?.persist !== "function") {
    return "unsupported";
  }
  try {
    if (await storage.persisted()) return "persistent";
    return (await storage.persist()) ? "persistent" : "best-effort";
  } catch {
    return "best-effort";
  }
}
