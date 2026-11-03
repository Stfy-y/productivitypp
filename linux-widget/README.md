# Productivity++ widget for Linux (GNOME)

GNOME has no desktop widgets, so this adds Productivity++ to the **top bar**:

- The bar shows how many tasks are due and what's next, e.g. `3 · Dentist 11:00` (or `Now: …` while something is happening).
- Click it for today's **schedule** (your events, Google Calendar events and timed tasks, with times and lengths), the **tasks** due (overdue ones in red), and your **habits** for today.
- Click any item to open the app. There are also *Add task…* and *Add event…* shortcuts.
- It refreshes every 5 minutes and whenever you open the menu.

Works on GNOME 45–50 (Ubuntu 24.04, 25.x, 26.04).

## Requirements

The widget reads your data from your **sync worker** (see [`../worker/README.md`](../worker/README.md)). Your tasks live in the browser, so a desktop extension can't read them directly.

In the app, open **Settings → Widgets** and copy **"Your widget data URL"**.

## Install

```bash
cd ~/productivitypp/linux-widget
./install.sh
```

Paste the widget data URL when asked. Then **log out and back in once**: GNOME on Wayland only discovers new extensions at login. The icon then appears on the right of the top bar.

- To change the URL later: `./install.sh --reconfigure`
- To update after pulling new code, run `./install.sh` again, then log out and back in.
- To remove it: `./uninstall.sh`

The settings live in `~/.config/productivitypp/widget.json`:

```json
{
  "widgetUrl": "https://productivity-sync.<you>.workers.dev/widget?token=…",
  "appUrl": "https://stfy-y.github.io/productivitypp/"
}
```

The widget URL contains your secret token, so the file is only readable by you (`chmod 600`).

## Troubleshooting

- **"Set up" in the bar:** the settings file is missing. Run `./install.sh`.
- **"!" in the bar or "Wrong token":** check the widget URL. Open it in a browser and you should see JSON.
- **Errors:** run `journalctl -f -o cat /usr/bin/gnome-shell` and open the menu.
