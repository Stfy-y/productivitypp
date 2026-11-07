# Now playing on the Dashboard (Linux)

Shows the song playing on your computer on the Dashboard, with cover art, progress, play/pause/skip and volume, plus a full-screen player. Your phone can show it too, through the sync server.
It works with any player that supports MPRIS, the standard Linux media interface: YouTube Music Desktop, Spotify, Firefox/Chrome tabs, VLC, Rhythmbox, and so on.

Browsers can't see your desktop's media players, so a small helper (`now-playing.py`, Python standard library + PyGObject) reads them and serves the current song at `http://127.0.0.1:8971`.

- It only listens on your own computer, not your network.
- Only `localhost` and the app's web address may read it or press its buttons. Other websites get refused.
- **Album covers and names:** YouTube Music players often report the music video's 16:9 thumbnail, and YouTube Music Desktop can keep reporting an old album name for every track. The helper then asks YouTube Music for the song's square cover and real album (it sends the song's title and artist, or its video ID). If the song isn't on YouTube Music (an uploaded video, say), the thumbnail stays and no album is shown. Turn this off with `--no-covers`.
- **Volume** changes the player's own volume when it has one (YouTube Music Desktop, Spotify, VLC...). Otherwise it changes the computer's output volume (`wpctl` or `pactl`).

## Set it up

1. In the app, open **Settings → Now playing** (or click **Set up** on the Dashboard) and click **Copy**.
2. Paste the command into a terminal and press Enter. It looks like this:
   ```bash
   curl -fsSL https://stfy-y.github.io/productivitypp/extras/now-playing/install.sh | bash -s -- https://stfy-y.github.io/productivitypp/
   ```
3. That's it. The app notices the helper within a few seconds and turns the music card on. From then on the helper starts by itself whenever you log in.

Chrome and Edge may ask whether the site can **access devices on your local network**. Click **Allow**, because that's how the app reaches the helper. Firefox and Zen don't ask.

From a clone of the repo you can also run `./install.sh [app URL]`. To skip a player completely, add `--ignore <part of its name>`.

## On your phone

Your phone can show what's playing on the computer, with play/pause/skip, volume and the full-screen player, inside the normal app.

1. Set up **Sync & background push** (the free Cloudflare Worker, see [`worker/`](../../worker/)) on the computer and on the phone, and make sure the Worker runs the latest `worker.js`.
2. On the computer: **Settings → Now playing → Show on my phone**.
3. Open the app on the phone: the song shows above the tab bar. Tap it for the full-screen player.

How it works: the phone can't talk to the helper directly (an https app may not call a computer on your home network, and iPhone doesn't allow it at all), so the helper sends the song to your Worker and picks up the phone's taps from there. Taps take a second or two.

- The helper sends the song only when something changes (song, play/pause, a seek, the volume), plus a check-in every 10 minutes while something plays, so it stays well inside the Worker's free limits (1,000 storage writes a day). The phone's volume slider sends at most about one change a second while you drag.
- It checks for taps every 5 seconds, and every second while the full-screen player is open on the phone.
- The Worker URL and token are saved in `~/.config/productivitypp/relay.json`, readable only by you.
- Covers stored as files on the computer can't be shown on the phone (YouTube Music, Spotify and browsers use web covers, which work).
- The phone's hardware volume buttons can't control it: web apps can't read them. Use the slider.

## Good to know

- With several players open, the one that's **playing** wins. When everything is paused, the Dashboard shows the last one you used.
- Sounds shorter than 20 seconds (chat notification sounds, for example) are ignored.
- Try it without installing: `python3 now-playing.py`, then open <http://127.0.0.1:8971/now-playing>.
- Logs: `journalctl --user -u productivitypp-now-playing -n 50`
- Remove it: `./uninstall.sh`, or `systemctl --user disable --now productivitypp-now-playing && rm ~/.config/systemd/user/productivitypp-now-playing.service`
