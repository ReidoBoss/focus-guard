// Dota Limit: counts Dota 2 matches via Game State Integration and locks Steam
// for the rest of the day once the limit is reached. Runs as a system service:
// launchd on macOS, systemd on Linux, a SYSTEM scheduled task on Windows.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile, execFileSync } = require("child_process");
const { gsiPath, gsiConfig } = require("./gsi");
const { createOpenDota, accountIdFromSteamId, RETRY_MINUTES } = require("./opendota");
const insights = require("./insights");

const DIR = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
const STATE_FILE = path.join(DIR, "state.json");
const HISTORY_FILE = path.join(DIR, "history.json");
const LOG_FILE = path.join(DIR, "log.txt");
const STATS_PAGE = path.join(DIR, "stats.html");
const STATS_HOST = "dota-limiter-stats";
// Port 80 gives the page a clean address. If something else owns it (IIS, for
// example), the page falls back to this port and the address includes it.
const STATS_FALLBACK_PORT = CONFIG.statsFallbackPort || 8787;
let statsUrl = `http://${STATS_HOST}/`;
const GSI_FILE = CONFIG.dotaDir ? gsiPath(CONFIG.dotaDir) : null;
const GSI_CFG = gsiConfig(CONFIG.port);

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const DOTA_ENABLED = CONFIG.dotaEnabled !== false;
const BLOCK_SAFARI = IS_MAC && CONFIG.blockSafari === true;
const TILT_CHECK = CONFIG.tiltCheck !== false;
const PARSE_REPLAYS = CONFIG.parseReplays !== false;
const WEEKLY_SUMMARY = CONFIG.weeklySummary !== false;

const LIVE_STATES = new Set([
  "DOTA_GAMERULES_STATE_STRATEGY_TIME",
  "DOTA_GAMERULES_STATE_TEAM_SHOWCASE",
  "DOTA_GAMERULES_STATE_WAIT_FOR_MAP_TO_LOAD",
  "DOTA_GAMERULES_STATE_PRE_GAME",
  "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",
]);
const POST_GAME = "DOTA_GAMERULES_STATE_POST_GAME";

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.writeFileSync(LOG_FILE, "");
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {}
}

// "Day" rolls over at resetHour, so a late-night session counts toward the day it started.
function dayKey(d = new Date()) {
  const shifted = new Date(d.getTime() - CONFIG.resetHour * 3600 * 1000);
  return shifted.toLocaleDateString("en-CA");
}

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch (e) {
    return [];
  }
}

function archive(s) {
  if (!Object.keys(s.matches).length) return;
  const history = loadHistory().filter((d) => d.day !== s.day);
  history.unshift(s);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 60), null, 2));
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (s.day === dayKey()) return s;
    archive(s);
  } catch (e) {}
  return { day: dayKey(), matches: {}, lockedAt: null };
}

