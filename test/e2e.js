// CI only: checks the installed service end to end. Plays a fake 2-0 series over
// Game State Integration and expects Steam to be locked afterwards.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const { execFileSync } = require("child_process");

const fake = JSON.parse(fs.readFileSync(path.join(__dirname, ".fake.json"), "utf8"));
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const DEST = IS_WIN ? path.join(process.env.ProgramFiles, "FocusGuard") : IS_MAC ? "/usr/local/focus-guard" : "/opt/focus-guard";

// What the installer was told, so the same test covers default and interactive installs.
const EXPECT = {
  browsers: (process.env.FG_EXPECT_BROWSERS || (IS_WIN ? "brave,chrome,edge,firefox" : IS_MAC ? "brave,chrome,edge,firefox" : "brave,chrome,chromium,edge,firefox")).split(",").filter(Boolean),
  mode: process.env.FG_EXPECT_MODE || "bo3",
  maxGames: Number(process.env.FG_EXPECT_MAX || 3),
  weekendMode: process.env.FG_EXPECT_WEEKEND_MODE || "same",
  weekendMaxGames: Number(process.env.FG_EXPECT_WEEKEND_MAX || 7),
  resetHour: Number(process.env.FG_EXPECT_RESET || 4),
  blockSafari: process.env.FG_EXPECT_SAFARI === "1",
  opendota: process.env.FG_EXPECT_OPENDOTA !== "0",
  adult: process.env.FG_EXPECT_ADULT === "1",
};
const ALL_BROWSERS = IS_WIN || IS_MAC ? ["brave", "chrome", "edge", "firefox"] : ["brave", "chrome", "chromium", "edge", "firefox"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: body ? "POST" : "GET", timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
let statsUrl = "http://dota-limiter-stats/";
const api = async () => JSON.parse((await request(`${statsUrl}api`)).body);
const notices = async () => JSON.parse((await request("http://127.0.0.1:43210/notices?after=0")).body);

async function waitFor(what, fn, seconds) {
  for (let i = 0; i < seconds; i++) {
    try {
      if (await fn()) return console.log(`ok: ${what}`);
    } catch (e) {}
    await sleep(1000);
  }
  throw new Error(`timed out: ${what}`);
}

// Node running under a Steam or Dota process name, so the service sees a "real" one.
// Windows needs an actual file with that name; macOS and Linux only look at argv[0]
// (and a copied Homebrew node can't find its libraries anyway).
// Resolves once it's confirmed running, so a crash can't pass for "the service closed it".
function fakeProcess(file) {
  let exe = process.execPath;
  if (IS_WIN) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(process.execPath, file);
    exe = file;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ["-e", "console.log('up'); setTimeout(() => {}, 600000)"], { argv0: file, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.exitedAt = null;
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      child.exitedAt = Date.now();
      child.exitInfo = { code, signal, err };
    });
    child.stdout.once("data", () => {
      console.log(`started fake process ${path.basename(file)} (pid ${child.pid})`);
      resolve(child);
    });
    setTimeout(() => reject(new Error(`fake process ${file} didn't start: ${err}`)), 10000);
  });
}

function check(what, cond) {
  if (!cond) throw new Error(`failed: ${what}`);
  console.log(`ok: ${what}`);
}

// The part of the macOS profile for one browser.
function macPayload(b) {
  const file = path.join(DEST, "browsers", "focus-guard.mobileconfig");
  const type = { brave: "com.brave.Browser", chrome: "com.google.Chrome", edge: "com.microsoft.Edge", firefox: "org.mozilla.firefox" }[b];
  if (!fs.existsSync(file)) return "";
  const chunks = fs.readFileSync(file, "utf8").split("<key>PayloadType</key>");
  return chunks.find((c) => c.startsWith(`<string>${type}</string>`)) || "";
}

function regHas(key, value) {
  try {
    execFileSync("reg", value ? ["query", key, "/v", value] : ["query", key], { stdio: "ignore" });
    return true;
  } catch (e) {
    return false;
  }
}

