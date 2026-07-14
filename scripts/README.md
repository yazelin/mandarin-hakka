# 客語詞庫建置

`build_hakka_dictionary.py` 直接解析教育部臺灣客語辭典提供的六份 ODS，產生網站使用的 `data/dictionary.json`。來源 ODS 不納入 repository；請由[官方資源下載頁](https://hakkadict.moe.edu.tw/resource_download/)取得。

## 建置完整詞庫與測驗音檔

六份 ODS 的參數順序固定為「四縣、海陸、大埔、饒平、詔安、南四縣」：

```bash
python3 scripts/build_hakka_dictionary.py \
  /tmp/hakka-0.ods \
  /tmp/hakka-1.ods \
  /tmp/hakka-2.ods \
  /tmp/hakka-3.ods \
  /tmp/hakka-4.ods \
  /tmp/hakka-5.ods \
  --quiz-audio-output assets/hakka-audio \
  --quiz-audio-per-accent 360
```

預設輸出為 `data/dictionary.json`。`source_date` 取六份 ODS ZIP 成員中最新的日期，也可用 `--source-date YYYY-MM-DD` 明確覆寫。JSON 使用 UTF-8、最小化格式與固定排序，同一份來源可重現相同內容。

精選測驗包會從具有乾淨 `quiz_answer` 與官方音檔的資料中，以固定 SHA-256 排序為每腔挑選 360 題；同一腔內不重複詞目、答案或檔名。下載的 MP3 bytes 不轉碼、不改寫，分別放在：

- `assets/hakka-audio/sixian/`
- `assets/hakka-audio/hailu/`
- `assets/hakka-audio/dapu/`
- `assets/hakka-audio/raoping/`
- `assets/hakka-audio/zhaoan/`
- `assets/hakka-audio/south-sixian/`

已存在的非空檔案會重用；各腔資料夾中未被本次固定選取的 MP3 會移除，確保檔案數與 metadata 一致。可用 `--download-workers` 調整同時下載數。

## Schema v1

頂層資料為：

```json
{"metadata":{},"entries":[]}
```

每個 entry 是一個詞義群組：

```json
{
  "id": "hk0000014108-59e6eecf",
  "headword": "想像",
  "quiz_answer": "假想。",
  "variants": [
    {
      "accent": "四縣",
      "sequence": 15428,
      "part_of_speech": "動",
      "pronunciation": "xiong31 xiong55",
      "location": "",
      "definition": "假想。對不在眼前的事物，利用過去的記憶或類似的經驗，構想具體的形象。",
      "example": "…",
      "synonyms": "聯想",
      "antonyms": "",
      "categories": ["思維心態"],
      "audio": ["https://hakkadict.moe.edu.tw/static/audio/hk0000014108-1-1.mp3"]
    }
  ]
}
```

被選入同源測驗包的 variant 另有 `quiz_audio`，其值相對於 `data/dictionary.json`，例如 `../assets/hakka-audio/sixian/hk….mp3`。遠端 `audio[]` 仍完整保留，供一般連網播放。

metadata 記錄 schema 版本、六腔、官方來源與來源日期、授權，以及 row、entry、不重複 headword、官方 audio 統計。`metadata.quiz_audio` 另記錄每腔 folder key、檔案數與 bytes。

## 不改寫原始內容

- 詞目、詞性、音讀、方言點、釋義、例句與同反義詞只做首尾 trim，並把連續 Unicode 空白正規化為一個空白；其他文字、字形與標點不改寫。
- 跨腔優先以官方音檔的 `hk` 核心 ID 加詞目合併；沒有音檔時以「詞目＋詞性＋完整釋義」分組。同一錄音若在同腔被不同詞義共用，則再以官方詞性與完整釋義拆開，避免同形異義誤合併。
- `quiz_answer` 只能是官方釋義中未改寫的完整第一句，長度限 2–28 字；編號多義或不符合條件時不產生此欄位。
- 音檔名稱只接受教育部官方 HTTPS host 下的安全 MP3 路徑；無副檔名時補 `.mp3`，拒絕外部 host、query、fragment 與路徑穿越。

文字及聲音檔案依教育部標示採 [CC BY-ND 3.0 TW](https://creativecommons.org/licenses/by-nd/3.0/tw/)，使用時須標示來源，且不得改作。

## 測試

```bash
python3 -m unittest discover -s test -p 'test_*.py'
node --test test/data.test.js
```

測試涵蓋 ODS 解析、空白正規化、安全音檔 URL、同形異義拆分、固定選題、實際檔案 bytes 統計，以及「想像」六腔資料。
