#!/usr/bin/env bash
# Installs the Productivity++ top-bar widget for GNOME (Ubuntu 23.10+ / GNOME 45+).
set -euo pipefail

UUID="productivitypp@stfy-y.github.io"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/productivitypp"
CFG="$CFG_DIR/widget.json"

echo "Installing the extension to $DEST"
mkdir -p "$DEST"
cp -r "$SRC/." "$DEST/"

mkdir -p "$CFG_DIR"
if [ -f "$CFG" ] && [ "${1:-}" != "--reconfigure" ]; then
  echo "Keeping your existing settings in $CFG (run with --reconfigure to change them)"
else
  echo
  echo "Paste your widget data URL. Find it in the app: Settings → Widgets → \"Your widget data URL\"."
  read -rp "Widget data URL: " WIDGET_URL
  read -rp "App URL [https://stfy-y.github.io/productivitypp/]: " APP_URL
  APP_URL="${APP_URL:-https://stfy-y.github.io/productivitypp/}"
  python3 -c 'import json,sys; json.dump({"widgetUrl": sys.argv[1], "appUrl": sys.argv[2]}, open(sys.argv[3], "w"), indent=2)' \
    "$WIDGET_URL" "$APP_URL" "$CFG"
  chmod 600 "$CFG"
  echo "Saved settings to $CFG"
fi

if gnome-extensions enable "$UUID" 2>/dev/null; then
  echo
  echo "Enabled. If the icon doesn't appear in the top bar yet, log out and back in once."
else
  echo
  echo "Almost done: log out and back in (GNOME on Wayland only discovers new extensions at login),"
  echo "then run:  gnome-extensions enable $UUID"
fi