function checkBrowserPolicies() {
  for (const b of ALL_BROWSERS) {
    const want = EXPECT.browsers.includes(b);
    let has;
    let adult;
    if (IS_WIN) {
      const key = {
        brave: "HKLM\\SOFTWARE\\Policies\\BraveSoftware\\Brave\\URLBlocklist",
        chrome: "HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\URLBlocklist",
        edge: "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\URLBlocklist",
        firefox: "HKLM\\SOFTWARE\\Policies\\Mozilla\\Firefox\\WebsiteFilter\\Block",
      }[b];
      try {
        has = execFileSync("reg", ["query", key]).toString().includes(b === "firefox" ? "*://*.facebook.com/*" : "facebook.com");
      } catch (e) {
        has = false;
      }
      adult = b === "firefox" ? regHas("HKLM\\SOFTWARE\\Policies\\Mozilla\\Firefox\\DNSOverHTTPS") : regHas(key.replace(/\\URLBlocklist$/, ""), "DnsOverHttpsMode");
    } else if (IS_MAC) {
      const payload = macPayload(b);
      has = payload.includes(b === "firefox" ? "<key>WebsiteFilter</key>" : "<key>URLBlocklist</key>");
      adult = payload.includes(b === "firefox" ? "<key>DNSOverHTTPS</key>" : "<key>DnsOverHttpsMode</key>");
    } else if (b === "firefox") {
      const file = "/etc/firefox/policies/policies.json";
      const policies = (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).policies) || {};
      has = !!policies.WebsiteFilter;
      adult = !!policies.DNSOverHTTPS;
    } else {
      const dir = { brave: "/etc/brave/policies/managed", chrome: "/etc/opt/chrome/policies/managed", chromium: "/etc/chromium/policies/managed", edge: "/etc/opt/edge/policies/managed" }[b];
      const file = path.join(dir, "focus-guard.json");
      const policy = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      has = (policy.URLBlocklist || []).includes("facebook.com");
      adult = policy.DnsOverHttpsMode === "off";
    }
    check(`${b} policy ${want ? "applied" : "not applied"}`, has === want);
    check(`${b} adult settings ${EXPECT.adult ? "applied" : "not applied"}`, adult === EXPECT.adult);
  }
}

async function checkAdultDns() {
  const status = JSON.parse(execFileSync(process.execPath, [path.join(DEST, "browsers", "dns.js"), "status"]).toString());
  check(`DNS filter ${EXPECT.adult ? "on" : "off"} (${status.map((c) => `${c.name}: ${c.filtered ? "on" : `off [${c.servers.join(" ")}]`}`).join(", ")})`,
    status.length > 0 && status.every((c) => c.filtered === EXPECT.adult));
  if (!EXPECT.adult) return;
  // Cloudflare for Families answers 0.0.0.0 for adult sites. Windows won't hand out 0.0.0.0
  // as an address, so there the lookup fails instead (the next check shows DNS itself works).
  let got = "";
  try {
    await waitFor("an adult site is blocked by DNS", () => new Promise((resolve) => {
      require("dns").lookup("pornhub.com", { family: 4 }, (err, address) => {
        got = err ? err.code : address;
        resolve(got === "0.0.0.0" || (IS_WIN && got === "ENOENT"));
      });
    }), 30);
  } catch (e) {
    console.log(`the lookup answered ${got}`);
    throw e;
  }
  await waitFor("other sites still resolve", () => new Promise((resolve) => {
    require("dns").lookup("github.com", { family: 4 }, (err, address) => resolve(!err && address !== "0.0.0.0"));
  }), 30);
}

const gsi = (matchid, game_state, win_team) => ({
  map: { matchid, game_state, win_team, clock_time: 1800, radiant_score: 30, dire_score: 12 },
  player: { team_name: "radiant", kills: 10, deaths: 1, assists: 12, last_hits: 250, denies: 9, gpm: 650, xpm: 720 },
  hero: { name: "npc_dota_hero_juggernaut", level: 24 },
  items: { slot0: { name: "item_phase_boots" }, slot1: { name: "empty" } },
});

