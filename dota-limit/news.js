// Stories for the scrolling news feed, pulled from public RSS feeds and APIs.
// Includes feed images and on-demand source comments. Feeds refresh at most
// every 3 hours, so reloading the page doesn't show anything new.
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PER_SECTION = 60;
const REFRESH_MS = 3 * 3600 * 1000;
const CACHE_VERSION = 3;
const COMMENTS_MS = 10 * 60 * 1000;
const MAX_COMMENTS = 200;
const UA = "focus-guard (github.com/ReidoBoss/focus-guard)";

const AI_WORDS = /\b(ai|a\.i\.|agi|artificial intelligence|apple intelligence|superintelligence|llms?|gpts?|gpt-\w+|chatgpt|openai|anthropic|claude|gemini|llama|mistral|deepseek|qwen|copilot|machine learning|neural|agentic|chatbots?|diffusion|hugging ?face|nvidia)\b/i;
const isAi = (title) => AI_WORDS.test(title);

// Google News searches also return regional sites that only mention the Philippines in
// passing (Singapore fintech, for example), so a result has to be about the Philippines
// in its title or come from a Philippine outlet.
const PH_WORDS = /\b(philippines?|philippine|filipinos?|pinoys?|pinays?|ph|phl|manila|cebu|davao|makati|taguig|pasig|bgc|gcash|pldt|dict|bsp|pse|ntc)\b/i;
const PH_OUTLETS = ["inquirer.net", "rappler.com", "philstar.com", "gmanetwork.com", "abs-cbn.com", "bworldonline.com", "manilatimes.net", "manilastandard.net", "yugatech.com", "lionheartv.net", "brabonewsph.com"];
function isPh(item) {
  const h = hostOf(item.outletUrl || item.url);
  return PH_WORDS.test(item.title) || /\.ph$/.test(h) || PH_OUTLETS.some((o) => h === o || h.slice(-(o.length + 1)) === "." + o);
}
// Press releases and company directories show up in searches but aren't news. YugaTech
// also posts hashtag pages ("#iPhone 18 Pro launch") that aren't stories.
const NOT_NEWS = ["openpr.com", "einpresswire.com", "prnewswire.com", "globenewswire.com", "businesswire.com", "tracxn.com", "crunchbase.com"];
const isPhStory = (i) => isPh(i) && i.title[0] !== "#" && !NOT_NEWS.some((o) => hostOf(i.outletUrl || i.url) === o);

