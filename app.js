import {
  createSearchIndex,
  listAccents,
  pickSuggestionTerms,
  searchEntriesDetailed,
} from "./search.js?v=3";
import { buildQuizPool } from "./quiz.js?v=3";
import { initializeLearning } from "./learning.js?v=3";
import { canDownloadAccentPack, classifyServiceWorkerReply } from "./offline.js?v=3";
import {
  expandCoreDictionary,
  mergeDictionaryDetails,
  officialAudioUrl,
} from "./dictionary-data.js?v=3";

const CORE_DATA_URL = "./data/dictionary-core.json?v=3";
const DETAILS_DATA_URL = "./data/dictionary-details.json?v=3";
const DATA_BASE_URL = new URL(CORE_DATA_URL, window.location.href);
const RELEASE_REVISION = "3";
const DATA_CACHE = "mandarin-hakka-data-v3";
const AUDIO_CACHE = "mandarin-hakka-audio-v1";
const LEARNING_AUDIO_LIMIT = 500;
const SOURCE_URL = "https://hakkadict.moe.edu.tw/";
const ACCENT_KEYS = Object.freeze({
  四縣: "sixian",
  海陸: "hailu",
  大埔: "dapu",
  饒平: "raoping",
  詔安: "zhaoan",
  南四縣: "south-sixian",
});

const elements = {
  form: document.querySelector("#search-form"),
  input: document.querySelector("#query"),
  accent: document.querySelector("#accent"),
  submit: document.querySelector("#search-submit"),
  status: document.querySelector("#search-status"),
  results: document.querySelector("#results"),
  suggestionList: document.querySelector("#suggestion-list"),
  shuffleSuggestions: document.querySelector("#shuffle-suggestions"),
  termCount: document.querySelector("#term-count"),
  variantCount: document.querySelector("#variant-count"),
  audioCount: document.querySelector("#audio-count"),
  quizCount: document.querySelector("#quiz-count"),
  sourceDate: document.querySelector("#source-date"),
  downloadAccentAudio: document.querySelector("#download-accent-audio"),
  cancelAudioDownload: document.querySelector("#cancel-audio-download"),
  clearOfflineAudio: document.querySelector("#clear-offline-audio"),
  offlineStatus: document.querySelector("#offline-status"),
  textDataStatus: document.querySelector("#text-data-status"),
  textDataTitle: document.querySelector("#text-data-title"),
  textDataDetail: document.querySelector("#text-data-detail"),
  textDataProgress: document.querySelector("#text-data-progress"),
  retryTextData: document.querySelector("#retry-text-data"),
  textDataAnnouncement: document.querySelector("#text-data-announcement"),
  installApp: document.querySelector("#install-app"),
  audioDock: document.querySelector("#audio-dock"),
  audioTitle: document.querySelector("#audio-title"),
  audioSource: document.querySelector("#audio-source"),
  audio: document.querySelector("#audio-player"),
  stopAudio: document.querySelector("#stop-audio"),
};

const state = {
  dictionary: null,
  index: [],
  accents: [],
  activeQuery: "",
  resultLimit: 40,
  learning: null,
  serviceWorkerRegistration: null,
  serviceWorkerCompatibility: "serviceWorker" in navigator ? "checking" : "none",
  serviceWorkerCheck: 0,
  audioMessagePort: null,
  downloading: false,
  deferredInstallPrompt: null,
  appReady: false,
  detailsStatus: "pending",
  detailsStored: false,
  coreStorePromise: Promise.resolve(false),
  coreStored: false,
  detailsPayloadStored: false,
  pendingCoreBytes: null,
  pendingDetailsBytes: null,
  lastTextDataAnnouncement: "",
};

function makeElement(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attributes || {})) node.setAttribute(name, value);
  return node;
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-TW").format(Number(value) || 0);
}

function formatMegabytes(bytes) {
  const megabytes = (Number(bytes) || 0) / (1024 * 1024);
  return new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 1 }).format(megabytes);
}

function formatDataBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024 * 1024) return `${formatNumber(Math.round(value / 1024))} KB`;
  return `${formatMegabytes(value)} MB`;
}

function setStatus(message, kind = "") {
  elements.status.textContent = message;
  elements.status.dataset.kind = kind;
}

