import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createSearchIndex,
  listAccents,
  normalizePronunciation,
  pickSuggestionTerms,
  searchEntriesDetailed,
} from "../search.js";
import { expandCoreDictionary, mergeDictionaryDetails } from "../dictionary-data.js";

const dictionary = {
  metadata: { accents: ["四縣", "海陸"] },
  entries: [
    {
      headword: "想像",
      variants: [
        {
          accent: "四縣",
          pronunciation: "xiong31 xiong55",
          definition: "假想。構想具體的形象。",
          example: "天頂个白雲。(天上的白雲。)",
          sequence: 991234,
          quiz_audio: "../assets/hakka-audio/sixian/secret-file.mp3",
          audio: ["https://example.test/a.mp3"],
        },
        {
          accent: "海陸",
          pronunciation: "siong24 siong11",
          definition: "假想。構想具體的形象。",
        },
      ],
    },
    {
      headword: "醫院",
      variants: [{ accent: "四縣", pronunciation: "i24 ien55", definition: "治療病人的地方。" }],
    },
  ],
};

test("searches headword, Mandarin full text, and tone-number pronunciation", () => {
  const index = createSearchIndex(dictionary);
  assert.equal(searchEntriesDetailed(index, "想像").results[0].entry.headword, "想像");
  assert.equal(searchEntriesDetailed(index, "構想具體").results[0].entry.headword, "想像");
  assert.equal(searchEntriesDetailed(index, "天上的白雲").results[0].entry.headword, "想像");
  assert.equal(searchEntriesDetailed(index, "xiong31 xiong55").results[0].entry.headword, "想像");
});

test("pronunciation search tolerates spaces, punctuation, and diacritics", () => {
  assert.equal(normalizePronunciation("ngiˇ ien"), normalizePronunciation("ngi ien"));
  assert.equal(normalizePronunciation("xiong31-xiong55"), "xiong31xiong55");
});

test("tone-number queries preserve exact tone discrimination", () => {
  const index = createSearchIndex({
    entries: [
      { headword: "甲", variants: [{ accent: "四縣", pronunciation: "xiong31 xiong55" }] },
      { headword: "乙", variants: [{ accent: "四縣", pronunciation: "xiong55 xiong31" }] },
    ],
  });
  assert.deepEqual(
    searchEntriesDetailed(index, "xiong31 xiong55").results.map(({ entry }) => entry.headword),
    ["甲"],
  );
  assert.equal(searchEntriesDetailed(index, "xiong xiong").total, 2);
});

test("accent filter only returns and matches variants from that accent", () => {
  const index = createSearchIndex(dictionary);
  assert.equal(searchEntriesDetailed(index, "xiong31", { accent: "海陸" }).total, 0);
  const result = searchEntriesDetailed(index, "假想", { accent: "海陸" }).results[0];
  assert.deepEqual(result.match.variants.map(({ variant }) => variant.accent), ["海陸"]);
});

test("technical sequence and audio path values are never searchable", () => {
  const index = createSearchIndex(dictionary);
  for (const query of ["991234", "assets", "secret-file", "mp3"]) {
    assert.equal(searchEntriesDetailed(index, query).total, 0, query);
  }
});

test("lists metadata accents and produces unique suggestions", () => {
  assert.deepEqual(listAccents(dictionary), ["四縣", "海陸"]);
  assert.deepEqual(pickSuggestionTerms(dictionary, 2, () => 0), ["醫院", "想像"]);
});

test("real dictionary finds tone-free and tone-number Hakka pronunciation", async () => {
  const coreUrl = new URL("../data/dictionary-core.json", import.meta.url);
  const detailsUrl = new URL("../data/dictionary-details.json", import.meta.url);
  const realDictionary = expandCoreDictionary(JSON.parse(await readFile(coreUrl, "utf8")));
  const index = createSearchIndex(realDictionary);
  for (const query of ["xiong xiong", "xiong31 xiong55"]) {
    const results = searchEntriesDetailed(index, query, { accent: "四縣", limit: 20 }).results;
    assert.ok(results.some(({ entry }) => entry.headword === "想像"), query);
  }
  const placeholderResults = searchEntriesDetailed(index, "ngi ien", {
    accent: "四縣",
    limit: 20,
  }).results;
  assert.ok(placeholderResults.some(({ entry }) => entry.headword === "議員"));

  const imagination = realDictionary.entries.find((entry) => entry.headword === "想像");
  assert.ok(searchEntriesDetailed(index, "假想", { limit: 20 }).results.some(({ entry }) => entry === imagination));
  mergeDictionaryDetails(realDictionary, JSON.parse(await readFile(detailsUrl, "utf8")));
  const fullIndex = createSearchIndex(realDictionary);
  const examplePhrase = imagination.variants.find((variant) => variant.example)?.example.slice(0, 8);
  assert.ok(examplePhrase);
  assert.ok(searchEntriesDetailed(fullIndex, examplePhrase, { limit: 40 }).results.some(({ entry }) => entry === imagination));
});
