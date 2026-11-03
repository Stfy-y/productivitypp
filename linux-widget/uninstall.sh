#!/usr/bin/env bash
set -euo pipefail
UUID="productivitypp@stfy-y.github.io"
gnome-extensions disable "$UUID" 2>/dev/null || true
rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID"
echo "Removed the extension. Your settings file is kept at ~/.config/productivitypp/widget.json (delete it if you like)."