function setTextDataStatus(kind, title, detail, progress = null) {
  elements.textDataStatus.dataset.kind = kind;
  elements.textDataTitle.textContent = title;
  elements.textDataDetail.textContent = detail;
  elements.retryTextData.hidden = kind !== "error";
  elements.retryTextData.textContent = state.appReady
    ? "繼續下載完整內容"
    : "重試下載查詞資料";
  if (Number.isFinite(progress)) {
    elements.textDataProgress.value = Math.max(0, Math.min(100, progress));
  } else {
    elements.textDataProgress.removeAttribute("value");
  }
  const bucket = Number.isFinite(progress) ? Math.floor(progress / 10) * 10 : "state";
  const stableTitle = title.replace(/：\d+%$/, "");
  const announcementKey = `${kind}:${stableTitle}:${bucket}`;
  if (announcementKey !== state.lastTextDataAnnouncement) {
    state.lastTextDataAnnouncement = announcementKey;
    elements.textDataAnnouncement.textContent = `${title}。${detail}`;
  }
}

function renderStoredTextDataStatus() {
  if (!state.detailsStored) return;
  const offlineReady = ["current", "installed"].includes(state.serviceWorkerCompatibility);
  const detail = offlineReady
    ? "詞目、釋義、例句等文字內容均可離線查詢；一般官方發音仍依播放快取。"
    : state.serviceWorkerCompatibility === "checking"
      ? "完整文字已保存；離線服務仍在安裝，完成後即可離線重新開啟。"
      : "完整文字已保存，但此瀏覽器尚未啟用離線服務；連網時仍可完整使用。";
  setTextDataStatus("ready", "完整文字詞庫已儲存", detail, 100);
}

async function storeDataBytes(url, bytes) {
  if (!("caches" in window)) return false;
  try {
    const cache = await caches.open(DATA_CACHE);
    const request = new Request(new URL(url, window.location.href));
    const response = new Response(bytes, { headers: { "content-type": "application/json; charset=utf-8" } });
    await cache.put(request, response);
    return true;
  } catch {
    return false;
  }
}

async function deleteStoredData(url) {
  if (!("caches" in window)) return;
  try {
    const cache = await caches.open(DATA_CACHE);
    await cache.delete(new Request(new URL(url, window.location.href)));
  } catch {
    // A failed cleanup will be retried by the next versioned request.
  }
}

async function fetchJsonWithProgress(url, expectedBytes = 0, onProgress = () => {}) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress(bytes.byteLength, expectedBytes);
    return { data: JSON.parse(new TextDecoder().decode(bytes)), bytes };
  }

  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, expectedBytes);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const data = JSON.parse(new TextDecoder().decode(bytes));
  return { data, bytes };
}

function waitForMainThread() {
  return new Promise((resolve) => {
    if ("requestIdleCallback" in window) window.requestIdleCallback(resolve, { timeout: 800 });
    else window.setTimeout(resolve, 0);
  });
}

function stringValue(value) {
  if (Array.isArray(value)) return value.map(stringValue).filter(Boolean).join("、");
  return value == null || typeof value === "object" ? "" : String(value).trim();
}

function officialAudioUrls(variant) {
  const values = Array.isArray(variant?.audio) ? variant.audio : variant?.audio ? [variant.audio] : [];
  return [...new Set(values.map(officialAudioUrl).filter(Boolean))];
}

function resolveLearningAudioUrl(path) {
  const value = stringValue(path);
  if (!value) return "";
  return new URL(value, DATA_BASE_URL).href;
}

async function playUrl(url, title, source) {
  if (!url) return false;
  elements.audio.pause();
  elements.audioTitle.textContent = title;
  elements.audioSource.textContent = source;
  elements.audio.src = url;
  elements.audio.hidden = false;
  elements.audioDock.hidden = false;
  try {
    await elements.audio.play();
    setStatus("正在播放教育部客語發音。", "success");
    return true;
  } catch {
    setStatus("音檔暫時無法播放，請檢查網路後再試。", "error");
    return false;
  }
}

function playVariant(entry, variant, url, number = 1) {
  const suffix = officialAudioUrls(variant).length > 1 ? `・發音 ${number}` : "";
  return playUrl(
    url,
    `${entry.headword}（${variant.accent || "客語"}・${variant.pronunciation || "無拼音"}${suffix}）`,
    "教育部《臺灣客語辭典》官方音檔",
  );
}

