// Offline test for install.sh. "sudo bash -c "$(curl ...)"" puts the whole script on the
// command lines of sudo and bash, so nothing that closes Steam or Dota by command line may
// match the script's own text, or the installer kills itself.
// Run: node test/install.test.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const script = fs.readFileSync(path.join(ROOT, "install.sh"), "utf8");
const daemon = fs.readFileSync(path.join(ROOT, "dota-limit", "daemon.js"), "utf8");

// The command lines the daemon reads from ps. Linux shows the script's newlines as spaces;
// macOS might show them as they are, which splits the script into one line per line.
const asOneLine = "sudo bash -c " + script.replace(/\n/g, " ");
const asLines = ("sudo bash -c " + script).split("\n");

// The daemon's matchers, taken from its source since it runs on load.
const names = ["isDota", "isSteam", "isSafari"];
const sources = names.map((n) => {
  const m = daemon.match(new RegExp("function " + n + "\\(cmd\\) \\{[\\s\\S]*?\\n\\}"));
  assert.ok(m, n + " found in daemon.js");
  return m[0];
});
for (const [os, IS_WIN, IS_MAC] of [["Linux", false, false], ["macOS", false, true]]) {
  const fns = new Function("IS_WIN", "IS_MAC", sources.join("\n") + "\nreturn { " + names.join(", ") + " };")(IS_WIN, IS_MAC);
  for (const n of names) {
    assert.ok(!fns[n](asOneLine), `${n} on ${os} matches the installer's command line`);
    const hit = asLines.find((l) => fns[n](l.trim()));
    assert.ok(!hit, `${n} on ${os} matches this line of install.sh: ${hit}`);
  }
}
// And they still match the real thing, so the check above isn't passing by accident.
const linux = new Function("IS_WIN", "IS_MAC", sources.join("\n") + "\nreturn { isDota, isSteam };")(false, false);
assert.ok(linux.isDota("/home/me/.steam/steamapps/common/dota 2 beta/game/bin/linuxsteamrt64/dota2 -gamestateintegration"));
assert.ok(linux.isSteam("/home/me/.steam/steam/ubuntu12_32/steam -silent"));
console.log("ok: daemon's process matchers skip the installer");

// install.sh's own "pkill -f" patterns (extended regexes, close enough to JS here).
const patterns = [...script.matchAll(/pkill [^\n]*?-f "([^"]+)"/g)].map((m) => m[1]);
assert.ok(patterns.length > 0, "found the pkill -f lines");
for (const p of patterns) {
  const re = new RegExp(p);
  assert.ok(!re.test(asOneLine) && !asLines.some((l) => re.test(l)), `pkill -f "${p}" matches install.sh itself`);
}
assert.ok(new RegExp(patterns[0]).test("/x/steamapps/common/dota 2 beta/game/bin/linuxsteamrt64/dota2"), "pkill pattern still matches Dota");
console.log("ok: install.sh's pkill -f patterns skip the installer");
