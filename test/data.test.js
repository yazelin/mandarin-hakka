import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  expandCoreDictionary,
  mergeDictionaryDetails,
  officialAudioUrl,
  validateDictionaryDetails,
} from "../dictionary-data.js";

const coreUrl = new URL("../data/dictionary-core.json", import.meta.url);
const detailsUrl = new URL("../data/dictionary-details.json", import.meta.url);
const [coreRaw, detailsRaw] = await Promise.all([
  readFile(coreUrl, "utf8"),
  readFile(detailsUrl, "utf8"),
]);
const compactCore = JSON.parse(coreRaw);
const compactDetails = JSON.parse(detailsRaw);
const dictionary = expandCoreDictionary(JSON.parse(coreRaw));
validateDictionaryDetails(dictionary, compactDetails);
mergeDictionaryDetails(dictionary, compactDetails);

const ACCENTS = ["四縣", "海陸", "大埔", "饒平", "詔安", "南四縣"];
const ACCENT_KEYS = {
  四縣: "sixian",
  海陸: "hailu",
  大埔: "dapu",
  饒平: "raoping",
  詔安: "zhaoan",
  南四縣: "south-sixian",
};
const AUDIO_FILENAME = /^hk[0-9A-Za-z._-]+\.mp3$/;
const LOCAL_AUDIO =
  /^\.\.\/assets\/hakka-audio\/(sixian|hailu|dapu|raoping|zhaoan|south-sixian)\/hk[0-9A-Za-z._-]+\.mp3$/;

test("versioned two-stage files are deterministic, complete, and first-load bounded", () => {
  assert.equal(coreRaw.indexOf("\n"), coreRaw.length - 1);
  assert.equal(detailsRaw.indexOf("\n"), detailsRaw.length - 1);
  assert.deepEqual(dictionary.metadata.accents, ACCENTS);
  assert.equal(dictionary.metadata.schema_version, 1);
  assert.equal(dictionary.metadata.web_data.schema_version, 2);
  assert.equal(dictionary.metadata.web_data.core_format, 2);
  assert.equal(dictionary.metadata.web_data.revision, compactDetails.revision);
  assert.equal(dictionary.metadata.web_data.details_bytes, Buffer.byteLength(detailsRaw));
  assert.equal(dictionary.metadata.source_date, "2025-10-31");
  assert.equal(dictionary.metadata.license.name, "CC BY-ND 3.0 TW");
  assert.equal(dictionary.metadata.row_count, 105_852);
  assert.equal(dictionary.metadata.entry_count, 28_475);
  assert.equal(dictionary.metadata.headword_count, 23_004);
  assert.equal(dictionary.metadata.audio_count, 67_304);
  assert.equal(dictionary.entries.length, dictionary.metadata.entry_count);
  assert.ok(Array.isArray(compactCore.definitions));

  const coreBytes = Buffer.byteLength(coreRaw);
  const detailsBytes = Buffer.byteLength(detailsRaw);
  const coreGzip = gzipSync(coreRaw, { level: 9 }).byteLength;
  const detailsGzip = gzipSync(detailsRaw, { level: 9 }).byteLength;
  assert.ok(coreBytes < 5_600_000, `core is ${coreBytes} bytes`);
  assert.ok(coreGzip < 1_800_000, `core gzip is ${coreGzip} bytes`);
  assert.ok(detailsBytes < 13_200_000, `details is ${detailsBytes} bytes`);
  assert.ok(detailsGzip < 2_600_000, `details gzip is ${detailsGzip} bytes`);
  assert.ok(coreGzip + detailsGzip < 4_400_000);
});

