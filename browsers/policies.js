// Turns sites.json into each browser's policy format. Used by install.sh and install.ps1.
//
//   node policies.js chromium                   Brave / Chrome / Chromium / Edge policy JSON
//   node policies.js firefox                    Firefox WebsiteFilter { Block, Exceptions }
//   node policies.js firefox-merge <file> <on>  Firefox policies.json with our filter added (on=1) or removed (on=0)
//   node policies.js mobileconfig <browsers>    macOS profile for a comma-separated browser list
//   node policies.js profile-id <browsers>      identifier of that profile (changes when its content does)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const sites = JSON.parse(fs.readFileSync(path.join(__dirname, "sites.json"), "utf8"));

const chromium = () => ({ URLBlocklist: sites.block, URLAllowlist: sites.allow });

// "facebook.com" -> "*://*.facebook.com/*"; "facebook.com/messages" -> "*://*.facebook.com/messages*"
// ("*." also matches the bare domain in Firefox match patterns.)
function firefox() {
  const pattern = (entry) => {
    const [host, ...rest] = entry.split("/");
    const p = rest.length ? `/${rest.join("/")}*` : "/*";
    return `*://*.${host}${p}`;
  };
  return { Block: sites.block.map(pattern), Exceptions: sites.allow.map(pattern) };
}

function firefoxMerge(file, on) {
  let doc = { policies: {} };
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {}
  doc.policies = doc.policies || {};
  if (on) doc.policies.WebsiteFilter = firefox();
  else delete doc.policies.WebsiteFilter;
  return doc;
}

const PAYLOAD_TYPES = {
  brave: "com.brave.Browser",
  chrome: "com.google.Chrome",
  edge: "com.microsoft.Edge",
  firefox: "org.mozilla.firefox",
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const plistArray = (items, indent) =>
  `${indent}<array>\n${items.map((u) => `${indent}  <string>${esc(u)}</string>`).join("\n")}\n${indent}</array>`;

function uuid(seed) {
  const h = crypto.createHash("sha1").update(seed).digest("hex").toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function payload(browser) {
  const type = PAYLOAD_TYPES[browser];
  const body =
    browser === "firefox"
      ? `      <key>EnterprisePoliciesEnabled</key><true/>
      <key>WebsiteFilter</key>
      <dict>
        <key>Block</key>
${plistArray(firefox().Block, "        ")}
        <key>Exceptions</key>
${plistArray(firefox().Exceptions, "        ")}
      </dict>`
      : `      <key>URLBlocklist</key>
${plistArray(sites.block, "      ")}
      <key>URLAllowlist</key>
${plistArray(sites.allow, "      ")}`;
  return `    <dict>
      <key>PayloadType</key><string>${type}</string>
      <key>PayloadIdentifier</key><string>local.focusguard.browsers.${browser}</string>
      <key>PayloadUUID</key><string>${uuid("payload:" + browser)}</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadDisplayName</key><string>Focus Guard: ${browser}</string>
${body}
    </dict>`;
}

function list(arg) {
  return (arg || "").split(",").filter((b) => PAYLOAD_TYPES[b]);
}

function profileId(browsers) {
  const hash = crypto.createHash("sha1").update(JSON.stringify([browsers, sites])).digest("hex").slice(0, 8);
  return `local.focusguard.browsers.${hash}`;
}

function mobileconfig(browsers) {
  const id = profileId(browsers);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
${browsers.map(payload).join("\n")}
  </array>
  <key>PayloadDisplayName</key><string>Focus Guard (website blocker)</string>
  <key>PayloadDescription</key><string>Blocks ${esc(sites.block.join(", "))} in ${esc(browsers.join(", "))}.</string>
  <key>PayloadIdentifier</key><string>${id}</string>
  <key>PayloadUUID</key><string>${uuid(id)}</string>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadScope</key><string>System</string>
</dict>
</plist>
`;
}

const [cmd, a, b] = process.argv.slice(2);
const out = {
  chromium: () => JSON.stringify(chromium(), null, 2),
  firefox: () => JSON.stringify(firefox(), null, 2),
  "firefox-merge": () => JSON.stringify(firefoxMerge(a, b === "1"), null, 2),
  mobileconfig: () => mobileconfig(list(a)),
  "profile-id": () => profileId(list(a)),
}[cmd];
if (!out) {
  console.error("usage: node policies.js chromium | firefox | firefox-merge <file> <0|1> | mobileconfig <list> | profile-id <list>");
  process.exit(1);
}
process.stdout.write(out() + "\n");
