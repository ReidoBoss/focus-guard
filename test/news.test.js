// Offline test for the news page: runs dota-limit/news.js against canned feeds,
// then renders news.html in a fake DOM.
// Run: node test/news.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const news = require("../dota-limit/news");

// ---- parsing
const rss = `<?xml version="1.0"?><rss><channel><title>Feed</title>
<item><title><![CDATA[Marcos &amp; Senate <b>agree</b>]]></title><link>https://example.ph/a</link><pubDate>Mon, 05 Oct 2026 10:00:00 +0800</pubDate></item>
<item><title>&#8216;Quoted&#8217; &#8212; dash &amp;amp; more</title><link>https://example.ph/b</link></item>
<item><title>No link</title></item>
</channel></rss>`;
const items = news.parseFeed(rss);
assert.strictEqual(items.length, 2, "skips an item with no link");
assert.strictEqual(items[0].title, "Marcos & Senate agree", "CDATA, entities and HTML");
assert.strictEqual(items[0].time, Date.parse("2026-10-05T02:00:00Z"));
assert.strictEqual(items[1].title, "‘Quoted’ - dash & more", "numeric entities, no em dash");

const atom = `<feed><title>Blog</title><link href="https://blog.dev/" rel="alternate"/>
<entry><title type="html">Post one</title><link rel="replies" href="https://blog.dev/1#comments"/><link href="https://blog.dev/1" rel="alternate"/><published>2026-10-03T23:34:02+00:00</published></entry>
<entry><title>Post two</title><link href='https://blog.dev/2'/><updated>2026-10-02T00:00:00Z</updated></entry></feed>`;
const posts = news.parseFeed(atom);
assert.deepStrictEqual(posts.map((p) => p.url), ["https://blog.dev/1", "https://blog.dev/2"], "Atom alternate links");
assert.strictEqual(posts[1].time, Date.parse("2026-10-02T00:00:00Z"));

const google = `<rss><channel><item><title>Startup raises $4M seed round - Manila Bulletin</title><link>https://news.google.com/rss/articles/abc</link><pubDate>Mon, 05 Oct 2026 09:00:00 GMT</pubDate><source url="https://mb.com.ph">Manila Bulletin</source></item>
<item><title>Startup raises $4M seed round | BusinessWorld Philippines - Magzter</title><link>https://news.google.com/rss/articles/rep</link><source url="https://www.magzter.com">Magzter</source></item>
<item><title>MAS reshuffles leaders - fintechnews.sg</title><link>https://news.google.com/rss/articles/sg</link><source url="https://fintechnews.sg">fintechnews.sg</source></item>
<item><title>Philippines Wallet Market Surges - openPR.com</title><link>https://news.google.com/rss/articles/pr</link><source url="https://www.openpr.com">openPR.com</source></item>
<item><title>#iPhone 18 Pro launch - YugaTech</title><link>https://news.google.com/rss/articles/tag</link><source url="https://www.yugatech.com">YugaTech</source></item>
<item><title>Same story on Facebook - facebook.com</title><link>https://news.google.com/rss/articles/def</link><source url="https://www.facebook.com">facebook.com</source></item></channel></rss>`;
const g = news.parseFeed(google);
assert.strictEqual(g[0].title, "Startup raises $4M seed round", "outlet removed from the title");
assert.strictEqual(g[0].outlet, "Manila Bulletin");
assert.ok(news.isBlocked(g.filter((i) => i.outlet === "facebook.com")[0], ["facebook.com"]), "Google News result from a blocked site");
assert.ok(news.isBlocked({ url: "https://m.youtube.com/watch?v=1" }, ["youtube.com"]), "subdomain of a blocked site");
assert.ok(!news.isBlocked({ url: "https://notyoutube.com/" }, ["youtube.com"]), "only whole domains match");