let state = loadState();
let lastSave = 0;
function save() {
  lastSave = Date.now();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function rollover() {
  if (state.day !== dayKey()) {
    archive(state);
    state = { day: dayKey(), matches: {}, lockedAt: null };
    save();
    log("new day, counter reset");
  }
}

// Notices are shown directly on macOS and Linux. On Windows the service runs as
// SYSTEM and can't reach your desktop, so notifier.js picks them up from /notices.
const notices = [];
let lastNoticeId = 0;

function notify(title, msg) {
  lastNoticeId = Math.max(Date.now(), lastNoticeId + 1);
  notices.push({ id: lastNoticeId, title, msg });
  if (notices.length > 20) notices.shift();
  if (IS_WIN) return;
  try {
    const uid = execFileSync("id", ["-u", CONFIG.user]).toString().trim();
    if (IS_MAC) {
      const script = `display notification ${JSON.stringify(msg)} with title ${JSON.stringify(title)} sound name "Submarine"`;
      execFile("launchctl", ["asuser", uid, "sudo", "-u", CONFIG.user, "osascript", "-e", script], () => {});
    } else {
      execFile(
        "sudo",
        ["-u", CONFIG.user, "env", "DISPLAY=:0", `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, "notify-send", title, msg],
        () => {}
      );
    }
  } catch (e) {}
}

function tally() {
  const list = Object.values(state.matches);
  return {
    played: list.length,
    wins: list.filter((m) => m.result === "win").length,
    losses: list.filter((m) => m.result === "loss").length,
    live: list.some((m) => !m.result),
  };
}

function limitReached() {
  const t = tally();
  if (CONFIG.mode === "bo3") return t.wins >= 2 || t.losses >= 2 || t.played >= 3;
  return t.played >= CONFIG.maxGames;
}

function snapshot({ map = {}, player = {}, hero = {}, items = {} }) {
  const slots = [0, 1, 2, 3, 4, 5].map((i) => items[`slot${i}`]);
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  return {
    hero: hero.name || null,
    level: hero.level,
    team: player.team_name,
    ...pick(player, ["steamid", "accountid", "kills", "deaths", "assists", "last_hits", "denies", "gpm", "xpm", "net_worth", "gold"]),
    ...pick(map, ["clock_time", "radiant_score", "dire_score", "game_mode"]),
    items: slots.map((it) => (it && it.name && it.name !== "empty" ? it.name : null)),
    neutral: items.neutral0 && items.neutral0.name !== "empty" ? items.neutral0.name : null,
  };
}

let currentMatch = null;
let postGameSince = null;
let lastPost = 0;

function onGameState(body) {
  if (!DOTA_ENABLED) return;
  if (Date.now() - lastPost > 60 * 1000) log(`Dota reporting (state: ${(body.map && body.map.game_state) || "menu"})`);
  lastPost = Date.now();
  const map = body.map || {};
  const player = body.player || {};
  const matchid = map.matchid && map.matchid !== "0" ? String(map.matchid) : null;
  const team = player.team_name;
  const playing = matchid && (team === "radiant" || team === "dire");

  if (!playing) {
    // Back in the main menu or spectating.
    currentMatch = null;
    return;
  }

  rollover();
  currentMatch = matchid;

  if (LIVE_STATES.has(map.game_state) && !state.matches[matchid]) {
    state.matches[matchid] = { startedAt: new Date().toISOString(), result: null };
    save();
    log(`match ${matchid} started (${tally().played} today)`);
    if (limitReached()) notify("Dota Limit", "This is your last game today. Make it count.");
  }

  if (state.matches[matchid] && !state.matches[matchid].result) {
    state.matches[matchid].details = snapshot(body);
    if (Date.now() - lastSave > 10 * 1000) save();
  }

  if (map.game_state === POST_GAME && state.matches[matchid] && !state.matches[matchid].result) {
    const won = map.win_team && map.win_team === team;
    state.matches[matchid].result = won ? "win" : "loss";
    state.matches[matchid].endedAt = new Date().toISOString();
    if (opendota) {
      state.matches[matchid].opendota = { status: "pending", tries: 0 };
      scheduleLookup(matchid, RETRY_MINUTES[0] * 60 * 1000);
    }
    save();
    const t = tally();
    log(`match ${matchid} ${state.matches[matchid].result} (${t.wins}W ${t.losses}L)`);
    if (state.matches[matchid].result === "loss") state.matches[matchid].tilt = buildTilt(state.matches[matchid]);
    if (limitReached()) {
      postGameSince = Date.now();
      notify("Dota Limit", `Done for today (${t.wins}W ${t.losses}L). Steam closes in ${CONFIG.postGameGraceSeconds}s.`);
    } else if (TILT_CHECK && state.matches[matchid].tilt) {
      notify("Tilt check", `${t.wins}W ${t.losses}L today. ${state.matches[matchid].tilt.headline} ${state.matches[matchid].tilt.advice}`);
    } else {
      notify("Dota Limit", `${t.played} played today (${t.wins}W ${t.losses}L).`);
    }
    save();
  }
}

// Returns [{ pid, cmd }]. On Windows cmd is the image name, which is enough to spot Steam.
function processes() {
  try {
    if (IS_WIN) {
      const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true }).toString();
      return out
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ""));
          return { pid: Number(cols[1]), cmd: cols[0] };
        });
    }
    const out = execFileSync("ps", ["-A", "-o", "pid=,command="], { maxBuffer: 16 * 1024 * 1024 }).toString();
    return out
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), cmd: m[2] }));
  } catch (e) {
    return [];
  }
}

function isDota(cmd) {
  return IS_WIN ? /^dota2\.exe$/i.test(cmd) : /dota 2 beta\/game\/bin\//i.test(cmd);
}

// Only the main Safari app, not the system services that share its name.
function isSafari(cmd) {
  return /Safari\.app\/Contents\/MacOS\/Safari( |$)/.test(cmd);
}

// Steam's small background helpers (ipcserver on macOS, steamservice on Windows) are
// left alone: the OS respawns them and they can't launch games.
function isSteam(cmd) {
  if (IS_WIN) return /^(steam|steamwebhelper)\.exe$/i.test(cmd);
  if (IS_MAC) return /\/steam_osx( |$)/.test(cmd) || /Steam Helper\.app\//.test(cmd);
  return /(^|\/)(steam|steamwebhelper|steam\.sh|bin_steam\.sh)( |$)/.test(cmd);
}

const flagCache = new Map();
function hasLaunchFlag(p) {
  if (!IS_WIN) return p.cmd.includes("-gamestateintegration");
  if (!flagCache.has(p.pid)) {
    try {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${p.pid}").CommandLine`],
        { windowsHide: true }
      ).toString();
      flagCache.set(p.pid, out.includes("-gamestateintegration"));
    } catch (e) {
      return true;
    }
  }
  return flagCache.get(p.pid);
}

function kill(list) {
  for (const p of list) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch (e) {}
  }
}

