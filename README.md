# Focus Guard

[![test](https://github.com/ReidoBoss/focus-guard/actions/workflows/test.yml/badge.svg)](https://github.com/ReidoBoss/focus-guard/actions/workflows/test.yml)

Two self-control tools for people who want to get better at life:

- **Dota Limit**: one best-of-3 Dota 2 series per day. When the series is decided (2-0, 0-2, or after game 3), Steam is closed and stays closed until 4 AM. Comes with a stats page at **http://dota-limiter-stats**.
- **Brave blocker**: blocks Facebook, YouTube and Reddit in Brave, except **facebook.com/messages**.

Works on **macOS**, **Ubuntu / Debian** and **Windows 10 / 11**.

## Install

Copy one command, paste it, enter your password. That's it.

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

### What the installer does

1. Installs Node.js if you don't have it (apt on Ubuntu, winget on Windows).
2. Closes Steam, finds Dota 2 in any of your Steam libraries, and adds the `-gamestateintegration` launch option for you.
3. Starts a background service that runs on every boot (launchd, systemd, or a Windows scheduled task).
4. Adds `dota-limiter-stats` to your hosts file so the stats page has a real address.
5. Applies the Brave block list as a browser policy.

Running the installer again is safe. It updates everything and keeps your settings and today's games.

### One manual step: the Brave extension

Brave doesn't let installers add extensions, so do this once:

1. Open `brave://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick the folder the installer printed:
   - macOS: `/usr/local/focus-guard/brave/extension`
   - Ubuntu: `/opt/focus-guard/brave/extension`
   - Windows: `C:\Program Files\FocusGuard\brave\extension`
3. Quit Brave fully and open it again.

On macOS there's one more click: the installer opens **System Settings > General > Device Management**. Double-click **Focus Guard (Brave)** and press **Install**. macOS doesn't let scripts install profiles silently.

## Stats page

Open **http://dota-limiter-stats** (type the `http://` so Brave doesn't search for it).

- Today's series score and whether Steam is locked
- Every match: hero, win or loss, K/D/A, last hits and denies, GPM, XPM, net worth, items, game length and score, plus OpenDota, Dotabuff and STRATZ links
- History of past days (click a day to see its matches)

## Settings

Edit `config.json` (you need admin rights), then run the installer again to apply:

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

The sites Brave blocks are in `brave/policy.json`.

## How it works

Dota 2 has an official feature, [Game State Integration](https://developer.valvesoftware.com/wiki/Counter-Strike:_Global_Offensive_Game_State_Integration), that sends live match data to a local address. The service counts real online matches (bot games and demo hero don't count) and records the result of each one.

Once the day's series is decided, it closes Steam and Dota and keeps closing them until the reset. It never cuts you off in the middle of a game. You get a notification when your last game starts and when the day is over.

Loopholes it closes:

- **Abandoning or quitting a game**: it still counts.
- **Removing the launch option**: Dota is closed as soon as it starts.
- **Stopping the service or editing the count**: it runs as a system service, so both need your admin password.

The Brave extension exists because Facebook is a single-page app. Clicking **Home** inside Messages changes the page without a real page load, so a browser block list alone can't catch it. The extension watches for that and sends you back to `/messages`.

## Uninstall

macOS and Ubuntu:

```bash
curl -fsSL https://raw.githubusercontent.com/ReidoBoss/focus-guard/main/install.sh | sudo bash -s -- --uninstall
```

Windows (PowerShell as Administrator):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ReidoBoss/focus-guard/main/install.ps1))) -Uninstall
```

Then remove the extension from `brave://extensions`. The `-gamestateintegration` launch option is left in place. It's harmless.

## Troubleshooting

- **Games aren't being counted.** Open the stats page during a match. If it doesn't show a live game, run the installer again with Steam closed, then check that Dota's launch options (Steam > Dota 2 > Properties) include `-gamestateintegration`.
- **Dota was installed after Focus Guard.** Run the installer again so it can find Dota.
- **Logs**: `log.txt` next to `config.json`.
- **Ubuntu with Brave from Snap or Flatpak**: browser policies only work with the official `.deb` from [brave.com/linux](https://brave.com/linux/).

## Limits

This keeps an honest person honest. Anyone with the admin password can uninstall it, and it only covers the computer it's installed on.

## License

MIT
