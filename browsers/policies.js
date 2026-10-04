// Turns sites.json into each browser's policy format. Used by install.sh and install.ps1.
// <sites> is 1 to block the sites in sites.json. <adult> is 1 for the "block adult websites"
// option: SafeSearch, and the browser's own secure DNS turned off so it can't skip the
// family filter that dns.js sets up. Adult settings go to every browser, picked or not.
//
//   node policies.js chromium <browser> <sites> <adult>    Brave / Chrome / Chromium / Edge policy JSON
//   node policies.js firefox <sites> <adult>               Firefox policies
//   node policies.js firefox-merge <file> <sites> <adult>  Firefox policies.json with ours added or removed
//   node policies.js mobileconfig <browsers> <adult>       macOS profile; <browsers> is the comma-separated list to block sites in
//   node policies.js profile-id <browsers> <adult>         identifier of that profile (changes when its content does)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const sites = JSON.parse(fs.readFileSync(path.join(__dirname, "sites.json"), "utf8"));

function chromium(browser, block, adult) {
  const p = {};
  if (block) {
    p.URLBlocklist = sites.block;
    p.URLAllowlist = sites.allow;
  }
  if (adult) {
    p.DnsOverHttpsMode = "off";
    p.ForceGoogleSafeSearch = true;
    p.ForceYouTubeRestrict = 1; // moderate
    if (browser === "edge") p.ForceBingSafeSearch = 2; // strict
  }
  return p;
}

// "facebook.com" -> "*://*.facebook.com/*"; "facebook.com/messages" -> "*://*.facebook.com/messages*"
// ("*." also matches the bare domain in Firefox match patterns.)
function firefox(block, adult) {
  const pattern = (entry) => {
    const [host, ...rest] = entry.split("/");
    const p = rest.length ? `/${rest.join("/")}*` : "/*";
    return `*://*.${host}${p}`;
  };
  const p = {};
  if (block) p.WebsiteFilter = { Block: sites.block.map(pattern), Exceptions: sites.allow.map(pattern) };
  if (adult) p.DNSOverHTTPS = { Enabled: false, Locked: true };
  return p;
}

const OURS = ["WebsiteFilter", "DNSOverHTTPS"];

function firefoxMerge(file, block, adult) {
  let doc = { policies: {} };
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {}
  doc.policies = doc.policies || {};
  for (const k of OURS) delete doc.policies[k];
  Object.assign(doc.policies, firefox(block, adult));
  return doc;
}

const PAYLOAD_TYPES = {
  brave: "com.brave.Browser",
  chrome: "com.google.Chrome",
  edge: "com.microsoft.Edge",
  firefox: "org.mozilla.firefox",
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
function uuid(seed) {
  const h = crypto.createHash("sha1").update(seed).digest("hex").toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Policy values as plist XML: lists, true/false, numbers, text, and nested dicts.
function plistValue(v, indent) {
  if (Array.isArray(v)) return `${indent}<array>\n${v.map((u) => `${indent}  <string>${esc(u)}</string>`).join("\n")}\n${indent}</array>`;
  if (typeof v === "boolean") return `${indent}<${v}/>`;
  if (typeof v === "number") return `${indent}<integer>${v}</integer>`;
  if (typeof v === "object") return `${indent}<dict>\n${plistDict(v, indent + "  ")}\n${indent}</dict>`;
  return `${indent}<string>${esc(v)}</string>`;
}
const plistDict = (obj, indent) => Object.keys(obj).map((k) => `${indent}<key>${k}</key>\n${plistValue(obj[k], indent)}`).join("\n");

function payload(browser, policy) {
  const type = PAYLOAD_TYPES[browser];
  const body = browser === "firefox" ? Object.assign({ EnterprisePoliciesEnabled: true }, policy) : policy;
  return `    <dict>
      <key>PayloadType</key><string>${type}</string>
      <key>PayloadIdentifier</key><string>local.focusguard.browsers.${browser}</string>
      <key>PayloadUUID</key><string>${uuid("payload:" + browser)}</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadDisplayName</key><string>Focus Guard: ${browser}</string>
${plistDict(body, "      ")}
    </dict>`;
}

// Each browser's policies, leaving out browsers with nothing to set.
function policies(browsers, adult) {
  return Object.keys(PAYLOAD_TYPES)
    .map((b) => ({ b, p: b === "firefox" ? firefox(browsers.includes(b), adult) : chromium(b, browsers.includes(b), adult) }))
    .filter((x) => Object.keys(x.p).length);
}

function list(arg) {
  return (arg || "").split(",").filter((b) => PAYLOAD_TYPES[b]);
}

function profileId(browsers, adult) {
  // Without the adult option, the same hash as before it existed, so updating doesn't ask to approve the profile again.
  const seed = adult ? policies(browsers, adult) : [browsers, sites];
  const hash = crypto.createHash("sha1").update(JSON.stringify(seed)).digest("hex").slice(0, 8);
  return `local.focusguard.browsers.${hash}`;
}

function mobileconfig(browsers, adult) {
  const id = profileId(browsers, adult);
  const what = [];
  if (browsers.length) what.push(`Blocks ${sites.block.join(", ")} in ${browsers.join(", ")}.`);
  if (adult) what.push("Turns on SafeSearch and turns off browser secure DNS, for the adult website block.");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
${policies(browsers, adult).map((x) => payload(x.b, x.p)).join("\n")}
  </array>
  <key>PayloadDisplayName</key><string>Focus Guard (website blocker)</string>
  <key>PayloadDescription</key><string>${esc(what.join(" "))}</string>
  <key>PayloadIdentifier</key><string>${id}</string>
  <key>PayloadUUID</key><string>${uuid(id)}</string>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadScope</key><string>System</string>
</dict>
</plist>
`;
}

const [cmd, a, b, c] = process.argv.slice(2);
const out = {
  chromium: () => JSON.stringify(chromium(a, b === "1", c === "1"), null, 2),
  firefox: () => JSON.stringify(firefox(a === "1", b === "1"), null, 2),
  "firefox-merge": () => JSON.stringify(firefoxMerge(a, b === "1", c === "1"), null, 2),
  mobileconfig: () => mobileconfig(list(a), b === "1"),
  "profile-id": () => profileId(list(a), b === "1"),
}[cmd];
if (!out) {
  console.error("usage: node policies.js chromium <browser> <0|1> <0|1> | firefox <0|1> <0|1> | firefox-merge <file> <0|1> <0|1> | mobileconfig <list> <0|1> | profile-id <list> <0|1>");
  process.exit(1);
}
process.stdout.write(out() + "\n");