let gsiErrorLogged = false;
function ensureGsiConfig() {
  if (!GSI_FILE) return;
  try {
    if (!fs.existsSync(CONFIG.dotaDir)) return;
    fs.mkdirSync(path.dirname(GSI_FILE), { recursive: true });
    if (!fs.existsSync(GSI_FILE) || fs.readFileSync(GSI_FILE, "utf8") !== GSI_CFG) {
      fs.writeFileSync(GSI_FILE, GSI_CFG);
      log("restored GSI config");
    }
  } catch (e) {
    // macOS blocks system services from external drives; the installer writes the file as you instead.
    if (!gsiErrorLogged) log(`GSI config not writable (${e.code}), relying on the installer's copy`);
    gsiErrorLogged = true;
  }
}

let dotaSeenAt = null;
let lastLockNotice = 0;
let lastSafariNotice = 0;
let lastBlockedCount = 0;

function tick() {
  rollover();
  const procs = processes();

  // Safari can't be filtered site by site, so the installer offers to block it outright.
  if (BLOCK_SAFARI) {
    const safari = procs.filter((p) => isSafari(p.cmd));
    if (safari.length) {
      kill(safari);
      if (Date.now() - lastSafariNotice > 10 * 60 * 1000) {
        notify("Focus Guard", "Safari is blocked. Use one of your other browsers.");
        lastSafariNotice = Date.now();
      }
    }
  }

  if (!DOTA_ENABLED) return;
  ensureGsiConfig();
  maybeWeeklyNotice();

  const dota = procs.filter((p) => isDota(p.cmd));
  const steam = procs.filter((p) => isSteam(p.cmd));

  // Without this flag Dota never reports matches, so it is not allowed to run.
  const flagless = dota.filter((p) => !hasLaunchFlag(p));
  if (flagless.length) {
    kill(flagless);
    notify("Dota Limit", 'Add "-gamestateintegration" to Dota 2 launch options in Steam.');
    log("killed Dota: launch option missing");
  }

  // Dota reports at least every 30s while in a match. Silence means the config file was removed.
  dotaSeenAt = dota.length ? dotaSeenAt || Date.now() : null;
  const silentFor = Date.now() - Math.max(lastPost, dotaSeenAt || 0);
  if (CONFIG.requireReports && dota.length && silentFor > 120 * 1000) {
    kill(dota);
    notify("Dota Limit", "Dota isn't reporting matches, so it was closed. Re-run the installer.");
    log("killed Dota: no game state reports for 2 minutes");
    dotaSeenAt = null;
  }

  if (state.lockedAt) {
    if (steam.length || dota.length) {
      kill([...dota, ...steam]);
      // For the weekly summary. One attempt can show up over several ticks, so count once a minute.
      if (Date.now() - lastBlockedCount > 60 * 1000) {
        state.blockedLaunches = (state.blockedLaunches || 0) + 1;
        lastBlockedCount = Date.now();
        save();
      }
      if (Date.now() - lastLockNotice > 10 * 60 * 1000) {
        notify("Dota Limit", "Steam is locked until tomorrow. Go get better at life.");
        lastLockNotice = Date.now();
      }
    }
    return;
  }

  if (!limitReached()) return;

  const t = tally();
  const graceOver = postGameSince && Date.now() - postGameSince > CONFIG.postGameGraceSeconds * 1000;
  // Abandoned or quit mid-match: Dota closed or stopped reporting while a match was live.
  const leftLiveGame = t.live && (!dota.length || Date.now() - lastPost > 90 * 1000);
  const idle = !t.live && !currentMatch;

  if (graceOver || leftLiveGame || idle) {
    state.lockedAt = new Date().toISOString();
    save();
    log("limit reached, locking Steam");
    kill([...dota, ...steam]);
  }
}

