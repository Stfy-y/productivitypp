// Productivity++ widget for iPhone/iPad, using the free "Scriptable" app.
// 1. Install Scriptable from the App Store, create a new script, paste this file.
// 2. Replace WIDGET_URL with the "widget data URL" from the app's Settings → Widgets.
// 3. Add a Scriptable widget to your Home Screen, long-press → Edit Widget → choose this script.
const WIDGET_URL = "https://YOUR-WORKER.workers.dev/widget?token=YOUR_TOKEN";
const APP_URL = "https://YOUR-USERNAME.github.io/YOUR-REPO/#/today";

const COLORS = { 1: "#e5484d", 2: "#f5a524", 3: "#3b82f6", 4: "#22a06b" };
let data;
try { data = await new Request(WIDGET_URL).loadJSON(); } catch (e) { data = { date: "Offline", tasks: [], habits: [] }; }

const w = new ListWidget();
w.backgroundColor = Color.dynamic(new Color("#ffffff"), new Color("#1b1d24"));
w.url = APP_URL;
w.setPadding(12, 14, 12, 14);
const text = Color.dynamic(new Color("#1d2130"), new Color("#e9eaf0"));
const muted = Color.dynamic(new Color("#6b7185"), new Color("#9097ab"));

const head = w.addText(`Today · ${data.tasks.length} task${data.tasks.length === 1 ? "" : "s"}`);
head.font = Font.boldSystemFont(14); head.textColor = text;
w.addSpacer(6);

const family = config.widgetFamily || "medium";
const max = family === "small" ? 4 : family === "large" ? 12 : 5;
for (const t of data.tasks.slice(0, max)) {
  const row = w.addStack(); row.centerAlignContent();
  const dot = row.addText("●"); dot.font = Font.systemFont(9); dot.textColor = new Color(COLORS[t.quadrant]);
  row.addSpacer(5);
  const tt = row.addText(t.title); tt.font = Font.systemFont(13); tt.textColor = text; tt.lineLimit = 1;
  if (t.overdue || t.time) { row.addSpacer(); const m = row.addText(t.overdue ? "late" : t.time); m.font = Font.systemFont(11); m.textColor = t.overdue ? new Color("#e5484d") : muted; }
  w.addSpacer(3);
}
if (!data.tasks.length) { const n = w.addText("All clear 🎉"); n.font = Font.systemFont(13); n.textColor = muted; }

if (family !== "small" && data.habits.length) {
  w.addSpacer(6);
  const hs = w.addText(data.habits.map(h => `${h.done ? "✅" : "⬜️"}${h.icon}`).join("  "));
  hs.font = Font.systemFont(13); hs.lineLimit = 2;
}
w.addSpacer();
w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
if (config.runsInWidget) Script.setWidget(w); else await w.presentMedium();
Script.complete();
