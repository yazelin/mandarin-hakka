# 華客語詞語對照

一套使用教育部《臺灣客語辭典》六腔資料製作的離線優先 PWA。可以用華語釋義、客語漢字或客語拼音查詞，聆聽官方發音，也能用隨機挑戰、錯題本和學習卡練習。

線上版：https://yazelin.github.io/mandarin-hakka/

## 功能

- 整合四縣、海陸、大埔、饒平、詔安、南四縣六份教育部官方 ODS。
- 可搜尋客語詞目、拼音、華語釋義與例句，並依腔調篩選。
- 顯示詞性、音讀、方言點、釋義、例句、相似詞與相反詞。
- 首次先載入核心查詞資料（詞目、六腔拼音、華語釋義與挑戰），可用後再於背景補上例句、同反義詞、分類與官方發音播放資料；畫面會持續顯示真實進度。
- 每次啟動都先讀取同版的本機驗證快取；沒有才從固定 commit 的 jsDelivr 邊緣節點下載，失敗時自動改走 GitHub Pages。
- 核心與完整資料通過同版指紋驗證並寫入瀏覽器後，才會標示完整文字可離線查詢。App 殼與資料版本分開，單純更新介面不會讓詞庫重抓。
- 每腔精選 360 個原始官方 MP3 作為同源學習語音包，可另外下載後離線遊玩。
- 每局隨機抽 10 題「聽客語詞猜華語釋義」四選一；題目與答案不重複，歧義答案不會拿來硬判。
- 答錯詞語只存在本機錯題本，可用學習卡複習；完成挑戰可產生成績圖卡分享。
- 純靜態網站，沒有後端、帳號、追蹤碼或第三方 AI 呼叫。
- 支援安裝成 App；查詢只放在網址 `#` 片段，不會傳給靜態網站主機。

## 資料規模

目前建置資料包含：

- 105,852 筆腔別資料
- 28,475 個詞義群組
- 23,004 個不同詞目
- 67,304 個官方音檔網址
- 2,160 個隨站提供的離線學習音檔（每腔 360 個）

數字由建置程式直接從六份官方 ODS 與實際下載檔案計算，並由測試核對，不是人工填寫的估計值。

網站不再阻塞下載原本約 47.3 MB 的單一 JSON。現行首包約 5.43 MB、背景完整欄位約 13.01 MB；jsDelivr 會分別以約 1.55 MB 與 2.38 MB 的 Brotli 內容傳送，GitHub Pages 備援則使用 gzip。測試設有大小上限，避免日後不慎退化。

## 資料來源與授權

客語文字與音檔來自中華民國教育部《臺灣客語辭典》，官方內容採「創用 CC 姓名標示－禁止改作 3.0 臺灣」授權。本站保留官方文字及 MP3 原始內容，不改寫釋義、不轉碼音檔。

完整說明請見 [DATA-LICENSE.md](DATA-LICENSE.md)。程式碼採 [MIT License](LICENSE)；MIT License 不適用於教育部辭典資料與音檔。

## 本機開發

不需要建置框架：

```bash
python3 -m http.server 4173
```

開啟 http://127.0.0.1:4173/。Service Worker 只能在 HTTP localhost 或 HTTPS 下運作，不要直接以 `file://` 開啟。

執行測試：

```bash
npm test
python3 -m unittest discover -s test -p 'test_*.py'
```

## 重新產生詞庫

先從教育部[客語資源下載](https://hakkadict.moe.edu.tw/resource_download/)取得六份 ODS，再依四縣、海陸、大埔、饒平、詔安、南四縣順序執行：

```bash
python3 scripts/build_hakka_dictionary.py \
  /path/to/四縣腔詞條詞目文字.ods \
  /path/to/海陸腔詞條詞目文字.ods \
  /path/to/大埔腔詞條詞目文字.ods \
  /path/to/饒平腔詞條詞目文字.ods \
  /path/to/詔安腔詞條詞目文字.ods \
  /path/to/南四縣腔詞條詞目文字.ods \
  --quiz-audio-output assets/hakka-audio \
  --quiz-audio-per-accent 360
```

建置器只使用 Python 標準函式庫，會安全解析 ODS、整理六腔關聯、驗證官方音檔網址，產生同版的 `dictionary-core.json` 與 `dictionary-details.json`，並以固定規則挑選每腔不重複的學習題。音檔採原始位元下載，建置可重跑且結果可重現。如需稽核用未切分 JSON，可另加 `--output /tmp/dictionary.json`；網站不部署該檔。

## 專案結構

- `data/dictionary-core.json`：先載入的詞目、六腔拼音、華語釋義與挑戰資料
- `data/dictionary-details.json`：背景載入的例句、同反義詞、分類與發音播放資料
- `dictionary-data.js`：兩階段資料驗證、展開與合併
- `data-loader.js`：本機優先、固定 CDN 來源、Pages 備援與持久儲存
- `assets/hakka-audio/`：各腔精選的原始官方學習音檔
- `scripts/build_hakka_dictionary.py`：ODS、JSON 與學習音檔建置器
- `search.js`：華語、客語漢字與拼音搜尋
- `quiz.js`、`learning.js`：挑戰、錯題本、學習卡與分享圖卡
- `sw.js`、`offline.js`：PWA 安裝、版本交接與離線快取

本站不是教育部官方服務，教育部未為本站或作者背書。
