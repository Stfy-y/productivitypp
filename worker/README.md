# Sync & background push setup (free, about 5 minutes)

The app works on its own, fully offline, with data stored on each device.
This **optional** Cloudflare Worker adds:

- **Sync** between your phone and laptop
- **Push notifications when the app is closed** (task reminders and habit reminders)
- **Widget data** for home-screen widgets (iOS Scriptable, Android web widgets)
- **Now playing on your phone**: the song playing on your Linux computer, with controls (needs the [now-playing helper](../extras/now-playing/))

It runs on Cloudflare's **free plan**. One person's usage stays far below the free limits.

## 1. Create the worker

1. Sign up at <https://dash.cloudflare.com> (free, no card needed).
2. Go to **Workers & Pages → Create → Create Worker**. Name it e.g. `productivity-sync` and click **Deploy**.
3. Click **Edit code**, delete everything, paste the contents of [`worker.js`](worker.js), then click **Deploy**.

## 2. Add storage (KV)

1. Go to **Storage & Databases → KV → Create** and name it `productivity`.
2. Open your worker → **Settings → Bindings → Add → KV namespace**.
   - Variable name: `KV` (exactly)
   - Namespace: `productivity`

## 3. Add your secret token

Open your worker → **Settings → Variables and Secrets → Add**:

| Type   | Name      | Value |
|--------|-----------|-------|
| Secret | `TOKEN`   | a long random password, e.g. 32+ random characters |
| Text   | `SUBJECT` | `mailto:your@email.com` (push services want a contact address) |

## 4. Turn on the reminder clock

Open your worker → **Settings → Trigger events → Add → Cron trigger** → `* * * * *` (every minute).

## 5. Connect the app

On **each device**, open the app → **Settings → Sync & background push**:

1. Worker URL: `https://productivity-sync.<your-subdomain>.workers.dev`
2. Secret token: the `TOKEN` from step 3
3. Tap **Connect**, then **Enable background push** and **Send test push**.

> **iPhone:** push only works after you **Add to Home Screen** from Safari (iOS 16.4+) and open the app from that icon.

## Google Calendar

Optional. Takes about 10 minutes and is free. You sign in once on the worker, and every device then shows your Google events. You can also send tasks to Google Calendar.

1. Open <https://console.cloud.google.com>, then **Select a project → New project** (e.g. `productivity`).
2. **APIs & Services → Library**: search **Google Calendar API** → **Enable**.
3. **Google Auth Platform → Branding** (or "OAuth consent screen"): app name `Productivity++`, your email as support and developer contact. Audience: **External**.
4. **Audience → Publish app** (status "In production"). Don't leave it in *Testing*: in Testing, Google logs you out every 7 days. You don't need verification for personal use. When you sign in you'll see *"Google hasn't verified this app"*: click **Advanced → Go to Productivity++**.
5. **Clients → Create client → Web application**
   - Authorized redirect URI: `https://productivity-sync.<your-subdomain>.workers.dev/gcal/callback` (your worker URL + `/gcal/callback`)
   - Copy the **Client ID** and **Client secret**.
6. In Cloudflare, open your worker → **Settings → Variables and Secrets** and add two **Secrets**: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
7. Make sure the worker runs the latest [`worker.js`](worker.js) (paste it again and deploy if you set it up earlier).
8. In the app: **Settings → Google Calendar → Connect Google Calendar**, sign in, then return to the app.

What you get:
- Google events in **Calendar** (month, week, day agenda), **Today** ("Schedule") and **Next 7 Days**. Tap an event to open it in Google Calendar.
- Tick **Add to Google Calendar** in a task to create a matching event (30 min if the task has a time, otherwise all-day). Editing, dragging or rescheduling the task updates the event. Deleting the task, or unticking the box, deletes the event. Repeating tasks move their event to the next occurrence.
- Pick which calendars to show and which calendar tasks go to.

Permissions asked: *see your calendar list* and *view and edit events*. The tokens are stored only in your worker's KV storage. **Disconnect** revokes them.

## How it works

- Each device keeps a full local copy. Changes are merged per item (newest edit wins; habit check-ins merge per day), so offline edits on both devices are kept.
- Every minute the worker checks whether a reminder is due in your time zone. If one is, it sends a content-free "wake up" push to your devices. The service worker then fetches `/due` (with your token) and shows the notification. Because the push carries no content, there's no encryption code to maintain.
- The VAPID push keys are generated automatically on first use and stored in KV.

## Free-tier budget

| Resource | Free limit / day | This app uses |
|---|---|---|
| Worker requests | 100,000 | ~1,440 cron runs + your syncs |
| KV reads | 100,000 | ~1,500 |
| KV writes | 1,000 | 1 per sync (edits are batched every few seconds) |

## Endpoints

`GET/PUT /state` · `GET /vapid` · `POST /subscribe` · `POST /unsubscribe` · `GET /due` · `POST /test-push` · `GET /widget` (JSON) · `GET /widget?format=html`

Everything except `/vapid` needs `Authorization: Bearer <TOKEN>` or `?token=<TOKEN>`.
