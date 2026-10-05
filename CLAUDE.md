# Focus Guard

Self-control tools installed with one command on macOS, Ubuntu and Windows:

- **Dota Limit** (`dota-limit/`): counts Dota 2 matches through Game State Integration (GSI) and closes Steam for the rest of the day once the day's series is decided. Serves a stats page at `http://focus/dota`.
- **Website blocker** (`browsers/`): blocks the sites in `browsers/sites.json` through browser policies, plus a Chromium extension for Facebook's single-page navigation. Can block Safari outright on macOS.
- **Adult website block** (`browsers/dns.js`, optional, `blockAdult`): sets the system DNS to Cloudflare for Families and adds SafeSearch and "secure DNS off" policies to every browser.

`README.md` is the user-facing doc. This file is for working on the code.

## Layout

| Path | What it is |
|---|---|
| `install.sh` | Installer for macOS and Linux. Runs as root via `sudo bash -c "$(curl ...)"`. |
| `install.ps1` | Installer for Windows. Runs as admin via `irm ... \| iex`. |
| `dota-limit/daemon.js` | The service. GSI endpoint on `127.0.0.1:43210`, stats page on port 80 (falls back to 8787), process killing, notifications. |
| `dota-limit/setup.js` | Install-time helper. `detect` (run as the Steam user) finds Dota, writes the GSI file and patches launch options. `write-config` (run as root) merges `config.json`. |
| `dota-limit/vdf.js` | Valve KeyValues parser/writer. |
| `dota-limit/gsi.js` | The GSI config file, shared by `setup.js` and `daemon.js`. |
| `dota-limit/notifier.js` | Windows only. Polls `/notices` and shows toasts in the user's session. |
| `dota-limit/topbar.js` | Runs in the browser. The tab bar (News, Videos, Dota, Blocked sites, Settings) on every page of `http://focus`. The routes are `PAGES` in `daemon.js`. |
| `dota-limit/blocked.html`, `settings.html` | The Blocked sites and Settings tabs. Read-only, from `/api/settings`: loosening a limit must take the installer, and any website can send requests to 127.0.0.1. |
| `dota-limit/stats.html` | Stats page at `/dota`, served by the daemon. Polls `/api`. Also renders the teammates and enemies panel and decides its labels (`chips()`). |
| `dota-limit/insights.js` | Hero report, tilt check, lane results, gold swing, counter-picks and weekly summary. Pure functions with no network or file access; the daemon feeds them data. |
| `dota-limit/news.js` | Headlines for the front page, `http://focus/` (`news.html`): 10 per section from RSS feeds, Hacker News, Lobsters and Steam. Fetched only when the page is opened, at most every 3 hours, cached in `news-cache.json`. Drops links to sites in `browsers/sites.json`. |
| `dota-limit/videos.js` | YouTube search for `/videos` (`videos.html`). Reads `ytInitialData` from YouTube's own search page (the Data API needs a key), videos only, without Shorts, live streams or anything under 2 minutes. The page plays through `youtube-nocookie.com/embed`, an `allow` entry in `sites.json`; youtube.com stays blocked. |
| `dota-limit/opendota.js` | After a match, fetches the scoreboard and each public player's profile from OpenDota. Requests go out one at a time, about 1.1 s apart, because the free tier allows 60 a minute. |
| `browsers/sites.json` | Blocked and allowed sites. The only list; every browser format is generated from it. |
| `browsers/policies.js` | Generates Chromium policy JSON, Firefox policies, and the macOS `.mobileconfig`. Takes a site-list flag and an adult flag per browser. |
| `browsers/dns.js` | Turns the family DNS filter on or off. Run by the installers, and every minute by the daemon (as a child process) while `blockAdult` is on. |
| `browsers/extension/` | MV3 extension for Brave, Chrome, Edge and Chromium. |
| `test/` | `insights.test.js`, `opendota.test.js`, `news.test.js`, `pages.test.js` and `videos.test.js` (offline, safe to run anywhere) plus the CI-only `fake-steam.js`, `e2e.js` and `interactive.exp`. |

Install locations: `/usr/local/focus-guard` (macOS), `/opt/focus-guard` (Linux), `C:\Program Files\FocusGuard` (Windows). Services: launchd `local.focusguard`, systemd `focus-guard`, scheduled tasks `FocusGuard` (SYSTEM) and `FocusGuardNotifier` (user).

## How the pieces connect

1. The installer asks its questions, then saves the answers to `<install>/choices.json`. The next run uses them as defaults.
2. `setup.js detect` runs **as the real user** (`sudo -H -u "$USER_NAME"`), not root. Its JSON output goes to `setup.js write-config` through the `FG_DETECTED` env var, and the installer's answers go through `FG_CHOICES`.
3. `write-config` merges the defaults, the existing `config.json`, the answers, and the detected values, in that order, so settings edited by hand survive a reinstall.
4. The daemon reads `config.json` once at startup. Config changes need a service restart, which the installer does.

## Rules that aren't obvious from the code

