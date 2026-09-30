# Focus Guard

[![test](https://github.com/ReidoBoss/focus-guard/actions/workflows/test.yml/badge.svg)](https://github.com/ReidoBoss/focus-guard/actions/workflows/test.yml)

Two self-control tools for people who want to get better at life:

- **Dota Limit**: one best-of-3 Dota 2 series per day. When the series is decided (2-0, 0-2, or after game 3), Steam is closed and stays closed until 4 AM. Comes with a stats page at **http://dota-limiter-stats**.
- **Website blocker**: blocks Facebook, YouTube and Reddit, except **facebook.com/messages**, in Brave, Chrome, Edge, Firefox and Chromium. On macOS it can also stop Safari from opening.

Works on **macOS**, **Ubuntu / Debian** and **Windows 10 / 11**.

## Install

Copy one command, paste it, enter your password, and answer a few questions. Press Enter on any question to take the suggested answer.

### macOS and Ubuntu

Open **Terminal** and run:

```bash
curl -fsSL https://raw.githubusercontent.com/ReidoBoss/focus-guard/main/install.sh | sudo bash
```

### Windows

Right-click the Start button, choose **Terminal (Admin)** or **Windows PowerShell (Admin)**, and run:

```powershell
irm https://raw.githubusercontent.com/ReidoBoss/focus-guard/main/install.ps1 | iex
```

### What it asks

```
1. Dota 2 daily limit
Set up the Dota 2 limit? (y/n) [y]:
When should the day end?
  1) Best of 3: stop at 2 wins or 2 losses
  2) After a fixed number of games
What hour does a new day start? (0-23, so a 2 AM game counts toward the night before) [4]:

2. Website blocker
Supported here: Brave (installed), Google Chrome, Microsoft Edge, Firefox
Block these sites in:
  1) Every supported browser, including ones you install later (recommended)
  2) Only the browsers I pick
  3) None, skip the website blocker
What should happen to Safari?          (macOS only)
  1) Leave Safari alone
  2) Stop Safari from opening

Summary ... Install with these settings? (y/n) [y]:
```

Running the installer again is how you change settings. Your last answers become the suggested ones, and today's games are kept. To skip the questions, add `--yes` (macOS / Ubuntu: `... | sudo bash -s -- --yes`, Windows: `-Yes`).

### What the installer does

1. Installs Node.js if you don't have it (apt on Ubuntu, winget on Windows).
2. Closes Steam (it asks first), finds Dota 2 in any of your Steam libraries, and adds the `-gamestateintegration` launch option for you.
3. Starts a background service that runs on every boot (launchd, systemd, or a Windows scheduled task).
4. Adds `dota-limiter-stats` to your hosts file so the stats page has a real address.
5. Applies the block list to the browsers you picked, as browser policies.

### Browser support

| Browser | macOS | Ubuntu | Windows | Facebook Home button fix |
|---|---|---|---|---|
| Brave | yes | yes | yes | yes, with the extension |
| Google Chrome | yes | yes | yes | yes, with the extension |
| Microsoft Edge | yes | yes | yes | yes, with the extension |
| Chromium | | yes | | yes, with the extension |
| Firefox | yes | yes | yes | no, see below |
| Safari | block Safari entirely, or leave it | | | |

**Safari** has no setting for blocking sites by address, so it can't keep facebook.com/messages open while blocking the rest of Facebook. The installer offers to stop Safari from opening instead, so it can't be used to get around the blocker.

**Firefox** gets the block list, so typing or clicking a link to a blocked site fails. But Firefox only runs extensions signed by Mozilla, so the Home-button fix can't be installed there.

**Ubuntu**: policies work with browsers from `.deb` packages and the Firefox and Chromium snaps. Brave and Chrome from Flatpak ignore them.

### One manual step: the extension

Facebook is a single-page app: clicking **Home** inside Messages changes the page without a real page load, so a block list alone can't catch it. The extension sends you back to `/messages` when that happens. Browsers don't let installers add extensions, so do this once in each browser:

1. Open the extensions page (`brave://extensions`, `chrome://extensions` or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick the folder the installer printed:
   - macOS: `/usr/local/focus-guard/browsers/extension`
   - Ubuntu: `/opt/focus-guard/browsers/extension`
   - Windows: `C:\Program Files\FocusGuard\browsers\extension`
3. Quit the browser fully and open it again.

On macOS there's one more click: the installer opens **System Settings > General > Device Management**. Double-click **Focus Guard (website blocker)**, press **Install**, then press Enter in the installer. macOS doesn't let scripts install profiles silently.

## Stats page

Open **http://dota-limiter-stats** (type the `http://` so Brave doesn't search for it).

- Today's series score and whether Steam is locked
- Every match: hero, win or loss, K/D/A, last hits and denies, GPM, XPM, net worth, items, game length and score, plus OpenDota, Dotabuff and STRATZ links
- History of past days (click a day to see its matches)

## Settings

The easy way is to run the installer again and give different answers. You can also edit `config.json` (you need admin rights), then run the installer with `--yes` (Windows: `-Yes`) to apply it:

| OS | File |
|---|---|
| macOS | `/usr/local/focus-guard/dota-limit/config.json` |
| Ubuntu | `/opt/focus-guard/dota-limit/config.json` |
| Windows | `C:\Program Files\FocusGuard\dota-limit\config.json` |

| Setting | Default | Meaning |
|---|---|---|
| `mode` | `"bo3"` | `"bo3"`: stop at 2 wins or 2 losses. `"games"`: stop after `maxGames` games. |
| `maxGames` | `3` | Games per day when `mode` is `"games"`. |
| `resetHour` | `4` | Hour (0 to 23) when a new day starts. A 2 AM game counts toward the day before. |
| `postGameGraceSeconds` | `90` | Time on the result screen before Steam closes. |
| `dotaEnabled` | `true` | `false` turns the Dota limit off. |
| `blockSafari` | `false` | macOS: `true` closes Safari whenever it opens. |

The blocked and allowed sites are in `browsers/sites.json` (in this repo, or in the install folder).

## How it works

Dota 2 has an official feature, [Game State Integration](https://developer.valvesoftware.com/wiki/Counter-Strike:_Global_Offensive_Game_State_Integration), that sends live match data to a local address. The service counts real online matches (bot games and demo hero don't count) and records the result of each one.

Once the day's series is decided, it closes Steam and Dota and keeps closing them until the reset. It never cuts you off in the middle of a game. You get a notification when your last game starts and when the day is over.

Loopholes it closes:

- **Abandoning or quitting a game**: it still counts.
- **Removing the launch option**: Dota is closed as soon as it starts.
- **Stopping the service or editing the count**: it runs as a system service, so both need your admin password.

## Uninstall

macOS and Ubuntu:

```bash
curl -fsSL https://raw.githubusercontent.com/ReidoBoss/focus-guard/main/install.sh | sudo bash -s -- --uninstall
```

Windows (PowerShell as Administrator):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ReidoBoss/focus-guard/main/install.ps1))) -Uninstall
```

It asks you to confirm first. Then remove the extension from each browser's extensions page. The `-gamestateintegration` launch option is left in place. It's harmless.

## Troubleshooting

- **Games aren't being counted.** Open the stats page during a match. If it doesn't show a live game, run the installer again with Steam closed, then check that Dota's launch options (Steam > Dota 2 > Properties) include `-gamestateintegration`.
- **Dota was installed after Focus Guard.** Run the installer again so it can find Dota.
- **Logs**: `log.txt` next to `config.json`.
- **A browser still loads a blocked site**: fully quit and reopen it. Check `brave://policy`, `chrome://policy`, `edge://policy` or `about:policies` in Firefox to see the block list.

## Limits

This keeps an honest person honest. Anyone with the admin password can uninstall it, and it only covers the computer it's installed on.

## License

MIT
