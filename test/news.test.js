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
assert.strictEqual(posts[0].commentsUrl, "https://blog.dev/1#comments", "Atom replies link");

const illustrated = news.parseFeed(`<rss><channel>
<item><title>Media image</title><link>https://paper.dev/a</link>
<media:thumbnail url="https://cdn.dev/a.jpg?x=1&amp;y=2"/><media:content medium="image" url="https://cdn.dev/other.jpg"/>
<comments>https://paper.dev/a#comments</comments><slash:comments>12</slash:comments></item>
<item><title>Media content</title><link>https://paper.dev/b</link><media:content type="image/jpeg" url="/b.jpg"/></item>
<item><title>Enclosure</title><link>https://paper.dev/c</link><enclosure type="audio/mpeg" url="/podcast.mp3"/><enclosure type="image/png" url="//cdn.dev/c.png"/></item>
<item><title>HTML image</title><link>https://paper.dev/d</link><content:encoded><![CDATA[<img src="/pixel.gif" width="1" height="1"><img src='../d.jpg'/>]]></content:encoded></item>
<item><title>Escaped image</title><link>https://paper.dev/e</link><description>&lt;img src=&quot;https://cdn.dev/e.jpg&quot;&gt;</description></item>
<item><title>Unsafe media</title><link>https://paper.dev/f</link><media:thumbnail url="javascript:alert(1)"/><description><![CDATA[<img src="data:image/png;base64,abc">]]></description><comments>javascript:alert(2)</comments><slash:comments>-1</slash:comments></item>
</channel></rss>`);
assert.deepStrictEqual(illustrated.map((i) => i.thumbnail), [
  "https://cdn.dev/a.jpg?x=1&y=2", "https://paper.dev/b.jpg", "https://cdn.dev/c.png",
  "https://paper.dev/d.jpg", "https://cdn.dev/e.jpg", null,
], "feed image formats, relative URLs, no tracking pixel or unsafe URL");
assert.strictEqual(illustrated[0].commentsUrl, "https://paper.dev/a#comments");
assert.strictEqual(illustrated[0].commentCount, 12);
assert.strictEqual(illustrated[5].commentsUrl, null);
assert.strictEqual(illustrated[5].commentCount, null);
const replyAfterArticle = news.parseFeed(`<feed><entry><title>Atom image</title><link href="https://blog.dev/post"/><link rel="enclosure" type="image/jpeg" href="/photo.jpg"/><link rel="replies" type="application/atom+xml" href="/comments.xml"/><link rel="replies" type="text/html" href="/post#comments"/><thr:total>0</thr:total></entry></feed>`)[0];
assert.strictEqual(replyAfterArticle.thumbnail, "https://blog.dev/photo.jpg");
assert.strictEqual(replyAfterArticle.commentsUrl, "https://blog.dev/post#comments", "replies after article, not an XML feed");
assert.strictEqual(replyAfterArticle.commentCount, 0);
assert.strictEqual(news.parseFeed('<rss><item><title>Preview</title><link>https://paper.dev/</link><description><![CDATA[<p>Short &amp; useful preview.</p>]]></description></item></rss>')[0].summary, "Short & useful preview.");

