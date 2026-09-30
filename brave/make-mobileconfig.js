// Builds the macOS configuration profile that applies brave/policy.json to Brave.
// Fixed UUIDs, so reinstalling replaces the profile instead of adding a second one.
const fs = require("fs");
const path = require("path");

const policy = JSON.parse(fs.readFileSync(path.join(__dirname, "policy.json"), "utf8"));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const array = (key) => `      <key>${key}</key>\n      <array>\n${policy[key].map((u) => `        <string>${esc(u)}</string>`).join("\n")}\n      </array>`;

process.stdout.write(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key><string>com.brave.Browser</string>
      <key>PayloadIdentifier</key><string>local.focusguard.brave.policy</string>
      <key>PayloadUUID</key><string>6F1C2B4E-2D0A-4B39-9E5B-7A3C1F0E8D21</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadDisplayName</key><string>Brave URL Blocklist</string>
${array("URLBlocklist")}
${array("URLAllowlist")}
    </dict>
  </array>
  <key>PayloadDisplayName</key><string>Focus Guard (Brave)</string>
  <key>PayloadIdentifier</key><string>local.focusguard.brave</string>
  <key>PayloadUUID</key><string>B8E4D1A7-5C2F-4E6B-8A90-3D7F2C1B6E54</string>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadScope</key><string>System</string>
</dict>
</plist>
`);
