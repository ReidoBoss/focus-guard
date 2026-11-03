// Shares the Dota and Plan tabs between machines through one small server.
//
//   FG_SYNC_TOKEN=<secret> node sync.js serve <host> <port> <data file>   (on the server)
//
// The daemon syncs when config.json has syncUrl and syncToken. Matches are only ever added,
// so every machine sees every machine's games and the daily limit counts them all.
// The plan is one list per day; the most recent edit wins.
const http = require("http");
const https = require("https");
const fs = require("fs");

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Two copies of one match: the finished one wins, then the one with more filled in.
// shortcut: "more filled in" is JSON length; fine while a match only changes on the machine that played it.
function pickMatch(a, b) {
  if (!a || !b) return a || b;
  if (!!a.result !== !!b.result) return a.result ? a : b;
  return JSON.stringify(b).length > JSON.stringify(a).length ? b : a;
}

function mergeDay(a, b) {
  if (!a || !b) return a || b;
  const matches = Object.assign({}, a.matches);
  for (const id of Object.keys(b.matches || {})) matches[id] = pickMatch(matches[id], b.matches[id]);
  const locks = [a.lockedAt, b.lockedAt].filter(Boolean).sort();
  const out = Object.assign({}, a, b, { matches, lockedAt: locks[0] || null });
  const blocked = Math.max(a.blockedLaunches || 0, b.blockedLaunches || 0);
  if (blocked) out.blockedLaunches = blocked;
  return out;
}

// Newest day first, at most 60, like history.json.
function mergeDays(a, b) {
  const byDay = {};
  for (const d of (a || []).concat(b || [])) byDay[d.day] = mergeDay(byDay[d.day], d);
  return Object.keys(byDay).sort().reverse().slice(0, 60).map((k) => byDay[k]);
}

function mergePlan(a, b) {
  if (!a || !b) return a || b;
  if (a.day !== b.day) return a.day > b.day ? a : b;
  return (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a;
}

const isObj = (o) => !!o && typeof o === "object" && !Array.isArray(o);
const validDay = (d) => isObj(d) && DAY.test(d.day) && isObj(d.matches);
const validPlan = (p) => isObj(p) && DAY.test(p.day) && Array.isArray(p.tasks);

// One request: { rev, days?, plan? } in, { rev, days?, plan? } out. Data comes back only when
// the server's copy changed since `rev`, and goes up only when the machine's copy changed.
function createServer({ file, token }) {
  let store = { rev: 0, days: [], plan: null };
  try {
    store = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {}
  return http.createServer((req, res) => {
    if (req.method !== "POST" || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403);
      return res.end();
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 32 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      let ask;
      try {
        ask = JSON.parse(body);
      } catch (e) {}
      if (!isObj(ask) || (ask.days !== undefined && !(Array.isArray(ask.days) && ask.days.every(validDay))) || (ask.plan != null && !validPlan(ask.plan))) {
        res.writeHead(400);
        return res.end();
      }
      const days = mergeDays(store.days, ask.days);
      const plan = mergePlan(store.plan, ask.plan || null);
      if (JSON.stringify([days, plan]) !== JSON.stringify([store.days, store.plan])) {
        store = { rev: store.rev + 1, days, plan };
        fs.writeFileSync(file + ".tmp", JSON.stringify(store));
        fs.renameSync(file + ".tmp", file);
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(ask.rev === store.rev ? { rev: store.rev } : store));
    });
  });
}

// The daemon's side. sync(days, plan, cb) calls cb(reply) when the server answers.
function createSync({ url, token, log }) {
  const target = new URL(url);
  const lib = target.protocol === "https:" ? https : http;
  let rev = null;
  let sent = "";
  let busy = false;
  return function sync(days, plan, cb) {
    if (busy) return;
    const local = JSON.stringify({ days, plan });
    const ask = local === sent ? { rev } : { rev, days, plan };
    const data = JSON.stringify(ask);
    busy = true;
    const req = lib.request(target, { method: "POST", timeout: 20000, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => {
        busy = false;
        let reply;
        try {
          reply = JSON.parse(out);
        } catch (e) {}
        if (res.statusCode !== 200 || !isObj(reply)) return log(`sync failed: HTTP ${res.statusCode}`);
        if ((reply.days && !reply.days.every(validDay)) || (reply.plan && !validPlan(reply.plan))) return log("sync failed: bad reply");
        sent = local;
        rev = reply.rev;
        cb(reply);
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (e) => {
      busy = false;
      log(`sync failed: ${e.message}`);
    });
    req.end(data);
  };
}

module.exports = { mergeDay, mergeDays, mergePlan, createServer, createSync };

if (require.main === module && process.argv[2] === "serve") {
  const [host, port, file] = process.argv.slice(3);
  const token = process.env.FG_SYNC_TOKEN;
  if (!host || !port || !file || !token || token.length < 16) {
    console.error("usage: FG_SYNC_TOKEN=<16+ chars> node sync.js serve <host> <port> <data file>");
    process.exit(1);
  }
  createServer({ file, token }).listen(Number(port), host, () => console.log(`sync server on ${host}:${port}`));
}
