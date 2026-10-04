#!/usr/bin/env bash
# Focus Guard installer for macOS and Linux (Ubuntu/Debian).
#
#   curl -fsSL https://raw.githubusercontent.com/ReidoBoss/focus-guard/main/install.sh | sudo bash
#
# Options (after "sudo bash -s --" when piping):
#   --yes         don't ask anything, use the last answers (or the recommended ones)
#   --uninstall   remove Focus Guard
set -euo pipefail

REPO="ReidoBoss/focus-guard"
OS="$(uname -s)"
LABEL="local.focusguard"
STATS_HOST="dota-limiter-stats"

YES=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    --uninstall) UNINSTALL=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m' "$*"; }
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m[!] %s\033[0m\n' "$*"; }
die() { printf '\033[31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- prompts
# Questions go to the terminal even when this script arrives through a pipe.
# No terminal (CI, --yes) means every question takes its default.
INTERACTIVE=0
if [ "$YES" = 0 ] && { [ -z "${CI:-}" ] || [ -n "${FG_INTERACTIVE:-}" ]; } && { : </dev/tty; } 2>/dev/null; then
  INTERACTIVE=1
fi

tell() { if [ "$INTERACTIVE" = 1 ]; then printf '%s\n' "$*" >/dev/tty; fi; }

ask() { # ask "question" default
  local ans=""
  if [ "$INTERACTIVE" = 1 ]; then
    if [ -n "$2" ]; then printf '%s [%s]: ' "$1" "$2" >/dev/tty; else printf '%s ' "$1" >/dev/tty; fi
    IFS= read -r ans </dev/tty || ans=""
  fi
  printf '%s' "${ans:-$2}"
}

yesno() { # yesno "question" y|n
  local ans
  while :; do
    ans="$(ask "$1 (y/n)" "$2")"
    case "$ans" in
      [Yy]*) return 0 ;;
      [Nn]*) return 1 ;;
    esac
    tell "Please answer y or n."
  done
}

choose() { # choose "question" default "option 1" "option 2" ... -> prints the number picked
  local q="$1" def="$2" ans i
  shift 2
  tell ""
  tell "$q"
  i=1
  for opt in "$@"; do tell "  $i) $opt"; i=$((i + 1)); done
  if [ "$INTERACTIVE" = 0 ]; then printf '%s' "$def"; return; fi
  while :; do
    ans="$(ask "Choose 1-$#" "$def")"
    if [[ "$ans" =~ ^[0-9]+$ ]] && [ "$ans" -ge 1 ] && [ "$ans" -le $# ]; then printf '%s' "$ans"; return; fi
    tell "Please type a number from 1 to $#."
  done
}

number() { # number "question" default min max
  local ans
  if [ "$INTERACTIVE" = 0 ]; then printf '%s' "$2"; return; fi
  while :; do
    ans="$(ask "$1" "$2")"
    if [[ "$ans" =~ ^[0-9]+$ ]] && [ "$ans" -ge "$3" ] && [ "$ans" -le "$4" ]; then printf '%s' "$ans"; return; fi
    tell "Please type a whole number from $3 to $4."
  done
}

# ---------------------------------------------------------------- basics
[ "$(id -u)" -eq 0 ] || die "Run this with sudo."
case "$OS" in
  Darwin) DEST=/usr/local/focus-guard ;;
  Linux) DEST=/opt/focus-guard ;;
  *) die "Unsupported OS: $OS. On Windows use install.ps1." ;;
esac

# The person who uses Steam and the browsers, not root.
USER_NAME="${SUDO_USER:-}"
if [ -z "$USER_NAME" ] || [ "$USER_NAME" = root ]; then
  if [ "$OS" = Darwin ]; then USER_NAME="$(stat -f%Su /dev/console)"; else USER_NAME="$(logname 2>/dev/null || true)"; fi
fi
[ -n "$USER_NAME" ] && [ "$USER_NAME" != root ] || die "Couldn't tell which user this is for. Run with sudo from your own account."
USER_HOME="$(eval echo "~$USER_NAME")"

