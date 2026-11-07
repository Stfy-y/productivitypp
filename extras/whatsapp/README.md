# Unread WhatsApp messages on the Dashboard (Linux)

Shows the chats with unread messages on the Dashboard: **pinned chats first, then people, then groups**, newest first inside each. Each chat shows its unread count and its newest unread messages (up to 3; in groups, with who sent them). Muted chats are greyed out. Click a chat to open it in WhatsApp Web.

Browsers can't read WhatsApp, so a small helper (`whatsapp-helper.js`) signs in to your account as a **linked device**, the same way WhatsApp Web does, and serves your unread chats at `http://127.0.0.1:8972`. It drives a headless Chrome through [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js).

- **It only reads.** It never sends messages and never marks anything as read: your contacts don't see blue ticks because of it.
- It only listens on your own computer, not your network. Only `localhost` and the app's web address may read it. Other websites get refused, including via DNS-rebinding tricks (it checks the `Host` header).
- Your messages stay on the computer. Nothing goes through the sync server.
- whatsapp-web.js is an **unofficial** client. WhatsApp's terms don't allow unofficial clients; read-only use like this is low risk, but it's your call.
- It runs Chrome in the background: expect about 300 MB of RAM.

## Set it up

1. It needs Node.js 18 or newer: `sudo apt install nodejs npm`
2. In the app, open **Settings → WhatsApp** and click **Copy**.
3. Paste the command into a terminal and press Enter. It looks like this:
   ```bash
   curl -fsSL https://stfy-y.github.io/productivitypp/extras/whatsapp/install.sh | bash -s -- https://stfy-y.github.io/productivitypp/
   ```
4. Back in the app, the Dashboard shows a code. On your phone: **WhatsApp → Settings → Linked devices → Link a device**, and scan it. Loading your chats the first time takes up to a minute.

The helper starts by itself whenever you log in. It uses the Chrome or Chromium you already have. Without one, npm downloads a copy (about 170 MB). The Snap version of Chromium can't be used.

## Good to know

- **WhatsApp stopped loading?** WhatsApp Web changes often and whatsapp-web.js follows. Run the setup command again: it updates both.
- Archived chats, Status updates, Channels and broadcast lists aren't shown (WhatsApp keeps them out of the chat list too).
- Chats you marked as unread by hand show a dot instead of a number.
- The list updates when a message arrives or you read a chat on your phone, and re-checks every minute.
- **Unlink:** **Settings → WhatsApp → Unlink from WhatsApp** in the app, or remove the computer on your phone under Linked devices. The Dashboard then shows a new code.
- The login is stored in `~/.local/share/productivitypp/whatsapp/session`, readable only by you.
- Try it without installing: `npm install` here, then `node whatsapp-helper.js` and open <http://127.0.0.1:8972/unread>.
- Logs: `journalctl --user -u productivitypp-whatsapp -n 50`
- Remove it: `./uninstall.sh` (also deletes the login on this computer), or `systemctl --user disable --now productivitypp-whatsapp`
