import {
  createSearchIndex,
  listAccents,
  pickSuggestionTerms,
  searchEntriesDetailed,
} from "./search.js?v=1";
import { buildQuizPool } from "./quiz.js?v=1";
import { initializeLearning } from "./learning.js?v=1";
import { canDownloadAccentPack, classifyServiceWorkerReply } from "./offline.js?v=1";

const DATA_URL = "./data/dictionary.json?v=1";
const DATA_BASE_URL = new URL(DATA_URL, window.location.href);
const RELEASE_REVISION = "1";
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

function setStatus(message, kind = "") {
  elements.status.textContent = message;
  elements.status.dataset.kind = kind;
}

function stringValue(value) {
  if (Array.isArray(value)) return value.map(stringValue).filter(Boolean).join("、");
  return value == null || typeof value === "object" ? "" : String(value).trim();
}

function officialAudioUrls(variant) {
  const values = Array.isArray(variant?.audio) ? variant.audio : variant?.audio ? [variant.audio] : [];
  return [...new Set(values.map(stringValue).filter((url) => /^https:\/\//i.test(url)))];
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
  if (!audio.length) actions.append(makeElement("span", { className: "audio-unavailable", text: "未提供錄音" }));
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

function runSearch({ updateHash = true, resetLimit = true } = {}) {
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
  elements.results.focus({ preventScroll: true });
  elements.results.scrollIntoView({ behavior: "smooth", block: "start" });
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
    elements.offlineStatus.textContent = "已清除離線學習語音；文字詞庫仍可離線查詢。";
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
      elements.offlineStatus.textContent = "詞庫已可離線；選擇腔調可下載挑戰題語音。";
    }
  }
  updateOfflineButton();
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    elements.offlineStatus.textContent = "此瀏覽器不支援離線安裝；仍可連網查詞與挑戰。";
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register("./sw.js?v=1", { scope: "./" });
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

async function initialize() {
  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const dictionary = await response.json();
    if (!Array.isArray(dictionary?.entries)) throw new TypeError("詞庫格式不符");
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
    setStatus(`詞庫已就緒，共 ${formatNumber(metadata.headword_count ?? metadata.entry_count ?? dictionary.entries.length)} 個客語詞目。`, "success");
    state.learning = initializeLearning({
      dictionary,
      playAudio: playQuizAudio,
      sourceUrl: metadata.source_url || SOURCE_URL,
    });
    state.appReady = true;
    if (!isStandalone()) elements.installApp.hidden = false;
    restoreSearchFromHash();
    updateOfflineButton();
  } catch (error) {
    console.error(error);
    setStatus("詞庫載入失敗。若目前離線，請先連網開啟一次後再試。", "error");
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
  elements.offlineStatus.textContent = "App 已安裝；文字詞庫可離線，學習語音可依腔調下載。";
});

registerServiceWorker();
initialize();