function playQuizAudio(candidate, { reveal = false } = {}) {
  const title = reveal
    ? `${candidate.headword}（${candidate.accent || "客語"}・${candidate.pronunciation}）`
    : `${candidate.accent || "客語"}挑戰題`;
  return playUrl(
    resolveLearningAudioUrl(candidate.audio),
    title,
    "教育部《臺灣客語辭典》學習題音檔",
  );
}

function labeledText(label, value, className = "variant-detail") {
  const text = stringValue(value);
  if (!text) return null;
  const paragraph = makeElement("p", { className });
  paragraph.append(makeElement("strong", { text: `${label}：` }), document.createTextNode(text));
  return paragraph;
}

function renderVariant(entry, variant, matched = false) {
  const article = makeElement("article", {
    className: matched ? "comparison comparison--matched" : "comparison",
  });
  const words = makeElement("div", { className: "comparison__words" });
  if (matched) words.append(makeElement("span", { className: "match-badge", text: "符合查詢" }));
  words.append(
    makeElement("strong", { className: "comparison__hanji", text: variant.accent || "未標腔調" }),
    makeElement("span", {
      className: "comparison__pronunciation",
      text: variant.pronunciation || "未提供拼音",
      attributes: { lang: "hak-Latn" },
    }),
  );
  const partOfSpeech = stringValue(variant.part_of_speech || variant.pos);
  if (partOfSpeech) {
    const tags = makeElement("ul", { className: "accent-list", attributes: { "aria-label": "詞性" } });
    tags.append(makeElement("li", { className: "accent-tag", text: partOfSpeech }));
    words.append(tags);
  }

  const details = makeElement("div", { className: "variant-details" });
  const rows = [
    labeledText("華語釋義", variant.definition || variant.mandarin_definition || variant.quiz_answer),
    labeledText("例句／華語譯文", variant.example),
    labeledText("方言點", variant.location),
    labeledText("分類", variant.categories),
    labeledText("近義詞", variant.synonyms || variant.similar),
    labeledText("反義詞", variant.antonyms || variant.opposite),
  ].filter(Boolean);
  if (rows.length) details.append(...rows);
  else details.append(makeElement("p", { className: "learning-muted", text: "此筆資料未提供釋義或例句。" }));

  const actions = makeElement("div", { className: "comparison__actions" });
  const audio = officialAudioUrls(variant);
  audio.forEach((url, index) => {
    const button = makeElement("button", {
      className: "button button--audio",
      text: audio.length > 1 ? `▶ 發音 ${index + 1}` : "▶ 聽發音",
      attributes: { type: "button", "aria-label": `聽${entry.headword}${variant.accent || "客語"}官方發音` },
    });
    button.addEventListener("click", () => playVariant(entry, variant, url, index + 1));
    actions.append(button);
  });
  if (!audio.length) {
    const text = state.detailsStatus === "ready" ? "未提供錄音" : "完整資料下載中";
    actions.append(makeElement("span", { className: "audio-unavailable", text }));
  }
  article.append(words, details, actions);
  return article;
}

function renderEntry(result) {
  const entry = result.entry;
  const selectedAccent = elements.accent.value;
  const matchedIndexes = new Set(result.match.variants.map(({ index }) => index));
  const variants = (Array.isArray(entry.variants) ? entry.variants : [])
    .map((variant, index) => ({ variant, index }))
    .filter(({ variant }) => !selectedAccent || variant.accent === selectedAccent)
    .sort(({ index: left }, { index: right }) => Number(matchedIndexes.has(right)) - Number(matchedIndexes.has(left)));

  const card = makeElement("article", { className: "result-card" });
  const header = makeElement("header", { className: "result-card__header" });
  const heading = makeElement("div");
  heading.append(
    makeElement("h2", { className: "result-card__title", text: entry.headword }),
    makeElement("p", { className: "result-card__speech-note", text: `收錄 ${formatNumber(variants.length)} 筆腔調資料` }),
  );
  const source = makeElement("a", {
    className: "source-link",
    text: "教育部辭典 ↗",
    attributes: {
      href: state.dictionary?.metadata?.source_url || SOURCE_URL,
      target: "_blank",
      rel: "noopener noreferrer",
    },
  });
  header.append(heading, source);
  const list = makeElement("div", { className: "comparison-list" });
  for (const { variant, index } of variants) {
    list.append(renderVariant(entry, variant, result.match.headword || matchedIndexes.has(index)));
  }
  card.append(header, list);
  return card;
}