const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-PH&gl=PH&ceid=PH:en`;

// Each source has an id (its cache key), a name shown under the headline, and how to read it.
const SECTIONS = [
  {
    id: "programming",
    title: "Programming",
    sources: [
      { id: "hn", name: "Hacker News", url: "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=60", kind: "hn", keep: (i) => !i.ai },
      { id: "lobsters", name: "Lobsters", url: "https://lobste.rs/hottest.json", kind: "lobsters", keep: (i) => !i.ai },
    ],
  },
  {
    id: "ai",
    title: "AI",
    sources: [
      { id: "simon", name: "Simon Willison", url: "https://simonwillison.net/atom/entries/", kind: "feed" },
      { id: "verge-ai", name: "The Verge", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", kind: "feed" },
      { id: "techcrunch-ai", name: "TechCrunch", url: "https://techcrunch.com/category/artificial-intelligence/feed/", kind: "feed" },
      { id: "hn", keep: (i) => i.ai },
      { id: "lobsters", keep: (i) => i.ai },
    ],
  },
  {
    id: "ph",
    title: "Philippines",
    sources: [
      { id: "rappler", name: "Rappler", url: "https://www.rappler.com/feed/", kind: "feed" },
      { id: "inquirer", name: "Inquirer", url: "https://newsinfo.inquirer.net/feed", kind: "feed" },
      { id: "gma", name: "GMA News", url: "https://data.gmanetwork.com/gno/rss/news/feed.xml", kind: "feed" },
      { id: "philstar", name: "Philstar", url: "https://www.philstar.com/rss/headlines", kind: "feed" },
    ],
  },
  {
    id: "ph-tech",
    title: "PH tech and startups",
    sources: [
      // intitle: keeps out stories that only mention a startup in passing.
      { id: "gnews-ph-startups", name: "Google News", url: gnews("philippines (intitle:startup OR intitle:startups OR intitle:fintech OR intitle:unicorn OR intitle:\"venture capital\") when:7d"), kind: "feed", newest: true, keep: isPhStory },
      { id: "gnews-ph-tech", name: "Google News", url: gnews("philippines (intitle:tech OR intitle:AI OR intitle:digital OR intitle:DICT OR intitle:e-wallet OR intitle:GCash OR intitle:Maya OR intitle:app OR intitle:internet) when:3d"), kind: "feed", newest: true, keep: isPhStory },
    ],
  },
  {
    id: "world",
    title: "World",
    sources: [
      { id: "bbc", name: "BBC", url: "https://feeds.bbci.co.uk/news/world/rss.xml", kind: "feed" },
      { id: "aljazeera", name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml", kind: "feed" },
      { id: "guardian", name: "The Guardian", url: "https://www.theguardian.com/world/rss", kind: "feed" },
    ],
  },
  {
    id: "dota",
    title: "Dota 2",
    sources: [
      { id: "steam-dota", name: "Steam", url: "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=570&count=60&feeds=steam_community_announcements", kind: "steam" },
    ],
  },
];

// Every source that is fetched, once each (the AI section reuses Hacker News and Lobsters).
function feedSources() {
  const seen = {};
  const list = [];
  for (const s of SECTIONS) {
    for (const src of s.sources) {
      if (src.url && !seen[src.id]) {
        seen[src.id] = true;
        list.push(src);
      }
    }
  }
  return list;
}

// ---- parsing

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "...", mdash: "-", ndash: "-", lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"' };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (n === 0x2014 || n === 0x2013) return "-";
      try {
        return String.fromCodePoint(n);
      } catch (err) {
        return m;
      }
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

// Text inside a tag: CDATA unwrapped, entities decoded, any HTML removed.
function text(s) {
  if (s == null) return "";
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Decode first, so escaped HTML (&lt;b&gt;) is removed too, then decode what's left.
  return decode(decode(s).replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : null;
}

function attr(t, name) {
  const m = t.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? decode(m[2] !== undefined ? m[2] : m[3]) : null;
}

function time(s) {
  const t = Date.parse(text(s));
  return isNaN(t) ? null : t;
}

// Resolve feed-relative images and links, allowing only ordinary web URLs.
function webUrl(value, base) {
  if (!value || typeof value !== "string") return null;
  try {
    const u = new URL(value.trim(), base);
    return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : null;
  } catch (e) {
    return null;
  }
}

function commentCount(value) {
  if (value == null || !/^\d+$/.test(String(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function excerpt(value) {
  const s = text(value).replace(/\[\/?[^\]]+\]/g, "");
  return s.length > 280 ? s.slice(0, 277).trim() + "..." : s;
}

// Only these two sources expose public comment threads we can display here.
function discussionKey(value) {
  const safe = webUrl(value);
  if (!safe) return null;
  const u = new URL(safe);
  if (u.hostname === "news.ycombinator.com" && u.pathname === "/item") {
    const id = u.searchParams.get("id");
    return /^\d{1,16}$/.test(id || "") ? "hn:" + id : null;
  }
  const m = u.pathname.match(/^\/s\/([a-z0-9]{1,10})(?:\/|$)/);
  return u.hostname === "lobste.rs" && m ? "lobsters:" + m[1] : null;
}

function commentText(html) {
  // Strip real markup before decoding, so escaped code such as a &lt; b survives.
  const plain = String(html || "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(?:p|div|pre|blockquote)\b[^>]*>|<br\s*\/?\s*>/gi, "\n\n")
    .replace(/<[^>]*>/g, "");
  return decode(plain).replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]*\n(?:[ \t]*\n)*/g, "\n\n").trim();
}

function parseComments(kind, body) {
  const data = JSON.parse(body);
  const comments = [];
  let truncated = false;
  if (kind === "hn") {
    if (!data || !Array.isArray(data.children)) throw new Error("no comment thread");
    const stack = data.children.slice().reverse().map((c) => ({ c, depth: 0 }));
    while (stack.length && comments.length < MAX_COMMENTS) {
      const entry = stack.pop();
      const c = entry.c;
      if (!c || typeof c !== "object") continue;
      const children = Array.isArray(c.children) ? c.children : [];
      const bodyText = c.deleted || c.dead ? "" : commentText(c.text);
      if (bodyText || children.length) {
        const id = /^\d+$/.test(String(c.id)) ? String(c.id) : "";
        comments.push({
          id, author: bodyText ? String(c.author || "Unknown") : "[deleted]", text: bodyText.slice(0, 20000) || "Comment unavailable.",
          time: c.created_at_i ? c.created_at_i * 1000 : time(c.created_at), depth: Math.min(entry.depth, 6),
          url: id ? "https://news.ycombinator.com/item?id=" + id : null,
        });
      }
      if (entry.depth < 64) {
        for (let i = children.length - 1; i >= 0; i--) stack.push({ c: children[i], depth: entry.depth + 1 });
      } else if (children.length) truncated = true;
    }
    truncated = truncated || stack.length > 0;
  } else {
    if (!data || !Array.isArray(data.comments)) throw new Error("no comment thread");
    for (const c of data.comments.slice(0, MAX_COMMENTS)) {
      if (!c || typeof c !== "object") continue;
      const id = /^[a-z0-9]{1,10}$/.test(c.short_id || "") ? c.short_id : "";
      const gone = c.is_deleted || c.is_moderated;
      comments.push({
        id, author: gone ? "[deleted]" : String(c.commenting_user || "Unknown"),
        text: gone ? "Comment unavailable." : String(c.comment_plain == null ? commentText(c.comment) : c.comment_plain).slice(0, 20000),
        time: time(c.created_at), depth: Math.max(0, Math.min(6, Number(c.depth) || 0)),
        url: id ? "https://lobste.rs/c/" + id : null,
      });
    }
    truncated = data.comments.length > MAX_COMMENTS;
  }
  return { comments, truncated };
}

// Media RSS, image enclosures, then the first image in RSS/Atom HTML content.
function thumbnail(block, base) {
  const media = block.match(/<media:thumbnail\b[^>]*>/gi) || [];
  const content = block.match(/<(?:media:content|enclosure|link)\b[^>]*>/gi) || [];
  for (const t of content) {
    const type = attr(t, "type") || "";
    if (/^image\//i.test(type) || attr(t, "medium") === "image") media.push(t);
  }
  const html = ["content:encoded", "description", "content", "summary"].map((name) => {
    return decode((tag(block, name) || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
  }).join(" ");
  const images = media.concat(html.match(/<img\b[^>]*>/gi) || []);
  for (const image of images) {
    const width = Number(attr(image, "width"));
    const height = Number(attr(image, "height"));
    if ((width > 0 && width <= 2) || (height > 0 && height <= 2)) continue;
    const url = webUrl(attr(image, "url") || attr(image, "href") || attr(image, "src"), base);
    if (url) return url;
  }
  return null;
}

// RSS 2.0 and Atom, in feed order. Google News titles end in " - Outlet", which becomes the source.
function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    let title = text(tag(b, "title"));
    let url = null;
    let commentsUrl = null;
    const links = b.match(/<link\b[^>]*>/gi) || [];
    for (const l of links) {
      const href = attr(l, "href");
      const rel = attr(l, "rel");
      if (rel === "replies" && (!attr(l, "type") || attr(l, "type") === "text/html")) commentsUrl = href;
      if (!url && href && (!rel || rel === "alternate")) {
        url = href;
      }
    }
    if (!url) url = text(tag(b, "link")) || null;
    if (!url) {
      const guid = tag(b, "guid");
      if (guid && /^https?:/.test(text(guid))) url = text(guid);
    }
    const when = time(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date"));
    const item = {
      title, url, time: when,
      thumbnail: thumbnail(b, url),
      summary: excerpt(tag(b, "description") || tag(b, "summary") || tag(b, "content") || tag(b, "content:encoded")),
      commentsUrl: webUrl(commentsUrl || text(tag(b, "comments")), url),
      commentCount: commentCount(text(tag(b, "slash:comments") || tag(b, "thr:total"))),
    };
    const source = b.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/i);
    if (source) {
      item.outlet = text(source[2]);
      item.outletUrl = attr(source[0], "url");
      const suffix = " - " + item.outlet;
      if (item.outlet && title.slice(-suffix.length) === suffix) item.title = title.slice(0, -suffix.length);
    }
    if (item.title && item.url && /^https?:\/\//.test(item.url)) items.push(item);
  }
  return items;
}

// Hacker News front page through Algolia's API. Only stories that link out.
function parseHn(body) {
  const hits = (JSON.parse(body).hits || []).slice().sort((a, b) => (b.points || 0) - (a.points || 0));
  return hits.filter((h) => h.url && h.title).map((h) => ({
    title: h.title, url: h.url, time: h.created_at_i ? h.created_at_i * 1000 : null, ai: isAi(h.title),
    commentsUrl: /^\d+$/.test(String(h.objectID)) ? "https://news.ycombinator.com/item?id=" + h.objectID : null,
    commentCount: commentCount(h.num_comments),
  }));
}

function parseLobsters(body) {
  return JSON.parse(body)
    .filter((s) => s.url && s.title)
    .map((s) => ({
      title: s.title, url: s.url, time: Date.parse(s.created_at) || null, ai: isAi(s.title) || (s.tags || []).some((t) => t === "ai" || t === "vibecoding"),
      commentsUrl: webUrl(s.comments_url || s.short_id_url), commentCount: commentCount(s.comment_count),
      summary: excerpt(s.description_plain || s.description),
    }));
}

function parseSteam(body) {
  const news = (JSON.parse(body).appnews || {}).newsitems || [];
  return news.filter((n) => n.url && n.title).map((n) => {
    const content = String(n.contents || "").replace(/\{STEAM_CLAN_IMAGE\}/g, "https://clan.akamai.steamstatic.com/images");
    const image = content.match(/\[img\]([\s\S]*?)\[\/img\]/i);
    return {
      title: text(n.title), url: n.url, time: n.date ? n.date * 1000 : null,
      thumbnail: thumbnail("<description><![CDATA[" + content + "]]></description>", n.url) || webUrl(image && image[1], n.url),
      summary: excerpt(content.replace(/\[img\][\s\S]*?\[\/img\]/gi, "")),
    };
  });
}

function parse(kind, body) {
  if (kind === "hn") return parseHn(body);
  if (kind === "lobsters") return parseLobsters(body);
  if (kind === "steam") return parseSteam(body);
  return parseFeed(body);
}

// ---- building sections

function hostOf(u) {
  const m = /^https?:\/\/([^/:?#]+)/i.exec(u || "");
  return m ? m[1].toLowerCase().replace(/^www\./, "") : "";
}

// Blocked sites from browsers/sites.json ("youtube.com" also covers m.youtube.com).
function isBlocked(item, blocked) {
  const hosts = [hostOf(item.url), hostOf(item.outletUrl)].filter(Boolean);
  return hosts.some((h) => blocked.some((b) => h === b || h.slice(-(b.length + 1)) === "." + b));
}

const words = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Same story if the titles match, or one starts with the other (4+ words), as when a
// repost adds " | Outlet name" to the end.
function sameStory(a, b) {
  if (a === b) return true;
  const short = a.length < b.length ? a : b;
  const long = short === a ? b : a;
  return short.split(" ").length >= 4 && long.indexOf(short + " ") === 0;
}

// Takes items from each source in turn, so one busy feed can't fill the whole section.
function buildSection(section, cache, blocked) {
  const lists = section.sources.map((src) => {
    const entry = cache.sources[src.id];
    const def = feedSources().filter((f) => f.id === src.id)[0] || src;
    const items = entry ? entry.items : [];
    return items
      .filter((i) => (!src.keep || src.keep(i)) && !isBlocked(i, blocked))
      .map((i) => {
        const allowedUrl = (u) => {
          const url = webUrl(u, i.url);
          return url && !isBlocked({ url }, blocked) ? url : null;
        };
        const commentsUrl = allowedUrl(i.commentsUrl);
        return {
          title: i.title, url: i.url, time: i.time, source: i.outlet || src.name || def.name,
          summary: i.summary || "", thumbnail: allowedUrl(i.thumbnail), commentsUrl, commentCount: commentCount(i.commentCount),
          commentKey: discussionKey(commentsUrl),
        };
      });
  });
  const out = [];
  const seenUrl = {};
  const seenTitles = [];
  for (let round = 0; out.length < PER_SECTION && lists.some((l) => l.length > round); round++) {
    for (const l of lists) {
      const i = l[round];
      if (!i || out.length >= PER_SECTION) continue;
      const k = words(i.title);
      if (seenUrl[i.url] || seenTitles.some((t) => sameStory(t, k))) continue;
      seenUrl[i.url] = true;
      seenTitles.push(k);
      out.push(i);
    }
  }
  const failed = section.sources.filter((src) => src.url && cache.sources[src.id] && cache.sources[src.id].error).map((src) => src.name);
  return { id: section.id, title: section.title, items: out, failed };
}

// ---- fetching

function httpText(url, redirects) {
  if (redirects === undefined) redirects = 3;
  return new Promise((resolve, reject) => {
    const lib = url.indexOf("http:") === 0 ? http : https;
    const req = lib.get(url, { headers: { "user-agent": UA, accept: "application/rss+xml, application/atom+xml, application/json, text/xml, */*" }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(httpText(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`answered ${res.statusCode}`));
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        data += c;
        if (data.length > 5 * 1024 * 1024) req.destroy(new Error("too big"));
      });
      res.on("end", () => resolve(data));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

// fetchText(url) and now() can be swapped out in tests.
function createNews({ dir, blocked, fetchText = httpText, now = Date.now, log = () => {}, retryMs = 2000 }) {
  const file = path.join(dir, "news-cache.json");
  let cache = { version: CACHE_VERSION, fetchedAt: 0, sources: {} };
  try {
    cache = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {}
  let running = null;
  const threads = new Map();

  // Tries a feed twice, since one slow answer out of fifteen parallel requests is common.
  function fetchTwice(url) {
    return fetchText(url).catch(() => new Promise((r) => setTimeout(r, retryMs)).then(() => fetchText(url)));
  }

  // A source that fails keeps its last headlines, marked with the error.
  function refresh() {
    if (running) return running;
    running = Promise.all(
      feedSources().map((src) =>
        fetchTwice(src.url)
          .then((body) => {
            const items = parse(src.kind, body);
            // Google News ranks by relevance, so its results are put in date order.
            if (src.newest) items.sort((a, b) => (b.time || 0) - (a.time || 0));
            if (!items.length) throw new Error("no headlines");
            cache.sources[src.id] = { items: items.slice(0, 60), fetchedAt: now() };
          })
          .catch((e) => {
            const old = cache.sources[src.id];
            cache.sources[src.id] = { items: old ? old.items : [], fetchedAt: old ? old.fetchedAt : 0, error: e.message };
            log(`news: ${src.name} failed: ${e.message}`);
          })
      )
    ).then(() => {
      cache.version = CACHE_VERSION;
      cache.fetchedAt = now();
      try {
        fs.writeFileSync(file, JSON.stringify(cache));
      } catch (e) {}
      running = null;
    });
    return running;
  }

  function sections() {
    return SECTIONS.map((s) => buildSection(s, cache, blocked));
  }

  // The first visit waits for the feeds. After that the page gets the saved headlines
  // straight away, and a stale set is refreshed in the background for next time.
  async function get() {
    if (!cache.fetchedAt) await refresh();
    else if (cache.version !== CACHE_VERSION || now() - cache.fetchedAt > REFRESH_MS) refresh();
    return { fetchedAt: cache.fetchedAt, nextAt: cache.fetchedAt + REFRESH_MS, refreshing: !!running, sections: sections() };
  }

  // Only fetch fixed API URLs for discussions attached to currently allowed stories.
  // Shared promises prevent repeat clicks from making duplicate requests.
  function comments(key) {
    let item = null;
    for (const section of sections()) {
      item = section.items.filter((i) => i.commentKey && i.commentKey === key)[0];
      if (item) break;
    }
    if (!item) return Promise.resolve({ status: "unavailable", comments: [] });
    const parts = key.split(":");
    const api = parts[0] === "hn" ? "https://hn.algolia.com/api/v1/items/" + parts[1] : "https://lobste.rs/s/" + parts[1] + ".json";
    if (isBlocked({ url: api }, blocked)) return Promise.resolve({ status: "unavailable", comments: [] });
    const old = threads.get(key);
    if (old && old.until > now()) return old.promise;
    const entry = { until: now() + COMMENTS_MS };
    entry.promise = Promise.resolve().then(() => fetchText(api, 0)).then((body) => {
      const thread = parseComments(parts[0], body);
      return Object.assign({ status: "ready", source: parts[0] === "hn" ? "Hacker News" : "Lobsters", url: item.commentsUrl, fetchedAt: now() }, thread);
    }).catch((e) => {
      log("news comments failed: " + e.message);
      entry.until = now() + 60000;
      return { status: "error", comments: [] };
    });
    threads.delete(key);
    threads.set(key, entry);
    if (threads.size > 100) threads.delete(threads.keys().next().value);
    return entry.promise;
  }

  return { get, refresh, comments };
}

module.exports = { createNews, parseFeed, parse, parseComments, isAi, isPh, isBlocked, buildSection, SECTIONS, PER_SECTION, REFRESH_MS, MAX_COMMENTS,
  feed: { decode, text, tag, attr, commentText } };
