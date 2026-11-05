#!/usr/bin/env bash
# Stops and removes the Productivity++ now-playing helper.
set -euo pipefail
UNIT="productivitypp-now-playing.service"
systemctl --user disable --now "$UNIT" 2>/dev/null || true
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT" "${XDG_DATA_HOME:-$HOME/.local/share}/productivitypp/now-playing.py"
systemctl --user daemon-reload
echo "Removed the now-playing helper."