const hnThread = { children: [
  { id: 100, author: "reader", text: "<p>First paragraph.</p><p>Second &amp; last.</p><script>bad()</script>", created_at_i: 1759600000, children: [
    { id: 101, author: "reply", text: "<p>A reply.</p>", children: [] },
  ] },
  { id: 102, author: null, text: null, children: [{ id: 103, author: "survivor", text: "Still here.", children: [] }] },
  { id: 104, text: null, children: [] },
] };
const parsedThread = news.parseComments("hn", JSON.stringify(hnThread));
assert.deepStrictEqual(parsedThread.comments.map((c) => c.depth), [0, 1, 0, 1], "reply order and deleted parent preserved");
assert.strictEqual(parsedThread.comments[0].text, "First paragraph.\n\nSecond & last.");
assert.strictEqual(parsedThread.comments[2].text, "Comment unavailable.");
assert.strictEqual(parsedThread.comments[0].url, "https://news.ycombinator.com/item?id=100");
assert.strictEqual(news.parseComments("hn", JSON.stringify({ children: [{ id: 1, author: "coder", text: "<pre><code>if (a &lt; b &amp;&amp; b &gt; c) {\n  return true;\n}</code></pre>", children: [] }] })).comments[0].text, "if (a < b && b > c) {\n  return true;\n}", "code in comments keeps escaped operators and indentation");
const lobsterThread = { comments: [
  { short_id: "abc", commenting_user: "lobster", comment_plain: "Code: a < b\n\nNext paragraph.", depth: 0, created_at: "2026-10-05T00:00:00Z" },
  { short_id: "def", commenting_user: "reply", comment: "<p>Reply &amp; thanks.</p>", depth: 1 },
  { short_id: "gone", is_moderated: true, comment_plain: "Removed text", depth: 2 },
] };
assert.deepStrictEqual(news.parseComments("lobsters", JSON.stringify(lobsterThread)).comments.map((c) => c.text), ["Code: a < b\n\nNext paragraph.", "Reply & thanks.", "Comment unavailable."]);
const largeThread = { children: Array.from({ length: news.MAX_COMMENTS + 1 }, (_, i) => ({ id: i + 1, author: "reader", text: "A comment", children: [] })) };
const bounded = news.parseComments("hn", JSON.stringify(largeThread));
assert.strictEqual(bounded.comments.length, news.MAX_COMMENTS);
assert.ok(bounded.truncated, "large threads are bounded");
assert.throws(() => news.parseComments("hn", '{"error":"missing"}'));

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
  { title: "Top story", url: "https://a.dev/top", points: 800, objectID: "12345", num_comments: 23 },
  { title: "Watch this", url: "https://www.youtube.com/watch?v=1", points: 700 },
] };
const lobsters = [
  { title: "Top story", url: "https://a.dev/top", created_at: "2026-10-05T00:00:00Z", tags: ["web"] },
  { title: "Vibe check", url: "https://b.dev/v", created_at: "2026-10-05T00:00:00Z", tags: ["vibecoding"] },
  { title: "Parsers", url: "https://b.dev/p", created_at: "2026-10-05T00:00:00Z", tags: ["plt"], comments_url: "https://lobste.rs/s/abc/parsers", comment_count: 0 },
];
const steam = { appnews: { newsitems: Array.from({ length: 60 }, (_, i) => ({ title: `7.41${i === 0 ? "a" : i + 1} Patch`, url: `https://steam/${i}`, date: 1759600000 - i * 86400, contents: "[img]{STEAM_CLAN_IMAGE}/3703047/patch.png[/img] Patch preview." })) } };
assert.strictEqual(news.parse("steam", JSON.stringify(steam))[0].thumbnail, "https://clan.akamai.steamstatic.com/images/3703047/patch.png");
assert.strictEqual(news.parse("hn", JSON.stringify({ hits: [{ title: "Invalid ID", url: "https://a.dev/", objectID: '1" onclick="bad', num_comments: -1 }] }))[0].commentsUrl, null);
assert.strictEqual(news.parse("lobsters", JSON.stringify([{ title: "Fallback", url: "https://a.dev/", short_id_url: "https://lobste.rs/s/abc", comment_count: 1 }]))[0].commentsUrl, "https://lobste.rs/s/abc");

const blockedMedia = news.buildSection({ id: "test", title: "Test", sources: [{ id: "test", name: "Test" }] }, {
  sources: { test: { items: [{ title: "Allowed article", url: "https://paper.dev/", thumbnail: "https://img.youtube.com/a.jpg", commentsUrl: "https://m.facebook.com/discuss", commentCount: 3 }] } },
}, ["youtube.com", "facebook.com"]).items[0];
assert.ok(blockedMedia && !blockedMedia.thumbnail && !blockedMedia.commentsUrl, "blocked media and discussions omitted without dropping an allowed article");
const feed = (name, n) => `<rss><channel>${Array.from({ length: n }, (_, i) => `<item><title>${name} story ${i + 1}</title><link>https://${name}.example/${i + 1}</link></item>`).join("")}</channel></rss>`;