test("expanded entries retain every searchable and display field with safe audio", () => {
  const headwords = new Set();
  const audio = new Set();
  let rowCount = 0;
  let previousHeadword = "";

  for (const entry of dictionary.entries) {
    assert.equal(typeof entry.headword, "string");
    assert.equal(entry.headword, entry.headword.trim());
    assert.ok(entry.headword >= previousHeadword, `out of order: ${entry.headword}`);
    previousHeadword = entry.headword;
    headwords.add(entry.headword);
    assert.ok(Array.isArray(entry.variants) && entry.variants.length > 0);
    assert.ok(entry.variants.length <= ACCENTS.length);

    if (Object.hasOwn(entry, "quiz_answer")) {
      assert.equal(entry.quiz_answer, entry.quiz_answer.trim());
      assert.ok([...entry.quiz_answer].length >= 2);
      assert.ok([...entry.quiz_answer].length <= 28);
      assert.match(entry.quiz_answer, /[。！？!?]$/u);
    }

    for (const variant of entry.variants) {
      rowCount += 1;
      assert.ok(ACCENTS.includes(variant.accent));
      for (const field of [
        "part_of_speech",
        "pronunciation",
        "location",
        "definition",
        "example",
        "synonyms",
        "antonyms",
      ]) {
        assert.equal(typeof variant[field], "string", `${entry.headword}.${field}`);
        assert.equal(variant[field], variant[field].trim(), `${entry.headword}.${field}`);
      }
      assert.ok(Array.isArray(variant.categories));
      assert.ok(Array.isArray(variant.audio));
      for (const filename of variant.audio) {
        assert.match(filename, AUDIO_FILENAME);
        assert.match(officialAudioUrl(filename), /^https:\/\/hakkadict\.moe\.edu\.tw\/static\/audio\//);
        audio.add(filename);
      }
      if (Object.hasOwn(variant, "quiz_audio")) {
        assert.match(variant.quiz_audio, LOCAL_AUDIO);
        assert.ok(variant.quiz_audio.includes(`/${ACCENT_KEYS[variant.accent]}/`));
        assert.ok(variant.audio.includes(variant.quiz_audio.split("/").at(-1)));
      }
    }
  }

  assert.equal(rowCount, dictionary.metadata.row_count);
  assert.equal(headwords.size, dictionary.metadata.headword_count);
  assert.equal(audio.size, dictionary.metadata.audio_count);
});

test("想像 is one six-accent entry with official definitions and recordings", () => {
  const matches = dictionary.entries.filter((entry) => entry.headword === "想像");
  assert.equal(matches.length, 1);
  const [entry] = matches;
  assert.equal(entry.quiz_answer, "假想。");
  assert.deepEqual(entry.variants.map((variant) => variant.accent), ACCENTS);
  for (const [index, variant] of entry.variants.entries()) {
    assert.ok(variant.definition.startsWith("假想。"));
    assert.ok(variant.audio.some((filename) => filename === `hk0000014108-1-${index + 1}.mp3`));
  }
});

test("the same recording never merges the two official meanings of 掠", () => {
  const matches = dictionary.entries.filter((entry) => entry.headword === "掠");
  const definitions = new Set(matches.flatMap((entry) => entry.variants.map((variant) => variant.definition)));
  assert.ok(definitions.has("捕捉、捕獲。"));
  assert.ok(definitions.has("動作敏捷不呆滯。"));
  assert.ok(matches.every((entry) => new Set(entry.variants.map((variant) => variant.definition)).size === 1));
});

test("local quiz packs contain exactly 360 unchanged files per accent", async () => {
  const pack = dictionary.metadata.quiz_audio;
  assert.equal(pack.per_accent, 360);
  assert.equal(pack.total_count, 2_160);
  const seenHeadwords = new Map(ACCENTS.map((accent) => [accent, new Set()]));
  const seenAnswers = new Map(ACCENTS.map((accent) => [accent, new Set()]));
  const selected = new Map(ACCENTS.map((accent) => [accent, []]));

  for (const entry of dictionary.entries) {
    for (const variant of entry.variants) {
      if (!variant.quiz_audio) continue;
      assert.ok(entry.quiz_answer);
      assert.ok(!seenHeadwords.get(variant.accent).has(entry.headword));
      assert.ok(!seenAnswers.get(variant.accent).has(entry.quiz_answer));
      seenHeadwords.get(variant.accent).add(entry.headword);
      seenAnswers.get(variant.accent).add(entry.quiz_answer);
      selected.get(variant.accent).push(variant.quiz_audio);
    }
  }

  let totalBytes = 0;
  for (const accent of ACCENTS) {
    const details = pack.accents[accent];
    assert.equal(details.key, ACCENT_KEYS[accent]);
    assert.equal(details.count, 360);
    assert.equal(selected.get(accent).length, 360);
    const folderUrl = new URL(`../assets/hakka-audio/${details.key}/`, import.meta.url);
    const filenames = (await readdir(folderUrl)).sort();
    assert.equal(filenames.length, 360);
    let accentBytes = 0;
    for (const filename of filenames) {
      const fileInfo = await stat(new URL(filename, folderUrl));
      assert.ok(fileInfo.size > 0);
      accentBytes += fileInfo.size;
    }
    assert.equal(accentBytes, details.bytes);
    totalBytes += accentBytes;
    for (const relativeUrl of selected.get(accent)) {
      const path = fileURLToPath(new URL(relativeUrl, coreUrl));
      assert.ok((await stat(path)).size > 0);
    }
  }
  assert.equal(totalBytes, pack.total_bytes);
});
