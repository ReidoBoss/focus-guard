// CI only: checks the installed service end to end. Plays a fake 2-0 series over
// Game State Integration and expects Steam to be locked afterwards.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const fake = JSON.parse(fs.readFileSync(path.join(__dirname, ".fake.json"), "utf8"));
const IS_WIN = process.platform === "win32";
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
const api = async () => JSON.parse((await request("http://dota-limiter-stats/api")).body);

async function waitFor(what, fn, seconds) {
  for (let i = 0; i < seconds; i++) {
    try {
      if (await fn()) return console.log(`ok: ${what}`);
    } catch (e) {}
    await sleep(1000);
  }
  throw new Error(`timed out: ${what}`);
}

// A copy of node under a Steam or Dota process name, so the service sees a "real" one.
function fakeProcess(file, args = []) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(process.execPath, file);
  fs.chmodSync(file, 0o755);
  const child = spawn(file, ["-e", "setTimeout(() => {}, 600000)", ...args], { stdio: "ignore" });
  child.exitedAt = null;
  child.on("exit", () => (child.exitedAt = Date.now()));
  return child;
}

function check(what, cond) {
  if (!cond) throw new Error(`failed: ${what}`);
  console.log(`ok: ${what}`);
}

const gsi = (matchid, game_state, win_team) => ({
  map: { matchid, game_state, win_team, clock_time: 1800, radiant_score: 30, dire_score: 12 },
  player: { team_name: "radiant", kills: 10, deaths: 1, assists: 12, last_hits: 250, denies: 9, gpm: 650, xpm: 720 },
  hero: { name: "npc_dota_hero_juggernaut", level: 24 },
  items: { slot0: { name: "item_phase_boots" }, slot1: { name: "empty" } },
});

(async () => {
  await waitFor("stats page answers on http://dota-limiter-stats", async () => (await request("http://dota-limiter-stats/")).body.includes("Dota Limiter"), 30);

  const cfg = path.join(fake.dotaDir, "game", "dota", "cfg", "gamestate_integration", "gamestate_integration_dotalimit.cfg");
  check("GSI config written", fs.existsSync(cfg) && fs.readFileSync(cfg, "utf8").includes('"uri"       "http://127.0.0.1:43210/"'));
  const lc = (id) => fs.readFileSync(path.join(fake.root, "userdata", id, "config", "localconfig.vdf"), "utf8");
  check("launch option appended to existing options", lc("111").includes('"LaunchOptions"\t\t"-novid -gamestateintegration"'));
  check("launch option added for account without Dota settings", lc("222").includes('"LaunchOptions"\t\t"-gamestateintegration"'));

  const old = await request("http://127.0.0.1:43210/");
  check("old address redirects to stats page", old.status === 302 && old.headers.location === "http://dota-limiter-stats/");

  const dotaExe = IS_WIN
    ? path.join(os.tmpdir(), "fg-dota", "dota2.exe")
    : path.join(os.tmpdir(), "fg-dota", "dota 2 beta", "game", "bin", "linuxsteamrt64", "dota2");
  const dota = fakeProcess(dotaExe);
  await waitFor("Dota without -gamestateintegration gets closed", () => dota.exitedAt, 30);

  for (const id of ["9000000001", "9000000002"]) {
    await request("http://127.0.0.1:43210/", gsi(id, "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"));
    await request("http://127.0.0.1:43210/", gsi(id, "DOTA_GAMERULES_STATE_POST_GAME", "radiant"));
  }
  await request("http://127.0.0.1:43210/", { provider: { name: "Dota 2" } });

  const today = (await api()).today;
  check("two wins recorded", today.wins === 2 && today.losses === 0 && today.limitReached);
  const d = today.matches["9000000001"].details;
  check("match details saved", d.hero === "npc_dota_hero_juggernaut" && d.kills === 10 && d.items[0] === "item_phase_boots");
  await waitFor("Steam gets locked after 2-0", async () => (await api()).today.lockedAt, 20);

  const steam = fakeProcess(path.join(os.tmpdir(), "fg-steam", IS_WIN ? "steam.exe" : process.platform === "darwin" ? "steam_osx" : "steam"));
  await waitFor("Steam gets closed while locked", () => steam.exitedAt, 30);

  const notices = JSON.parse((await request("http://127.0.0.1:43210/notices?after=0")).body);
  check("notifications queued", notices.some((n) => n.msg.includes("locked until tomorrow")));
  console.log("\nall checks passed");
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