if [ "$OS" = Darwin ]; then
  BROWSERS_ALL="brave chrome edge firefox"
else
  BROWSERS_ALL="brave chrome chromium edge firefox"
fi

browser_name() {
  case "$1" in
    brave) echo "Brave" ;; chrome) echo "Google Chrome" ;; chromium) echo "Chromium" ;;
    edge) echo "Microsoft Edge" ;; firefox) echo "Firefox" ;;
  esac
}

browser_installed() {
  if [ "$OS" = Darwin ]; then
    local app
    case "$1" in
      brave) app="Brave Browser" ;; chrome) app="Google Chrome" ;; edge) app="Microsoft Edge" ;; firefox) app="Firefox" ;;
    esac
    [ -d "/Applications/$app.app" ] || [ -d "$USER_HOME/Applications/$app.app" ]
  else
    local bins
    case "$1" in
      brave) bins="brave-browser brave" ;; chrome) bins="google-chrome google-chrome-stable" ;;
      chromium) bins="chromium chromium-browser" ;; edge) bins="microsoft-edge microsoft-edge-stable" ;;
      firefox) bins="firefox" ;;
    esac
    for b in $bins; do
      if command -v "$b" >/dev/null 2>&1 || [ -x "/snap/bin/$b" ]; then return 0; fi
    done
    return 1
  fi
}

# Linux policy locations. Chromium-based browsers read every JSON file in their folder.
linux_policy_dirs() {
  case "$1" in
    brave) echo "/etc/brave/policies/managed" ;;
    chrome) echo "/etc/opt/chrome/policies/managed" ;;
    chromium) echo "/etc/chromium/policies/managed /etc/chromium-browser/policies/managed" ;;
    edge) echo "/etc/opt/edge/policies/managed" ;;
  esac
}
FIREFOX_POLICY=/etc/firefox/policies/policies.json

stop_service() {
  if [ "$OS" = Darwin ]; then
    launchctl bootout "system/$LABEL" 2>/dev/null || true
    # Older single-file install of the Dota limiter.
    launchctl bootout system/local.dotalimit 2>/dev/null || true
    rm -f /Library/LaunchDaemons/local.dotalimit.plist
  else
    systemctl stop focus-guard 2>/dev/null || true
  fi
}

remove_hosts_entry() {
  local tmp; tmp="$(mktemp)"
  grep -v " $STATS_HOST\$" /etc/hosts > "$tmp" || true
  cat "$tmp" > /etc/hosts && rm -f "$tmp"
}

mac_profiles() { # identifiers of Focus Guard profiles currently installed
  profiles list -all 2>/dev/null | grep -oE "local\.focusguard\.(brave|browsers\.[0-9a-f]{8})" | sort -u || true
}

remove_mac_profiles() { # remove_mac_profiles [identifier to keep]
  local id
  for id in $(mac_profiles); do
    if [ "$id" != "${1:-}" ]; then
      profiles remove -identifier "$id" >/dev/null 2>&1 || warn "Remove the old Focus Guard profile in System Settings > General > Device Management."
    fi
  done
}

