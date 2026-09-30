// CI only: builds a fake Steam install (with Dota in a second library folder and two
// Steam accounts) so the installer has something real-looking to detect and patch.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const home = os.homedir();
let root;
if (process.platform === "win32") {
  root = "C:\\FakeSteam";
  execFileSync("reg", ["add", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath", "/t", "REG_SZ", "/d", "c:/fakesteam", "/f"]);
} else if (process.platform === "darwin") {
  root = path.join(home, "Library/Application Support/Steam");
} else {
  root = path.join(home, ".local/share/Steam");
}
const library = path.join(path.dirname(root), "SteamLibrary");
const dotaDir = path.join(library, "steamapps", "common", "dota 2 beta");
const esc = (p) => p.replace(/\\/g, "\\\\");

fs.mkdirSync(path.join(root, "steamapps"), { recursive: true });
fs.mkdirSync(path.join(dotaDir, "game", "dota", "cfg"), { recursive: true });
fs.writeFileSync(
  path.join(root, "steamapps", "libraryfolders.vdf"),
  `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${esc(root)}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${esc(library)}"\n\t\t"apps"\n\t\t{\n\t\t\t"570"\t\t"1"\n\t\t}\n\t}\n}\n`
);

const account = (id, apps) => {
  const dir = path.join(root, "userdata", id, "config");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "localconfig.vdf"),
    `"UserLocalConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"apps"\n\t\t\t\t{\n${apps}\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n`
  );
};
// One account already has launch options, the other has never opened Dota.
account("111", `\t\t\t\t\t"570"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LaunchOptions"\t\t"-novid"\n\t\t\t\t\t}\n`);
account("222", "");

fs.writeFileSync(path.join(__dirname, ".fake.json"), JSON.stringify({ root, library, dotaDir }, null, 2));
console.log(`fake Steam at ${root}, Dota at ${dotaDir}`);