let calls = [];
let failing = {};
let flaky = { "bbci.co.uk": 1 }; // times out once, then answers
const fetchText = async (url) => {
  calls.push(url);
  for (const k of Object.keys(flaky)) if (url.indexOf(k) >= 0 && flaky[k]-- > 0) throw new Error("timed out");
  for (const k of Object.keys(failing)) if (url.indexOf(k) >= 0) throw new Error(failing[k]);
  if (url.indexOf("hn.algolia.com/api/v1/items/") >= 0) return JSON.stringify(hnThread);
  if (/lobste\.rs\/s\//.test(url)) return JSON.stringify(lobsterThread);
  if (url.indexOf("hn.algolia.com") >= 0) return JSON.stringify(hn);
  if (url.indexOf("lobste.rs") >= 0) return JSON.stringify(lobsters);
  if (url.indexOf("steampowered") >= 0) return JSON.stringify(steam);
  if (url.indexOf("news.google.com") >= 0) return url.indexOf("startup") >= 0 ? google : feed("gtech", 3);
  return feed(new URL(url).hostname.replace(/^www\./, "").split(".")[0], 60);
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
  assert.strictEqual(sec("programming").items[0].commentsUrl, "https://news.ycombinator.com/item?id=12345");
  assert.strictEqual(sec("programming").items[0].commentCount, 23);
  assert.strictEqual(sec("programming").items[0].commentKey, "hn:12345");
  assert.strictEqual(sec("programming").items[2].commentCount, 0);
  const ai = sec("ai").items;
  assert.ok(ai.some((i) => i.title === "OpenAI ships a thing" && i.source === "Hacker News"), "AI stories from Hacker News");
  assert.ok(ai.some((i) => i.title === "Vibe check" && i.source === "Lobsters"), "AI-tagged Lobsters story");
  assert.strictEqual(ai.length, news.PER_SECTION);

  const ph = sec("ph").items;
  assert.strictEqual(ph.length, news.PER_SECTION);
  assert.deepStrictEqual(ph.slice(0, 4).map((i) => i.source), ["Rappler", "Inquirer", "GMA News", "Philstar"], "takes from each outlet in turn");
  const tech = sec("ph-tech").items;
  assert.ok(tech[0].title === "Startup raises $4M seed round" && tech[0].source === "Manila Bulletin", "Google News shows the outlet");
  assert.ok(!tech.some((i) => /Facebook/.test(i.title)), "blocked outlet left out");
  assert.ok(!tech.some((i) => /Magzter|MAS|#|openPR/.test(i.title + i.source)), "repost, non-PH story, press release and hashtag page left out");
  assert.strictEqual(sec("dota").items.length, news.PER_SECTION);
  assert.strictEqual(sec("dota").items[0].title, "7.41a Patch");
  assert.strictEqual(sec("dota").items[0].thumbnail, "https://clan.akamai.steamstatic.com/images/3703047/patch.png");

  const beforeComments = calls.length;
  assert.strictEqual((await n.comments("hn:999")).status, "unavailable");
  assert.strictEqual((await n.comments("https://127.0.0.1/private")).status, "unavailable");
  assert.strictEqual((await n.comments(null)).status, "unavailable");
  assert.strictEqual(calls.length, beforeComments, "unknown threads cannot trigger outbound requests");
  const [thread, sameThread] = await Promise.all([n.comments("hn:12345"), n.comments("hn:12345")]);
  assert.strictEqual(thread.status, "ready");
  assert.strictEqual(thread, sameThread);
  assert.strictEqual(calls.length, beforeComments + 1, "concurrent comment requests share one fetch");
  await n.comments("hn:12345");
  assert.strictEqual(calls.length, beforeComments + 1, "comments cached for repeated opens");
  assert.strictEqual((await n.comments("lobsters:abc")).comments[0].author, "lobster");
  const blockedThreads = news.createNews({ dir, blocked: ["news.ycombinator.com", "lobste.rs"], fetchText, now: () => clock });
  const beforeBlocked = calls.length;
  assert.strictEqual((await blockedThreads.comments("hn:12345")).status, "unavailable");
  assert.strictEqual((await blockedThreads.comments("lobsters:abc")).status, "unavailable");
  assert.strictEqual(calls.length, beforeBlocked, "blocked discussions are never fetched");
  clock += 11 * 60000;
  failing["api/v1/items/"] = "timed out";
  assert.strictEqual((await n.comments("hn:12345")).status, "error", "failed comments do not discard news");
  const afterFailure = calls.length;
  await n.comments("hn:12345");
  assert.strictEqual(calls.length, afterFailure, "failed requests have a short cooldown");
  delete failing["api/v1/items/"];
  clock += 61000;
  assert.strictEqual((await n.comments("hn:12345")).status, "ready", "comments recover after an error");

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
  const saved = await again.get();
  assert.strictEqual(saved.sections.length, 6);
  assert.strictEqual(saved.sections[0].items[0].commentCount, 23, "discussion metadata survives a restart");
  assert.ok(saved.sections[5].items[0].thumbnail, "thumbnails survive a restart");
  assert.strictEqual(calls.length, 0, "headlines survive a restart");
  const legacy = JSON.parse(fs.readFileSync(path.join(dir, "news-cache.json"), "utf8"));
  delete legacy.version;
  legacy.sources.hn.items.forEach((i) => { delete i.commentsUrl; delete i.commentCount; });
  fs.writeFileSync(path.join(dir, "news-cache.json"), JSON.stringify(legacy));
  const upgrade = news.createNews({ dir, blocked: [], fetchText, now: () => clock, retryMs: 0 });
  const old = await upgrade.get();
  assert.ok(old.refreshing && old.sections[0].items.length, "old caches serve headlines while new metadata refreshes");
  await upgrade.refresh();
  assert.strictEqual((await upgrade.get()).sections[0].items[0].commentCount, 23, "old caches acquire discussion metadata without waiting three hours");
  console.log(`ok: news module (${sourceCount} feeds)`);

  // ---- news page
  const html = fs.readFileSync(path.join(__dirname, "..", "dota-limit", "news.html"), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const els = {};
  const el = (id) => (els[id] = els[id] || {
    id, innerHTML: "", textContent: "", hidden: false, handlers: {},
    insertAdjacentHTML: function (where, value) { assert.strictEqual(where, "beforeend"); this.innerHTML += value; },
    addEventListener: function (name, handler) { this.handlers[name] = handler; },
    querySelectorAll: () => [],
  });
  r.sections[0].items[0].title = "<script>x</script>";
  let commentRequestFails = false;
  const clientCalls = [];
  const context = {
    console, Date, Math, JSON, Object, Array, String, Number, Promise, URL, Map, Set, window: {}, encodeURIComponent,
    fetch: async (url) => {
      clientCalls.push(url);
      if (url.indexOf("/api/news/comments") === 0 && commentRequestFails) throw new Error("offline");
      return { ok: true, json: async () => JSON.parse(JSON.stringify(url === "/api/news" ? Object.assign({}, r, { nextAt: Date.now() + 3600 * 1000 }) : thread)) };
    },
    document: { getElementById: el },
  };
  vm.runInNewContext(script, context);
  await new Promise((res) => setTimeout(res, 20));
  let page = els.feed.innerHTML;
  assert.strictEqual((page.match(/<article class="story">/g) || []).length, 12, "first page is a mixed scrolling feed");
  assert.strictEqual(clientCalls.length, 1, "comments are fetched only when opened");
  assert.strictEqual((els.filters.innerHTML.match(/data-topic=/g) || []).length, 7, "all topics and individual filters");
  assert.ok(!els.more.hidden, "more than ten stories per topic available");
  assert.ok(page.includes("PH tech and startups") && page.includes("Manila Bulletin"));
  assert.ok(els.warnings.textContent.includes("Rappler didn't answer"), "says which feed failed");
  assert.ok(page.includes("&lt;script&gt;") && !page.includes("<script>x"), "titles are escaped");
  assert.ok(page.includes('target="_blank" rel="noopener noreferrer"'));
  assert.ok(page.includes('<details class="discussion"') && page.includes(">23 comments</summary>"), "comments open inline");
  els.more.handlers.click();
  page = els.feed.innerHTML;
  assert.strictEqual((page.match(/<article class="story">/g) || []).length, 24, "scrolling appends the next page");
  assert.ok(page.includes(">0 comments</summary>"), "zero comments is still a discussion");
  assert.ok(page.includes('<img src="https://clan.akamai.steamstatic.com/images/3703047/patch.png"') && page.includes('loading="lazy"') && page.includes('referrerpolicy="no-referrer"'));
  const fallback = context.story({ title: "No media", url: "https://paper.dev/", source: "Paper", thumbnail: "javascript:bad", commentsUrl: "data:text/html,bad" });
  assert.ok(!fallback.includes("<img") && !fallback.includes("javascript:bad") && !fallback.includes("data:text/html,bad"), "unsafe metadata stays out of the page");
  const escapedMedia = context.story({ title: 'A "quoted" story', url: "https://paper.dev/", source: "Paper", thumbnail: 'https://cdn.dev/a.jpg?x="&y=1', commentsUrl: "https://paper.dev/#comments", commentCount: 1 });
  assert.ok(escapedMedia.includes(">1 comment</summary>") && escapedMedia.includes("&quot;quoted&quot;") && escapedMedia.includes("&amp;y=1"), "comment singular and media attributes escaped");
  const unknownCount = context.story({ title: "Article", url: "https://paper.dev/", source: "Paper", commentsUrl: "https://paper.dev/#comments", commentCount: null });
  assert.ok(unknownCount.includes(">Comments</summary>"), "unknown count is not shown as zero");
  const failedImage = { parentElement: { hidden: false } };
  vm.runInNewContext(page.match(/onerror="([^"]+)"/)[1], failedImage);
  assert.ok(failedImage.parentElement.hidden, "broken thumbnail removed with its reserved space");
  const panel = { innerHTML: "" };
  const details = { dataset: { story: "0" }, querySelector: () => panel, open: true, matches: () => true };
  await context.loadComments(details);
  assert.ok(panel.innerHTML.includes("First paragraph.") && panel.innerHTML.includes("Second &amp; last.") && panel.innerHTML.includes("--depth:1"), "comments and replies appear in the feed");
  assert.ok(panel.innerHTML.includes("View full discussion"));
  const afterOpen = clientCalls.length;
  await context.loadComments(details);
  assert.strictEqual(clientCalls.length, afterOpen, "reopening an inline thread reuses its data");
  const malicious = context.comment({ author: '<img src=x onerror=bad()>', text: '<script>bad()</script>', depth: '0; color:red' });
  assert.ok(!malicious.includes("<script>") && !malicious.includes("<img") && malicious.includes("&lt;script&gt;") && malicious.includes("--depth:0"), "comments cannot inject HTML or styles");
  context.renderThread(panel, { item: { commentsUrl: "https://lobste.rs/s/abc" }, shown: 20, data: { status: "ready", comments: [] } });
  assert.ok(panel.innerHTML.includes("No comments yet."));
  context.renderThread(panel, { item: {}, shown: 20, data: { status: "ready", comments: Array.from({ length: 21 }, () => ({ author: "a", text: "b" })) } });
  assert.ok(panel.innerHTML.includes("Show more comments"), "long threads expand progressively");
  vm.runInNewContext('threads.clear()', context);
  commentRequestFails = true;
  await context.loadComments(details);
  assert.ok(panel.innerHTML.includes("Couldn't load comments") && panel.innerHTML.includes("Try again"));
  vm.runInNewContext('threads.clear()', context);
  commentRequestFails = false;
  await context.loadComments(details);
  assert.ok(panel.innerHTML.includes("First paragraph."), "client recovers after retry");
  const filter = { dataset: { topic: "dota" } };
  els.filters.handlers.click({ target: { closest: () => filter } });
  assert.ok(els.feed.innerHTML.includes("7.41a Patch") && !els.feed.innerHTML.includes("Manila Bulletin"), "topic filter updates the feed");
  while (!els.more.hidden) context.showMore();
  assert.strictEqual((els.feed.innerHTML.match(/<article class="story">/g) || []).length, 60);
  assert.ok(els["end-note"].textContent.includes("end of the latest stories"), "scrolling ends cleanly when feeds are exhausted");
  assert.ok(/^Updated .+New headlines after /.test(els.note.textContent), els.note.textContent);
  console.log("ok: news page");

  // Exercise just the route in isolation, without starting the daemon or touching Steam.
  const daemon = fs.readFileSync(path.join(__dirname, "..", "dota-limit", "daemon.js"), "utf8");
  const route = daemon.match(/if \(url === "\/api\/news\/comments"\) \{([\s\S]*?)\n    \}/)[1];
  let routeKey = null;
  let routeBody = null;
  let routeStatus = null;
  const routeContext = { URL, req: { method: "GET", url: "/api/news/comments?key=hn%3A12345" },
    news: { comments: async (key) => { routeKey = key; return thread; } }, json: (body) => { routeBody = body; },
    res: { writeHead: (status) => { routeStatus = status; }, end: () => {} },
  };
  vm.runInNewContext("(function () {" + route + "})()", routeContext);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.strictEqual(routeKey, "hn:12345");
  assert.strictEqual(routeBody.status, "ready");
  routeContext.req.method = "POST";
  routeKey = null;
  vm.runInNewContext("(function () {" + route + "})()", routeContext);
  assert.strictEqual(routeStatus, 405);
  assert.strictEqual(routeKey, null, "comments route only accepts reads");
  console.log("ok: comments route");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
