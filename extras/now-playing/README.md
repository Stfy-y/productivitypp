# Now playing on the Dashboard (Linux)

Shows the song playing on your computer on the Dashboard, with cover art, progress and play/pause/skip buttons.
It works with any player that supports MPRIS, the standard Linux media interface: YouTube Music Desktop, Spotify, Firefox/Chrome tabs, VLC, Rhythmbox, and so on.

Browsers can't see your desktop's media players, so a small helper (`now-playing.py`, Python standard library + PyGObject) reads them and serves the current song at `http://127.0.0.1:8971`.

- It only listens on your own computer, not your network.
- Only `localhost` and the app's web address may read it or press its buttons. Other websites get refused.
- Nothing leaves your computer.

## Set it up

1. In the app, open **Settings → Now playing** (or click **Set up** on the Dashboard) and click **Copy**.
2. Paste the command into a terminal and press Enter. It looks like this:
   ```bash
   curl -fsSL https://stfy-y.github.io/productivitypp/extras/now-playing/install.sh | bash -s -- https://stfy-y.github.io/productivitypp/
   ```
3. That's it. The app notices the helper within a few seconds and turns the music card on. From then on the helper starts by itself whenever you log in.

Chrome and Edge may ask whether the site can **access devices on your local network**. Click **Allow**, because that's how the app reaches the helper. Firefox and Zen don't ask.

From a clone of the repo you can also run `./install.sh [app URL]`. To skip a player completely, add `--ignore <part of its name>`.

## Good to know

- With several players open, the one that's **playing** wins. When everything is paused, the Dashboard shows the last one you used.
- Sounds shorter than 20 seconds (chat notification sounds, for example) are ignored.
- Try it without installing: `python3 now-playing.py`, then open <http://127.0.0.1:8971/now-playing>.
- Logs: `journalctl --user -u productivitypp-now-playing -n 50`
- Remove it: `./uninstall.sh`, or `systemctl --user disable --now productivitypp-now-playing && rm ~/.config/systemd/user/productivitypp-now-playing.service`