assert.ok(news.isPh({ title: "Visa stablecoin growth", outletUrl: "https://www.philstar.com" }) && news.isPh({ title: "Mynt IPO", outletUrl: "https://mb.com.ph" }));
assert.ok(news.isPh({ title: "GCash prices its IPO", outletUrl: "https://www.wsj.com" }) && !news.isPh({ title: "MAS reshuffles leaders", outletUrl: "https://fintechnews.sg" }));
assert.ok(news.isAi("Claude Says") && news.isAi("Turn off Apple Intelligence") && news.isAi("Running LLMs locally") && news.isAi("The AI bubble"));
assert.ok(!news.isAi("Rust's derive often implies inline") && !news.isAi("Email is hard") && !news.isAi("Thai food"));
console.log("ok: feed parsing");

// ---- the whole module against canned answers
const hn = { hits: [
  { title: "Low score", url: "https://a.dev/low", points: 10, created_at_i: 1759600000 },
  { title: "Ask HN: anything?", url: null, points: 900 },
  { title: "OpenAI ships a thing", url: "https://openai.com/x", points: 500 },
  { title: "Top story", url: "https://a.dev/top", points: 800 },
  { title: "Watch this", url: "https://www.youtube.com/watch?v=1", points: 700 },
] };
const lobsters = [
  { title: "Top story", url: "https://a.dev/top", created_at: "2026-10-05T00:00:00Z", tags: ["web"] },
  { title: "Vibe check", url: "https://b.dev/v", created_at: "2026-10-05T00:00:00Z", tags: ["vibecoding"] },
  { title: "Parsers", url: "https://b.dev/p", created_at: "2026-10-05T00:00:00Z", tags: ["plt"] },
];
const steam = { appnews: { newsitems: Array.from({ length: 15 }, (_, i) => ({ title: `7.41${"abcdefghijklmno"[i]} Patch`, url: `https://steam/${i}`, date: 1759600000 - i * 86400 })) } };
const feed = (name, n) => `<rss><channel>${Array.from({ length: n }, (_, i) => `<item><title>${name} story ${i + 1}</title><link>https://${name}.example/${i + 1}</link></item>`).join("")}</channel></rss>`;

