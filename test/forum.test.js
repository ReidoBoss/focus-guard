// Offline Forum tests. No daemon, installer, or live forum requests are used.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { createForum, parseReddit, parseRedditComments, parseHn, parseLobsters } = require("../dota-limit/forum");

const entry = (id, title, content, extra) => `<entry><id>${id}</id><title>${title}</title><author><name>/u/reader</name></author><category term="programming" label="r/programming"/><link href="https://www.reddit.com/r/programming/comments/${id.startsWith("t3_") ? id.slice(3) : "abc"}/example/${id.startsWith("t1_") ? id.slice(3) + "/" : ""}"/><updated>2026-10-13T00:00:00Z</updated><content type="html">${content}</content>${extra || ""}</entry>`;
const content = "&lt;!-- SC_OFF --&gt;&lt;div&gt;&lt;p&gt;A question &amp;amp; some code: a &amp;lt; b.&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt; submitted by user";
const reddit = `<feed>${entry("t3_abc", "A Reddit question", content, '<media:thumbnail url="https://preview.redd.it/example.jpg?width=600&amp;format=pjpg"/>')}${entry("t3_def", "Another question", content)}${entry("t3_def", "Repeated", content)}${entry("invalid", "Invalid", content)}</feed>`;
const redditComments = `<feed>${entry("t3_abc", "Original post", content)}${entry("t1_reply", "Reply", content)}${entry("t1_reply2", "Another reply", "&lt;p&gt;A second reply.&lt;/p&gt;")}</feed>`;
const hn = JSON.stringify({ hits: [
  { objectID: "123", title: "Ask HN: a question?", author: "reader", url: null, story_text: "<p>Full question.</p>", num_comments: 2, created_at_i: 1759600000 },
  { objectID: "124", title: "Video discussion", url: "https://youtube.com/watch?v=x", num_comments: 1 },
  { objectID: 'bad"id', title: "Invalid" },
] });
const lobster = (id, count) => `<li id="story_${id}" data-shortid="${id}"><a class="u-url" href="https://example.com/${id}">Lobsters ${id}</a><ul><li><a class="tag">web</a></li></ul><a class="u-author h-card">lobster</a><time data-at-unix="1759600000"></time><span class="comments_label"><a href="/s/${id}/example">${count} comments</a></span></li>`;
const lobsters = `<html><form><input name="q"></form>${lobster("lob1", 4)}${lobster("lob2", "no")}</html>`;
const hnComments = JSON.stringify({ children: [{ id: 500, author: "reader", text: "<p>A comment.</p>", children: [{ id: 501, author: "reply", text: "<p>A reply.</p>", children: [] }] }] });
const lobstersComments = JSON.stringify({ comments: [{ short_id: "c123", commenting_user: "lobster", comment_plain: "A Lobsters comment.", depth: 0 }] });

assert.strictEqual(parseReddit(reddit).length, 2, "invalid ids and duplicate posts omitted");
assert.strictEqual(parseReddit(reddit)[0].key, "reddit:abc");
assert.strictEqual(parseReddit(reddit)[0].url, "https://www.reddit.com/r/programming/comments/abc/example/", "canonical post path retained for its comment feed");
assert.strictEqual(parseReddit(reddit.replace("www.reddit.com/r/programming/comments/abc", "private.invalid/r/programming/comments/abc"))[0].url, "https://www.reddit.com/comments/abc/", "untrusted canonical destinations fall back to a fixed Reddit URL");
assert.strictEqual(parseReddit(reddit)[0].community, "programming");
assert.strictEqual(parseReddit(reddit)[0].body, "A question & some code: a < b.", "RSS bodies decode once per encoding layer and omit metadata");
assert.strictEqual(parseReddit(reddit)[0].thumbnail, "https://preview.redd.it/example.jpg?width=600&format=pjpg");
assert.strictEqual(parseReddit(reddit.replace("https://preview.redd.it/example.jpg", "http://127.0.0.1/private"))[0].thumbnail, null, "untrusted image hosts rejected");
assert.deepStrictEqual(parseRedditComments(redditComments).comments.map((c) => c.id), ["reply", "reply2"], "original post omitted from comments");
assert.ok(parseRedditComments(redditComments).note.includes("selection"), "public feed limitations explained");
assert.throws(() => parseReddit("<html>blocked</html>"));
assert.strictEqual(parseHn(hn)[0].url, null, "Ask HN discussions are included");
assert.strictEqual(parseHn(hn)[0].body, "Full question.");
assert.deepStrictEqual(parseLobsters(lobsters).map((p) => p.commentCount), [4, 0], "nested list tags do not truncate a Lobsters story");
assert.strictEqual(parseLobsters('<form><input name="q"></form>').length, 0, "empty searches are valid");
assert.throws(() => parseLobsters("<html>blocked</html>"));
console.log("ok: forum parsers");