function renderEmpty(query) {
  const empty = makeElement("div", { className: "empty-state" });
  empty.append(
    makeElement("h2", { text: `找不到「${query}」` }),
    makeElement("p", { text: "請試試不同漢字、拼音，或切換成全部六腔。華語可輸入釋義中的完整詞句搜尋。" }),
  );
  elements.results.replaceChildren(empty);
}

function runSearch({ updateHash = true, resetLimit = true, focusResults = true } = {}) {
  const query = elements.input.value.trim();
  if (resetLimit) state.resultLimit = 40;
  state.activeQuery = query;
  if (!query) {
    elements.results.replaceChildren();
    setStatus("輸入華語、客語漢字或拼音開始查詢。", "");
    return;
  }
  const found = searchEntriesDetailed(state.index, query, {
    accent: elements.accent.value,
    limit: state.resultLimit,
  });
  if (!found.results.length) renderEmpty(query);
  else {
    const fragment = document.createDocumentFragment();
    for (const result of found.results) fragment.append(renderEntry(result));
    if (found.truncated) {
      const more = makeElement("button", {
        className: "button button--secondary results__more",
        text: `再顯示結果（共 ${formatNumber(found.total)} 筆詞義）`,
        attributes: { type: "button" },
      });
      more.addEventListener("click", () => {
        state.resultLimit += 40;
        runSearch({ updateHash: false, resetLimit: false });
      });
      fragment.append(more);
    }
    elements.results.replaceChildren(fragment);
  }
  const accentText = elements.accent.value ? `・${elements.accent.value}` : "・全部六腔";
  setStatus(`找到 ${formatNumber(found.total)} 筆詞義${accentText}。`, "success");
  if (updateHash) {
    const params = new URLSearchParams({ q: query });
    if (elements.accent.value) params.set("accent", elements.accent.value);
    history.replaceState(null, "", `#dictionary?${params}`);
  }
  if (focusResults) {
    elements.results.focus({ preventScroll: true });
    elements.results.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function renderSuggestions() {
  const terms = pickSuggestionTerms(state.dictionary, 6);
  elements.suggestionList.replaceChildren(
    ...terms.map((term) => {
      const button = makeElement("button", { text: term, attributes: { type: "button" } });
      button.addEventListener("click", () => {
        elements.input.value = term;
        runSearch();
      });
      return button;
    }),
  );
}

function populateAccents() {
  state.accents = listAccents(state.dictionary);
  for (const accent of state.accents) elements.accent.append(new Option(accent, accent));
}

function quizAudioUrlsForAccent(accent) {
  return buildQuizPool(state.dictionary, { accent })
    .map((candidate) => resolveLearningAudioUrl(candidate.audio))
    .filter(Boolean)
    .slice(0, LEARNING_AUDIO_LIMIT);
}

function activeWorker() {
  return navigator.serviceWorker?.controller || state.serviceWorkerRegistration?.active || null;
}

function updateOfflineButton() {
  const accent = elements.accent.value;
  const accentKey = ACCENT_KEYS[accent] || "";
  const urls = accent && state.dictionary ? quizAudioUrlsForAccent(accent) : [];
  const packMetadata = state.dictionary?.metadata?.quiz_audio?.accents?.[accent] || {};
  const ready =
    Boolean(activeWorker()) &&
    canDownloadAccentPack(state.serviceWorkerCompatibility, accentKey) &&
    urls.length > 0 &&
    !state.downloading;
  const packCount = Number(packMetadata.count) || urls.length;
  const packSize = formatMegabytes(packMetadata.bytes);
  elements.downloadAccentAudio.disabled = !ready;
  elements.downloadAccentAudio.textContent = accent
    ? `下載${accent}學習語音（${formatNumber(packCount)} 個・${packSize} MB）`
    : "請先選擇一種腔調";
  elements.clearOfflineAudio.hidden = !canDownloadAccentPack(
    state.serviceWorkerCompatibility,
    ACCENT_KEYS[state.accents[0]] || "",
  );
  if (accent && !urls.length && state.dictionary) {
    elements.offlineStatus.textContent = `${accent}目前沒有可下載的挑戰題音檔。`;
  }
}

function workerMessageChannel(onMessage) {
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => onMessage(event.data, channel.port1);
  channel.port1.start?.();
  return channel;
}

function postWorkerMessage(worker, message, onMessage) {
  const channel = workerMessageChannel(onMessage);
  worker.postMessage(message, [channel.port2]);
  return channel.port1;
}

function startAudioDownload() {
  const accent = elements.accent.value;
  const urls = quizAudioUrlsForAccent(accent);
  const worker = activeWorker();
  if (!worker || !accent || !urls.length) return;
  state.downloading = true;
  elements.cancelAudioDownload.hidden = false;
  elements.offlineStatus.textContent = `準備下載 ${formatNumber(urls.length)} 個${accent}學習音檔…`;
  updateOfflineButton();
  state.audioMessagePort?.close?.();
  state.audioMessagePort = postWorkerMessage(
    worker,
    {
      type: "CACHE_HAKKA_AUDIO",
      accent: ACCENT_KEYS[accent] || accent,
      accentLabel: accent,
      urls,
      release: RELEASE_REVISION,
    },
    handleServiceWorkerMessage,
  );
}

function handleServiceWorkerMessage(message, port) {
  if (!message || typeof message !== "object") return;
  const accent = message.accentLabel || message.accent || elements.accent.value || "客語";
  if (message.type === "HAKKA_AUDIO_PROGRESS") {
    if (!state.downloading) return;
    const completed = Number(message.completed) || 0;
    const total = Number(message.total) || 0;
    elements.offlineStatus.textContent = `正在下載${accent}學習語音：${formatNumber(completed)} / ${formatNumber(total)}`;
  } else if (message.type === "HAKKA_AUDIO_COMPLETE") {
    state.downloading = false;
    elements.cancelAudioDownload.hidden = true;
    elements.clearOfflineAudio.hidden = false;
    elements.offlineStatus.textContent = `${accent}學習語音下載完成，可離線挑戰。`;
    port?.close?.();
    updateOfflineButton();
  } else if (message.type === "HAKKA_AUDIO_CLEARED") {
    state.downloading = false;
    elements.offlineStatus.textContent = "已清除離線學習語音；不影響上方顯示的文字詞庫狀態。";
    port?.close?.();
    updateOfflineButton();
  } else if (message.type === "HAKKA_AUDIO_CANCELLED") {
    state.downloading = false;
    elements.cancelAudioDownload.disabled = false;
    elements.cancelAudioDownload.hidden = true;
    elements.offlineStatus.textContent = "已停止這次下載；已完成的音檔會保留。";
    port?.close?.();
    updateOfflineButton();
  } else if (message.type === "HAKKA_AUDIO_ERROR") {
    state.downloading = false;
    elements.cancelAudioDownload.hidden = true;
    elements.offlineStatus.textContent = `語音下載未完成：${message.message || "請稍後再試"}`;
    port?.close?.();
    updateOfflineButton();
  }
}

function queryWorkerRelease(worker, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      port?.close?.();
      resolve(value);
    };
    const channel = workerMessageChannel((message) => finish(message));
    const port = channel.port1;
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    try {
      worker.postMessage({ type: "GET_RELEASE" }, [channel.port2]);
    } catch {
      finish(null);
    }
  });
}

