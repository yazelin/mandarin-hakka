import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

async function source(file) {
  return readFile(new URL(file, root), "utf8");
}

test("page is independently branded for Mandarin and Hakka", async () => {
  const html = await source("index.html");
  assert.match(html, /華語客語詞典/);
  assert.match(html, /華 ↔ 客/);
  assert.match(html, /四縣、海陸、大埔、饒平、詔安與南四縣/);
  assert.doesNotMatch(html, /mandarin-taigi|台語|臺語|臺羅|sutian/i);
});

test("mobile-first page exposes search, six-accent filter, learning routes, and install UI", async () => {
  const html = await source("index.html");
  for (const expected of [
    'id="query"',
    'id="accent"',
    'href="#challenge"',
    'href="#wrongbook"',
    'href="#flashcards"',
    'href="#about"',
    'id="install-app"',
    'id="download-accent-audio"',
  ]) assert.ok(html.includes(expected), expected);
  const css = await source("styles.css");
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(css, /\.quiz-options\s*\{[\s\S]*grid-template-columns: 1fr/);
});

test("the v4 app shell keeps the unchanged v3 dictionary identity", async () => {
  const html = await source("index.html");
  assert.match(html, /manifest\.webmanifest\?v=4/);
  assert.match(html, /styles\.css\?v=4/);
  assert.match(html, /app\.js\?v=4/);
  const app = await source("app.js");
  for (const edge of ["search.js?v=4", "quiz.js?v=4", "learning.js?v=4", "offline.js?v=4", "dictionary-data.js?v=4", "data-loader.js?v=4", "sw.js?v=4"]) {
    assert.ok(app.includes(edge), edge);
  }
  for (const edge of ["dictionary-core.json?v=3", "dictionary-details.json?v=3", "mandarin-hakka-data-v3"]) {
    assert.ok(app.includes(edge), edge);
  }
  const learning = await source("learning.js");
  assert.ok(learning.includes("quiz.js?v=4"));
  const worker = await source("sw.js");
  assert.match(worker, /const RELEASE_REVISION = "4"/);
  assert.match(worker, /const DATA_CACHE = "mandarin-hakka-data-v3"/);
});

test("core enables the app before details continue in the background", async () => {
  const app = await source("app.js");
  assert.match(app, /initializeCore\(\)\.then\(\(ready\) => \{\s*registerServiceWorker\(\);\s*if \(ready\) loadDictionaryDetails\(\);/);
  assert.match(app, /elements\.input\.disabled = false;[\s\S]*state\.detailsStatus = "pending"/);
  assert.match(app, /loadValidatedJson\(\{[\s\S]*canonicalUrl: DETAILS_DATA_URL[\s\S]*validateDictionaryDetails/);
  assert.match(app, /mergeDictionaryDetails\(state\.dictionary, result\.value\)/);
  assert.match(app, /if \(state\.activeQuery\) \{\s*runSearch\(\{ updateHash: false, resetLimit: false, focusResults: false \}\);/);
});

test("dictionary startup is local-first, CDN-backed, and asks for durable storage", async () => {
  const app = await source("app.js");
  assert.match(app, /cdn\.jsdelivr\.net\/gh\/yazelin\/mandarin-hakka@f953fbd518aaecf64ebda0d63b4be1b2a22ad813/);
  assert.match(app, /canonicalUrl: CORE_DATA_URL,[\s\S]*primaryUrl: CORE_PRIMARY_URL/);
  assert.match(app, /result\.source === "cache"[\s\S]*已從本機開啟/);
  assert.match(app, /已由高速節點下載並保存/);
  assert.match(app, /requestPersistentStorage\(\)/);
  assert.match(app, /void ensurePersistentDataStorage\(\)/);
  const html = await source("index.html");
  assert.match(html, /本機沒有時才從網路下載/);
  assert.match(html, /不會因介面更新而重複下載/);
});

test("text download state stays global, accessible, honest, and retryable", async () => {
  const html = await source("index.html");
  const mainStart = html.indexOf('<main id="main">');
  const dictionaryStart = html.indexOf('<section id="dictionary"');
  const statusStart = html.indexOf('id="text-data-status"');
  assert.ok(mainStart < statusStart && statusStart < dictionaryStart);
  assert.match(html, /id="text-data-progress"[\s\S]*aria-describedby="text-data-detail"/);
  assert.match(html, /id="text-data-announcement"[\s\S]*aria-live="polite"/);
  const app = await source("app.js");
  assert.match(app, /Math\.floor\(progress \/ 10\) \* 10/);
  assert.match(app, /pendingCoreBytes/);
  assert.match(app, /retryTextDataStorage\(\)/);
  assert.match(app, /state\.pendingCoreBytes[\s\S]*storeDataBytes\(CORE_DATA_URL, state\.pendingCoreBytes, dataCacheOptions\(\)\)/);
  assert.match(app, /完整文字詞庫已儲存/);
  assert.doesNotMatch(app, /完整詞庫已儲存在這台裝置/);
});

test("learning data and share assets use the Hakka namespace", async () => {
  const learning = await source("learning.js");
  assert.match(learning, /mandarin-hakka-learning-v1/);
  assert.match(learning, /hakka-challenge-score\.png/);
  assert.match(learning, /客語詞語隨機挑戰/);
  assert.doesNotMatch(learning, /mandarin-taigi|taigi-challenge|台語|臺語|臺羅/);
});

test("unanswered quiz audio and flashcard fronts do not reveal the answer", async () => {
  const app = await source("app.js");
  assert.match(app, /function playQuizAudio\(candidate, \{ reveal = false \} = \{\}\)/);
  assert.match(app, /const title = reveal[\s\S]*candidate\.headword[\s\S]*挑戰題/);

  const learning = await source("learning.js");
  const front = learning.match(
    /\} else \{\n\s+const listen = makeButton\("▶ 聽客語"[\s\S]*?\n\s+\}\n\s+card\.append\(face\);/,
  )?.[0];
  assert.ok(front, "flashcard front block is missing");
  assert.doesNotMatch(front, /candidate\.(?:answer|hanji|headword|romanization|pronunciation)/);
  assert.match(front, /先聽聲音，再翻面看詞目、拼音與華語意思/);
});

test("install entry appears only after readiness and supports iOS instructions", async () => {
  const app = await source("app.js");
  assert.match(app, /appReady: false/);
  assert.match(app, /state\.appReady = true;\n\s+if \(!isStandalone\(\)\) elements\.installApp\.hidden = false/);
  assert.match(
    app,
    /beforeinstallprompt[\s\S]*if \(state\.appReady && !isStandalone\(\)\) elements\.installApp\.hidden = false/,
  );
  assert.match(app, /navigator\.standalone === true/);
  assert.match(app, /iPhone／iPad：請用 Safari 的分享按鈕，選擇「加入主畫面」/);
  assert.match(app, /「安裝應用程式」或「加到主畫面」/);
  assert.match(app, /document\.querySelector\("\.offline-card"\)\?\.scrollIntoView/);
  assert.match(app, /appinstalled[\s\S]*elements\.installApp\.hidden = true/);
});

test("search result counts describe meaning records instead of unique headwords", async () => {
  const app = await source("app.js");
  assert.match(app, /找到 \$\{formatNumber\(found\.total\)\} 筆詞義/);
  assert.match(app, /共 \$\{formatNumber\(found\.total\)\} 筆詞義/);
  assert.doesNotMatch(app, /找到 \$\{formatNumber\(found\.total\)\} 個詞目/);
});

test("manifest describes an installable standalone education PWA", async () => {
  const manifest = JSON.parse(await source("manifest.webmanifest"));
  assert.equal(manifest.name, "華語客語詞典");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.ok(manifest.categories.includes("education"));
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
});
