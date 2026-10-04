// The "block adult websites" option. Points the computer's DNS at Cloudflare for
// Families, which answers 0.0.0.0 for adult and malware sites, in every browser and app.
// Used by install.sh / install.ps1 (as root/admin) and re-checked by the daemon, so a
// new network connection or a hand-made change gets the filter again.
//
//   node dns.js on       use the filter on every network connection
//   node dns.js off      put back the DNS servers each connection had before
//   node dns.js status   JSON: each connection and whether it uses the filter
//
// macOS and Windows keep each connection's previous servers in ../dns-backup.json.
// Linux adds a systemd-resolved drop-in file, and removing it is the whole undo.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SERVERS = ["1.1.1.3", "1.0.0.3", "2606:4700:4700::1113", "2606:4700:4700::1003"];
const BACKUP = path.join(__dirname, "..", "dns-backup.json");
const RESOLVED_FILE = "/etc/systemd/resolved.conf.d/focus-guard.conf";
// "~." sends every lookup to these servers instead of the ones the network hands out.
const RESOLVED_CONF = `# Focus Guard: block adult websites (Cloudflare for Families)\n[Resolve]\nDNS=${SERVERS.join(" ")}\nDomains=~.\n`;

function run(cmd, args, env) {
  try {
    return execFileSync(cmd, args, { windowsHide: true, env: Object.assign({}, process.env, env || {}), maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (e) {
    // The command's own message, not the whole PowerShell script.
    throw new Error(String(e.stderr || "").trim() || `${cmd} failed`);
  }
}
const ps = (script, env) => run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], env);
// Filtered means only our servers, and at least the IPv4 ones (a connection without IPv6 can't take the rest).
// fec0:0:0:ffff::1-3 are placeholders Windows lists when IPv6 has no DNS server; they never answer.
const same = (list) => list.indexOf(SERVERS[0]) !== -1 && list.every((s) => SERVERS.indexOf(s) !== -1 || /^fec0:0:0:ffff::[123]$/i.test(s));

function readBackup() {
  try {
    return JSON.parse(fs.readFileSync(BACKUP, "utf8"));
  } catch (e) {
    return {};
  }
}

// ---------------------------------------------------------------- macOS
// Each network service (Wi-Fi, Ethernet, a USB adapter) has its own DNS list.
// An empty list means "whatever the network hands out".
function macConnections() {
  return run("networksetup", ["-listallnetworkservices"])
    .split("\n")
    .slice(1)
    .map((s) => s.trim())
    .filter((s) => s && s[0] !== "*")
    .map((name) => {
      const out = run("networksetup", ["-getdnsservers", name]);
      const servers = /aren't any/i.test(out) ? [] : out.split("\n").map((s) => s.trim()).filter(Boolean);
      return { id: name, name, servers, saved: servers };
    });
}

function macSet(list) {
  for (const c of list) run("networksetup", ["-setdnsservers", c.id].concat(c.servers.length ? c.servers : ["Empty"]));
  try {
    run("dscacheutil", ["-flushcache"]);
    run("killall", ["-HUP", "mDNSResponder"]);
  } catch (e) {}
}

// ---------------------------------------------------------------- Windows
// "servers" are the ones in use, from the network or typed in. "saved" are only the ones
// typed in by hand (from the registry), since none means automatic.
// An adapter with IPv6 turned off gets the IPv4 servers only.
function winConnections() {
  const out = ps(`
$r = @()
foreach ($a in Get-NetAdapter) {
  $g = $a.InterfaceGuid
  $v4 = (Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$g" -Name NameServer -ErrorAction SilentlyContinue).NameServer
  $v6 = (Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters\\Interfaces\\$g" -Name NameServer -ErrorAction SilentlyContinue).NameServer
  $now = @(Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -ErrorAction SilentlyContinue | ForEach-Object { $_.ServerAddresses })
  $r += [pscustomobject]@{ id = "$g"; index = $a.ifIndex; name = $a.Name; servers = ($now -join " "); saved = "$v4 $v6" }
}
ConvertTo-Json -InputObject @($r) -Compress`).trim();
  const split = (v) => String(v || "").split(/[\s,]+/).filter(Boolean);
  return JSON.parse(out || "[]").map((c) => ({ id: c.id, index: c.index, name: c.name, servers: split(c.servers), saved: split(c.saved) }));
}

// Throws with the reason if any adapter refused the change.
function winSet(list) {
  // Passed through the environment: PowerShell 5 mangles quotes in native arguments.
  ps(
    `
$failed = 0
$list = $env:FG_DNS_SET | ConvertFrom-Json
foreach ($c in $list) {
  try {
    if (@($c.servers).Count) {
      try { Set-DnsClientServerAddress -InterfaceIndex $c.index -ServerAddresses @($c.servers) -ErrorAction Stop }
      catch { Set-DnsClientServerAddress -InterfaceIndex $c.index -ServerAddresses @($c.servers | Where-Object { $_ -notmatch ":" }) -ErrorAction Stop }
    } else {
      Set-DnsClientServerAddress -InterfaceIndex $c.index -ResetServerAddresses -ErrorAction Stop
    }
  } catch {
    [Console]::Error.WriteLine("adapter $($c.index): $_")
    $failed++
  }
}
Clear-DnsClientCache
exit $failed`,
    { FG_DNS_SET: JSON.stringify(list.map((c) => ({ index: c.index, servers: c.servers }))) }
  );
}

// ---------------------------------------------------------------- shared
function connections() {
  if (process.platform === "darwin") return macConnections();
  if (process.platform === "win32") return winConnections();
  return [{ id: "systemd-resolved", name: "systemd-resolved", servers: linuxOn() ? SERVERS.slice() : [] }];
}

function linuxOn() {
  try {
    return fs.readFileSync(RESOLVED_FILE, "utf8") === RESOLVED_CONF;
  } catch (e) {
    return false;
  }
}

function linuxResolved() {
  try {
    run("systemctl", ["is-active", "--quiet", "systemd-resolved"]);
    return true;
  } catch (e) {
    return false;
  }
}

const set = (list) => (process.platform === "darwin" ? macSet(list) : winSet(list));

// Returns the names of the connections it changed (empty when everything was already on).
function on() {
  if (process.platform === "linux") {
    if (linuxOn()) return [];
    if (!linuxResolved()) throw new Error("systemd-resolved isn't running, so DNS can't be set");
    fs.mkdirSync(path.dirname(RESOLVED_FILE), { recursive: true });
    fs.writeFileSync(RESOLVED_FILE, RESOLVED_CONF);
    run("systemctl", ["restart", "systemd-resolved"]);
    return ["systemd-resolved"];
  }
  const backup = readBackup();
  const todo = connections().filter((c) => !same(c.servers));
  if (!todo.length) return [];
  // Only the first time a connection is seen, so a second "on" never saves the filter as the "before".
  for (const c of todo) if (!backup[c.id]) backup[c.id] = { name: c.name, servers: c.saved };
  fs.writeFileSync(BACKUP, JSON.stringify(backup, null, 2) + "\n");
  set(todo.map((c) => Object.assign({}, c, { servers: SERVERS })));
  return todo.map((c) => c.name);
}

function off() {
  if (process.platform === "linux") {
    if (!fs.existsSync(RESOLVED_FILE)) return [];
    fs.unlinkSync(RESOLVED_FILE);
    if (linuxResolved()) run("systemctl", ["restart", "systemd-resolved"]);
    return ["systemd-resolved"];
  }
  const backup = readBackup();
  // Connections without a backup but with the filter set go back to automatic.
  const todo = connections()
    .filter((c) => backup[c.id] || same(c.servers))
    .map((c) => Object.assign({}, c, { servers: backup[c.id] ? backup[c.id].servers : [] }));
  if (todo.length) set(todo);
  try {
    fs.unlinkSync(BACKUP);
  } catch (e) {}
  return todo.map((c) => c.name);
}

function status() {
  return connections().map((c) => ({ name: c.name, filtered: same(c.servers), servers: c.servers }));
}

module.exports = { on, off, status, SERVERS };

if (require.main === module) {
  const cmd = process.argv[2];
  const fn = { on, off, status }[cmd];
  if (!fn) {
    console.error("usage: node dns.js on | off | status");
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(fn()));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