# ---------------------------------------------------------------- uninstall
if [ "$UNINSTALL" = 1 ]; then
  if [ "$INTERACTIVE" = 1 ] && ! yesno "Remove the Dota limit and the website blocker from this computer?" n; then
    echo "Nothing removed."
    exit 0
  fi
  say "Removing Focus Guard"
  stop_service
  if [ "$OS" = Darwin ]; then
    rm -f "/Library/LaunchDaemons/$LABEL.plist"
    remove_mac_profiles
  else
    systemctl disable focus-guard 2>/dev/null || true
    rm -f /etc/systemd/system/focus-guard.service
    systemctl daemon-reload
    for b in $BROWSERS_ALL; do
      for d in $(linux_policy_dirs "$b"); do rm -f "$d/focus-guard.json"; done
    done
  fi
  remove_hosts_entry
  NODE_FOR_UNINSTALL="$(command -v node || true)"
  for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -z "$NODE_FOR_UNINSTALL" ] && [ -x "$p" ]; then NODE_FOR_UNINSTALL="$p"; fi
  done
  if [ -n "$NODE_FOR_UNINSTALL" ] && [ -f "$DEST/browsers/dns.js" ]; then
    "$NODE_FOR_UNINSTALL" "$DEST/browsers/dns.js" off >/dev/null || warn "Couldn't put your DNS settings back. Set them to automatic in your network settings."
  fi
  if [ "$OS" = Linux ] && [ -f "$FIREFOX_POLICY" ] && [ -n "$NODE_FOR_UNINSTALL" ] && [ -f "$DEST/browsers/policies.js" ]; then
    "$NODE_FOR_UNINSTALL" "$DEST/browsers/policies.js" firefox-merge "$FIREFOX_POLICY" 0 0 > "$FIREFOX_POLICY.tmp" && mv "$FIREFOX_POLICY.tmp" "$FIREFOX_POLICY"
  fi
  rm -rf "$DEST"
  say "Done. Remove the Focus Guard extension from your browsers' extension pages yourself."
  exit 0
fi

# ---------------------------------------------------------------- source files
SCRIPT="${BASH_SOURCE[0]:-}"
if [ -n "$SCRIPT" ] && [ -f "$(dirname "$SCRIPT")/dota-limit/daemon.js" ]; then
  SRC="$(cd "$(dirname "$SCRIPT")" && pwd)"
else
  echo "Downloading Focus Guard..."
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL --connect-timeout 20 --max-time 300 --retry 3 "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" | tar -xz -C "$TMP" \
    || die "Couldn't download Focus Guard from GitHub. Check your internet connection and try again."
  SRC="$TMP/focus-guard-main"
fi

# ---------------------------------------------------------------- node.js
NODE="$(command -v node || true)"
for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -z "$NODE" ] && [ -x "$p" ]; then NODE="$p"; fi
done
if [ -z "$NODE" ]; then
  if [ "$OS" = Linux ] && command -v apt-get >/dev/null; then
    say "Installing Node.js (needed to run Focus Guard)"
    apt-get update -qq && apt-get install -y -qq nodejs >/dev/null
    NODE="$(command -v node)"
  else
    die "Node.js is required. Install it from https://nodejs.org (or: brew install node), then run this again."
  fi
fi

# ---------------------------------------------------------------- questions
# Last install's answers become this run's defaults.
prev() { # prev key default
  [ -f "$DEST/choices.json" ] || { printf '%s' "$2"; return; }
  "$NODE" -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=c[process.argv[2]];process.stdout.write(v===undefined?process.argv[3]:String(v))' "$DEST/choices.json" "$1" "$2"
}

tell ""
tell "$(bold "Focus Guard setup")"
tell "Press Enter to take the answer in [brackets]."