// ---------------------------------------------------------------- OpenDota lookups
const opendota = CONFIG.opendota === false ? null : createOpenDota({ dir: DIR, apiKey: CONFIG.opendotaApiKey });
const lookupTimers = new Map();

// A match lives in today's state or in history; returns it with a function that saves it.
function findMatch(id) {
  if (state.matches[id]) return { match: state.matches[id], commit: save };
  const history = loadHistory();
  for (const day of history) {
    if (day.matches[id]) return { match: day.matches[id], commit: () => fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2)) };
  }
  return null;
}

function scheduleLookup(id, delayMs) {
  if (!opendota || !/^\d+$/.test(id) || lookupTimers.has(id)) return;
  lookupTimers.set(id, setTimeout(() => {
    lookupTimers.delete(id);
    lookup(id).catch((e) => log(`OpenDota lookup for ${id} failed: ${e.message}`));
  }, delayMs));
}

async function lookup(id) {
  const before = findMatch(id);
  if (!before) return;
  let result = null;
  let error = null;
  try {
    const local = Object.assign({}, before.match.details);
    if (!local.accountid && !local.steamid && CONFIG.accountId) local.accountid = CONFIG.accountId;
    result = await opendota.fetchMatch(id, local);
    if (!result) error = "OpenDota doesn't have this match yet";
  } catch (e) {
    error = e.message;
  }
  // Look it up again: the day may have rolled over while we waited on OpenDota.
  const found = findMatch(id);
  if (!found) return;
  if (result) {
    found.match.opendota = Object.assign({ status: "ready" }, result);
    found.commit();
    log(`OpenDota details saved for match ${id}`);
    afterLookup(id).catch((e) => log(`after-match extras for ${id} failed: ${e.message}`));
    return;
  }
  const od = found.match.opendota || { tries: 0 };
  od.tries = (od.tries || 0) + 1;
  od.lastTry = new Date().toISOString();
  od.error = error;
  if (od.tries >= RETRY_MINUTES.length) {
    od.status = "unavailable";
    log(`gave up on OpenDota for match ${id}: ${error}`);
  } else {
    od.status = "pending";
    scheduleLookup(id, (RETRY_MINUTES[od.tries] - RETRY_MINUTES[od.tries - 1]) * 60 * 1000);
  }
  found.match.opendota = od;
  found.commit();
}

