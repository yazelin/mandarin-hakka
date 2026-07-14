// Pure search helpers. This module intentionally has no DOM or network access.

const HAN_OR_LATIN = /[\p{Script=Han}\p{Script=Latin}\p{Number}]/u;

export function normalizeText(value = "") {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("zh-Hant-TW")
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePronunciation(value = "") {
  return normalizeText(value)
    .replace(/[\-–—·・,，.。;；:：!?！？()（）\[\]{}'\s]/g, "")
    .normalize("NFD")
    .replace(/[\p{M}\p{Sk}ˊˇˋˆ]/gu, "")
    .normalize("NFC");
}

function withoutToneDigits(value = "") {
  return value.replace(/\d+/g, "");
}

function textValues(value) {
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (value == null || typeof value === "object") return [];
  const text = String(value).trim();
  return text ? [text] : [];
}

function variantFulltext(variant) {
  const searchableFields = [
    "definition",
    "example",
    "location",
    "categories",
    "synonyms",
    "antonyms",
    "part_of_speech",
  ];
  return searchableFields
    .flatMap((field) => textValues(variant?.[field]))
    .join(" \u0001 ");
}

function normalizedFieldScore(normalized, wanted) {
  if (!wanted) return 0;
  if (normalized === wanted) return 100;
  if (normalized.startsWith(wanted)) return 70;
  if (normalized.includes(wanted)) return 45;
  return 0;
}

export function createSearchIndex(input = {}) {
  const entries = Array.isArray(input) ? input : Array.isArray(input?.entries) ? input.entries : [];
  const fulltextIntern = new Map();
  const internFulltext = (variant) => {
    const normalized = normalizeText(variantFulltext(variant));
    const shared = fulltextIntern.get(normalized);
    if (shared !== undefined) return shared;
    fulltextIntern.set(normalized, normalized);
    return normalized;
  };
  return entries
    .filter((entry) => entry && typeof entry === "object" && normalizeText(entry.headword))
    .map((entry, entryIndex) => ({
      entry,
      entryIndex,
      headword: normalizeText(entry.headword),
      variants: (Array.isArray(entry.variants) ? entry.variants : []).map((variant, index) => {
        const pronunciation = normalizePronunciation(variant?.pronunciation);
        return {
          variant,
          index,
          accent: normalizeText(variant?.accent),
          pronunciation,
          pronunciationWithoutTones: withoutToneDigits(pronunciation),
          fulltext: internFulltext(variant),
        };
      }),
    }));
}

export function searchEntriesDetailed(index = [], query = "", options = {}) {
  const textQuery = normalizeText(query);
  const pronunciationQuery = normalizePronunciation(query);
  const pronunciationHasToneDigits = /\d/.test(pronunciationQuery);
  const pronunciationWithoutTones = withoutToneDigits(pronunciationQuery);
  const selectedAccent = normalizeText(options.accent);
  const limit = Math.max(1, Number(options.limit) || 40);
  if (!textQuery || !HAN_OR_LATIN.test(textQuery)) {
    return { results: [], total: 0, truncated: false };
  }

  const matches = [];
  for (const item of index) {
    const availableVariants = selectedAccent
      ? item.variants.filter((variant) => variant.accent === selectedAccent)
      : item.variants;
    if (selectedAccent && availableVariants.length === 0) continue;

    const headwordScore = normalizedFieldScore(item.headword, textQuery) * 4;
    const variants = [];
    let score = headwordScore;

    for (const indexed of availableVariants) {
      const pronunciationScore =
        normalizedFieldScore(
          pronunciationHasToneDigits ? indexed.pronunciation : indexed.pronunciationWithoutTones,
          pronunciationHasToneDigits ? pronunciationQuery : pronunciationWithoutTones,
        ) * 3;
      const fulltextScore = normalizedFieldScore(indexed.fulltext, textQuery);
      const variantScore = Math.max(pronunciationScore, fulltextScore);
      if (headwordScore || variantScore) {
        const fields = [];
        if (pronunciationScore) fields.push("pronunciation");
        if (fulltextScore) fields.push("mandarin-fulltext");
        variants.push({ index: indexed.index, variant: indexed.variant, fields, score: variantScore });
        score = Math.max(score, variantScore);
      }
    }

    if (score > 0) {
      matches.push({
        entry: item.entry,
        score,
        match: { headword: Boolean(headwordScore), variants },
      });
    }
  }

  matches.sort(
    (left, right) =>
      right.score - left.score ||
      String(left.entry.headword).localeCompare(String(right.entry.headword), "zh-Hant-TW"),
  );
  const results = matches.slice(0, limit);
  return { results, total: matches.length, truncated: results.length < matches.length };
}

export function searchEntries(index, query, options = {}) {
  return searchEntriesDetailed(index, query, options).results.map(({ entry }) => entry);
}

export function listAccents(input = {}) {
  const metadataAccents = Array.isArray(input?.metadata?.accents) ? input.metadata.accents : [];
  const entryAccents = (Array.isArray(input?.entries) ? input.entries : []).flatMap((entry) =>
    (Array.isArray(entry?.variants) ? entry.variants : []).map((variant) => variant?.accent),
  );
  return [...new Set([...metadataAccents, ...entryAccents].map((value) => String(value || "").trim()).filter(Boolean))];
}

export function pickSuggestionTerms(input = {}, count = 6, random = Math.random) {
  const entries = Array.isArray(input) ? input : Array.isArray(input?.entries) ? input.entries : [];
  const terms = [...new Set(entries.map((entry) => String(entry?.headword || "").trim()).filter(Boolean))];
  for (let index = terms.length - 1; index > 0; index -= 1) {
    const value = Number(random());
    const safe = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999) : 0;
    const picked = Math.floor(safe * (index + 1));
    [terms[index], terms[picked]] = [terms[picked], terms[index]];
  }
  return terms.slice(0, Math.max(0, Number(count) || 0));
}