# Dota
DOTA_ENABLED=false
MODE="$(prev mode bo3)"
MAX_GAMES="$(prev maxGames 3)"
WEEKEND_MODE="$(prev weekendMode same)"
WEEKEND_MAX="$(prev weekendMaxGames 7)"
RESET_HOUR="$(prev resetHour 4)"
OPENDOTA="$(prev opendota true)"
TILT="$(prev tiltCheck true)"
tell ""
tell "$(bold "1. Dota 2 daily limit")"
tell "Counts your matches and closes Steam for the rest of the day once you're done."
if yesno "Set up the Dota 2 limit?" "$( [ "$(prev dotaEnabled true)" = true ] && echo y || echo n )"; then
  DOTA_ENABLED=true
  pick="$(choose "When should the day end?" "$( [ "$MODE" = games ] && echo 2 || echo 1 )" \
    "Best of 3: stop at 2 wins or 2 losses" \
    "After a fixed number of games")"
  if [ "$pick" = 2 ]; then
    MODE=games
    MAX_GAMES="$(number "How many games per day?" "$MAX_GAMES" 1 20)"
  else
    MODE=bo3
  fi
  if yesno "Use a different limit on Saturday and Sunday?" "$( [ "$WEEKEND_MODE" = same ] && echo n || echo y )"; then
    pick="$(choose "On Saturday and Sunday, when should the day end?" "$( [ "$WEEKEND_MODE" = bo3 ] && echo 1 || echo 2 )" \
      "Best of 3: stop at 2 wins or 2 losses" \
      "After a fixed number of games")"
    if [ "$pick" = 2 ]; then
      WEEKEND_MODE=games
      WEEKEND_MAX="$(number "How many games on Saturday and Sunday?" "$WEEKEND_MAX" 1 20)"
    else
      WEEKEND_MODE=bo3
    fi
  else
    WEEKEND_MODE=same
  fi
  RESET_HOUR="$(number "What hour does a new day start? (0-23, so a 2 AM game counts toward the night before)" "$RESET_HOUR" 0 23)"
  tell ""
  tell "The stats page can show your teammates and enemies after each match: rank, most-played"
  tell "heroes, smurfs, parties, streaks, and your record with and against them. This sends the"
  tell "match ID to OpenDota (opendota.com, a free public Dota stats site)."
  if yesno "Look up the other 9 players on OpenDota after each match?" "$( [ "$OPENDOTA" = true ] && echo y || echo n )"; then
    OPENDOTA=true
  else
    OPENDOTA=false
  fi
  if yesno "After a loss, get a tilt check notification (what went wrong, and a nudge to take a break)?" "$( [ "$TILT" = true ] && echo y || echo n )"; then
    TILT=true
  else
    TILT=false
  fi
fi

# Browsers
tell ""
tell "$(bold "2. Website blocker")"
tell "Blocks Facebook, YouTube and Reddit, but keeps facebook.com/messages working."
BROWSERS=""
PREV_BROWSERS="$(prev browsers "")"
status_line=""
for b in $BROWSERS_ALL; do
  if browser_installed "$b"; then status_line="$status_line $(browser_name "$b") (installed),"; else status_line="$status_line $(browser_name "$b"),"; fi
done
tell "Supported here:${status_line%,}"
default_pick=1
if [ -n "$PREV_BROWSERS" ] && [ "$PREV_BROWSERS" != "$(echo "$BROWSERS_ALL" | tr ' ' ',')" ]; then default_pick=2; fi
if [ -f "$DEST/choices.json" ] && [ -z "$PREV_BROWSERS" ]; then default_pick=3; fi
pick="$(choose "Block these sites in:" "$default_pick" \
  "Every supported browser, including ones you install later (recommended)" \
  "Only the browsers I pick" \
  "None, skip the website blocker")"
case "$pick" in
  1) BROWSERS="$(echo "$BROWSERS_ALL" | tr ' ' ',')" ;;
  2)
    for b in $BROWSERS_ALL; do
      if [ -n "$PREV_BROWSERS" ]; then
        def="$(case ",$PREV_BROWSERS," in *",$b,"*) echo y ;; *) echo n ;; esac)"
      else
        def="$(browser_installed "$b" && echo y || echo n)"
      fi
      if yesno "  $(browser_name "$b")?" "$def"; then BROWSERS="$BROWSERS,$b"; fi
    done
    BROWSERS="${BROWSERS#,}"
    ;;
esac

BLOCK_SAFARI=false
if [ "$OS" = Darwin ]; then
  tell ""
  tell "Safari can't block single pages, so it can't keep facebook.com/messages open while"
  tell "blocking the rest of Facebook. Left alone, Safari is a way around the blocker."
  pick="$(choose "What should happen to Safari?" "$( [ "$(prev blockSafari false)" = true ] && echo 2 || echo 1 )" \
    "Leave Safari alone" \
    "Stop Safari from opening")"
  if [ "$pick" = 2 ]; then BLOCK_SAFARI=true; fi
fi

# Adult websites
PREV_ADULT="$(prev blockAdult false)"
BLOCK_ADULT=false
tell ""
tell "$(bold "3. Adult websites")"
tell "Blocks porn and other adult sites in every browser and app, by switching this computer's"
tell "DNS to Cloudflare's free family filter. Also turns on SafeSearch in Google, Bing and YouTube."
if yesno "Block adult websites?" "$( [ "$PREV_ADULT" = true ] && echo y || echo n )"; then BLOCK_ADULT=true; fi
ADULT01="$( [ "$BLOCK_ADULT" = true ] && echo 1 || echo 0 )"