async function checkServiceWorkerCompatibility(registration = state.serviceWorkerRegistration) {
  const check = ++state.serviceWorkerCheck;
  const worker = navigator.serviceWorker.controller || registration?.active || null;
  if (!worker) {
    state.serviceWorkerCompatibility = "checking";
    updateOfflineButton();
    return;
  }
  const reply = await queryWorkerRelease(worker);
  if (check !== state.serviceWorkerCheck) return;
  state.serviceWorkerCompatibility = classifyServiceWorkerReply(reply, {
    controlled: worker === navigator.serviceWorker.controller,
    releaseRevision: RELEASE_REVISION,
    audioCache: AUDIO_CACHE,
  });
  if (!state.downloading) {
    if (state.serviceWorkerCompatibility === "outdated") {
      elements.offlineStatus.textContent = "網站已更新；請完全關閉本站所有分頁與 App 後再開一次，即可下載學習語音。";
    } else if (state.serviceWorkerCompatibility === "unverified") {
      elements.offlineStatus.textContent = "離線服務未能確認版本；查詞仍可使用，請稍後重新開啟本站。";
    } else if (state.serviceWorkerCompatibility === "installed") {
      elements.offlineStatus.textContent = "離線服務已安裝，可直接下載學習語音。";
    } else {
      elements.offlineStatus.textContent = "離線服務已就緒；選擇腔調可下載挑戰題語音。文字詞庫狀態請見上方。";
    }
  }
  renderStoredTextDataStatus();
  updateOfflineButton();
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    elements.offlineStatus.textContent = "此瀏覽器不支援離線安裝；仍可連網查詞與挑戰。";
    renderStoredTextDataStatus();
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register("./sw.js?v=3", { scope: "./" });
    state.serviceWorkerRegistration = registration;
    registration.addEventListener("updatefound", () => {
      registration.installing?.addEventListener("statechange", () => checkServiceWorkerCompatibility(registration));
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => checkServiceWorkerCompatibility(registration));
    await checkServiceWorkerCompatibility(registration);
    navigator.serviceWorker.ready.then((ready) => {
      state.serviceWorkerRegistration = ready;
      checkServiceWorkerCompatibility(ready);
    });
  } catch {
    state.serviceWorkerCompatibility = "none";
    elements.offlineStatus.textContent = "離線服務尚未安裝；查詞與連網播放仍可使用。";
    renderStoredTextDataStatus();
    updateOfflineButton();
  }
}

