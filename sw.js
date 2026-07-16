const CACHE_PREFIX = "mandarin-hakka-";
const RELEASE_REVISION = "4";
// Bump the shell cache and every release query together.
const SHELL_CACHE = "mandarin-hakka-shell-v6";
// This cache follows the dictionary revision, not the shell revision. UI-only
// releases must preserve already-validated text instead of downloading it again.
const DATA_CACHE = "mandarin-hakka-data-v3";
// Audio is kept across shell updates until its source format actually changes.
const AUDIO_CACHE = "mandarin-hakka-audio-v1";
const OFFICIAL_AUDIO_ORIGIN = "https://hakkadict.moe.edu.tw";
const OFFICIAL_AUDIO_PATH = "/static/audio/";
const LOCAL_AUDIO_PATH = new URL("assets/hakka-audio/", self.registration.scope).pathname;
const ACCENT_KEYS = new Set(["sixian", "hailu", "dapu", "raoping", "zhaoan", "south-sixian"]);
// A single ExtendableMessageEvent is not a reliable home for an entire 10k-file
// dialect archive on mobile. The app can send resumable batches; cached URLs are
// skipped automatically on retry.
const MAX_AUDIO_BATCH_SIZE = 500;
const AUDIO_DOWNLOAD_CONCURRENCY = 4;
const SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css?v=4",
  "./app.js?v=4",
  "./search.js?v=4",
  "./quiz.js?v=4",
  "./learning.js?v=4",
  "./offline.js?v=4",
  "./dictionary-data.js?v=4",
  "./data-loader.js?v=4",
  "./manifest.webmanifest?v=4",
  "./assets/icon.svg",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/icon-maskable-512.png",
  "./assets/apple-touch-icon.png",
];

const SCOPE_URL = new URL(self.registration.scope);
const ROOT_URL = SCOPE_URL.href;
const INDEX_URL = new URL("index.html", SCOPE_URL).href;
const SHELL_URLS = new Set(
  SHELL_FILES.map((path) => urlWithoutSearchOrHash(new URL(path, SCOPE_URL))),
);
let activeAudioDownload = null;

function urlWithoutSearchOrHash(value) {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.href;
}

function isAppDocumentUrl(url) {
  const cleanUrl = urlWithoutSearchOrHash(url);
  return cleanUrl === ROOT_URL || cleanUrl === INDEX_URL;
}

function isHtmlResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  return contentType.toLowerCase().split(";", 1)[0].trim() === "text/html";
}

function isJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  return contentType.toLowerCase().split(";", 1)[0].trim() === "application/json";
}

function isCacheableResponse(response) {
  // Cache.put rejects partial 206 responses.
  return response.ok && response.status !== 206;
}

function isCacheableAudioResponse(response) {
  // Cross-origin no-cors audio is intentionally opaque. CacheStorage accepts it,
  // even though status, headers, and the body are unreadable to JavaScript.
  return response?.type === "opaque" || isCacheableResponse(response);
}

function isCacheableShellResponse(url, response) {
  if (!isCacheableResponse(response)) return false;
  if (isAppDocumentUrl(url)) return isHtmlResponse(response);
  if (isDataRequest(url)) return isJsonResponse(response);
  return true;
}

function isDataRequest(url) {
  return url.origin === SCOPE_URL.origin &&
    url.pathname.startsWith(new URL("data/", SCOPE_URL).pathname) &&
    url.pathname.endsWith(".json");
}

function isOfficialHakkaAudioUrl(value) {
  let url;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    return false;
  }

  if (url.origin !== OFFICIAL_AUDIO_ORIGIN || url.username || url.password) return false;
  if (!url.pathname.startsWith(OFFICIAL_AUDIO_PATH)) return false;
  const filename = url.pathname.slice(OFFICIAL_AUDIO_PATH.length);
  return filename.length > 4 && !filename.includes("/") && filename.toLowerCase().endsWith(".mp3");
}

function isLocalHakkaPackAudioUrl(value, expectedAccent = "") {
  let url;
  try {
    url = value instanceof URL ? value : new URL(value, SCOPE_URL);
  } catch {
    return false;
  }

  if (
    url.origin !== SCOPE_URL.origin ||
    url.username ||
    url.password ||
    !url.pathname.startsWith(LOCAL_AUDIO_PATH)
  ) return false;
  const segments = url.pathname.slice(LOCAL_AUDIO_PATH.length).split("/");
  return segments.length === 2 &&
    segments.every(Boolean) &&
    ACCENT_KEYS.has(segments[0]) &&
    (!expectedAccent || segments[0] === expectedAccent) &&
    /^[a-z0-9][a-z0-9._-]*\.mp3$/i.test(segments[1]);
}

