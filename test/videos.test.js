// Offline test for the Videos tab: runs dota-limit/videos.js against a canned YouTube
// search page, then renders videos.html in a fake DOM.
// Run: node test/videos.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { createVideos, parseSearch, seconds } = require("../dota-limit/videos");

const video = (id, title, length, extra) =>
  ({ videoRenderer: Object.assign({
    videoId: id,
    title: { runs: [{ text: title }] },
    ownerText: { runs: [{ text: "freeCodeCamp.org" }] },
    lengthText: length ? { simpleText: length } : undefined,
    publishedTimeText: { simpleText: "3y ago" },
    viewCountText: { simpleText: "1,253,236 views" },
    navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: `/watch?v=${id}` } } },
  }, extra || {}) });
const data = { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
  { itemSectionRenderer: { contents: [
    video("BpPEoZW5IiY", "Learn Rust <Programming>", "13:59:10"),
    { adSlotRenderer: { videoId: "adadadadada" } },
    video("tS1PFlTmpuU", "Rust in 100 Seconds", "1:40"),
    video("shortshort1", "Rust meme", "2:30", { navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: "/shorts/shortshort1" } } } }),
    video("livelivelive", "Rust live coding", null),
    { shelfRenderer: { content: { verticalListRenderer: { items: [video("abcdefghijk", "Rust error handling", "12:30")] } } } },
    video("BpPEoZW5IiY", "Learn Rust again", "13:59:10"),
  ] } },
] } } } } };
const page = `<html><script>var ytInitialData = ${JSON.stringify(data)};</script></html>`;

assert.strictEqual(seconds("13:59:10"), 50350);
assert.strictEqual(seconds("2:00"), 120);
assert.strictEqual(seconds("LIVE"), null);
const found = parseSearch(page);
assert.deepStrictEqual(found.map((v) => v.id), ["BpPEoZW5IiY", "abcdefghijk"], "no ads, Shorts, live streams, clips under 2 minutes or repeats");
assert.strictEqual(found[0].title, "Learn Rust <Programming>");
assert.strictEqual(found[0].channel, "freeCodeCamp.org");
assert.strictEqual(found[0].thumb, "https://i.ytimg.com/vi/BpPEoZW5IiY/mqdefault.jpg");
assert.throws(() => parseSearch("<html>consent page</html>"), /changed its search page/);
console.log("ok: search parsing");

(async () => {
  const urls = [];
  let clock = 0;
  const v = createVideos({ fetchText: async (url) => (urls.push(url), page), now: () => clock });
  assert.deepStrictEqual(await v.search("   "), { query: "", videos: [] }, "empty search fetches nothing");
  const r = await v.search("  Rust   Tutorial ");
  assert.strictEqual(r.query, "Rust Tutorial");
  assert.ok(urls[0].indexOf("search_query=Rust%20Tutorial") > 0 && urls[0].indexOf("sp=EgIQAQ") > 0, "videos-only search");
  await v.search("rust tutorial");
  assert.strictEqual(urls.length, 1, "same search within an hour is cached");
  clock += 2 * 3600 * 1000;
  await v.search("rust tutorial");
  assert.strictEqual(urls.length, 2, "cache expires");
  assert.ok((await v.search("x".repeat(500))).query.length <= 120, "long queries are cut");
  console.log("ok: search module");

  // ---- page
  const html = fs.readFileSync(path.join(__dirname, "..", "dota-limit", "videos.html"), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  async function render(search) {
    const els = {};
    const asked = [];
    vm.runInNewContext(script, {
      console, JSON, Object, Array, String, Promise, URLSearchParams, encodeURIComponent,
      location: { search },
      fetch: async (url) => (asked.push(url), { json: async () => JSON.parse(JSON.stringify(r)) }),
      document: { getElementById: (id) => (els[id] = els[id] || { innerHTML: "", value: "", focus() {} }) },
    });
    await new Promise((res) => setTimeout(res, 20));
    return { els, asked };
  }

  let out = await render("?q=rust%20tutorial");
  assert.strictEqual(out.els.q.value, "rust tutorial", "search box keeps the query");
  assert.deepStrictEqual(out.asked, ["/api/videos?q=rust%20tutorial"]);
  let main = out.els.main.innerHTML;
  assert.ok(main.includes("Learn Rust &lt;Programming&gt;") && !main.includes("<Programming>"), "titles escaped");
  assert.ok(main.includes('href="/videos?v=BpPEoZW5IiY&q=rust%20tutorial"'), "results open in the Videos tab");
  assert.ok(!/youtube\.com\/watch/.test(main), "never links to youtube.com");

  out = await render("?v=BpPEoZW5IiY&q=rust%20tutorial");
  main = out.els.main.innerHTML;
  assert.ok(main.includes("https://www.youtube-nocookie.com/embed/BpPEoZW5IiY?rel=0"), "privacy-mode player");
  assert.ok(main.includes('referrerpolicy="strict-origin-when-cross-origin"'), "sends the referrer YouTube needs");
  assert.ok(out.els.info.innerHTML.includes("freeCodeCamp.org"), "title and channel under the player");
  assert.ok(main.includes('Back to results for "rust tutorial"'));

  out = await render("?v=not-an-id&q=");
  assert.ok(!out.els.main.innerHTML.includes("iframe") && out.asked.length === 0, "a bad video id plays nothing");
  console.log("ok: videos page");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