function restoreSearchFromHash() {
  if (!window.location.hash.startsWith("#dictionary?")) return;
  const params = new URLSearchParams(window.location.hash.split("?", 2)[1]);
  const query = params.get("q") || "";
  const accent = params.get("accent") || "";
  elements.input.value = query;
  if (state.accents.includes(accent)) elements.accent.value = accent;
  if (query) runSearch({ updateHash: false });
}

async function initializeCore() {
  if (state.appReady) return true;
  state.detailsStatus = "core-loading";
  setTextDataStatus(
    "loading",
    "正在下載基本查詞資料…",
    "完成後可先查詞，其餘完整內容會繼續在背景下載。",
  );
  elements.form.setAttribute("aria-busy", "true");
  try {
    const result = await fetchJsonWithProgress(CORE_DATA_URL);
    const dictionary = expandCoreDictionary(result.data);
    state.coreStorePromise = storeDataBytes(CORE_DATA_URL, result.bytes).then((stored) => {
      state.coreStored = stored;
      state.pendingCoreBytes = stored ? null : result.bytes;
      return stored;
    });
    state.dictionary = dictionary;
    state.index = createSearchIndex(dictionary);
    populateAccents();
    renderSuggestions();

    const metadata = dictionary.metadata || {};
    const variants = dictionary.entries.reduce(
      (total, entry) => total + (Array.isArray(entry?.variants) ? entry.variants.length : 0),
      0,
    );
    const quizCountFromMetadata = Number(metadata.quiz_audio?.total_count) || 0;
    const quizPool = buildQuizPool(dictionary);
    elements.termCount.textContent = formatNumber(metadata.headword_count ?? metadata.entry_count ?? dictionary.entries.length);
    elements.variantCount.textContent = formatNumber(metadata.row_count ?? variants);
    elements.audioCount.textContent = formatNumber(metadata.audio_count);
    elements.quizCount.textContent = formatNumber(quizCountFromMetadata || quizPool.length);
    elements.sourceDate.textContent = metadata.source_date || "以詞庫檔案為準";

    elements.input.disabled = false;
    elements.submit.disabled = false;
    elements.accent.disabled = false;
    elements.shuffleSuggestions.disabled = false;
    elements.form.setAttribute("aria-busy", "false");
    setStatus(`詞庫已就緒，共 ${formatNumber(metadata.headword_count ?? metadata.entry_count ?? dictionary.entries.length)} 個客語詞目。`, "success");
    state.detailsStatus = "pending";
    setTextDataStatus(
      "loading",
      "查詞已可使用；完整資料正在背景下載",
      "例句、方言點、同反義詞、分類與官方發音的播放資料尚在下載，可先開始使用。",
      0,
    );
    state.learning = initializeLearning({
      dictionary,
      playAudio: playQuizAudio,
      sourceUrl: metadata.source_url || SOURCE_URL,
    });
    state.appReady = true;
    if (!isStandalone()) elements.installApp.hidden = false;
    restoreSearchFromHash();
    updateOfflineButton();
    return true;
  } catch (error) {
    console.error(error);
    await deleteStoredData(CORE_DATA_URL);
    state.detailsStatus = "core-error";
    elements.form.setAttribute("aria-busy", "false");
    setStatus("詞庫載入失敗。若目前離線，請先連網開啟一次後再試。", "error");
    setTextDataStatus(
      "error",
      "查詞資料下載失敗",
      "目前還不能查詞；請檢查網路後重試。",
    );
    return false;
  }
}

