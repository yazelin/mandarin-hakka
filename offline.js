export const OFFICIAL_HAKKA_AUDIO_ORIGIN = "https://hakkadict.moe.edu.tw";
export const OFFICIAL_HAKKA_AUDIO_PATH = "/static/audio/";
export const LOCAL_HAKKA_AUDIO_PATH = "assets/hakka-audio/";
export const HAKKA_ACCENT_KEYS = Object.freeze([
  "sixian",
  "hailu",
  "dapu",
  "raoping",
  "zhaoan",
  "south-sixian",
]);
const HAKKA_ACCENT_KEY_SET = new Set(HAKKA_ACCENT_KEYS);

export function classifyServiceWorkerReply(
  reply,
  { controlled = false, releaseRevision = "", audioCache = "" } = {},
) {
  if (!reply || typeof reply !== "object") return "unverified";
  if (reply.release !== releaseRevision || reply.audioCache !== audioCache) return "outdated";
  return controlled ? "current" : "installed";
}

export function canDownloadOfflineAudio(compatibility) {
  return compatibility === "current" || compatibility === "installed";
}

export function canDownloadAccentPack(compatibility, selectedAccent) {
  return canDownloadOfflineAudio(compatibility) &&
    typeof selectedAccent === "string" &&
    HAKKA_ACCENT_KEY_SET.has(selectedAccent.trim());
}

export function isOfficialHakkaAudioUrl(value) {
  let url;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    return false;
  }

  if (url.origin !== OFFICIAL_HAKKA_AUDIO_ORIGIN || url.username || url.password) return false;
  if (!url.pathname.startsWith(OFFICIAL_HAKKA_AUDIO_PATH)) return false;

  const filename = url.pathname.slice(OFFICIAL_HAKKA_AUDIO_PATH.length);
  return filename.length > 4 && !filename.includes("/") && filename.toLowerCase().endsWith(".mp3");
}

export function isLocalHakkaPackAudioUrl(value, scope) {
  let url;
  let scopeUrl;
  try {
    url = value instanceof URL ? value : new URL(value, scope);
    scopeUrl = scope instanceof URL ? scope : new URL(scope);
  } catch {
    return false;
  }

  const prefix = new URL(LOCAL_HAKKA_AUDIO_PATH, scopeUrl).pathname;
  if (url.origin !== scopeUrl.origin || url.username || url.password || !url.pathname.startsWith(prefix)) {
    return false;
  }
  const relativePath = url.pathname.slice(prefix.length);
  const segments = relativePath.split("/");
  return segments.length === 2 &&
    segments.every(Boolean) &&
    HAKKA_ACCENT_KEY_SET.has(segments[0]) &&
    /^[a-z0-9][a-z0-9._-]*\.mp3$/i.test(segments[1]);
}
