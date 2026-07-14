import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dictionaryUrl = new URL("../data/dictionary.json", import.meta.url);
const raw = await readFile(dictionaryUrl, "utf8");
const dictionary = JSON.parse(raw);

const ACCENTS = ["四縣", "海陸", "大埔", "饒平", "詔安", "南四縣"];
const ACCENT_KEYS = {
  四縣: "sixian",
  海陸: "hailu",
  大埔: "dapu",
  饒平: "raoping",
  詔安: "zhaoan",
  南四縣: "south-sixian",
};
const REMOTE_AUDIO =
  /^https:\/\/hakkadict\.moe\.edu\.tw\/static\/audio\/hk[0-9A-Za-z._-]+\.mp3$/;
const LOCAL_AUDIO =
  /^\.\.\/assets\/hakka-audio\/(sixian|hailu|dapu|raoping|zhaoan|south-sixian)\/hk[0-9A-Za-z._-]+\.mp3$/;

test("dictionary is deterministic minified UTF-8 JSON with complete snapshot counts", () => {
  assert.equal(raw.indexOf("\n"), raw.length - 1);
  assert.deepEqual(dictionary.metadata.accents, ACCENTS);
  assert.equal(dictionary.metadata.schema_version, 1);
  assert.equal(dictionary.metadata.source_date, "2025-10-31");
  assert.equal(dictionary.metadata.license.name, "CC BY-ND 3.0 TW");
  assert.equal(dictionary.metadata.row_count, 105_852);
  assert.equal(dictionary.metadata.entry_count, 28_475);
  assert.equal(dictionary.metadata.headword_count, 23_004);
  assert.equal(dictionary.metadata.audio_count, 67_304);
  assert.equal(dictionary.entries.length, dictionary.metadata.entry_count);
});

test("entries and variants conform to schema v1 without unsafe audio URLs", () => {
  const ids = new Set();
  const headwords = new Set();
  const audio = new Set();
  let rowCount = 0;
  let previousSortKey = "";

  for (const entry of dictionary.entries) {
    assert.equal(typeof entry.id, "string");
    assert.ok(entry.id);
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
    ids.add(entry.id);
    assert.equal(typeof entry.headword, "string");
    assert.equal(entry.headword, entry.headword.trim());
    assert.ok(entry.headword);
    headwords.add(entry.headword);
    const sortKey = `${entry.headword}\0${entry.id}`;
    assert.ok(sortKey >= previousSortKey, `out of order: ${entry.headword}`);
    previousSortKey = sortKey;
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
      assert.ok(Number.isInteger(variant.sequence) || typeof variant.sequence === "string");
      for (const field of [
        "part_of_speech",
        "pronunciation",
        "location",
        "definition",
        "example",
        "synonyms",
        "antonyms",
      ]) {
        assert.equal(typeof variant[field], "string", `${entry.id}.${field}`);
        assert.equal(variant[field], variant[field].trim(), `${entry.id}.${field}`);
      }
      assert.ok(Array.isArray(variant.categories));
      assert.ok(Array.isArray(variant.audio));
      for (const url of variant.audio) {
        assert.match(url, REMOTE_AUDIO);
        audio.add(url);
      }
      if (Object.hasOwn(variant, "quiz_audio")) {
        assert.match(variant.quiz_audio, LOCAL_AUDIO);
        assert.ok(
          variant.quiz_audio.includes(`/${ACCENT_KEYS[variant.accent]}/`),
          `${variant.accent} has mismatched local folder`,
        );
        assert.ok(
          variant.audio.some(
            (url) => new URL(url).pathname.split("/").at(-1) === variant.quiz_audio.split("/").at(-1),
          ),
          `${entry.id} local quiz audio does not match its official audio`,
        );
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
  assert.deepEqual(
    entry.variants.map((variant) => variant.accent),
    ACCENTS,
  );
  for (const [index, variant] of entry.variants.entries()) {
    assert.ok(variant.definition.startsWith("假想。"));
    assert.ok(variant.audio.length > 0);
    assert.ok(
      variant.audio.some((url) => url.includes(`hk0000014108-1-${index + 1}.mp3`)),
    );
  }
});

test("the same recording never merges the two official meanings of 掠", () => {
  const matches = dictionary.entries.filter((entry) => entry.headword === "掠");
  const definitions = new Set(
    matches.flatMap((entry) => entry.variants.map((variant) => variant.definition)),
  );
  assert.ok(definitions.has("捕捉、捕獲。"));
  assert.ok(definitions.has("動作敏捷不呆滯。"));
  assert.ok(
    matches.every(
      (entry) => new Set(entry.variants.map((variant) => variant.definition)).size === 1,
    ),
  );
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
    assert.ok(filenames.every((filename) => /^hk[0-9A-Za-z._-]+\.mp3$/.test(filename)));

    let accentBytes = 0;
    for (const filename of filenames) {
      const fileInfo = await stat(new URL(filename, folderUrl));
      assert.ok(fileInfo.size > 0);
      accentBytes += fileInfo.size;
    }
    assert.equal(accentBytes, details.bytes);
    totalBytes += accentBytes;

    for (const relativeUrl of selected.get(accent)) {
      const path = fileURLToPath(new URL(relativeUrl, dictionaryUrl));
      const fileInfo = await stat(path);
      assert.ok(fileInfo.size > 0);
    }
  }
  assert.equal(totalBytes, pack.total_bytes);
});