# Summary
names=""
IFS=',' read -r -a picked <<< "$BROWSERS"
for b in "${picked[@]:-}"; do
  if [ -n "$b" ]; then names="$names, $(browser_name "$b")"; fi
done
names="${names#, }"
tell ""
tell "$(bold "Summary")"
if [ "$DOTA_ENABLED" = true ]; then
  if [ "$MODE" = bo3 ]; then tell "  Dota 2 limit:     best of 3, new day at $RESET_HOUR:00"; else tell "  Dota 2 limit:     $MAX_GAMES games, new day at $RESET_HOUR:00"; fi
  case "$WEEKEND_MODE" in
    bo3) tell "  Weekends:         best of 3" ;;
    games) tell "  Weekends:         $WEEKEND_MAX games" ;;
    *) tell "  Weekends:         same as weekdays" ;;
  esac
  tell "  Player lookups:   $( [ "$OPENDOTA" = true ] && echo "on (OpenDota)" || echo "off" )"
  tell "  Tilt check:       $( [ "$TILT" = true ] && echo "on" || echo "off" )"
else
  tell "  Dota 2 limit:     off"
fi
tell "  Website blocker:  ${names:-off}"
if [ "$OS" = Darwin ]; then tell "  Safari:           $( [ "$BLOCK_SAFARI" = true ] && echo "blocked" || echo "left alone" )"; fi
tell "  Adult websites:   $( [ "$BLOCK_ADULT" = true ] && echo "blocked" || echo "not blocked" )"
tell ""
if [ "$INTERACTIVE" = 1 ] && ! yesno "Install with these settings?" y; then
  echo "Nothing changed."
  exit 0
fi

CHOICES="$("$NODE" -e 'const [d,m,g,wm,wg,h,b,s,a,o,t]=process.argv.slice(1);console.log(JSON.stringify({dotaEnabled:d==="true",mode:m,maxGames:Number(g),weekendMode:wm,weekendMaxGames:Number(wg),resetHour:Number(h),browsers:b,blockSafari:s==="true",blockAdult:a==="true",opendota:o==="true",tiltCheck:t==="true"}))' \
  "$DOTA_ENABLED" "$MODE" "$MAX_GAMES" "$WEEKEND_MODE" "$WEEKEND_MAX" "$RESET_HOUR" "$BROWSERS" "$BLOCK_SAFARI" "$BLOCK_ADULT" "$OPENDOTA" "$TILT")"

# ---------------------------------------------------------------- files
say "Installing to $DEST"
stop_service
mkdir -p "$DEST"
rm -rf "$DEST/brave" "$DEST/browsers/extension"
rm -f "$DEST/dota-limit/stats-url.txt"
cp -R "$SRC/dota-limit" "$SRC/browsers" "$DEST/"
printf '%s\n' "$CHOICES" > "$DEST/choices.json"
if [ -d /usr/local/dotalimit ]; then
  for f in state.json history.json; do
    if [ -f "/usr/local/dotalimit/$f" ] && [ ! -f "$DEST/dota-limit/$f" ]; then cp "/usr/local/dotalimit/$f" "$DEST/dota-limit/$f"; fi
  done
  rm -rf /usr/local/dotalimit
fi
chown -R root:"$( [ "$OS" = Darwin ] && echo wheel || echo root )" "$DEST"
chmod -R go-w "$DEST"