(async () => {
  await waitFor("service answers", async () => {
    const r = await request("http://127.0.0.1:43210/");
    statsUrl = r.headers.location;
    return r.status === 302;
  }, 30);
  check(`stats page uses the dota-limiter-stats address (${statsUrl})`, /^http:\/\/dota-limiter-stats(:\d+)?\/$/.test(statsUrl));
  await waitFor("stats page answers", async () => (await request(statsUrl)).body.includes("Dota Limiter"), 30);

  const cfg = path.join(fake.dotaDir, "game", "dota", "cfg", "gamestate_integration", "gamestate_integration_dotalimit.cfg");
  check("GSI config written", fs.existsSync(cfg) && fs.readFileSync(cfg, "utf8").includes('"uri"       "http://127.0.0.1:43210/"'));
  const lc = (id) => fs.readFileSync(path.join(fake.root, "userdata", id, "config", "localconfig.vdf"), "utf8");
  check("launch option appended to existing options", lc("111").includes('"LaunchOptions"\t\t"-novid -gamestateintegration"'));
  check("launch option added for account without Dota settings", lc("222").includes('"LaunchOptions"\t\t"-gamestateintegration"'));


  const config = JSON.parse(fs.readFileSync(path.join(DEST, "dota-limit", "config.json"), "utf8"));
  check(`config matches the installer answers (${config.mode}, ${config.maxGames} games, reset ${config.resetHour})`,
    config.mode === EXPECT.mode && config.weekendMode === EXPECT.weekendMode && (config.weekendMode !== "games" || config.weekendMaxGames === EXPECT.weekendMaxGames) && config.resetHour === EXPECT.resetHour && (config.mode === "bo3" || config.maxGames === EXPECT.maxGames) && config.blockSafari === EXPECT.blockSafari && config.blockAdult === EXPECT.adult && config.opendota === EXPECT.opendota && config.tiltCheck === true);

  checkBrowserPolicies();
  await checkAdultDns();

  const dotaExe = IS_WIN
    ? path.join(os.tmpdir(), "fg-dota", "dota2.exe")
    : path.join(os.tmpdir(), "fg-dota", "dota 2 beta", "game", "bin", "linuxsteamrt64", "dota2");
  const dota = await fakeProcess(dotaExe);
  await waitFor("Dota without -gamestateintegration gets closed", () => dota.exitedAt, 30);
  check("closed by the service, with a notice", (await notices()).some((n) => n.msg.includes("-gamestateintegration")));

  // Best of 3: a 2-0 ends the day. Fixed games: play them all, losing one, and check it
  // doesn't lock one game early.
  // On Saturday and Sunday the weekend limit applies, so ask the service which one is in force.
  const limit = (await api()).today;
  const weekendRule = limit.weekend && EXPECT.weekendMode !== "same";
  const want = weekendRule ? { mode: EXPECT.weekendMode, maxGames: EXPECT.weekendMaxGames } : EXPECT;
  check(`today's limit is the ${weekendRule ? "weekend" : "everyday"} one (${limit.mode}, ${limit.maxGames} games)`,
    limit.mode === want.mode && (want.mode === "bo3" || limit.maxGames === want.maxGames));
  const results = want.mode === "bo3" ? ["radiant", "radiant"] : Array.from({ length: want.maxGames }, (_, i) => (i === 1 ? "dire" : "radiant"));
  for (let i = 0; i < results.length; i++) {
    // IDs far above real ones, so the OpenDota lookup finds nothing.
    const id = String(990000000001 + i);
    await request("http://127.0.0.1:43210/", gsi(id, "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"));
    await request("http://127.0.0.1:43210/", gsi(id, "DOTA_GAMERULES_STATE_POST_GAME", results[i]));
    await request("http://127.0.0.1:43210/", { provider: { name: "Dota 2" } });
    if (i < results.length - 1) {
      await sleep(6000);
      check(`not locked after game ${i + 1} of ${results.length}`, !(await api()).today.lockedAt);
    }
  }

  const today = (await api()).today;
  const wins = results.filter((r) => r === "radiant").length;
  check(`${wins}-${results.length - wins} recorded`, today.wins === wins && today.losses === results.length - wins && today.limitReached);
  const d = today.matches["990000000001"].details;
  check("OpenDota lookup queued", (today.matches["990000000001"].opendota || {}).status === (EXPECT.opendota ? "pending" : undefined));
  check("match details saved", d.hero === "npc_dota_hero_juggernaut" && d.kills === 10 && d.items[0] === "item_phase_boots");
  await waitFor("Steam gets locked once the day is decided", async () => (await api()).today.lockedAt, 20);

  const steam = await fakeProcess(path.join(os.tmpdir(), "fg-steam", IS_WIN ? "steam.exe" : process.platform === "darwin" ? "steam_osx" : "steam"));
  await waitFor("Steam gets closed while locked", () => steam.exitedAt, 30);

  check("closed by the service, with a notice", (await notices()).some((n) => n.msg.includes("locked until tomorrow")));

  const lost = Object.values((await api()).today.matches).find((m) => m.result === "loss");
  if (lost) check("tilt check saved for the lost game", !!(lost.tilt && lost.tilt.advice));
  const week = JSON.parse((await request(`${statsUrl}api/weekly`)).body);
  check(`weekly summary counts this week (${week.wins}-${week.losses}, limit ${week.limitDays} day, ${week.blockedLaunches} reopen attempt)`,
    week.games === results.length && week.limitDays === 1 && week.blockedLaunches >= 1);
  const rep = JSON.parse((await request(`${statsUrl}api/report`)).body);
  check(`hero report endpoint answers (${rep.status})`, ["off", "no-account", "pending", "ready"].includes(rep.status));

  if (IS_MAC) {
    const safari = await fakeProcess("/Applications/Safari.app/Contents/MacOS/Safari");
    if (EXPECT.blockSafari) {
      await waitFor("Safari gets closed when blocked", () => safari.exitedAt, 30);
    } else {
      await sleep(12000);
      check("Safari left alone when not blocked", !safari.exitedAt);
      safari.kill();
    }
  }
  console.log("\nall checks passed");
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
