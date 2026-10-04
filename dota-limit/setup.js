// Install-time helper, called by install.sh / install.ps1.
//
//   node setup.js detect [port]           (run as the Steam user)
//     Finds Dota 2, writes its Game State Integration file and adds the
//     -gamestateintegration launch option. Prints what it found as JSON.
//
//   node setup.js write-config <file> <user>   (run as root/admin)
//     Reads the detect output from FG_DETECTED and the installer's answers from
//     FG_CHOICES (both JSON), and keeps any settings you changed by hand.
//     Writes config.json, keeping any settings you changed on a reinstall.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const vdf = require("./vdf");
const { gsiPath, gsiConfig } = require("./gsi");

const LAUNCH_FLAG = "-gamestateintegration";
const DOTA_APP_ID = "570";

const DEFAULTS = {
  mode: "bo3",
  maxGames: 3,
  weekendMode: "same",
  weekendMaxGames: 7,
  resetHour: 4,
  postGameGraceSeconds: 90,
  port: 43210,
  requireReports: false,
  dotaEnabled: true,
  blockSafari: false,
  blockAdult: false,
  opendota: true,
  tiltCheck: true,
  parseReplays: true,
  weeklySummary: true,
};

// Installer answers that map straight onto config.json.
const CHOICE_KEYS = ["dotaEnabled", "mode", "maxGames", "weekendMode", "weekendMaxGames", "resetHour", "blockSafari", "blockAdult", "opendota", "tiltCheck"];

function windowsSteamPath() {
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"], { windowsHide: true }).toString();
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/);
    return m ? m[1].trim() : null;
  } catch (e) {
    return null;
  }
}

function steamRoots() {
  const home = os.homedir();
  let candidates;
  if (process.platform === "win32") {
    candidates = [windowsSteamPath(), "C:\\Program Files (x86)\\Steam", "C:\\Program Files\\Steam"];
  } else if (process.platform === "darwin") {
    candidates = [path.join(home, "Library/Application Support/Steam")];
  } else {
    candidates = [
      path.join(home, ".steam/steam"),
      path.join(home, ".local/share/Steam"),
      path.join(home, ".var/app/com.valvesoftware.Steam/.local/share/Steam"),
      path.join(home, "snap/steam/common/.local/share/Steam"),
    ];
  }
  const roots = [];
  for (const c of candidates) {
    if (!c || !fs.existsSync(c)) continue;
    const real = fs.realpathSync(c);
    if (!roots.includes(real)) roots.push(real);
  }
  return roots;
}

function libraries(root) {
  const libs = [root];
  for (const file of ["steamapps/libraryfolders.vdf", "config/libraryfolders.vdf"]) {
    const f = path.join(root, file);
    if (!fs.existsSync(f)) continue;
    const walk = (entries) => {
      for (const [k, v] of entries) {
        if (Array.isArray(v)) walk(v);
        else if (k.toLowerCase() === "path") libs.push(v.replace(/\\\\/g, "\\"));
      }
    };
    walk(vdf.parse(fs.readFileSync(f, "utf8")));
  }
  return [...new Set(libs)];
}

function findDota(roots) {
  if (process.env.DOTA_DIR) return process.env.DOTA_DIR;
  for (const root of roots) {
    for (const lib of libraries(root)) {
      const dir = path.join(lib, "steamapps", "common", "dota 2 beta");
      if (fs.existsSync(dir)) return dir;
    }
  }
  return null;
}

// Adds -gamestateintegration to Dota's launch options for every Steam account on
// this machine. Steam must be closed, or it overwrites the file on exit.
function patchLaunchOptions(root) {
  const patched = [];
  const userdata = path.join(root, "userdata");
  if (!fs.existsSync(userdata)) return patched;
  for (const id of fs.readdirSync(userdata)) {
    const file = path.join(userdata, id, "config", "localconfig.vdf");
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const tree = vdf.parse(text);
    let node = tree;
    for (const key of ["UserLocalConfigStore", "Software", "Valve", "Steam", "apps", DOTA_APP_ID]) {
      node = vdf.ensureObject(node, key);
    }
    const opt = vdf.find(node, "LaunchOptions");
    if (opt && opt[1].includes(LAUNCH_FLAG)) continue;
    if (opt) opt[1] = `${opt[1]} ${LAUNCH_FLAG}`.trim();
    else node.push(["LaunchOptions", LAUNCH_FLAG]);
    fs.writeFileSync(`${file}.focus-guard.bak`, text);
    fs.writeFileSync(file, vdf.stringify(tree));
    patched.push(id);
  }
  return patched;
}

// Your Dota account ID: the account Steam signed in with most recently.
function steamAccountId(roots) {
  let best = null;
  for (const root of roots) {
    const file = path.join(root, "config", "loginusers.vdf");
    if (!fs.existsSync(file)) continue;
    const users = vdf.find(vdf.parse(fs.readFileSync(file, "utf8")), "users");
    if (!users || !Array.isArray(users[1])) continue;
    for (const [steamid, fields] of users[1]) {
      if (!Array.isArray(fields)) continue;
      const get = (k) => (vdf.find(fields, k) || [])[1];
      const score = (get("MostRecent") === "1" ? 1e12 : 0) + Number(get("Timestamp") || 0);
      if (!best || score > best.score) best = { steamid, score };
    }
  }
  if (!best) return null;
  try {
    const id = BigInt(best.steamid) - BigInt("76561197960265728");
    return id > BigInt(0) ? Number(id) : null;
  } catch (e) {
    return null;
  }
}

function detect(port) {
  const roots = steamRoots();
  const dotaDir = findDota(roots);
  const result = { steamRoots: roots, dotaDir, accountId: steamAccountId(roots), gsiWritten: false, launchOptionsPatched: [] };
  if (dotaDir) {
    const file = gsiPath(dotaDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, gsiConfig(port));
    result.gsiWritten = true;
  }
  // Skipped when you chose to keep Steam open, since Steam would overwrite the change.
  if (!process.env.FG_NO_LAUNCH_OPTIONS) {
    for (const root of roots) result.launchOptionsPatched.push(...patchLaunchOptions(root));
  }
  return result;
}

function writeConfig(file, user, detected, choices) {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {}
  const picked = {};
  for (const k of CHOICE_KEYS) if (choices[k] !== undefined) picked[k] = choices[k];
  const config = Object.assign({}, DEFAULTS, existing, picked, { user });
  if (detected.dotaDir) config.dotaDir = detected.dotaDir;
  if (detected.accountId) config.accountId = detected.accountId;
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return config;
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "detect") {
  console.log(JSON.stringify(detect(Number(args[0]) || DEFAULTS.port)));
} else if (cmd === "write-config") {
  const json = (v) => JSON.parse(v || "{}");
  console.log(JSON.stringify(writeConfig(args[0], args[1], json(process.env.FG_DETECTED), json(process.env.FG_CHOICES))));
} else {
  console.error("usage: node setup.js detect [port] | write-config <file> <user>");
  process.exit(1);
}