# ---------------------------------------------------------------- dota 2
DETECTED="{}"
if [ "$DOTA_ENABLED" = true ]; then
  say "Setting up Dota 2 match tracking"
  # Steam rewrites its settings when it quits, so it has to be closed before launch options change.
  steam_running=0
  if pgrep -x steam_osx >/dev/null 2>&1 || pgrep -x steam >/dev/null 2>&1; then steam_running=1; fi
  PATCH=1
  if [ "$steam_running" = 1 ] && [ "$INTERACTIVE" = 1 ] && ! yesno "Steam is open and has to close so its launch options can be changed. Close it now?" y; then
    PATCH=0
  fi
  if [ "$PATCH" = 1 ]; then
    pkill -9 -x steam_osx 2>/dev/null || true
    pkill -9 -f "dota 2 beta/game/bin/" 2>/dev/null || true
    pkill -9 -x steam 2>/dev/null || true
    pkill -9 -x steamwebhelper 2>/dev/null || true
    sleep 1
  fi
  DETECTED="$(sudo -H -u "$USER_NAME" env FG_NO_LAUNCH_OPTIONS="$( [ "$PATCH" = 1 ] && echo "" || echo 1 )" "$NODE" "$DEST/dota-limit/setup.js" detect)"
  DOTA_DIR="$("$NODE" -e 'console.log(JSON.parse(process.argv[1]).dotaDir || "")' "$DETECTED")"
  PATCHED="$("$NODE" -e 'console.log(JSON.parse(process.argv[1]).launchOptionsPatched.length)' "$DETECTED")"
  if [ -n "$DOTA_DIR" ]; then
    echo "Found Dota 2 at: $DOTA_DIR"
    if [ "$PATCHED" -gt 0 ]; then echo "Added -gamestateintegration to Dota 2 launch options."; fi
    if [ "$PATCH" = 0 ]; then warn "Add -gamestateintegration to Dota 2 launch options in Steam yourself (Dota 2 > Properties)."; fi
  else
    warn "Dota 2 wasn't found. Install it through Steam, then run this installer again."
  fi
fi
FG_DETECTED="$DETECTED" FG_CHOICES="$CHOICES" "$NODE" "$DEST/dota-limit/setup.js" write-config "$DEST/dota-limit/config.json" "$USER_NAME" >/dev/null

# ---------------------------------------------------------------- adult websites
# Before the service starts, since the service re-applies the filter when it's on.
if [ "$BLOCK_ADULT" = true ]; then
  say "Blocking adult websites"
  "$NODE" "$DEST/browsers/dns.js" on >/dev/null \
    || warn "Couldn't change this computer's DNS settings, so adult sites are only hidden from Google, Bing and YouTube searches."
elif [ "$PREV_ADULT" = true ]; then
  say "Unblocking adult websites"
  "$NODE" "$DEST/browsers/dns.js" off >/dev/null || warn "Couldn't put your DNS settings back. Set them to automatic in your network settings."
fi

# ---------------------------------------------------------------- service
say "Starting the background service"
if [ "$OS" = Darwin ]; then
  cat > "/Library/LaunchDaemons/$LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DEST/dota-limit/daemon.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$DEST/dota-limit/error.txt</string>
</dict>
</plist>
EOF
  chmod 644 "/Library/LaunchDaemons/$LABEL.plist"
  launchctl bootstrap system "/Library/LaunchDaemons/$LABEL.plist"
else
  cat > /etc/systemd/system/focus-guard.service <<EOF
[Unit]
Description=Focus Guard (Dota 2 daily limit)
After=network.target

[Service]
ExecStart=$NODE $DEST/dota-limit/daemon.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now focus-guard >/dev/null 2>&1
fi

grep -q " $STATS_HOST\$" /etc/hosts || echo "127.0.0.1 $STATS_HOST" >> /etc/hosts
if [ "$OS" = Darwin ]; then dscacheutil -flushcache; killall -HUP mDNSResponder 2>/dev/null || true; fi

