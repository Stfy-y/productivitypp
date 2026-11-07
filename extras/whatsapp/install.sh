#!/usr/bin/env bash
# Installs the Productivity++ WhatsApp helper and starts it on every login (systemd user service).
#
# Easiest: copy the command from the app (Settings → WhatsApp). It looks like:
#   curl -fsSL https://stfy-y.github.io/productivitypp/extras/whatsapp/install.sh | bash -s -- https://stfy-y.github.io/productivitypp/
# From a clone of the repo:  ./install.sh [app URL]
# Running it again updates the helper and whatsapp-web.js (do that if WhatsApp stops loading).
set -euo pipefail

APP_URL="https://stfy-y.github.io/productivitypp/"
if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then APP_URL="$1"; shift; fi
APP_URL="${APP_URL%/}/"
ORIGIN="$(printf '%s' "$APP_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"

DEST_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/productivitypp/whatsapp"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="productivitypp-whatsapp.service"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "This needs Node.js 18 or newer. Install it with:  sudo apt install nodejs npm   (then run this again)" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js $(node -v) is too old: this needs 18 or newer (https://nodejs.org)." >&2
  exit 1
fi

# Use the Chrome you already have; otherwise npm downloads one (about 170 MB) just for this
CHROME=""
for c in google-chrome-stable google-chrome chromium chromium-browser brave-browser microsoft-edge; do
  p="$(command -v "$c" 2>/dev/null || true)"
  # the Snap Chromium can't be driven from outside its sandbox
  if [ -n "$p" ] && [ "$(readlink -f "$p" | cut -c1-6)" != "/snap/" ]; then CHROME="$p"; break; fi
done

mkdir -p "$DEST_DIR" "$UNIT_DIR"
HERE=""  # set when run as a file from the repo; empty when piped from curl
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; fi
for f in whatsapp-helper.js package.json; do
  if [ -n "$HERE" ] && [ -f "$HERE/$f" ]; then cp "$HERE/$f" "$DEST_DIR/$f"
  else curl -fsSL "${APP_URL}extras/whatsapp/$f" -o "$DEST_DIR/$f"; fi
done

echo "Installing whatsapp-web.js (takes a minute)…"
rm -f "$DEST_DIR/package-lock.json"  # always take the newest whatsapp-web.js: WhatsApp Web changes often
if [ -n "$CHROME" ]; then
  (cd "$DEST_DIR" && PUPPETEER_SKIP_DOWNLOAD=1 npm install --omit=dev --no-audit --no-fund --loglevel=error)
  CHROME_ARG=" --chrome $CHROME"
else
  (cd "$DEST_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error)
  CHROME_ARG=""
fi

cat > "$UNIT_DIR/$UNIT" <<UNITEOF
[Unit]
Description=Productivity++ WhatsApp helper (shows your unread chats on the app's Dashboard)
After=network-online.target

[Service]
WorkingDirectory=$DEST_DIR
ExecStart=$(command -v node) $DEST_DIR/whatsapp-helper.js --origin $ORIGIN$CHROME_ARG
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNITEOF

systemctl --user daemon-reload
systemctl --user enable "$UNIT" >/dev/null 2>&1
systemctl --user restart "$UNIT"

for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8972/ >/dev/null 2>&1; then
    echo "✓ The WhatsApp helper is set up and starts automatically when you log in."
    echo "  Go back to the app: the Dashboard shows a code to scan with WhatsApp on your phone"
    echo "  (Settings → Linked devices → Link a device)."
    echo "  (If Chrome asks to allow access to devices on your local network, click Allow.)"
    exit 0
  fi
  sleep 0.5
done
echo "Installed, but the helper isn't answering. See what went wrong with:" >&2
echo "  journalctl --user -u $UNIT -n 30" >&2
exit 1
