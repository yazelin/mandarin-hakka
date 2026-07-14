// Pure helpers for joining the versioned first-load and deferred dictionary bundles.

const OFFICIAL_AUDIO_BASE = "https://hakkadict.moe.edu.tw/static/audio/";
const OFFICIAL_AUDIO_FILENAME = /^hk[0-9A-Za-z._-]+\.mp3$/i;

export function expandCoreDictionary(input) {
  const accents = input?.metadata?.accents;
  const definitions = input?.definitions;
  const compactEntries = input?.entries;
  if (
    input?.metadata?.web_data?.core_format !== 2 ||
    !Array.isArray(accents) ||
    !Array.isArray(definitions) ||
    !Array.isArray(compactEntries)
  ) throw new TypeError("核心詞庫格式不符");
  if (compactEntries.length !== Number(input.metadata.entry_count)) {
    throw new TypeError("核心詞庫的詞目數不一致");
  }

  let rowCount = 0;
  const entries = compactEntries.map((row, entryIndex) => {
    if (!Array.isArray(row) || typeof row[0] !== "string" || !Array.isArray(row[2])) {
      throw new TypeError(`核心詞庫第 ${entryIndex + 1} 筆格式不符`);
    }
    const variants = row[2].map((variant, variantIndex) => {
      const accent = accents[variant?.[0]];
      const definition = definitions[variant?.[2]];
      if (!Array.isArray(variant) || !accent || typeof variant[1] !== "string" || typeof definition !== "string") {
        throw new TypeError(`核心詞庫第 ${entryIndex + 1} 筆第 ${variantIndex + 1} 腔格式不符`);
      }
      const expanded = { accent, pronunciation: variant[1], definition };
      if (variant[3]) expanded.quiz_audio = variant[3];
      return expanded;
    });
    rowCount += variants.length;
    const entry = { headword: row[0], variants };
    if (row[1]) entry.quiz_answer = row[1];
    return entry;
  });
  if (rowCount !== Number(input.metadata.row_count)) {
    throw new TypeError("核心詞庫的六腔資料數不一致");
  }
  input.entries = entries;
  delete input.definitions;
  return input;
}

export function officialAudioUrl(value = "") {
  const text = String(value || "").trim();
  if (OFFICIAL_AUDIO_FILENAME.test(text)) {
    return `${OFFICIAL_AUDIO_BASE}${encodeURIComponent(text)}`;
  }
  try {
    const url = new URL(text);
    if (
      url.origin === "https://hakkadict.moe.edu.tw" &&
      url.pathname.startsWith("/static/audio/") &&
      OFFICIAL_AUDIO_FILENAME.test(url.pathname.slice("/static/audio/".length)) &&
      !url.search &&
      !url.hash
    ) return url.href;
  } catch {
    // Invalid or non-official values are deliberately ignored.
  }
  return "";
}

export function validateDictionaryDetails(core, details) {
  const expected = core?.metadata?.web_data;
  if (!Array.isArray(core?.entries) || !expected) throw new TypeError("核心詞庫格式不符");
  if (
    !Array.isArray(details?.entries) ||
    !Array.isArray(details?.parts_of_speech) ||
    !Array.isArray(details?.locations) ||
    !Array.isArray(details?.examples) ||
    !Array.isArray(details?.synonyms) ||
    !Array.isArray(details?.antonyms) ||
    !Array.isArray(details?.categories)
  ) {
    throw new TypeError("完整詞庫格式不符");
  }
  if (details.schema_version !== expected.schema_version || details.revision !== expected.revision) {
    throw new TypeError("核心與完整詞庫版本不一致");
  }
  if (
    Number(details.entry_count) !== Number(core.metadata.entry_count) ||
    details.source_date !== core.metadata.source_date
  ) throw new TypeError("核心與完整詞庫的資料版本不一致");
  if (details.entries.length !== core.entries.length) {
    throw new TypeError("完整詞庫的詞目數不一致");
  }

  let rows = 0;
  for (let entryIndex = 0; entryIndex < core.entries.length; entryIndex += 1) {
    const coreVariants = core.entries[entryIndex]?.variants;
    const detailVariants = details.entries[entryIndex];
    if (!Array.isArray(coreVariants) || !Array.isArray(detailVariants) || coreVariants.length !== detailVariants.length) {
      throw new TypeError(`完整詞庫第 ${entryIndex + 1} 筆的腔調數不一致`);
    }
    for (const row of detailVariants) {
      if (!Array.isArray(row) || row.length < 1 || row.length > 7) {
        throw new TypeError(`完整詞庫第 ${entryIndex + 1} 筆的欄位格式不符`);
      }
      for (const [index, table] of [
        [row[0], details.parts_of_speech],
        [row[1] || 0, details.locations],
        [row[2] || 0, details.examples],
        [row[3] || 0, details.synonyms],
        [row[4] || 0, details.antonyms],
      ]) {
        if (!Number.isInteger(index) || typeof table[index] !== "string") {
          throw new TypeError(`完整詞庫第 ${entryIndex + 1} 筆的字串索引不符`);
        }
      }
      const categoryIndexes = Array.isArray(row[5]) ? row[5] : row[5] ? [row[5]] : [];
      if (categoryIndexes.some((index) => !Number.isInteger(index) || typeof details.categories[index] !== "string")) {
        throw new TypeError(`完整詞庫第 ${entryIndex + 1} 筆的分類索引不符`);
      }
      const audio = Array.isArray(row[6]) ? row[6] : row[6] ? [row[6]] : [];
      if (audio.some((filename) => !OFFICIAL_AUDIO_FILENAME.test(filename))) {
        throw new TypeError(`完整詞庫第 ${entryIndex + 1} 筆的音檔名稱不符`);
      }
    }
    rows += detailVariants.length;
  }
  if (rows !== Number(details.row_count) || rows !== Number(core.metadata.row_count)) {
    throw new TypeError("完整詞庫的六腔資料數不一致");
  }
  return true;
}

export function mergeDictionaryDetails(core, details) {
  validateDictionaryDetails(core, details);
  for (let entryIndex = 0; entryIndex < core.entries.length; entryIndex += 1) {
    const entry = core.entries[entryIndex];
    for (let variantIndex = 0; variantIndex < entry.variants.length; variantIndex += 1) {
      const row = details.entries[entryIndex][variantIndex];
      const categoryIndexes = Array.isArray(row[5]) ? row[5] : row[5] ? [row[5]] : [];
      const audio = Array.isArray(row[6]) ? row[6] : row[6] ? [row[6]] : [];
      Object.assign(entry.variants[variantIndex], {
        part_of_speech: details.parts_of_speech[row[0]] || "",
        location: details.locations[row[1]] || "",
        example: details.examples[row[2]] || "",
        synonyms: details.synonyms[row[3]] || "",
        antonyms: details.antonyms[row[4]] || "",
        categories: categoryIndexes.map((index) => details.categories[index]).filter(Boolean),
        audio,
      });
    }
  }
  return core;
}
