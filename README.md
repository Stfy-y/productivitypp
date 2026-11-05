# Productivity++

A free, TickTick-inspired productivity PWA: **tasks, calendar, Eisenhower matrix and habit tracker**.
Plain HTML/CSS/JS with no build step and no dependencies. Hosted on GitHub Pages, installable on phone and laptop, and works offline.

## Features

- **Dashboard:** a screen to leave open on your laptop: a big clock, weather and forecast, what's on now and next, today's agenda, tasks, habits and a look at tomorrow. Full screen (`F`), keep-the-screen-on and burn-in protection (it drifts a few pixels now and then). On Linux it can also show the song you're playing, with controls ([`extras/now-playing/`](extras/now-playing/)).
- **Exams:** their own page and editor (type, room, notes, grade), a countdown on the Dashboard and a reminder the day before. They also show in the Calendar with 🎓. Quick add: switch to *Exam* and type `Calculus 15.12 9am`.
- **Tasks:** Today, Next 7 Days, All, Completed. Repeating tasks, reminders, notes, undo.
- **Smart quick add** (press `n` on desktop): `Gym tomorrow 6pm !2`, `Pay rent every month`, `Exam 15.12 at 9`, `Call mom fri`
  - `!1` Urgent & Important · `!2` Important · `!3` Urgent · `!4` Neither
- **Calendar:** month view (habit-progress rings and an agenda for the selected day) and week view. Drag tasks onto days.
- **Eisenhower Matrix:** four quadrants. Drag and drop with a mouse or by long-pressing on touch.
- **Habit tracker:** per-weekday schedules, N-times-per-day goals, streaks, monthly heatmap, reminders.
- **Installable app:** full screen, home-screen icon, app shortcuts, app badge with today's count, light and dark themes.
- **Notifications:** reminders while the app is open. With the optional free worker, reminders also arrive when it's closed.
- **Sync** between devices via your own free Cloudflare Worker (optional).
- **Google Calendar:** see your events in Calendar, Today and Next 7 Days, and send tasks to Google Calendar, where their event stays updated as you edit the task (optional, via the worker).
- **Widgets:** Windows 11 widget board, iOS via Scriptable, Android via shortcuts or a web-widget app.
- Export and import JSON backups.

## Deploy to GitHub Pages

```bash
git init && git add . && git commit -m "Productivity++"
gh repo create productivitypp --public --source=. --push     # or create the repo on github.com and push
```

Then on GitHub: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**.
Your app will be live at `https://<username>.github.io/productivitypp/`.

> Free GitHub accounts need the repo to be **public** for Pages. Your *data* is never in the repo: it lives on your devices and in your own worker.

## Install it like an app

- **Android (Chrome):** open the site → menu ⋮ → **Install app**. Long-press the icon for shortcuts.
- **iPhone (Safari):** Share → **Add to Home Screen**. Open it from the icon. Notifications only work this way.
- **Laptop (Chrome/Edge):** the install icon in the address bar.

## Notifications & sync

See **[worker/README.md](worker/README.md)**: about 5 minutes on Cloudflare's free plan.

| | Without worker | With worker |
|---|---|---|
| Data | per device | synced |
| Reminders while app open | ✅ | ✅ |
| Reminders when app closed | ❌ | ✅ (push) |
| Widget data URL | ❌ | ✅ |
| Google Calendar | ❌ | ✅ |

## Widgets: what's possible

Web apps can't add native home-screen widgets on Android or iOS. That's a platform limit, not one of this app. The free options:

| Platform | Option |
|---|---|
| **Windows 11** | Real PWA widget: install with Edge, then open the Widgets board (`Win+W`) |
| **iPhone** | Free [Scriptable](https://apps.apple.com/app/scriptable/id1405459188) app + [`extras/scriptable-widget.js`](extras/scriptable-widget.js) |
| **Linux (GNOME)** | Top-bar widget with today's schedule, tasks and habits: see [`linux-widget/`](linux-widget/) |
| **Android** | Long-press the app icon and drag *Add task* / *Today* / *Habits* shortcuts to the home screen. For a live list, any "web page widget" app can show `…/widget?format=html&token=…` |

## Project layout

```
index.html, manifest.webmanifest, sw.js   PWA shell, manifest, service worker
css/app.css                               all styles (light/dark)
js/app.js                                 router, actions, wiring
js/store.js                               local data model (localStorage)
js/shared.js                              merge + reminder logic (mirrored in worker/worker.js)
js/parse.js                               smart quick-add parser
js/sync.js, js/notify.js                  sync, notifications, push, badge
js/views/*.js                             tasks, calendar, matrix, habits, settings
worker/                                   optional Cloudflare Worker (sync + push + widget)
widgets/                                  Windows 11 widget template
extras/scriptable-widget.js               iOS widget
```

When you change app files, bump `VERSION` in `sw.js` so installed apps pick up the update.