// After a restart, pick up lookups that were still waiting.
function resumeLookups() {
  if (!opendota) return;
  const week = Date.now() - 7 * 24 * 3600 * 1000;
  const days = [state].concat(loadHistory());
  let n = 0;
  for (const day of days) {
    for (const [id, m] of Object.entries(day.matches)) {
      const od = m.opendota;
      if (!od || new Date(m.endedAt || m.startedAt).getTime() < week) continue;
      if (od.status === "pending") scheduleLookup(id, (15 + 10 * n++) * 1000);
      else if (od.status === "ready" && od.parse && od.parse.status === "pending") scheduleParse(id, (15 + 10 * n++) * 1000);
    }
  }
}

// ---------------------------------------------------------------- insights
const REPORT_FILE = path.join(DIR, "report.json");
const WEEKLY_FILE = path.join(DIR, "weekly.json");
// Minutes after the scoreboard arrives to check whether the replay is parsed.
const PARSE_MINUTES = [0.5, 2, 5, 10, 20, 40, 90];
const parseTimers = new Map();
let report = null;
try {
  report = JSON.parse(fs.readFileSync(REPORT_FILE, "utf8"));
} catch (e) {}
let reportBusy = false;

const label = (n) => (opendota && opendota.heroLabels()[n]) || (n ? n.replace("npc_dota_hero_", "").replace(/_/g, " ") : "unknown hero");

function myAccountId() {
  if (CONFIG.accountId) return Number(CONFIG.accountId);
  for (const day of [state].concat(loadHistory())) {
    for (const m of Object.values(day.matches)) {
      const d = m.details || {};
      const id = Number(d.accountid) || accountIdFromSteamId(d.steamid);
      if (id) return id;
    }
  }
  return null;
}

function buildTilt(match) {
  return insights.tiltCheck({ details: match.details, opendota: match.opendota, report, label });
}

async function refreshReport(force) {
  const id = myAccountId();
  if (!opendota || !id || reportBusy) return;
  if (!force && report && report.accountId === id && Date.now() - report.at < 3600 * 1000) return;
  reportBusy = true;
  try {
    const rows = await opendota.recentMatches(id);
    report = Object.assign({ at: Date.now(), accountId: id }, insights.heroReport(rows));
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report));
    log(`hero report updated (${report.games} matches)`);
  } catch (e) {
    log(`hero report failed: ${e.message}`);
  } finally {
    reportBusy = false;
  }
}

// Counter-picks for the enemy heroes, a fresh hero report, the tilt check, then replay parsing.
async function afterLookup(id) {
  const first = findMatch(id);
  if (!first) return;
  const od = first.match.opendota;
  const me = od.players.find((p) => p.isMe);
  const myTeam = (me && me.team) || (first.match.details || {}).team;
  const counterMap = {};
  for (const p of od.players) {
    if (p.team === myTeam || !p.hero) continue;
    try {
      counterMap[p.hero] = insights.counters(await opendota.matchups(p.hero));
    } catch (e) {}
  }
  await refreshReport(true);
  const found = findMatch(id);
  if (!found) return;
  found.match.opendota.counters = counterMap;
  if (found.match.result === "loss") found.match.tilt = buildTilt(found.match);
  if (PARSE_REPLAYS) {
    found.match.opendota.parse = { status: "pending", tries: 0 };
    scheduleParse(id, PARSE_MINUTES[0] * 60 * 1000);
  }
  found.commit();
}

function scheduleParse(id, delayMs) {
  if (!opendota || parseTimers.has(id)) return;
  parseTimers.set(id, setTimeout(() => {
    parseTimers.delete(id);
    parseStep(id).catch((e) => log(`replay parse for ${id} failed: ${e.message}`));
  }, delayMs));
}

