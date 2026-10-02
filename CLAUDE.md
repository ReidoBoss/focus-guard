# Focus Guard

Self-control tools installed with one command on macOS, Ubuntu and Windows:

- **Dota Limit** (`dota-limit/`): counts Dota 2 matches through Game State Integration (GSI) and closes Steam for the rest of the day once the day's series is decided. Serves a stats page at `http://dota-limiter-stats`.
- **Website blocker** (`browsers/`): blocks the sites in `browsers/sites.json` through browser policies, plus a Chromium extension for Facebook's single-page navigation. Can block Safari outright on macOS.

`README.md` is the user-facing doc. This file is for working on the code.

## Layout

| Path | What it is |
|---|---|
| `install.sh` | Installer for macOS and Linux. Runs as root via `curl ... \| sudo bash`. |
| `install.ps1` | Installer for Windows. Runs as admin via `irm ... \| iex`. |
| `dota-limit/daemon.js` | The service. GSI endpoint on `127.0.0.1:43210`, stats page on port 80 (falls back to 8787), process killing, notifications. |
| `dota-limit/setup.js` | Install-time helper. `detect` (run as the Steam user) finds Dota, writes the GSI file and patches launch options. `write-config` (run as root) merges `config.json`. |
| `dota-limit/vdf.js` | Valve KeyValues parser/writer. |
| `dota-limit/gsi.js` | The GSI config file, shared by `setup.js` and `daemon.js`. |
| `dota-limit/notifier.js` | Windows only. Polls `/notices` and shows toasts in the user's session. |
| `dota-limit/stats.html` | Stats page, served by the daemon. Polls `/api`. Also renders the teammates and enemies panel and decides its labels (`chips()`). |
| `dota-limit/opendota.js` | After a match, fetches the scoreboard and each public player's profile from OpenDota. Requests go out one at a time, about 1.1 s apart, because the free tier allows 60 a minute. |
| `browsers/sites.json` | Blocked and allowed sites. The only list; every browser format is generated from it. |
| `browsers/policies.js` | Generates Chromium policy JSON, Firefox `WebsiteFilter`, and the macOS `.mobileconfig`. |
| `browsers/extension/` | MV3 extension for Brave, Chrome, Edge and Chromium. |
| `test/` | `opendota.test.js` (offline, safe to run anywhere) plus the CI-only `fake-steam.js`, `e2e.js` and `interactive.exp`. |

Install locations: `/usr/local/focus-guard` (macOS), `/opt/focus-guard` (Linux), `C:\Program Files\FocusGuard` (Windows). Services: launchd `local.focusguard`, systemd `focus-guard`, scheduled tasks `FocusGuard` (SYSTEM) and `FocusGuardNotifier` (user).

## How the pieces connect

1. The installer asks its questions, then saves the answers to `<install>/choices.json`. The next run uses them as defaults.
2. `setup.js detect` runs **as the real user** (`sudo -H -u "$USER_NAME"`), not root. Its JSON output goes to `setup.js write-config` through the `FG_DETECTED` env var, and the installer's answers go through `FG_CHOICES`.
3. `write-config` merges the defaults, the existing `config.json`, the answers, and the detected values, in that order, so settings edited by hand survive a reinstall.
4. The daemon reads `config.json` once at startup. Config changes need a service restart, which the installer does.

## Rules that aren't obvious from the code