async function loadDictionaryDetails() {
  if (!state.dictionary || ["loading", "indexing"].includes(state.detailsStatus)) return;
  if (state.pendingCoreBytes) {
    const coreBytes = state.pendingCoreBytes;
    state.coreStorePromise = storeDataBytes(CORE_DATA_URL, coreBytes).then((stored) => {
      state.coreStored = stored;
      state.pendingCoreBytes = stored ? null : coreBytes;
      return stored;
    });
  }
  state.detailsStatus = "loading";
  const expectedBytes = Number(state.dictionary.metadata?.web_data?.details_bytes) || 0;
  setTextDataStatus(
    "loading",
    "查詞已可使用；完整資料正在背景下載",
    "例句等完整內容即將開始下載，可先開始使用。",
    0,
  );
  try {
    const result = await fetchJsonWithProgress(
      DETAILS_DATA_URL,
      expectedBytes,
      (loaded, total) => {
        const percent = total ? Math.min(99, Math.round((loaded / total) * 100)) : null;
        const bytes = total
          ? `${formatDataBytes(Math.min(loaded, total))} / ${formatDataBytes(total)}`
          : `${formatDataBytes(loaded)} 已接收`;
        setTextDataStatus(
          "loading",
          `查詞已可使用；完整資料正在背景下載${percent === null ? "" : `：${percent}%`}`,
          `正在接收例句等完整內容（${bytes}），可先開始使用。`,
          percent,
        );
      },
    );
    mergeDictionaryDetails(state.dictionary, result.data);
    const detailsStorePromise = storeDataBytes(DETAILS_DATA_URL, result.bytes).then((stored) => {
      state.detailsPayloadStored = stored;
      state.pendingDetailsBytes = stored ? null : result.bytes;
      return stored;
    });
    state.detailsStatus = "indexing";
    setTextDataStatus(
      "loading",
      "完整資料下載完成；正在建立全文索引",
      "查詞仍可使用，完成後即可搜尋例句與同反義詞。",
      100,
    );
    await waitForMainThread();
    state.index = createSearchIndex(state.dictionary);
    const [coreStored, detailsStored] = await Promise.all([
      state.coreStorePromise,
      detailsStorePromise,
    ]);
    state.detailsStored = Boolean(coreStored && detailsStored);
    state.detailsStatus = "ready";
    if (state.detailsStored) {
      renderStoredTextDataStatus();
    } else {
      setTextDataStatus(
        "error",
        "查詞已可使用；完整內容未能離線保存",
        "完整資料已載入，但瀏覽器未能寫入離線空間；可重試保存。",
      );
    }
    if (state.activeQuery) {
      runSearch({ updateHash: false, resetLimit: false, focusResults: false });
    }
  } catch (error) {
    console.error(error);
    await deleteStoredData(DETAILS_DATA_URL);
    state.detailsStatus = "error";
    setTextDataStatus(
      "error",
      "查詞已可使用；完整資料尚未下載完成",
      "目前仍可查詞目、六腔拼音與華語釋義；連網後可繼續下載例句等內容。",
    );
  }
}

