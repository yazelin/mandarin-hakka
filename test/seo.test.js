import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const productionUrl = "https://yazelin.github.io/mandarin-hakka/";

async function source(path, encoding = "utf8") {
  return readFile(new URL(path, root), encoding);
}

function pngDimensions(buffer) {
  assert.equal(buffer.subarray(1, 4).toString("ascii"), "PNG");
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

test("production metadata has canonical, social preview, and structured data", async () => {
  const html = await source("index.html");
  assert.match(html, new RegExp(`<link rel="canonical" href="${productionUrl}"`));
  assert.match(html, /property="og:image" content="https:\/\/yazelin\.github\.io\/mandarin-hakka\/assets\/og-image\.png"/);
  assert.match(html, /name="twitter:image" content="https:\/\/yazelin\.github\.io\/mandarin-hakka\/assets\/og-image\.png"/);
  assert.match(html, /property="og:image:width" content="1200"/);
  assert.match(html, /property="og:image:height" content="630"/);

  const jsonLdText = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(jsonLdText, "JSON-LD is missing");
  const jsonLd = JSON.parse(jsonLdText);
  assert.equal(jsonLd["@type"], "WebApplication");
  assert.equal(jsonLd.url, productionUrl);
  assert.equal(jsonLd.isAccessibleForFree, true);
});

test("search discovery files expose only the production Pages URL", async () => {
  const [robots, sitemap] = await Promise.all([source("robots.txt"), source("sitemap.xml")]);
  assert.match(robots, new RegExp(`Sitemap: ${productionUrl}sitemap\\.xml`));
  assert.match(sitemap, new RegExp(`<loc>${productionUrl}</loc>`));
  assert.doesNotMatch(`${robots}\n${sitemap}`, /mandarin-taigi/);
});

test("install and social images have their declared dimensions", async () => {
  const expected = new Map([
    ["assets/apple-touch-icon.png", [180, 180]],
    ["assets/icon-192.png", [192, 192]],
    ["assets/icon-512.png", [512, 512]],
    ["assets/icon-maskable-512.png", [512, 512]],
    ["assets/og-image.png", [1200, 630]],
  ]);
  for (const [path, dimensions] of expected) {
    assert.deepEqual(pngDimensions(await source(path, null)), dimensions, path);
  }
});

test("public app sources contain no copied Taigi branding or legacy counts", async () => {
  const files = [
    "index.html",
    "manifest.webmanifest",
    "app.js",
    "search.js",
    "quiz.js",
    "learning.js",
    "offline.js",
    "sw.js",
    "styles.css",
    "README.md",
    "DATA-LICENSE.md",
  ];
  const joined = (await Promise.all(files.map((file) => source(file)))).join("\n");
  assert.doesNotMatch(joined, /mandarin-taigi|臺語|台語|臺羅|sutian/i);
  assert.doesNotMatch(joined, /6,505|6,607|13,419|13,161|108 MB|186 MB/);
});