let calls = [];
let failing = {};
let flaky = { "bbci.co.uk": 1 }; // times out once, then answers
const fetchText = async (url) => {
  calls.push(url);
  for (const k of Object.keys(flaky)) if (url.indexOf(k) >= 0 && flaky[k]-- > 0) throw new Error("timed out");
  for (const k of Object.keys(failing)) if (url.indexOf(k) >= 0) throw new Error(failing[k]);
  if (url.indexOf("hn.algolia.com") >= 0) return JSON.stringify(hn);
  if (url.indexOf("lobste.rs") >= 0) return JSON.stringify(lobsters);
  if (url.indexOf("steampowered") >= 0) return JSON.stringify(steam);
  if (url.indexOf("news.google.com") >= 0) return url.indexOf("startup") >= 0 ? google : feed("gtech", 3);
  return feed(new URL(url).hostname.replace(/^www\./, "").split(".")[0], 12);
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-news-"));
  let clock = Date.parse("2026-10-05T08:00:00Z");
  const n = news.createNews({ dir, blocked: ["facebook.com", "youtube.com"], fetchText, now: () => clock, retryMs: 0 });

  let r = await n.get();
  const sourceCount = calls.length - 1;
  assert.strictEqual(calls.filter((u) => u.indexOf("bbci.co.uk") >= 0).length, 2, "a failed feed is tried again");
  assert.ok(r.sections.filter((s) => s.id === "world")[0].items.some((i) => i.source === "BBC") && !r.sections.filter((s) => s.id === "world")[0].failed.length, "the retry counts");
  const sec = (id) => r.sections.filter((s) => s.id === id)[0];
  assert.deepStrictEqual(r.sections.map((s) => s.title), ["Programming", "AI", "Philippines", "PH tech and startups", "World", "Dota 2"]);
  assert.strictEqual(calls.filter((u) => u.indexOf("hn.algolia") >= 0).length, 1, "Hacker News fetched once for two sections");

  const prog = sec("programming").items.map((i) => i.title);
  assert.deepStrictEqual(prog, ["Top story", "Low score", "Parsers"], "by points, no Ask HN, no AI, no YouTube, no duplicate");
  assert.strictEqual(sec("programming").items[0].source, "Hacker News");
  const ai = sec("ai").items;
  assert.ok(ai.some((i) => i.title === "OpenAI ships a thing" && i.source === "Hacker News"), "AI stories from Hacker News");
  assert.ok(ai.some((i) => i.title === "Vibe check" && i.source === "Lobsters"), "AI-tagged Lobsters story");
  assert.strictEqual(ai.length, news.PER_SECTION);

  const ph = sec("ph").items;
  assert.strictEqual(ph.length, 10);
  assert.deepStrictEqual(ph.slice(0, 4).map((i) => i.source), ["Rappler", "Inquirer", "GMA News", "Philstar"], "takes from each outlet in turn");
  const tech = sec("ph-tech").items;
  assert.ok(tech[0].title === "Startup raises $4M seed round" && tech[0].source === "Manila Bulletin", "Google News shows the outlet");
  assert.ok(!tech.some((i) => /Facebook/.test(i.title)), "blocked outlet left out");
  assert.ok(!tech.some((i) => /Magzter|MAS|#|openPR/.test(i.title + i.source)), "repost, non-PH story, press release and hashtag page left out");
  assert.strictEqual(sec("dota").items.length, 10);
  assert.strictEqual(sec("dota").items[0].title, "7.41a Patch");

  // Within 3 hours nothing is fetched again.
  clock += 2 * 3600 * 1000;
  calls = [];
  await n.get();
  assert.strictEqual(calls.length, 0, "no refetch within 3 hours");

  // After 3 hours the saved headlines come back straight away and a refresh runs behind them.
  clock += 2 * 3600 * 1000;
  failing = { "rappler.com": "answered 503" };
  r = await n.get();
  assert.ok(r.refreshing && calls.length >= sourceCount, "stale set refreshes in the background");
  await n.refresh();
  r = await n.get();
  assert.strictEqual(r.fetchedAt, clock);
  assert.ok(sec("ph").items.some((i) => i.source === "Rappler"), "a failing feed keeps its last headlines");
  assert.deepStrictEqual(sec("ph").failed, ["Rappler"]);

  // A restart reads the saved headlines instead of fetching.
  calls = [];
  const again = news.createNews({ dir, blocked: [], fetchText, now: () => clock });
  assert.strictEqual((await again.get()).sections.length, 6);
  assert.strictEqual(calls.length, 0, "headlines survive a restart");
  console.log(`ok: news module (${sourceCount} feeds)`);

  // ---- news page
  const html = fs.readFileSync(path.join(__dirname, "..", "dota-limit", "news.html"), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: "", textContent: "" });
  r.sections[0].items[0].title = "<script>x</script>";
  vm.runInNewContext(script, {
    console, Date, Math, JSON, Object, Array, String, Number, Promise,
    fetch: async () => ({ json: async () => JSON.parse(JSON.stringify(Object.assign({}, r, { nextAt: Date.now() + 3600 * 1000 }))) }),
    document: { getElementById: el },
  });
  await new Promise((res) => setTimeout(res, 20));
  const page = els.sections.innerHTML;
  assert.strictEqual((page.match(/<section>/g) || []).length, 6);
  assert.ok(page.includes("PH tech and startups") && page.includes("Manila Bulletin"));
  assert.ok(page.includes("Rappler didn't answer"), "says which feed failed");
  assert.ok(page.includes("&lt;script&gt;") && !page.includes("<script>x"), "titles are escaped");
  assert.ok(page.includes('target="_blank" rel="noopener noreferrer"'));
  assert.ok(/^Updated .+New headlines after /.test(els.note.textContent), els.note.textContent);
  console.log("ok: news page");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
