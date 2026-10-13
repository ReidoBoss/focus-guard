// Search-only forum reader. Public Reddit RSS, Hacker News and Lobsters are fetched
// by the service. Browser blocks stay in place; this is not an arbitrary web proxy.
const https = require("https");
const { parseFeed, parseComments, isBlocked, feed } = require("./news");
const { decode, text, tag, attr, commentText } = feed;

const SOURCES = { reddit: "Reddit", hn: "Hacker News", lobsters: "Lobsters" };
const CACHE_MS = 10 * 60000;
const POST_MS = 3600000;
const LIMIT = 60;
const UA = "focus-guard/1.0 (github.com/ReidoBoss/focus-guard)";
const IMAGE_HOSTS = ["i.redd.it", "preview.redd.it", "external-preview.redd.it", "a.thumbs.redditmedia.com", "b.thumbs.redditmedia.com"];
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

function webUrl(value, base) {
  try {
    const u = new URL(value, base);
    return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : null;
  } catch (e) { return null; }
}

function imageUrl(value) {
  const safe = webUrl(value);
  if (!safe) return null;
  const u = new URL(safe);
  return u.protocol === "https:" && !u.port && IMAGE_HOSTS.indexOf(u.hostname) >= 0 ? safe : null;
}

function shorten(s) {
  return s.length > 300 ? s.slice(0, 297).trim() + "..." : s;
}

