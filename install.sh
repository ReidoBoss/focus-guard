#!/usr/bin/env bash
# Focus Guard installer for macOS and Linux (Ubuntu/Debian).
#
#   curl -fsSL https://raw.githubusercontent.com/ReidoBoss/focus-guard/main/install.sh | sudo bash
#   curl -fsSL https://raw.githubusercontent.com/ReidoBoss/focus-guard/main/install.sh | sudo bash -s -- --uninstall
set -euo pipefail

REPO="ReidoBoss/focus-guard"
OS="$(uname -s)"
LABEL="local.focusguard"
STATS_HOST="dota-limiter-stats"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m[!] %s\033[0m\n' "$*"; }
die() { printf '\033[31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo."
case "$OS" in
  Darwin) DEST=/usr/local/focus-guard ;;
  Linux) DEST=/opt/focus-guard ;;
  *) die "Unsupported OS: $OS. On Windows use install.ps1." ;;
esac

# The person who uses Steam, not root.
USER_NAME="${SUDO_USER:-}"
if [ -z "$USER_NAME" ] || [ "$USER_NAME" = root ]; then
  if [ "$OS" = Darwin ]; then USER_NAME="$(stat -f%Su /dev/console)"; else USER_NAME="$(logname 2>/dev/null || true)"; fi
fi
[ -n "$USER_NAME" ] && [ "$USER_NAME" != root ] || die "Couldn't tell which user plays Steam. Run with sudo from your own account."

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

if [ "${1:-}" = "--uninstall" ]; then
  say "Removing Focus Guard"
  stop_service
  if [ "$OS" = Darwin ]; then
    rm -f "/Library/LaunchDaemons/$LABEL.plist"
    profiles remove -identifier local.focusguard.brave 2>/dev/null || warn "Remove the \"Focus Guard (Brave)\" profile in System Settings > General > Device Management."
  else
    systemctl disable focus-guard 2>/dev/null || true
    rm -f /etc/systemd/system/focus-guard.service /etc/brave/policies/managed/focus-guard.json
    systemctl daemon-reload
  fi
  remove_hosts_entry
  rm -rf "$DEST"
  say "Done. Remove the Focus Guard extension from brave://extensions yourself."
  exit 0
fi

# ---------------------------------------------------------------- source files
SCRIPT="${BASH_SOURCE[0]:-}"
if [ -n "$SCRIPT" ] && [ -f "$(dirname "$SCRIPT")/dota-limit/daemon.js" ]; then
  SRC="$(cd "$(dirname "$SCRIPT")" && pwd)"
else
  say "Downloading Focus Guard"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" | tar -xz -C "$TMP"
  SRC="$TMP/focus-guard-main"
fi

# ---------------------------------------------------------------- node.js
NODE="$(command -v node || true)"
for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -z "$NODE" ] && [ -x "$p" ]; then NODE="$p"; fi
done
if [ -z "$NODE" ]; then
  if [ "$OS" = Linux ] && command -v apt-get >/dev/null; then
    say "Installing Node.js"
    apt-get update -qq && apt-get install -y -qq nodejs >/dev/null
    NODE="$(command -v node)"
  else
    die "Node.js is required. Install it from https://nodejs.org (or: brew install node), then run this again."
  fi
fi
echo "Using Node.js $("$NODE" -v) at $NODE"

# ---------------------------------------------------------------- files
say "Installing to $DEST"
stop_service
mkdir -p "$DEST"
rm -f "$DEST/dota-limit/stats-url.txt"
cp -R "$SRC/dota-limit" "$SRC/brave" "$DEST/"
if [ -d /usr/local/dotalimit ]; then
  for f in state.json history.json; do
    if [ -f "/usr/local/dotalimit/$f" ] && [ ! -f "$DEST/dota-limit/$f" ]; then cp "/usr/local/dotalimit/$f" "$DEST/dota-limit/$f"; fi
  done
  rm -rf /usr/local/dotalimit
fi
chown -R root:"$( [ "$OS" = Darwin ] && echo wheel || echo root )" "$DEST"
chmod -R go-w "$DEST"

# ---------------------------------------------------------------- dota 2
say "Setting up Dota 2 match tracking"
# Steam rewrites its config on exit, so it has to be closed before launch options are changed.
pkill -9 -x steam_osx 2>/dev/null || true
pkill -9 -f "dota 2 beta/game/bin/" 2>/dev/null || true
pkill -9 -x steam 2>/dev/null || true
pkill -9 -x steamwebhelper 2>/dev/null || true
sleep 1
DETECTED="$(sudo -H -u "$USER_NAME" "$NODE" "$DEST/dota-limit/setup.js" detect)"
"$NODE" "$DEST/dota-limit/setup.js" write-config "$DEST/dota-limit/config.json" "$USER_NAME" "$DETECTED" >/dev/null
DOTA_DIR="$("$NODE" -e 'console.log(JSON.parse(process.argv[1]).dotaDir || "")' "$DETECTED")"
PATCHED="$("$NODE" -e 'console.log(JSON.parse(process.argv[1]).launchOptionsPatched.length)' "$DETECTED")"
if [ -n "$DOTA_DIR" ]; then
  echo "Found Dota 2 at: $DOTA_DIR"
  if [ "$PATCHED" -gt 0 ]; then echo "Added -gamestateintegration to Dota 2 launch options."; fi
else
  warn "Dota 2 wasn't found. Install it through Steam, then run this installer again."
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

# ---------------------------------------------------------------- brave
say "Blocking Facebook, YouTube and Reddit in Brave"
if [ "$OS" = Darwin ]; then
  "$NODE" "$DEST/brave/make-mobileconfig.js" > "$DEST/brave/focus-guard.mobileconfig"
  if profiles list -all 2>/dev/null | grep -q "local.focusguard.brave"; then
    echo "Brave profile already installed."
  elif [ -z "${CI:-}" ]; then
    sudo -u "$USER_NAME" open "$DEST/brave/focus-guard.mobileconfig" || true
    sudo -u "$USER_NAME" open "x-apple.systempreferences:com.apple.preferences.configurationprofiles" 2>/dev/null || true
    warn "macOS needs you to approve the Brave profile: System Settings > General > Device Management > Focus Guard (Brave) > Install."
  fi
else
  mkdir -p /etc/brave/policies/managed
  cp "$DEST/brave/policy.json" /etc/brave/policies/managed/focus-guard.json
  chmod 644 /etc/brave/policies/managed/focus-guard.json
fi

# ---------------------------------------------------------------- check
STATS_URL="http://$STATS_HOST/"
for _ in $(seq 1 15); do
  if [ -f "$DEST/dota-limit/stats-url.txt" ] && curl -fs "$(cat "$DEST/dota-limit/stats-url.txt")api" >/dev/null 2>&1; then break; fi
  sleep 1
done
if [ -f "$DEST/dota-limit/stats-url.txt" ] && curl -fs "$(cat "$DEST/dota-limit/stats-url.txt")api" >/dev/null 2>&1; then
  STATS_URL="$(cat "$DEST/dota-limit/stats-url.txt")"
  say "Focus Guard is running"
else
  warn "The service didn't answer yet. Check $DEST/dota-limit/log.txt"
fi

cat <<EOF

  Stats page:  $STATS_URL
  Daily limit: best of 3 (resets at 4 AM). Change it in $DEST/dota-limit/config.json

  One last manual step: Brave doesn't let installers add extensions.
    1. Open brave://extensions and turn on Developer mode
    2. Click "Load unpacked" and choose: $DEST/brave/extension
    3. Fully quit Brave and open it again

EOF