function isShellRequest(url) {
  return url.origin === SCOPE_URL.origin && SHELL_URLS.has(urlWithoutSearchOrHash(url));
}

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);

  await Promise.all(
    SHELL_FILES.map(async (path) => {
      const url = new URL(path, SCOPE_URL);
      // Release-query shell URLs are immutable. Dictionary payloads are not
      // install members; the page validates and stores them exactly once.
      const cacheMode = url.searchParams.get("v") === RELEASE_REVISION ? "force-cache" : "reload";
      const request = new Request(url, { cache: cacheMode });
      const response = await fetch(request);

      if (!isCacheableShellResponse(url, response)) {
        throw new Error(`Refusing to precache invalid response for ${url.href}`);
      }
      await cache.put(request, response);
    }),
  );
}

self.addEventListener("install", (event) => {
  // The worker deliberately waits for older tabs to close. Pairing a newly
  // claimed worker with already-running old modules can corrupt offline state.
  event.waitUntil(precacheShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) => key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE && key !== DATA_CACHE && key !== AUDIO_CACHE,
          )
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

function postMessageReply(event, payload) {
  const target = event.ports?.[0] || event.source;
  try {
    target?.postMessage(payload);
  } catch {
    // A closed page must not abort cache work already protected by waitUntil.
  }
}

function audioError(event, accent, message, details = {}) {
  postMessageReply(event, {
    type: "HAKKA_AUDIO_ERROR",
    accent,
    message,
    ...details,
  });
}

function makeFullAudioRequest(url) {
  return new Request(url, {
    method: "GET",
    mode: "no-cors",
    credentials: "omit",
    cache: "no-cache",
    redirect: "follow",
  });
}

function makeLocalPackRequest(url) {
  return new Request(url, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-cache",
    redirect: "follow",
  });
}

async function downloadAudioBatch(event, data) {
  const accent = typeof data.accent === "string" ? data.accent.trim() : "";
  const accentLabel = typeof data.accentLabel === "string" ? data.accentLabel.trim().slice(0, 32) : "";
  const suppliedUrls = Array.isArray(data.urls) ? data.urls : [];

  if (!ACCENT_KEYS.has(accent)) {
    audioError(event, "", "請先選擇客語腔調。", { accentLabel });
    return;
  }
  if (data.release && data.release !== RELEASE_REVISION) {
    audioError(event, accent, "網站已更新；請完全關閉本站後重新開啟再下載。", {
      accentLabel,
    });
    return;
  }
  if (!suppliedUrls.length) {
    audioError(event, accent, "語音清單包含無效網址；離線學習包只接受本站精選音檔。", {
      accentLabel,
    });
    return;
  }
  if (suppliedUrls.length > MAX_AUDIO_BATCH_SIZE) {
    audioError(
      event,
      accent,
      `單批最多 ${MAX_AUDIO_BATCH_SIZE} 個音檔；請分批送出，重試會自動略過已下載檔案。`,
      { accentLabel, total: suppliedUrls.length, maxBatchSize: MAX_AUDIO_BATCH_SIZE },
    );
    return;
  }
  if (suppliedUrls.some((url) => !isLocalHakkaPackAudioUrl(url, accent))) {
    audioError(event, accent, "語音清單包含無效網址；離線學習包只接受本站精選音檔。", {
      accentLabel,
    });
    return;
  }
  const urls = [...new Set(suppliedUrls.map((url) => new URL(url, SCOPE_URL).href))];
  if (activeAudioDownload) {
    audioError(event, accent, "另一個客語語音下載仍在進行中，請稍後再試。", {
      accentLabel,
    });
    return;
  }

  const task = { accent, cancelled: false };
  activeAudioDownload = task;
  let completed = 0;
  let downloaded = 0;
  let cached = 0;
  let failed = 0;
  const total = urls.length;

  const reportProgress = (force = false) => {
    if (!force && completed % 10 !== 0) return;
    postMessageReply(event, {
      type: "HAKKA_AUDIO_PROGRESS",
      accent,
      accentLabel,
      completed,
      total,
      downloaded,
      cached,
      failed,
    });
  };

  try {
    const cache = await caches.open(AUDIO_CACHE);
    reportProgress(true);
    let cursor = 0;

    const downloadNext = async () => {
      while (cursor < total) {
        if (task.cancelled) return;
        const index = cursor++;
        const url = urls[index];
        try {
          if (await cache.match(url)) {
            cached += 1;
          } else {
            const response = await fetch(makeLocalPackRequest(url));
            if (!isCacheableResponse(response)) {
              throw new Error("local learning audio response is not cacheable");
            }
            await cache.put(url, response);
            downloaded += 1;
          }
        } catch {
          failed += 1;
        } finally {
          completed += 1;
          if (!task.cancelled) reportProgress(completed === total);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(AUDIO_DOWNLOAD_CONCURRENCY, total) }, () => downloadNext()),
    );

    const summary = { accent, accentLabel, completed, total, downloaded, cached, failed };
    if (task.cancelled) {
      postMessageReply(event, { type: "HAKKA_AUDIO_CANCELLED", ...summary });
      return;
    }
    if (failed) {
      audioError(event, accent, `有 ${failed} 個音檔未能下載；保持網路連線後重試即可續傳。`, summary);
    } else {
      postMessageReply(event, { type: "HAKKA_AUDIO_COMPLETE", ...summary });
    }
  } catch {
    audioError(event, accent, "瀏覽器無法開啟離線語音儲存空間。", {
      completed,
      total,
      accentLabel,
      downloaded,
      cached,
      failed,
    });
  } finally {
    if (activeAudioDownload === task) activeAudioDownload = null;
  }
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data?.type === "GET_RELEASE") {
    postMessageReply(event, { release: RELEASE_REVISION, audioCache: AUDIO_CACHE, dataCache: DATA_CACHE });
    return;
  }
  if (data?.type === "CACHE_HAKKA_AUDIO") {
    event.waitUntil(downloadAudioBatch(event, data));
    return;
  }
  if (data?.type === "CANCEL_HAKKA_AUDIO") {
    if (activeAudioDownload) activeAudioDownload.cancelled = true;
    return;
  }
  if (data?.type === "CLEAR_HAKKA_AUDIO") {
    if (activeAudioDownload) activeAudioDownload.cancelled = true;
    event.waitUntil(
      caches.delete(AUDIO_CACHE).then(
        () => postMessageReply(event, { type: "HAKKA_AUDIO_CLEARED" }),
        () => audioError(event, "", "離線語音目前無法清除，請稍後再試。"),
      ),
    );
  }
});