- **Old runtimes.** Code the installers run (`dota-limit/*.js`, `browsers/*.js`) must work on Node 12, because Ubuntu 22.04's apt `nodejs` is v12. Don't use `?.`, `??`, or newer APIs there. `stats.html` and `extension/` run in browsers, so they're exempt.
- **PowerShell 5.1.** `install.ps1` must run in Windows PowerShell 5.1: no ternaries, no `??`, and `else` / `elseif` on the same line as the closing `}`. Never pass JSON as a native-command argument, because 5.1 mangles the quotes. Use env vars, like `FG_DETECTED`.
- **Questions on macOS and Linux** read from and write to `/dev/tty`, because stdin is the piped script. Every prompt helper must return its default immediately when `INTERACTIVE=0`, or a bad saved default loops forever.
- **Never run `pkill -f` on a broad Steam pattern.** macOS launchd respawns Steam's `ipcserver` every few seconds; killing it caused a notification loop. `isSteam()` targets only `steam_osx` / `Steam Helper.app`, `steam` / `steamwebhelper` on Linux, and `steam.exe` / `steamwebhelper.exe` on Windows.
- **macOS privacy rules block the root daemon from external drives.** So on macOS the GSI file is written by `setup.js detect` as the user, and `ensureGsiConfig()` failing there is expected. Linux and Windows can restore the file from the daemon.
- **Steam rewrites `localconfig.vdf` when it quits**, so Steam must be closed before launch options are patched. `vdf.js` must keep round-tripping Steam's files byte for byte. Check against a real `localconfig.vdf` after any parser change.
- **OpenDota lookups.**
  - **When:** after `POST_GAME`, the daemon schedules `lookup()` on the `RETRY_MINUTES` timetable. The results are saved on the match as `opendota`, in today's state or in `history.json` via `findMatch()`. Pending lookups resume after a restart.
  - **Counts include the match itself,** because the lookup runs after it ends. So 1 game on a hero means it was their first, and the "games together" labels only show above 1.
  - **Partial history:** OpenDota often lacks a player's full history (`profile.fh_unavailable`), even for Immortal players. Their game counts come back as 0. `opendota.js` sets `fhUnavailable` and nulls `games`, and the page must skip every count-based label for them, or it labels high-rank players as new accounts.
  - **Fake match IDs:** `e2e.js` uses IDs from 990000000001 up, so CI never looks up real matches.
- **Port 80 can be taken.** GitHub's Windows runners reserve it, so the stats page falls back to 8787. The daemon writes the URL it actually used to `stats-url.txt`; read that instead of hard-coding the address.
- **macOS profile identifiers** include a hash of their content (`local.focusguard.browsers.<hash>`), so a changed profile is a new identifier. The installer removes older Focus Guard profiles only after the new one is installed.
- **Firefox** can't get the extension (release Firefox only runs Mozilla-signed add-ons). **Safari** has no URL policy, so it can only be blocked outright (`blockSafari`).

## Adding a browser

Every one of these must be updated:

- `install.sh`: `BROWSERS_ALL`, `browser_name`, `browser_installed`, and `linux_policy_dirs`
- `install.ps1`: `$AllBrowsers`, `$BrowserNames`, `$PolicyKeys`, `$BrowserExes`
- `browsers/policies.js`: `PAYLOAD_TYPES` (macOS)
- `test/e2e.js`: `ALL_BROWSERS` and `checkBrowserPolicies()`
- `README.md`: the browser support table

## Testing

CI (`.github/workflows/test.yml`) is the real test. It runs on Ubuntu, Windows and macOS, in two jobs per OS:

- **Default install:** installs from the checkout, runs `test/e2e.js`, reinstalls with the README one-liner, then uninstalls.
- **Interactive install:** answers the questions with `expect` (`test/interactive.exp`), or with piped stdin plus `FG_INTERACTIVE=1` on Windows, then checks that the answers took effect.

`e2e.js` reads `FG_EXPECT_*` env vars, so one test covers both jobs. Its fake Steam and Dota processes run Node under a fake `argv0` on macOS and Linux. Windows uses a renamed copy of `node.exe`, because `tasklist` reports the image name. Never copy the node binary on macOS: Homebrew node can't find its libraries and crashes, which once made the test pass falsely. The test now checks that each fake process started, and that the service left a notice when it closed it.

**Don't run `test/e2e.js` or the installer casually on a dev machine.** The installer closes Steam, and e2e posts fake matches to the real service, which locks the real Steam for the rest of the day.

Safe local checks:

```bash
node test/opendota.test.js   # teammates and enemies, against canned OpenDota answers
for f in dota-limit/*.js browsers/*.js browsers/extension/*.js test/*.js; do node --check "$f" || echo "FAIL $f"; done
bash -n install.sh
node browsers/policies.js mobileconfig brave,chrome,edge,firefox | plutil -lint -   # macOS
```

To try the installer's questions without installing anything, copy `install.sh`, remove the root check, point `DEST` at a scratch folder, end the script before the `files` section, and drive it with `expect`.

## Style

- No em dashes anywhere: code, comments, docs or commit messages.
- User-facing text (README, installer output, notifications) is plain language for a non-technical reader.
- Commit messages have no `Co-Authored-By` or other trailers.
- Per-machine files stay out of git: `config.json`, `state.json`, `history.json`, logs and `stats-url.txt` are gitignored, and `choices.json` only exists in the install folder.
