# 客語詞庫 CDN、快取與資料發布手冊

這份文件是維護者與 Agent 的正式交接規格。產生 JSON 不等於完成發布；任何資料更新都必須走完整流程。

## 目前正式契約

| 項目 | 目前值 |
|---|---|
| App shell release | `4` |
| Dictionary data release | `3` |
| CDN data commit | `f953fbd518aaecf64ebda0d63b4be1b2a22ad813` |
| Canonical core | `./data/dictionary-core.json?v=3` |
| Canonical details | `./data/dictionary-details.json?v=3` |
| Data cache | `mandarin-hakka-data-v3` |
| Audio cache | `mandarin-hakka-audio-v1` |
| Core raw bytes | `5430039` |
| Details raw bytes | `13014463` |
| Core SHA-256 | `630c5173b558a1b13b3732d65b7ed1dd067be81cf1a1e54ab450722bf4af81d1` |
| Details SHA-256 | `c8eaaf2133a0a50a30240aa07145f411d25b07e0d2a1d846472ac29a0ee6ebf1` |

`PRIMARY_DATA_BASE` 故意不指向 HEAD。它指向最後一次改變目前兩份資料的 immutable commit；後續只改 UI 時必須保持不動。

## 載入與信任模型

每份資料都使用同一個同源 canonical key，順序固定為：

1. `mandarin-hakka-data-v3` 中已驗證的 canonical response。
2. jsDelivr 上 exact-commit 的精確檔案 URL。
3. 同源 GitHub Pages canonical URL 作最後備援。

`data-loader.js` 解析並呼叫 `dictionary-data.js` validator，成功後才把原始 bytes 存入 canonical key。CDN request 不帶 credentials。Service Worker 只能 cache-first 讀取 `DATA_CACHE`；cache miss 時不得把網路 JSON 直接寫入，否則會繞過 core/details revision 配對驗證。

## 為什麼使用完整 commit SHA

正式路徑不得使用 `@main`、branch、短 SHA、`@latest` 或可移動 tag：它們可能延遲更新，core 與 details 也可能在不同時間命中不同版本。完整 40 字元 commit 才能重現完全相同的 bytes。

可以另建 release tag 供人閱讀，但 runtime identity 仍使用 commit SHA。已被 pin 的 commit 不得 amend、rebase、squash 或 force-push。若內容有錯，建立新的 data commit 與新的 data release，不要改寫舊 identity。

jsDelivr GitHub endpoint 預設不支援單檔超過 20 MB、package 超過 150 MB。現行 details 約 13.0 MB、整個 tracked deployment 約 99.8 MB，已接近需要持續監控的範圍。只使用兩個精確 JSON URL；不得把 package root、完整官方音檔或 `assets/hakka-audio/` 改成 CDN 整包下載。若將來逼近限制，應把文字資料移到獨立小型 data repo 或 object storage，而不是改用 branch URL。

## 兩套版本的更新矩陣

| 變更 | Shell release/cache/query | Data URL/cache | CDN pin | Audio cache |
|---|---|---|---|---|
| 只改 HTML、CSS、JS、測試或文件 | 升版（純文件且不影響 Pages runtime 可不升） | 保持 | 保持 | 保持 |
| core/details bytes 改變 | 升版 | 升 data release | 換成 data commit A | 保持或依音檔判斷 |
| 精選學習 MP3 改變 | 升版 | metadata 改變時升 data release | metadata 改變時換 pin | 升版 |
| 只修 README／Agent 手冊 | 不必 | 保持 | 保持 | 保持 |

Shell 升版時必須同步 `app.js`、`sw.js`、`index.html`、`learning.js` 的 release 常數、shell cache、Service Worker registration query 與所有 module／manifest query。UI-only release 絕對不能清除或重新命名仍相同的 data cache。

## 完整資料發布流程

### 1. 產生並檢查資料

依 README 與 `scripts/README.md`，用六份官方 ODS 重建：

- `data/dictionary-core.json`
- `data/dictionary-details.json`
- `assets/hakka-audio/`（選題或來源有變更時）

先執行：

```bash
npm test
python3 -m unittest discover -s test -p 'test_*.py'
sha256sum data/dictionary-core.json data/dictionary-details.json
wc -c data/dictionary-core.json data/dictionary-details.json
```

每個 JSON 必須小於 20,000,000 bytes。同步核對 metadata、README 的資料規模與傳輸大小、`scripts/README.md` 範例和相關測試；不要把舊統計留在使用者文件。

### 2. 建立不可改寫的 data commit A

只在資料與必要音檔已定稿後提交：

```bash
git add data/ assets/hakka-audio/
git commit -m "data: refresh Hakka dictionary"
DATA_COMMIT="$(git rev-parse HEAD)"
test "${#DATA_COMMIT}" -eq 40
```

此後不得 amend A。先不要單獨 push，避免舊 App 的 Pages fallback 在 A、B 之間讀到新資料。

### 3. 建立引用 A 的 shell commit B

在 `app.js` 同步：

- 兩個 canonical `?v=<DATA_RELEASE>`。
- `PRIMARY_DATA_BASE` 的完整 `DATA_COMMIT`。
- `DATA_CACHE`。
- 學習音檔或同 URL bytes 改變時的 `AUDIO_CACHE`。

在 `sw.js` 同步 `DATA_CACHE`、必要的 `AUDIO_CACHE`，並升 shell release。再同步：

- `index.html`、`learning.js` 與所有 shell query。
- `test/ui.test.js`、`test/sw.test.js`、`test/data-loader.test.js`、`test/offline.test.js`。
- `test/data.test.js` 的來源日期、筆數與容量門檻。
- README、本文件目前值及 `scripts/README.md` 的 metadata 範例。

確認 B 沒有再次改動 A 的資料：

```bash
git diff --exit-code "$DATA_COMMIT" -- data/dictionary-core.json data/dictionary-details.json
npm test
python3 -m unittest discover -s test -p 'test_*.py'
```

提交 B 後一次 push A、B。若 A 的 SHA 改變，必須重新更新 pin；不可留下指向不存在或不同內容的 SHA。

### 4. Push 後驗證 CDN 與 Pages

```bash
curl -fsSL "https://cdn.jsdelivr.net/gh/yazelin/mandarin-hakka@${DATA_COMMIT}/data/dictionary-core.json" -o /tmp/hakka-core.cdn.json
curl -fsSL "https://cdn.jsdelivr.net/gh/yazelin/mandarin-hakka@${DATA_COMMIT}/data/dictionary-details.json" -o /tmp/hakka-details.cdn.json
cmp data/dictionary-core.json /tmp/hakka-core.cdn.json
cmp data/dictionary-details.json /tmp/hakka-details.cdn.json
```

等待 Pages 與 CI 成功，再以 cache-busting query 下載正式站兩檔並 `cmp`。最後用全新 profile 驗證首次核心可用、背景完整資料、本機 cache keys、斷網重開、查詞、腔調篩選及挑戰；另從上一個 PWA release 驗證升級。

## 失敗與 rollback

- CDN 失敗：保持 pin，確認 Pages fallback；不要臨時改成 `@main`。
- 新資料驗證失敗：建立新的修正 data commit／data release，不改寫舊 commit。
- CacheStorage 寫入失敗：保留已載入 bytes 供「重試儲存」，不可為了重試再次下載。
- 若同一路徑 MP3 bytes 已改變，必須升 `AUDIO_CACHE`；否則既有使用者可能繼續播放舊檔。
- Web 儲存仍可能因使用者清除網站資料、無痕模式或瀏覽器空間政策被移除；UI 不得宣稱絕對永久。