async function parseStep(id) {
  const before = findMatch(id);
  if (!before || !before.match.opendota || !before.match.opendota.parse) return;
  const job = before.match.opendota.parse;
  let parsed = null;
  let error = null;
  try {
    // Ask once, and again later in case the replay wasn't downloadable the first time.
    if (!job.requested || job.tries === 3) await opendota.requestParse(id);
    parsed = await opendota.fetchParsed(id);
  } catch (e) {
    error = e.message;
  }
  const found = findMatch(id);
  if (!found) return;
  const od = found.match.opendota;
  if (parsed) {
    const me = od.players.find((p) => p.isMe);
    const myTeam = (me && me.team) || (found.match.details || {}).team;
    od.parse = { status: "ready" };
    od.lanes = insights.laneResults(parsed);
    od.lane = me ? insights.yourLane(parsed, me.slot) : null;
    od.swing = insights.goldSwing(parsed.goldAdv, myTeam);
    od.goldAdv = parsed.goldAdv;
    od.myTeam = myTeam;
    if (found.match.result === "loss") {
      found.match.tilt = buildTilt(found.match);
      // A second tilt notice only when the replay found something new and you're not mid-match.
      const fromReplay = (od.lane && od.lane.goldDiff <= -1000) || (od.swing && od.swing.lead.gold >= 5000);
      if (TILT_CHECK && fromReplay && !currentMatch && !state.lockedAt && state.matches[id]) {
        notify("Tilt check", `The replay is in. ${found.match.tilt.headline}`);
      }
    }
    found.commit();
    log(`replay parsed for match ${id}`);
    return;
  }
  const pj = od.parse || job;
  pj.requested = true;
  pj.tries = (pj.tries || 0) + 1;
  pj.error = error || "replay not parsed yet";
  if (pj.tries >= PARSE_MINUTES.length) {
    pj.status = "unavailable";
  } else {
    pj.status = "pending";
    scheduleParse(id, (PARSE_MINUTES[pj.tries] - PARSE_MINUTES[pj.tries - 1]) * 60 * 1000);
  }
  od.parse = pj;
  found.commit();
}

let weeklyState = {};
try {
  weeklyState = JSON.parse(fs.readFileSync(WEEKLY_FILE, "utf8"));
} catch (e) {}

// Once a week (the first time the computer is on after the week ends), sum up the last one.
function maybeWeeklyNotice() {
  if (!WEEKLY_SUMMARY) return;
  const lastWeek = insights.addDays(insights.weekStartOf(state.day), -7);
  if (weeklyState.week === lastWeek) return;
  weeklyState = { week: lastWeek };
  try {
    fs.writeFileSync(WEEKLY_FILE, JSON.stringify(weeklyState));
  } catch (e) {}
  const w = insights.weekly([state].concat(loadHistory()), lastWeek);
  if (!w.games) return;
  const best = w.best ? ` Best hero: ${label(w.best.hero)}.` : "";
  const stopped = w.limitDays ? ` The limit stopped you on ${w.limitDays} day${w.limitDays === 1 ? "" : "s"}.` : "";
  notify("Weekly summary", `Last week: ${w.wins}-${w.losses}.${best}${stopped} Details at ${statsUrl}#weekly`);
}

function status() {
  return {
    ...state,
    ...tally(),
    limitReached: limitReached(),
    mode: CONFIG.mode,
    maxGames: CONFIG.maxGames,
    resetHour: CONFIG.resetHour,
    dotaEnabled: DOTA_ENABLED,
    currentMatch,
    heroLabels: opendota ? opendota.heroLabels() : {},
  };
}

