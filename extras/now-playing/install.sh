#!/usr/bin/env bash
# Installs the Productivity++ now-playing helper and starts it on every login (systemd user service).
#
# Easiest: copy the command from the app (Settings → Now playing). It looks like:
#   curl -fsSL https://stfy-y.github.io/productivitypp/extras/now-playing/install.sh | bash -s -- https://stfy-y.github.io/productivitypp/
# From a clone of the repo:  ./install.sh [app URL] [--ignore player-name ...]
set -euo pipefail

APP_URL="https://stfy-y.github.io/productivitypp/"
if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then APP_URL="$1"; shift; fi
APP_URL="${APP_URL%/}/"
ORIGIN="$(printf '%s' "$APP_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
EXTRA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ignore) EXTRA="$EXTRA --ignore $2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

DEST_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/productivitypp"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="productivitypp-now-playing.service"

if ! python3 -c 'import gi' 2>/dev/null; then
  echo "This needs PyGObject. Install it with:  sudo apt install python3-gi   (then run this again)" >&2
  exit 1
fi

mkdir -p "$DEST_DIR" "$UNIT_DIR"
HERE=""  # set when run as a file from the repo; empty when piped from curl
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; fi
if [ -n "$HERE" ] && [ -f "$HERE/now-playing.py" ]; then
  cp "$HERE/now-playing.py" "$DEST_DIR/now-playing.py"
else
  echo "Downloading the helper from ${APP_URL}"
  curl -fsSL "${APP_URL}extras/now-playing/now-playing.py" -o "$DEST_DIR/now-playing.py"
fi

cat > "$UNIT_DIR/$UNIT" <<EOF
[Unit]
Description=Productivity++ now-playing helper (shares your current song with the app's Dashboard)
After=graphical-session.target

[Service]
ExecStart=/usr/bin/env python3 $DEST_DIR/now-playing.py --origin $ORIGIN$EXTRA
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable "$UNIT" >/dev/null 2>&1
systemctl --user restart "$UNIT"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:8971/ >/dev/null 2>&1; then
    echo "✓ Now playing is set up and starts automatically when you log in."
    echo "  Go back to the app: it connects by itself in a few seconds."
    echo "  (If Chrome asks to allow access to devices on your local network, click Allow.)"
    exit 0
  fi
  sleep 0.5
done
echo "Installed, but the helper isn't answering. See what went wrong with:" >&2
echo "  journalctl --user -u $UNIT -n 20" >&2
exit 1
