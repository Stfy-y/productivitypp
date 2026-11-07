#!/usr/bin/env bash
# Stops and removes the Productivity++ WhatsApp helper, including its WhatsApp login on this computer.
set -euo pipefail
UNIT="productivitypp-whatsapp.service"
systemctl --user disable --now "$UNIT" 2>/dev/null || true
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT"
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/productivitypp/whatsapp"
systemctl --user daemon-reload
echo "Removed the WhatsApp helper. Also remove the computer from WhatsApp on your phone: Settings → Linked devices."