// Stats site, reached through the hosts entry "dota-limiter-stats".
const statsServer = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    res.setHeader("cache-control", "no-store");
    const retry = url.match(/^\/api\/lookup\/(\d+)$/);
    if (retry && req.method === "POST") {
      const found = findMatch(retry[1]);
      if (!found || !opendota) {
        res.writeHead(404);
        return res.end();
      }
      found.match.opendota = { status: "pending", tries: 0 };
      found.commit();
      clearTimeout(lookupTimers.get(retry[1]));
      lookupTimers.delete(retry[1]);
      scheduleLookup(retry[1], 0);
      res.writeHead(202);
      return res.end();
    }
    if (url === "/api") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ today: status(), history: loadHistory() }));
    }
    const json = (body) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (url === "/api/report") {
      refreshReport(false);
      return json({ status: !opendota ? "off" : !myAccountId() ? "no-account" : report ? "ready" : "pending", report });
    }
    if (url === "/api/weekly") {
      const days = [state].concat(loadHistory());
      const asked = new URL(req.url, "http://x").searchParams.get("start");
      const start = /^\d{4}-\d{2}-\d{2}$/.test(asked || "") ? insights.weekStartOf(asked) : insights.weekStartOf(state.day);
      const earliest = days.map((d) => d.day).sort()[0] || state.day;
      return json(Object.assign(insights.weekly(days, start), { thisWeek: insights.weekStartOf(state.day), firstWeek: insights.weekStartOf(earliest) }));
    }
    const counterAsk = url.match(/^\/api\/counters\/(npc_dota_hero_[a-z_]+)$/);
    if (counterAsk) {
      const hero = counterAsk[1];
      if (!opendota) return json({ hero, status: "off" });
      (async () => {
        const list = insights.counters(await opendota.matchups(hero));
        const id = myAccountId();
        const mine = id ? await opendota.myHeroes(id) : {};
        json({ hero, status: "ready", counters: list, you: mine[hero] || null, yourPicks: insights.yourCounters(list, report) });
      })().catch((e) => json({ hero, status: "error", error: e.message }));
      return;
    }
    if (req.headers.host && !req.headers.host.startsWith(STATS_HOST)) {
      res.writeHead(302, { location: statsUrl });
      return res.end();
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    fs.createReadStream(STATS_PAGE).pipe(res);
  });

function listenStats(port) {
  statsServer
    .once("error", (e) => {
      if (port === 80) {
        log(`port 80 unavailable (${e.code}), using ${STATS_FALLBACK_PORT}`);
        return listenStats(STATS_FALLBACK_PORT);
      }
      log(`stats page unavailable: ${e.message}`);
    })
    .listen(port, "127.0.0.1", () => {
      statsUrl = port === 80 ? `http://${STATS_HOST}/` : `http://${STATS_HOST}:${port}/`;
      fs.writeFileSync(path.join(DIR, "stats-url.txt"), statsUrl);
      log(`stats page on ${statsUrl}`);
    });
}
listenStats(80);

// Game State Integration endpoint. Dota POSTs here; GET /notices feeds notifier.js.
http
  .createServer((req, res) => {
    if (req.method === "POST") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        try {
          onGameState(JSON.parse(data));
        } catch (e) {
          log(`bad payload: ${e.message}`);
        }
        res.end("ok");
      });
    } else if (req.url.startsWith("/notices")) {
      const after = Number(new URL(req.url, "http://x").searchParams.get("after")) || 0;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(notices.filter((n) => n.id > after)));
    } else {
      res.writeHead(302, { location: statsUrl });
      res.end();
    }
  })
  .on("error", (e) => {
    log(`GSI port ${CONFIG.port} unavailable: ${e.message}`);
    process.exit(1);
  })
  .listen(CONFIG.port, "127.0.0.1", () => log(`listening on ${CONFIG.port}`));

if (DOTA_ENABLED) ensureGsiConfig();
if (DOTA_ENABLED) resumeLookups();
if (DOTA_ENABLED && opendota) setTimeout(() => refreshReport(false), 20 * 1000);
setInterval(tick, 5000);
tick();