(async () => {
  let clock = 0;
  const urls = [];
  const imageUrls = [];
  let failing = "";
  const fetchText = async (url) => {
    urls.push(url);
    if (failing && url.includes(failing)) throw new Error("unavailable");
    if (url.includes("reddit.com") && url.includes("/comments/")) return redditComments;
    if (url.includes("reddit.com")) return reddit;
    if (url.includes("hn.algolia.com/api/v1/items/")) return hnComments;
    if (url.includes("hn.algolia.com")) return hn;
    if (url.includes("lobste.rs/s/")) return lobstersComments;
    return lobsters;
  };
  const forum = createForum({ blocked: ["reddit.com", "redd.it", "youtube.com"], fetchText, now: () => clock,
    fetchImage: async (url) => { imageUrls.push(url); return { type: "image/jpeg", body: Buffer.from([255, 216, 255]) }; },
  });
  assert.strictEqual((await forum.search(" ", "all", "")).posts.length, 0);
  assert.strictEqual(urls.length, 0, "empty page doesn't fetch a home feed");
  await assert.rejects(forum.search("x", "https://private.invalid", ""), /Choose a forum/);
  await assert.rejects(forum.search("x", "reddit", "../../private"), /community name/);
  assert.strictEqual((await forum.comments("reddit:abc")).status, "unavailable");
  assert.strictEqual(await forum.image("https://127.0.0.1/private"), null);
  assert.strictEqual(urls.length + imageUrls.length, 0, "unregistered threads and images cannot trigger requests");
  const [result, concurrent] = await Promise.all([forum.search("  Rust   help ", "all", ""), forum.search("rust help", "all", "")]);
  assert.strictEqual(urls.length, 3, "concurrent identical searches share provider requests");
  assert.deepStrictEqual(result.posts.map((p) => p.source), ["reddit", "hn", "lobsters", "reddit", "hn", "lobsters"], "providers mixed in rounds");
  assert.strictEqual(concurrent.posts.length, result.posts.length);
  assert.ok(urls.some((u) => u.includes("q=Rust%20help") && u.includes("include_over_18=off")));
  assert.strictEqual(result.posts[0].externalUrl, null, "blocked forum links never go to the browser");
  assert.strictEqual(result.posts[4].externalUrl, null, "blocked linked articles omitted while discussion remains readable");
  assert.strictEqual(result.posts[0].thumbnail, "/api/forum/image?key=reddit%3Aabc", "images use the local service");
  const [thread, same] = await Promise.all([forum.comments("reddit:abc"), forum.comments("reddit:abc")]);
  assert.strictEqual(thread, same);
  assert.strictEqual(thread.comments.length, 2);
  assert.strictEqual(urls[3], "https://www.reddit.com/r/programming/comments/abc/example/.rss?limit=50&sort=top");
  await forum.comments("reddit:abc");
  assert.strictEqual(urls.length, 4, "comments are cached");
  assert.strictEqual((await forum.comments("hn:123")).comments[1].depth, 1);
  assert.strictEqual((await forum.comments("lobsters:lob1")).comments[0].author, "lobster");
  const image = await forum.image("reddit:abc");
  assert.strictEqual(image.type, "image/jpeg");
  await forum.image("reddit:abc");
  assert.strictEqual(imageUrls.length, 1, "images are cached and fetched only from registered CDN URLs");
  assert.ok(imageUrls[0].startsWith("https://preview.redd.it/"));
  const beforeSub = urls.length;
  await forum.search("", "reddit", "r/programming");
  assert.strictEqual(urls.length, beforeSub + 1);
  assert.ok(urls[urls.length - 1].includes("/r/programming/.rss"), "community can be browsed without a query");
  await forum.search("help", "reddit", "programming");
  assert.ok(urls[urls.length - 1].includes("/r/programming/search.rss") && urls[urls.length - 1].includes("restrict_sr=on"));
  clock += 11 * 60000;
  const beforeExpire = urls.length;
  await forum.search("Rust help", "all", "");
  assert.strictEqual(urls.length, beforeExpire + 3, "search cache expires");
  failing = "reddit.com";
  const partial = await forum.search("another", "all", "");
  assert.deepStrictEqual(partial.failed, ["Reddit"]);
  assert.ok(partial.posts.length && partial.posts.every((p) => p.source !== "reddit"), "one unavailable source doesn't hide other results");
  failing = "";
  assert.ok((await forum.search("another", "all", "")).posts.some((p) => p.source === "reddit"), "failed sources can be retried");
  let rateCalls = 0;
  const limited = createForum({ now: () => clock, fetchText: async (url) => {
    rateCalls++;
    if (url.includes("reddit.com")) { const e = new Error("rate limit"); e.statusCode = 429; e.retryMs = 120000; throw e; }
    return hn;
  } });
  await limited.search("first", "all", "");
  const beforeCooldown = rateCalls;
  await limited.search("second", "reddit", "");
  assert.strictEqual(rateCalls, beforeCooldown, "rate-limited sources are not hammered by new queries");
  clock += 121000;
  await limited.search("second", "reddit", "");
  assert.strictEqual(rateCalls, beforeCooldown + 1, "rate limit cooldown honors Retry-After");
  let commentRateCalls = 0;
  let limitComments = true;
  const recoverable = createForum({ now: () => clock, fetchText: async (url) => {
    if (!url.includes("/comments/")) return reddit;
    commentRateCalls++;
    if (limitComments) { const e = new Error("rate limit"); e.statusCode = 429; e.retryMs = 120000; throw e; }
    return redditComments;
  } });
  await recoverable.search("comments", "reddit", "");
  const rateError = await recoverable.comments("reddit:abc");
  assert.strictEqual(rateError.status, "error");
  assert.strictEqual(rateError.retryAt, clock + 120000);
  assert.ok(rateError.message.includes("temporarily limiting requests"), "comment errors identify the source and its retry time");
  assert.strictEqual((await recoverable.comments("reddit:abc")).retryAt, rateError.retryAt);
  assert.strictEqual(commentRateCalls, 1, "reopening during cooldown does not repeat the failed request");
  limitComments = false;
  clock = rateError.retryAt + 1;
  assert.strictEqual((await recoverable.comments("reddit:abc")).status, "ready", "failed comments aren't cached for ten minutes");
  clock += 61 * 60000;
  assert.strictEqual((await forum.comments("reddit:abc")).status, "unavailable", "old search results expire");
  const invalidImage = createForum({ fetchText, fetchImage: async () => ({ type: "text/html", body: Buffer.from("<script>x</script>") }) });
  await invalidImage.search("x", "reddit", "");
  await assert.rejects(invalidImage.image("reddit:abc"), /supported image/, "image proxy cannot serve active content");
  console.log("ok: forum search, comments and image service");

  // Render and interact with the browser script without network access or dependencies.
  const html = fs.readFileSync(path.join(__dirname, "..", "dota-limit", "forum.html"), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const els = {};
  const el = (id) => (els[id] = els[id] || { innerHTML: "", textContent: "", value: "", hidden: false, disabled: false, handlers: {},
    addEventListener: function (event, handler) { this.handlers[event] = handler; },
    insertAdjacentHTML: function (where, content) { this.innerHTML += content; },
  });
  const many = Object.assign({}, result, { posts: Array.from({ length: 30 }, (_, i) => Object.assign({}, result.posts[0], { key: "reddit:" + i, title: i === 0 ? "<script>title</script>" : "Discussion " + i, body: "Full post\n\n" + "x".repeat(350) })) });
  const clientCalls = [];
  let failComments = false;
  let clientThread = thread;
  let slowResolve;
  let browserNow = Date.now();
  const timers = new Map();
  let timerId = 0;
  const context = { console, Date: class extends Date { static now() { return browserNow; } }, Math, JSON, Object, Array, String, Number, Promise, URL, URLSearchParams, Map, encodeURIComponent,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn: () => { timers.delete(id); fn(); }, delay }); return id; }, clearTimeout: (id) => timers.delete(id),
    window: {}, location: { search: "" }, history: { replaceState: () => {} }, document: { getElementById: el },
    fetch: async (url) => {
      clientCalls.push(url);
      if (url.startsWith("/api/forum/comments")) {
        if (failComments) throw new Error("offline");
        return { ok: true, json: async () => clientThread };
      }
      if (url.includes("q=slow")) return new Promise((resolve) => { slowResolve = () => resolve({ ok: true, json: async () => Object.assign({}, many, { query: "slow" }) }); });
      return { ok: true, json: async () => many };
    },
  };
  vm.runInNewContext(script, context);
  assert.strictEqual(clientCalls.length, 0, "Forum tab starts with a search box");
  el("q").value = "Rust help";
  await context.search();
  assert.strictEqual((el("feed").innerHTML.match(/<article class="story">/g) || []).length, 12);
  assert.ok(el("feed").innerHTML.includes("&lt;script&gt;title") && !el("feed").innerHTML.includes("<script>title"));
  assert.ok(el("feed").innerHTML.includes("Read full post") && el("feed").innerHTML.includes('src="/api/forum/image?key=reddit%3Aabc"'));
  assert.ok(!el("feed").innerHTML.includes('href="https://www.reddit.com'), "posts open within Forum");
  el("more").handlers.click();
  assert.strictEqual((el("feed").innerHTML.match(/<article class="story">/g) || []).length, 24);
  const panel = { innerHTML: "" };
  const details = { dataset: { post: "0" }, querySelector: () => panel, isConnected: true, open: true };
  await context.loadComments(details);
  assert.ok(panel.innerHTML.includes("A question &amp; some code: a &lt; b.") && panel.innerHTML.includes("selection"));
  const beforeReopen = clientCalls.length;
  await context.loadComments(details);
  assert.strictEqual(clientCalls.length, beforeReopen);
  assert.ok(!context.comment({ author: "<script>x</script>", text: "<img onerror=bad>", depth: "0;color:red" }).includes("<img"));
  vm.runInNewContext("threads.clear()", context);
  failComments = true;
  await context.loadComments(details);
  assert.ok(panel.innerHTML.includes("load comments") && panel.innerHTML.includes("Try again"));
  assert.strictEqual(timers.size, 1, "open failed threads schedule one retry");
  const retryTimer = Array.from(timers.values())[0];
  assert.ok(retryTimer.delay >= 30000, "transient failures wait before retrying");
  failComments = false;
  browserNow += retryTimer.delay;
  retryTimer.fn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(panel.innerHTML.includes("A question &amp; some code"), "open Reddit comments recover automatically after the wait");
  vm.runInNewContext("threads.clear()", context);
  timers.clear();
  failComments = true;
  await context.loadComments(details);
  failComments = false;
  browserNow += 31000;
  await context.loadComments(details);
  assert.ok(panel.innerHTML.includes("A question &amp; some code"), "reopening after an error fetches fresh comments instead of retaining the failure");
  vm.runInNewContext("threads.clear()", context);
  timers.clear();
  clientThread = { status: "error", comments: [], message: "Reddit is temporarily limiting requests.", retryAt: browserNow + 120000 };
  await context.loadComments(details);
  const serverRetry = Array.from(timers.values())[0];
  assert.ok(serverRetry.delay >= 120000, "client honors the server's retry time instead of retrying immediately");
  clientThread = thread;
  browserNow += serverRetry.delay;
  serverRetry.fn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(panel.innerHTML.includes("A question &amp; some code"), "rate-limited comments recover while still open");
  context.renderThread(panel, { data: { status: "error", comments: [], message: "Reddit is temporarily limiting requests." } });
  assert.ok(panel.innerHTML.includes("Reddit is temporarily limiting requests."), "retry reason is shown in the page");
  el("source").value = "hn";
  context.sourceChanged();
  assert.ok(el("community").disabled);
  el("q").value = "slow";
  const slow = context.search();
  el("q").value = "fast";
  await context.search();
  slowResolve();
  await slow;
  assert.ok(!el("status").textContent.includes("slow"), "late responses cannot overwrite a newer search");
  console.log("ok: Forum page and search interactions");

  // Isolate the routes to avoid starting the real daemon or affecting Steam.
  const daemon = fs.readFileSync(path.join(__dirname, "..", "dota-limit", "daemon.js"), "utf8");
  const route = daemon.match(/if \(url === "\/api\/forum" \|\| url === "\/api\/forum\/comments" \|\| url === "\/api\/forum\/image"\) \{([\s\S]*?)\n    \}/)[1];
  let body;
  let status;
  let called;
  const headers = {};
  const routeContext = { URL, url: "/api/forum", req: { method: "GET", url: "/api/forum?q=rust&source=reddit&community=programming" },
    json: (value) => { body = value; },
    forum: { search: async (...args) => { called = args; return many; }, comments: async (key) => { called = key; return thread; }, image: async (key) => { called = key; return image; } },
    res: { setHeader: (name, value) => { headers[name] = value; }, writeHead: (value) => { status = value; }, end: (value) => { body = value; } },
  };
  const runRoute = async () => { vm.runInNewContext("(function () {" + route + "})()", routeContext); await new Promise((resolve) => setTimeout(resolve, 0)); };
  await runRoute();
  assert.deepStrictEqual(called, ["rust", "reddit", "programming"]);
  assert.strictEqual(body.posts.length, 30);
  routeContext.url = "/api/forum/comments";
  routeContext.req.url = "/api/forum/comments?key=reddit%3Aabc";
  await runRoute();
  assert.strictEqual(called, "reddit:abc");
  assert.strictEqual(body.status, "ready");
  routeContext.url = "/api/forum/image";
  await runRoute();
  assert.strictEqual(headers["content-type"], "image/jpeg");
  assert.strictEqual(headers["x-content-type-options"], "nosniff");
  assert.ok(Buffer.isBuffer(body));
  called = null;
  routeContext.req.method = "POST";
  await runRoute();
  assert.strictEqual(status, 405);
  assert.strictEqual(called, null, "forum endpoints accept reads only");
  console.log("ok: Forum routes");
})().catch((e) => { console.error(e); process.exit(1); });