function redditEntries(xml) {
  if (!/<feed\b/i.test(xml)) throw new Error("Reddit didn't send a feed");
  const out = [];
  for (const block of xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || []) {
    const item = parseFeed(block)[0];
    if (!item) continue;
    const id = text(tag(block, "id"));
    const author = text(tag(tag(block, "author") || "", "name"));
    const category = block.match(/<category\b[^>]*>/i);
    const community = category ? attr(category[0], "term") || "" : "";
    const html = decode((tag(block, "content") || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
    const body = html.match(/<!--\s*SC_OFF\s*-->([\s\S]*?)<!--\s*SC_ON\s*-->/i);
    let bodyText = commentText(body ? body[1] : html);
    if (!body) bodyText = bodyText.replace(/\s*submitted by\s+[\s\S]*$/i, "").trim();
    out.push({ item, id, author, community, body: bodyText.slice(0, 20000) });
  }
  return out;
}

function parseReddit(xml) {
  const seen = {};
  return redditEntries(xml).filter((p) => /^t3_[a-z0-9]{1,16}$/.test(p.id)).map((p) => {
    const id = p.id.slice(3);
    return {
      key: "reddit:" + id, source: "reddit", sourceName: "Reddit", community: /^[a-z0-9_]{2,21}$/i.test(p.community) ? p.community : "",
      title: p.item.title, author: p.author, time: p.item.time, body: p.body, summary: shorten(p.body),
      url: "https://www.reddit.com/comments/" + id + "/", thumbnail: imageUrl(p.item.thumbnail), commentCount: null,
    };
  }).filter((p) => { if (seen[p.key]) return false; seen[p.key] = true; return true; });
}

function parseRedditComments(xml) {
  const entries = redditEntries(xml).filter((p) => /^t1_[a-z0-9]{1,16}$/.test(p.id));
  return {
    comments: entries.slice(0, 100).map((p) => ({ id: p.id.slice(3), author: p.author || "[deleted]", text: p.body, time: p.item.time, depth: 0 })),
    truncated: entries.length >= 100,
    note: "Reddit's public feed includes a selection of comments. Reply nesting and total comment counts aren't provided.",
  };
}

function parseHn(body) {
  const data = JSON.parse(body);
  if (!Array.isArray(data.hits)) throw new Error("Hacker News didn't send results");
  return data.hits.filter((h) => h.title && /^\d{1,16}$/.test(String(h.objectID))).map((h) => {
    const content = commentText(h.story_text).slice(0, 20000);
    return {
      key: "hn:" + h.objectID, source: "hn", sourceName: "Hacker News", community: "", title: text(h.title),
      author: String(h.author || ""), time: h.created_at_i ? h.created_at_i * 1000 : null,
      body: content, summary: shorten(content), url: webUrl(h.url), thumbnail: null,
      commentCount: Number.isSafeInteger(h.num_comments) && h.num_comments >= 0 ? h.num_comments : null,
    };
  });
}

function classAnchor(block, name) {
  const anchors = block.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
  return anchors.filter((a) => (attr(a, "class") || "").split(/\s+/).indexOf(name) >= 0)[0] || null;
}

function parseLobsters(html) {
  if (!/<form\b[^>]*[\s\S]*?name=["']q["']/i.test(html)) throw new Error("Lobsters changed its search page");
  // Split at story starts, since each story contains nested <li> tags for its tags.
  const blocks = html.split(/(?=<li\b[^>]*\bid=["']story_[a-z0-9]+["'])/i).slice(1);
  return blocks.map((block) => {
    const firstTag = block.match(/^<li\b[^>]*>/i)[0];
    const id = (attr(firstTag, "id") || "").slice(6);
    const title = classAnchor(block, "u-url");
    const author = classAnchor(block, "u-author");
    const label = block.match(/<span\b[^>]*class=["']comments_label["'][^>]*>([\s\S]*?)<\/span>/i);
    const count = label && text(label[1]).match(/(\d+)\s+comments?/i);
    const stamp = block.match(/<time\b[^>]*>/i);
    const unix = stamp ? Number(attr(stamp[0], "data-at-unix")) : 0;
    return {
      key: "lobsters:" + id, source: "lobsters", sourceName: "Lobsters", community: "", title: title ? text(title) : "",
      author: author ? text(author) : "", time: unix > 0 ? unix * 1000 : null,
      body: "", summary: "", url: title ? webUrl(attr(title, "href"), "https://lobste.rs") : null, thumbnail: null,
      commentCount: count ? Number(count[1]) : label && /no comments/i.test(text(label[1])) ? 0 : null,
    };
  }).filter((p) => p.title && /^lobsters:[a-z0-9]{1,10}$/.test(p.key));
}

// Follow only redirects on the same HTTPS origin, with bounded responses and timeouts.
function request(url, maxBytes, redirects) {
  if (redirects === undefined) redirects = 3;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "user-agent": UA, accept: "application/atom+xml, application/json, text/html, image/*, */*" }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        try {
          const next = new URL(res.headers.location, url);
          if (next.origin !== new URL(url).origin || next.username || next.password) return reject(new Error("unexpected redirect"));
          return resolve(request(next.href, maxBytes, redirects - 1));
        } catch (e) { return reject(new Error("invalid redirect")); }
      }
      if (res.statusCode !== 200) {
        res.resume();
        const error = new Error("answered " + res.statusCode);
        error.statusCode = res.statusCode;
        const retry = Number(res.headers["retry-after"]);
        error.retryMs = retry > 0 ? retry * 1000 : Math.max(0, Date.parse(res.headers["retry-after"]) - Date.now()) || 60000;
        return reject(error);
      }
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { res.destroy(); req.destroy(new Error("response too large")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ body: Buffer.concat(chunks), type: String(res.headers["content-type"] || "").split(";")[0].toLowerCase() }));
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("response interrupted")));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

function createForum({ blocked = [], fetchText = (url) => request(url, 5 * 1024 * 1024).then((r) => r.body.toString("utf8")),
  fetchImage = (url) => request(url, 2 * 1024 * 1024, 0), now = Date.now, log = () => {} } = {}) {
  const searches = new Map();
  const threads = new Map();
  const images = new Map();
  const posts = new Map();
  const cooldowns = new Map();

  async function sourceText(provider, url) {
    if ((cooldowns.get(provider) || 0) > now()) throw new Error("source is resting after a rate limit");
    try { return await fetchText(url); }
    catch (e) {
      if (e.statusCode === 429) cooldowns.set(provider, now() + Math.min(15 * 60000, Math.max(60000, e.retryMs || 60000)));
      throw e;
    }
  }

  function memo(cache, key, max, work) {
    const old = cache.get(key);
    if (old && now() - old.at < CACHE_MS) return old.promise;
    const entry = { at: now(), promise: Promise.resolve().then(work) };
    entry.promise = entry.promise.catch((e) => { if (cache.get(key) === entry) cache.delete(key); throw e; });
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size > max) cache.delete(cache.keys().next().value);
    return entry.promise;
  }

  function register(post) {
    const link = post.url && !isBlocked({ url: post.url }, blocked) ? post.url : null;
    const known = Object.assign({}, post, { externalUrl: link });
    posts.delete(post.key);
    posts.set(post.key, { post: known, at: now() });
    if (posts.size > 1000) posts.delete(posts.keys().next().value);
    // Images use a local URL so the existing redd.it browser block still works.
    return Object.assign({}, known, { url: undefined, thumbnail: post.thumbnail ? "/api/forum/image?key=" + encodeURIComponent(post.key) : null });
  }

  function search(query, source, community) {
    const q = String(query || "").replace(/\s+/g, " ").trim().slice(0, 120);
    const src = source || "all";
    const sub = String(community || "").trim().replace(/^\/?r\//i, "");
    if (src !== "all" && !Object.prototype.hasOwnProperty.call(SOURCES, src)) return Promise.reject(new Error("Choose a forum from the list."));
    if (sub && !/^[a-z0-9_]{2,21}$/i.test(sub)) return Promise.reject(new Error("Use a Reddit community name, such as programming."));
    if (!q && !sub) return Promise.resolve({ query: q, source: src, community: sub, posts: [], failed: [] });
    const active = src === "all" ? Object.keys(SOURCES) : [src];
    const key = JSON.stringify([q.toLowerCase(), src, sub.toLowerCase()]);
    return memo(searches, key, 100, async () => {
      const failed = [];
      const batches = await Promise.all(active.map(async (provider) => {
        if (!q && provider !== "reddit") return [];
        let url;
        let parse;
        if (provider === "reddit") {
          const base = "https://www.reddit.com" + (sub ? "/r/" + encodeURIComponent(sub) : "");
          url = base + (q ? "/search.rss?q=" + encodeURIComponent(q) + "&sort=relevance&restrict_sr=" + (sub ? "on" : "off") + "&include_over_18=off&limit=" + LIMIT : "/.rss?limit=" + LIMIT);
          parse = parseReddit;
        } else if (provider === "hn") {
          url = "https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=" + LIMIT + "&query=" + encodeURIComponent(q);
          parse = parseHn;
        } else {
          url = "https://lobste.rs/search?q=" + encodeURIComponent(q) + "&what=stories&order=relevance";
          parse = parseLobsters;
        }
        try { return parse(await sourceText(provider, url)).slice(0, LIMIT); }
        catch (e) { failed.push(SOURCES[provider]); log("forum: " + SOURCES[provider] + " failed: " + e.message); return []; }
      }));
      const found = [];
      const seen = {};
      for (let round = 0; batches.some((batch) => batch.length > round); round++) {
        for (const batch of batches) {
          const post = batch[round];
          if (post && !seen[post.key]) { seen[post.key] = true; found.push(post); }
        }
      }
      // Avoid caching an outage for ten minutes, while retaining successful sources.
      if (failed.length) searches.delete(key);
      return { query: q, source: src, community: sub, posts: found, failed };
    }).then((result) => Object.assign({}, result, { posts: result.posts.map(register) }));
  }

  function knownPost(key) {
    const known = posts.get(key);
    return known && now() - known.at < POST_MS ? known.post : null;
  }

  function comments(key) {
    const post = knownPost(key);
    if (!post) return Promise.resolve({ status: "unavailable", comments: [] });
    return memo(threads, key, 100, async () => {
      const id = post.key.split(":")[1];
      const url = post.source === "reddit" ? "https://www.reddit.com/comments/" + id + "/.rss?limit=100&sort=top" :
        post.source === "hn" ? "https://hn.algolia.com/api/v1/items/" + id : "https://lobste.rs/s/" + id + ".json";
      const body = await sourceText(post.source, url);
      const thread = post.source === "reddit" ? parseRedditComments(body) : parseComments(post.source, body);
      return Object.assign({ status: "ready" }, thread);
    });
  }

  function image(key) {
    const post = knownPost(key);
    const url = post && imageUrl(post.thumbnail);
    if (!url) return Promise.resolve(null);
    return memo(images, key, 20, async () => {
      const result = await fetchImage(url);
      if (!result || !Buffer.isBuffer(result.body) || !result.body.length || result.body.length > 2 * 1024 * 1024 || IMAGE_TYPES.indexOf(result.type) < 0) throw new Error("not a supported image");
      return result;
    });
  }

  return { search, comments, image };
}

module.exports = { createForum, parseReddit, parseRedditComments, parseHn, parseLobsters };
