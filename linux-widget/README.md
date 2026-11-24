# Productivity++ widget for Linux (GNOME)

GNOME has no desktop widgets, so this adds Productivity++ to the **top bar**:

- The bar shows how many tasks are due and what's next, e.g. `3 · Dentist 11:00` (or `Now: …` while something is happening).
- Click it for today's **schedule** (your Productivity++ events and timed tasks, with times and lengths; Google Calendar events aren't shown), the **tasks** due (overdue ones in red), and your **habits** for today.
- Click any item to open the app. There are also *Add task…* and *Add event…* shortcuts.
- It refreshes every 5 minutes and whenever you open the menu.

### The island

A black pill hangs just under the top bar, a bit like the iPhone's Dynamic Island. It appears only when there's something to show:

- **Now / next:** the event or timed task happening now, with the time left, or the next one starting within the hour (`in 12m`). It opens by itself for a few seconds when an event starts and 5 minutes before one.
- **Now playing:** whatever is playing in any media player that reports to the system (Spotify, YouTube or music in Chrome/Firefox, Rhythmbox, …), with the artwork and an animated equalizer. While music plays, the island takes the same background as the app's full-screen player: soft colours from the album cover, slowly drifting. If an event is also showing, its countdown appears on the right.

Click the island to open it: you get play/pause/skip, the song's progress, and the event's times, location, progress and what comes after. Click the song to bring its player to the front, or the event to open the calendar. The island closes when the mouse leaves it, and hides in the overview and in fullscreen apps.

To turn it off, add `"island": false` to `widget.json` (see below), then log out and back in.

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
  "appUrl": "https://stfy-y.github.io/productivitypp/",
  "island": true
}
```

`island` is optional and defaults to `true`.

The widget URL contains your secret token, so the file is only readable by you (`chmod 600`).

## Troubleshooting

- **"Set up" in the bar:** the settings file is missing. Run `./install.sh`.
- **"!" in the bar or "Wrong token":** check the widget URL. Open it in a browser and you should see JSON.
- **Errors:** run `journalctl -f -o cat /usr/bin/gnome-shell` and open the menu.