# ---------------------------------------------------------------- browsers
say "Website blocker: ${names:-off}"
if [ "$OS" = Darwin ]; then
  if [ -z "$BROWSERS" ] && [ "$BLOCK_ADULT" = false ]; then
    remove_mac_profiles
  else
    PROFILE_ID="$("$NODE" "$DEST/browsers/policies.js" profile-id "$BROWSERS" "$ADULT01")"
    PROFILE="$DEST/browsers/focus-guard.mobileconfig"
    "$NODE" "$DEST/browsers/policies.js" mobileconfig "$BROWSERS" "$ADULT01" > "$PROFILE"
    if mac_profiles | grep -qx "$PROFILE_ID"; then
      echo "Browser profile is already up to date."
    elif [ -z "${CI:-}" ]; then
      sudo -u "$USER_NAME" open "$PROFILE" || true
      sudo -u "$USER_NAME" open "x-apple.systempreferences:com.apple.preferences.configurationprofiles" 2>/dev/null || true
      warn "macOS needs you to approve the profile: System Settings > General > Device Management > Focus Guard (website blocker) > Install."
      if [ "$INTERACTIVE" = 1 ]; then
        ask "Press Enter once you've clicked Install" "" >/dev/null
        if mac_profiles | grep -qx "$PROFILE_ID"; then echo "Profile installed."; else warn "The profile isn't installed yet. You can install it later from $PROFILE"; fi
      fi
    fi
    # Drop older versions once the new one is in, so the two never disagree.
    if mac_profiles | grep -qx "$PROFILE_ID"; then remove_mac_profiles "$PROFILE_ID"; fi
  fi
else
  for b in $BROWSERS_ALL; do
    sites01="$( [[ ",$BROWSERS," == *",$b,"* ]] && echo 1 || echo 0 )"
    for d in $(linux_policy_dirs "$b"); do
      if [ "$sites01" = 1 ] || [ "$BLOCK_ADULT" = true ]; then
        mkdir -p "$d"
        "$NODE" "$DEST/browsers/policies.js" chromium "$b" "$sites01" "$ADULT01" > "$d/focus-guard.json"
        chmod 644 "$d/focus-guard.json"
      else
        rm -f "$d/focus-guard.json"
      fi
    done
  done
  if [[ ",$BROWSERS," == *",firefox,"* ]] || [ "$BLOCK_ADULT" = true ] || [ -f "$FIREFOX_POLICY" ]; then
    mkdir -p "$(dirname "$FIREFOX_POLICY")"
    on="$( [[ ",$BROWSERS," == *",firefox,"* ]] && echo 1 || echo 0 )"
    "$NODE" "$DEST/browsers/policies.js" firefox-merge "$FIREFOX_POLICY" "$on" "$ADULT01" > "$FIREFOX_POLICY.tmp"
    mv "$FIREFOX_POLICY.tmp" "$FIREFOX_POLICY" && chmod 644 "$FIREFOX_POLICY"
  fi
fi

# ---------------------------------------------------------------- check
STATS_URL="http://$STATS_HOST/"
running=0
for _ in $(seq 1 15); do
  if [ -f "$DEST/dota-limit/stats-url.txt" ] && curl -fs "$(cat "$DEST/dota-limit/stats-url.txt")api" >/dev/null 2>&1; then running=1; break; fi
  sleep 1
done
if [ "$running" = 1 ]; then
  STATS_URL="$(cat "$DEST/dota-limit/stats-url.txt")"
  say "Focus Guard is running"
else
  warn "The service didn't answer yet. Check $DEST/dota-limit/log.txt"
fi

echo ""
if [ "$DOTA_ENABLED" = true ]; then echo "  Stats page:  $STATS_URL"; fi
if [[ ",$BROWSERS," == *,brave,* || ",$BROWSERS," == *,chrome,* || ",$BROWSERS," == *,chromium,* || ",$BROWSERS," == *,edge,* ]]; then
  cat <<EOF

  One manual step per browser: browsers don't let installers add extensions.
  The extension stops Facebook's Home button from getting around the block.
    1. Open the extensions page (brave://extensions, chrome://extensions or edge://extensions)
    2. Turn on Developer mode
    3. Click "Load unpacked" and choose: $DEST/browsers/extension
EOF
fi
if [[ ",$BROWSERS," == *,firefox,* ]]; then
  cat <<EOF

  Firefox: direct visits are blocked, but Firefox only runs extensions signed by Mozilla,
  so clicking Home inside facebook.com/messages can still reach the feed there.
EOF
fi
echo ""
echo "  Restart your browsers so they pick up the block list. Run this installer again any time to change settings."
echo ""