async function matchBestEffort(cacheName, request) {
  try {
    const cache = await caches.open(cacheName);
    return await cache.match(request);
  } catch {
    return undefined;
  }
}

async function putBestEffort(cacheName, request, response) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
  } catch {
    // Runtime caching must never turn a valid network response into an error.
  }
}

function keepAlive(event, promise) {
  event.waitUntil(Promise.resolve(promise).catch(() => {}));
}

async function handleNavigation(request, url) {
  if (!isAppDocumentUrl(url)) return fetch(request);
  const cached =
    (await matchBestEffort(SHELL_CACHE, INDEX_URL)) ||
    (await matchBestEffort(SHELL_CACHE, ROOT_URL));
  return cached || fetch(request, { cache: "no-cache" });
}

async function cacheFirstData(request) {
  const cached = await matchBestEffort(DATA_CACHE, request);
  if (cached) return cached;
  // Do not cache an unvalidated JSON response here. app.js verifies the core /
  // details revision pair and writes the exact bytes to DATA_CACHE afterward.
  return fetch(request, { cache: "no-cache" });
}

async function rangedResponse(request, response) {
  const range = request.headers?.get?.("range");
  if (!range || response.type === "opaque") return response;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (!match) return response;

  const bytes = await response.arrayBuffer();
  const length = bytes.byteLength;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start === null && end !== null) {
    start = Math.max(0, length - end);
    end = length - 1;
  } else {
    start ??= 0;
    end = end === null ? length - 1 : Math.min(end, length - 1);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= length) {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${length}` },
    });
  }

  const headers = new Headers(response.headers);
  headers.set("accept-ranges", "bytes");
  headers.set("content-range", `bytes ${start}-${end}/${length}`);
  headers.set("content-length", String(end - start + 1));
  return new Response(bytes.slice(start, end + 1), { status: 206, headers });
}

async function cacheFirstOfficialAudio(event, request) {
  const cached = await matchBestEffort(AUDIO_CACHE, request.url);
  if (cached) return rangedResponse(request, cached);

  const response = await fetch(request);
  const hasRange = Boolean(request.headers?.get?.("range"));
  if (!hasRange && isCacheableAudioResponse(response)) {
    keepAlive(event, putBestEffort(AUDIO_CACHE, request, response.clone()));
  } else if (hasRange) {
    // Never cache an opaque response that may hide a partial 206. Return the
    // requested online response, then fetch a known full no-cors file for retry.
    keepAlive(
      event,
      (async () => {
        const fullRequest = isLocalHakkaPackAudioUrl(request.url)
          ? makeLocalPackRequest(request.url)
          : makeFullAudioRequest(request.url);
        const fullResponse = await fetch(fullRequest);
        if (isCacheableAudioResponse(fullResponse)) {
          await putBestEffort(AUDIO_CACHE, fullRequest, fullResponse);
        }
      })(),
    );
  }
  return response;
}

async function cacheFirstShell(request) {
  const cached = await matchBestEffort(SHELL_CACHE, request);
  return cached || fetch(request);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (isOfficialHakkaAudioUrl(url) || isLocalHakkaPackAudioUrl(url)) {
    event.respondWith(cacheFirstOfficialAudio(event, request));
    return;
  }

  if (url.origin !== SCOPE_URL.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request, url));
    return;
  }
  if (isShellRequest(url)) {
    event.respondWith(cacheFirstShell(request));
    return;
  }
  if (isDataRequest(url)) {
    event.respondWith(cacheFirstData(request));
  }
});