async function retryTextDataStorage() {
  setTextDataStatus(
    "loading",
    "查詞已可使用；正在重試離線保存",
    "不會重新建立詞庫，完成前仍可繼續使用。",
  );
  const coreStore = state.pendingCoreBytes
    ? storeDataBytes(CORE_DATA_URL, state.pendingCoreBytes)
    : Promise.resolve(state.coreStored);
  const detailsStore = state.pendingDetailsBytes
    ? storeDataBytes(DETAILS_DATA_URL, state.pendingDetailsBytes)
    : Promise.resolve(state.detailsPayloadStored);
  const [coreStored, detailsStored] = await Promise.all([coreStore, detailsStore]);
  state.coreStored = coreStored;
  state.detailsPayloadStored = detailsStored;
  if (coreStored) state.pendingCoreBytes = null;
  if (detailsStored) state.pendingDetailsBytes = null;
  state.detailsStored = Boolean(coreStored && detailsStored);
  if (state.detailsStored) {
    renderStoredTextDataStatus();
  } else {
    setTextDataStatus(
      "error",
      "查詞已可使用；完整內容仍未能離線保存",
      "瀏覽器可能沒有足夠儲存空間；清出空間後可再試一次。",
    );
  }
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch();
});
elements.accent.addEventListener("change", () => {
  updateOfflineButton();
  if (state.activeQuery) runSearch();
});
elements.shuffleSuggestions.addEventListener("click", renderSuggestions);
elements.retryTextData.addEventListener("click", async () => {
  elements.retryTextData.hidden = true;
  if (!state.appReady) {
    if (await initializeCore()) loadDictionaryDetails();
  } else if (state.detailsStatus === "ready" && (state.pendingCoreBytes || state.pendingDetailsBytes)) {
    retryTextDataStorage();
  } else {
    loadDictionaryDetails();
  }
});
elements.downloadAccentAudio.addEventListener("click", startAudioDownload);
elements.cancelAudioDownload.addEventListener("click", () => {
  const worker = activeWorker();
  if (!worker) return;
  elements.cancelAudioDownload.disabled = true;
  elements.offlineStatus.textContent = "正在停止下載…";
  worker.postMessage({ type: "CANCEL_HAKKA_AUDIO" });
});
elements.clearOfflineAudio.addEventListener("click", () => {
  const worker = activeWorker();
  if (!worker || state.downloading) return;
  elements.offlineStatus.textContent = "正在清除離線學習語音…";
  postWorkerMessage(worker, { type: "CLEAR_HAKKA_AUDIO" }, handleServiceWorkerMessage);
});
elements.stopAudio.addEventListener("click", () => {
  elements.audio.pause();
  elements.audio.removeAttribute("src");
  elements.audio.load();
  elements.audioDock.hidden = true;
});
elements.audio.addEventListener("ended", () => {
  elements.audioDock.hidden = true;
});

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

function showInstallInstructions() {
  const isAppleMobile = /iphone|ipad|ipod/i.test(navigator.userAgent);
  elements.offlineStatus.textContent = isAppleMobile
    ? "iPhone／iPad：請用 Safari 的分享按鈕，選擇「加入主畫面」。"
    : "請開啟瀏覽器選單，選擇「安裝應用程式」或「加到主畫面」。";
  const scrollToInstructions = () => {
    window.requestAnimationFrame(() =>
      document.querySelector(".offline-card")?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "center",
      }),
    );
  };
  if (!window.location.hash.startsWith("#dictionary")) {
    window.addEventListener("hashchange", scrollToInstructions, { once: true });
    window.location.hash = "#dictionary";
  } else {
    scrollToInstructions();
  }
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.deferredInstallPrompt = event;
  if (state.appReady && !isStandalone()) elements.installApp.hidden = false;
  elements.installApp.textContent = "安裝 App";
});
elements.installApp.addEventListener("click", async () => {
  if (!state.deferredInstallPrompt) {
    showInstallInstructions();
    return;
  }
  state.deferredInstallPrompt.prompt();
  await state.deferredInstallPrompt.userChoice.catch(() => ({}));
  state.deferredInstallPrompt = null;
});
window.addEventListener("appinstalled", () => {
  state.deferredInstallPrompt = null;
  elements.installApp.hidden = true;
  elements.offlineStatus.textContent = "App 已安裝；文字詞庫離線狀態請見上方，學習語音可依腔調下載。";
});

initializeCore().then((ready) => {
  registerServiceWorker();
  if (ready) loadDictionaryDetails();
});
