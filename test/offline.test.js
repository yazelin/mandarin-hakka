import test from "node:test";
import assert from "node:assert/strict";

import {
  canDownloadAccentPack,
  canDownloadOfflineAudio,
  classifyServiceWorkerReply,
  isLocalHakkaPackAudioUrl,
  isOfficialHakkaAudioUrl,
} from "../offline.js";

const expected = {
  releaseRevision: "3",
  audioCache: "mandarin-hakka-audio-v1",
};

test("a verified v3 worker allows an accent pack before and after it controls the page", () => {
  const reply = { release: "3", audioCache: expected.audioCache };
  assert.equal(classifyServiceWorkerReply(reply, { ...expected, controlled: false }), "installed");
  assert.equal(classifyServiceWorkerReply(reply, { ...expected, controlled: true }), "current");
  assert.equal(canDownloadOfflineAudio("installed"), true);
  assert.equal(canDownloadAccentPack("installed", "sixian"), true);
  assert.equal(canDownloadAccentPack("current", "south-sixian"), true);
});

test("old, silent, unavailable, and unselected states stay blocked", () => {
  assert.equal(
    classifyServiceWorkerReply(
      { release: "0", audioCache: expected.audioCache },
      { ...expected, controlled: true },
    ),
    "outdated",
  );
  assert.equal(classifyServiceWorkerReply(null, expected), "unverified");
  for (const status of ["checking", "outdated", "unverified", "none"]) {
    assert.equal(canDownloadOfflineAudio(status), false, status);
    assert.equal(canDownloadAccentPack(status, "sixian"), false, status);
  }
  assert.equal(canDownloadAccentPack("current", ""), false);
  assert.equal(canDownloadAccentPack("current", "  "), false);
  assert.equal(canDownloadAccentPack("current", "南四縣腔"), false);
});

test("only the Ministry's exact HTTPS MP3 directory is accepted as remote audio", () => {
  assert.equal(
    isOfficialHakkaAudioUrl("https://hakkadict.moe.edu.tw/static/audio/hk0000014108-1-1.mp3"),
    true,
  );
  assert.equal(
    isOfficialHakkaAudioUrl("https://hakkadict.moe.edu.tw/static/audio/HK0001.MP3?source=app"),
    true,
  );
  for (const value of [
    "http://hakkadict.moe.edu.tw/static/audio/a.mp3",
    "https://evil.test/static/audio/a.mp3",
    "https://hakkadict.moe.edu.tw/static/audio/nested/a.mp3",
    "https://hakkadict.moe.edu.tw/static/audio/a.wav",
    "https://hakkadict.moe.edu.tw/static/other/a.mp3",
    "not a URL",
  ]) {
    assert.equal(isOfficialHakkaAudioUrl(value), false, value);
  }
});

test("learning-pack URLs must stay inside this app's accent directory", () => {
  const scope = "https://example.test/mandarin-hakka/";
  assert.equal(
    isLocalHakkaPackAudioUrl(
      "https://example.test/mandarin-hakka/assets/hakka-audio/sixian/hk0001.mp3",
      scope,
    ),
    true,
  );
  assert.equal(
    isLocalHakkaPackAudioUrl("./assets/hakka-audio/south-sixian/hk0002.mp3", scope),
    true,
  );
  for (const value of [
    "https://example.test/assets/hakka-audio/sixian/hk.mp3",
    "https://example.test/mandarin-hakka/assets/hakka-audio/sixian/nested/hk.mp3",
    "https://example.test/mandarin-hakka/assets/hakka-audio/sixian/hk.wav",
    "https://example.test/mandarin-hakka/assets/hakka-audio/unknown/hk.mp3",
    "https://example.test/mandarin-hakka/assets/hakka-audio/sixian/%2Fsecret.mp3",
    "https://evil.test/mandarin-hakka/assets/hakka-audio/sixian/hk.mp3",
  ]) {
    assert.equal(isLocalHakkaPackAudioUrl(value, scope), false, value);
  }
});
