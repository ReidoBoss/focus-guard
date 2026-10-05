// YouTube search for the Videos tab (http://focus/videos): search only, with no home feed,
// Shorts, recommendations or comments. youtube.com stays blocked in the browsers; the
// service runs the search here, and the page plays a video through the privacy-mode embed
// player (youtube-nocookie.com/embed, an exception in browsers/sites.json).
// It reads the search page YouTube itself serves, because the official API needs a key.
const https = require("https");

const MIN_SECONDS = 120; // anything shorter is mostly Shorts and clips
const CACHE_MS = 3600 * 1000;
const MAX_QUERY = 120;
// sp=EgIQAQ== is YouTube's "Type: Video" filter, which leaves out channels, playlists and Shorts shelves.
const searchUrl = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D&hl=en&gl=PH`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

const textOf = (t) => (!t ? "" : t.simpleText || (t.runs || []).map((r) => r.text).join(""));

// "1:17:30" -> 4650
function seconds(length) {
  if (!/^\d+(:\d{2}){0,2}$/.test(length || "")) return null;
  return length.split(":").reduce((s, part) => s * 60 + Number(part), 0);
}

function initialData(html) {
  const start = html.indexOf("var ytInitialData = ");
  if (start < 0) throw new Error("YouTube changed its search page");
  const from = start + "var ytInitialData = ".length;
  const end = html.indexOf(";</script>", from);
  return JSON.parse(html.slice(from, end));
}

// Every videoRenderer in the page, in order. Ads and shelves use other renderers.
function renderers(data) {
  const out = [];
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (o.videoRenderer) return out.push(o.videoRenderer);
    for (const k of Object.keys(o)) walk(o[k]);
  })(data);
  return out;
}

// Leaves out Shorts, live streams and premieres (no length yet), and anything under 2 minutes.
function parseSearch(html) {
  const seen = {};
  const videos = [];
  for (const v of renderers(initialData(html))) {
    const url = (((v.navigationEndpoint || {}).commandMetadata || {}).webCommandMetadata || {}).url || "";
    const length = textOf(v.lengthText);
    const secs = seconds(length);
    if (!v.videoId || seen[v.videoId] || url.indexOf("/shorts/") === 0 || secs === null || secs < MIN_SECONDS) continue;
    seen[v.videoId] = true;
    videos.push({
      id: v.videoId,
      title: textOf(v.title),
      channel: textOf(v.ownerText || v.longBylineText),
      length,
      seconds: secs,
      published: textOf(v.publishedTimeText),
      views: textOf(v.viewCountText),
      thumb: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
    });
  }
  return videos;
}

function httpText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", cookie: "CONSENT=YES+1" }, timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`YouTube answered ${res.statusCode}`));
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });
    req.on("timeout", () => req.destroy(new Error("YouTube timed out")));
    req.on("error", reject);
  });
}

// fetchText(url) and now() can be swapped out in tests.
function createVideos({ fetchText = httpText, now = Date.now } = {}) {
  const cache = new Map();

  async function search(query) {
    const q = String(query || "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY);
    if (!q) return { query: q, videos: [] };
    const key = q.toLowerCase();
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.result;
    const result = { query: q, videos: parseSearch(await fetchText(searchUrl(q))) };
    cache.set(key, { at: now(), result });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return result;
  }

  return { search };
}

module.exports = { createVideos, parseSearch, seconds, MIN_SECONDS };