- **Old runtimes.** Code the installers run (`dota-limit/*.js`, `browsers/*.js`) must work on Node 12, because Ubuntu 22.04's apt `nodejs` is v12. Don't use `?.`, `??`, or newer APIs there. The `.html` pages, `topbar.js` and `extension/` run in browsers, so they're exempt.
- **PowerShell 5.1.** `install.ps1` must run in Windows PowerShell 5.1: no ternaries, no `??`, and `else` / `elseif` on the same line as the closing `}`. Never pass JSON as a native-command argument, because 5.1 mangles the quotes. Use env vars, like `FG_DETECTED`.
- **Questions on macOS and Linux** read from and write to `/dev/tty`, so they also work when the script is piped in. Every prompt helper must return its default immediately when `INTERACTIVE=0`, or a bad saved default loops forever.
- **Never tell people to run `curl ... | sudo bash`.** sudo-rs, the default sudo on newer Ubuntu, runs a piped-in script in a terminal of its own and never passes it keystrokes, so the first question hangs (the read is stopped, state `T` in `ps`). `sudo bash -c "$(curl ...)"` keeps the keyboard on stdin, and options go after `--`. `install.sh` stops with that command when it's piped in under sudo-rs. The whole script travels as one argument, which Linux caps at 128 KB, so keep `install.sh` well under that.
- **Never run `pkill -f` on a broad Steam pattern.** macOS launchd respawns Steam's `ipcserver` every few seconds; killing it caused a notification loop. `isSteam()` targets only `steam_osx` / `Steam Helper.app`, `steam` / `steamwebhelper` on Linux, and `steam.exe` / `steamwebhelper.exe` on Windows.
- **macOS privacy rules block the root daemon from external drives.** So on macOS the GSI file is written by `setup.js detect` as the user, and `ensureGsiConfig()` failing there is expected. Linux and Windows can restore the file from the daemon.
- **Steam rewrites `localconfig.vdf` when it quits**, so Steam must be closed before launch options are patched. `vdf.js` must keep round-tripping Steam's files byte for byte. Check against a real `localconfig.vdf` after any parser change.
- **OpenDota lookups.**
  - **When:** after `POST_GAME`, the daemon schedules `lookup()` on the `RETRY_MINUTES` timetable. The results are saved on the match as `opendota`, in today's state or in `history.json` via `findMatch()`. Pending lookups resume after a restart.
  - **Counts include the match itself,** because the lookup runs after it ends. So 1 game on a hero means it was their first, and the "games together" labels only show above 1.
  - **Partial history:** OpenDota often lacks a player's full history (`profile.fh_unavailable`), even for Immortal players. Their game counts come back as 0. `opendota.js` sets `fhUnavailable` and nulls `games`, and the page must skip every count-based label for them, or it labels high-rank players as new accounts.
  - **Fake match IDs:** `e2e.js` uses IDs from 990000000001 up, so CI never looks up real matches.
  - **After the scoreboard,** `afterLookup()` fetches counter-picks for the enemy heroes, refreshes the hero report, rebuilds the tilt check, and starts replay parsing. `parseStep()` asks OpenDota to parse (again on the 3rd try), then checks on the `PARSE_MINUTES` timetable.
  - **Tilt check text is built on the server,** because it goes into notifications. Pass `label` so it uses display names ("Invoker", not `npc_dota_hero_invoker`).
  - **Your account ID** comes from `setup.js detect` (Steam's `loginusers.vdf`) as `config.accountId`, or else from a match's GSI `accountid` / `steamid`. See `myAccountId()`.
  - **Request budget:** a full first lookup takes about 40 to 50 requests at 1.1 s each, so 1 to 3 minutes. Hero constants and matchups are cached on disk for a week, the report for an hour, and profiles for 6 hours.
- **Port 80 can be taken.** GitHub's Windows runners reserve it, so the stats page falls back to 8787. The daemon writes the URL it actually used to `stats-url.txt`; read that instead of hard-coding the address.
- **macOS profile identifiers** include a hash of their content (`local.focusguard.browsers.<hash>`), so a changed profile is a new identifier. The installer removes older Focus Guard profiles only after the new one is installed.
- **Adult block DNS.** macOS (`networksetup`, per network service) and Windows (`Set-DnsClientServerAddress`, per adapter) save each connection's previous servers in `<install>/dns-backup.json`, only the first time it's seen, and `off` restores them. Linux writes a `systemd-resolved` drop-in with `Domains=~.`, so link DNS from DHCP isn't used. Turn it off before the install folder is deleted, and after the service stops, or the daemon turns it straight back on. Its browser policies go to every browser, not just the ones picked for the site list, so `install.ps1` clears every name in `$OurPolicies` before writing.
- **Firefox** can't get the extension (release Firefox only runs Mozilla-signed add-ons). **Safari** has no URL policy, so it can only be blocked outright (`blockSafari`).

## Adding a browser

Every one of these must be updated:

- `install.sh`: `BROWSERS_ALL`, `browser_name`, `browser_installed`, and `linux_policy_dirs`
- `install.ps1`: `$AllBrowsers`, `$BrowserNames`, `$PolicyKeys`, `$BrowserExes` (and `$OurPolicies` for any new policy name)
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
node test/insights.test.js   # hero report, tilt check, lanes, counters, weekly summary
node test/opendota.test.js   # OpenDota lookups and the whole stats page, against canned answers
node test/news.test.js       # news feeds and the news page, against canned feeds
node test/pages.test.js      # tab bar, Blocked sites and Settings tabs
node test/videos.test.js     # YouTube search parsing and the Videos page, against a canned search page
node browsers/dns.js status  # read-only; "on" and "off" change this machine's DNS
for f in dota-limit/*.js browsers/*.js browsers/extension/*.js test/*.js; do node --check "$f" || echo "FAIL $f"; done
bash -n install.sh
node browsers/policies.js mobileconfig brave,chrome,edge,firefox 1 | plutil -lint -   # macOS
```

To try the installer's questions without installing anything, copy `install.sh`, remove the root check, point `DEST` at a scratch folder, end the script before the `files` section, and drive it with `expect`.

## Style

- No em dashes anywhere: code, comments, docs or commit messages.
- User-facing text (README, installer output, notifications) is plain language for a non-technical reader.
- Commit messages have no `Co-Authored-By` or other trailers.
- Per-machine files stay out of git: `config.json`, `state.json`, `history.json`, logs, caches like `news-cache.json` and `stats-url.txt` are gitignored, and `choices.json` only exists in the install folder.
