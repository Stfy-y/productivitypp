# Now playing on the Dashboard (Linux)

Shows the song playing on your computer on the Dashboard, with cover art, progress, play/pause/skip and volume, plus a full-screen player. Your phone can open the same player as a remote.
It works with any player that supports MPRIS, the standard Linux media interface: YouTube Music Desktop, Spotify, Firefox/Chrome tabs, VLC, Rhythmbox, and so on.

Browsers can't see your desktop's media players, so a small helper (`now-playing.py`, Python standard library + PyGObject) reads them and serves the current song at `http://127.0.0.1:8971`.

- It only listens on your own computer, not your network (unless you turn on the phone remote, see below).
- Only `localhost` and the app's web address may read it or press its buttons. Other websites get refused.
- **Album covers:** YouTube Music players often report the music video's 16:9 thumbnail. The helper then asks YouTube Music for the song's square album cover (it sends the song's title and artist, or its video ID). If the song isn't on YouTube Music, the thumbnail stays. Turn this off with `--no-covers`.
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

## Phone remote

Open **Settings → Now playing** on the computer and click **Set up phone remote**. Then scan the QR code with your phone. The phone gets the full-screen player (cover, play/pause/skip, volume, and swipe left/right to change songs), and it controls the music on the computer. Use **Add to Home Screen** to keep it one tap away.

- The phone and the computer need to be on the same Wi-Fi.
- The helper then also listens on port **8972** on your local network. Every request needs the secret key from the QR code, except the empty page shell. Anyone who has the link and is on your Wi-Fi can control your music, so only share it with your own devices.
- Using a firewall? Allow the port: `sudo ufw allow 8972/tcp`.
- **Turn off phone remote** closes the port and changes the key, so old links stop working.
- The phone page loads the player's code from the app's web address through the helper, so it always matches the app.

## Good to know

- With several players open, the one that's **playing** wins. When everything is paused, the Dashboard shows the last one you used.
- Sounds shorter than 20 seconds (chat notification sounds, for example) are ignored.
- Try it without installing: `python3 now-playing.py`, then open <http://127.0.0.1:8971/now-playing>.
- Logs: `journalctl --user -u productivitypp-now-playing -n 50`
- Remove it: `./uninstall.sh`, or `systemctl --user disable --now productivitypp-now-playing && rm ~/.config/systemd/user/productivitypp-now-playing.service`
