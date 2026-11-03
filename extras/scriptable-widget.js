// Productivity++ widget for iPhone/iPad (free "Scriptable" app): today's agenda.
// 1. Install Scriptable from the App Store, create a new script, paste this file.
// 2. Replace WIDGET_URL with the "widget data URL" from the app's Settings → Widgets.
// 3. Home Screen: long-press → Edit → Add Widget → Scriptable → pick a size,
//    then tap the widget → Script: this script. Also works on the Lock Screen.
const WIDGET_URL = "https://YOUR-WORKER.workers.dev/widget?token=YOUR_TOKEN";
const APP_URL = "https://stfy-y.github.io/productivitypp/#/calendar";

const QUAD = { 1: "#e5484d", 2: "#f5a524", 3: "#3b82f6", 4: "#22a06b" };
const text = Color.dynamic(new Color("#1d2130"), new Color("#e9eaf0"));
const muted = Color.dynamic(new Color("#6b7185"), new Color("#9097ab"));
const accent = Color.dynamic(new Color("#4f6bed"), new Color("#7088ff"));
const red = new Color("#e5484d");

/* ---------- Data (cached so the widget still works offline) ---------- */
const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), "productivitypp-widget.json");
let data = null;
let offline = false;
const configured = !WIDGET_URL.includes("YOUR-WORKER");
if (configured) {
  try {
    const req = new Request(WIDGET_URL);
    req.timeoutInterval = 15;
    data = await req.loadJSON();
    if (!data || data.error) throw new Error(data?.error || "No data");
    fm.writeString(cachePath, JSON.stringify(data));
  } catch (e) {
    offline = true;
    if (fm.fileExists(cachePath)) data = JSON.parse(fm.readString(cachePath));
  }
}

/* ---------- Build today's agenda ---------- */
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "")); return m ? +m[1] * 60 + +m[2] : -1; };
const clock = (m) => {
  const d = new Date(2000, 0, 1, Math.floor(m / 60), m % 60);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?(AM|PM)$/i, (x) => x.trim().toLowerCase()[0]);
};
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? m % 60 : ""}` : `${m}m`);
const now = new Date();
const nowMin = now.getHours() * 60 + now.getMinutes();
const isToday = data && data.date === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

const timed = [];
const allDay = [];
for (const e of (isToday && data.events) || []) {
  if (e.allDay) { allDay.push({ title: e.title, color: e.color }); continue; }
  const s = toMin(e.time), en = toMin(e.end);
  if (s >= 0) timed.push({ title: e.title, s, e: en > s ? en : s + 30, color: e.color || "#4f6bed", sub: e.location || "" });
}
for (const t of (isToday && data.tasks) || []) {
  if (!t.time || t.overdue) continue;
  const s = toMin(t.time);
  if (s >= 0) timed.push({ title: t.title, s, e: s + (t.duration || 30), color: QUAD[t.quadrant] || "#4f6bed", task: true });
}
timed.sort((a, b) => a.s - b.s || a.e - b.e);
const upcoming = timed.filter((i) => i.e > nowMin); // finished items drop off
const doneCount = timed.length - upcoming.length;
const untimed = ((isToday && data.tasks) || []).filter((t) => !t.time || t.overdue);
const habits = (isToday && data.habits) || [];

/* ---------- Layout ---------- */
const family = config.widgetFamily || "large";
const w = new ListWidget();
w.url = APP_URL;
w.backgroundColor = Color.dynamic(new Color("#ffffff"), new Color("#1b1d24"));
// refresh when the next item starts or ends (iOS may still wait longer), at most 15 minutes away
const nextChange = upcoming.length ? Math.min(...upcoming.map((i) => (i.s > nowMin ? i.s : i.e))) : nowMin + 15;
w.refreshAfterDate = new Date(Date.now() + Math.max(5, Math.min(15, nextChange - nowMin)) * 60000);

function addText(stack, str, size, color, { bold = false, lines = 1 } = {}) {
  const t = stack.addText(str);
  t.font = bold ? Font.semiboldSystemFont(size) : Font.systemFont(size);
  t.textColor = color;
  t.lineLimit = lines;
  return t;
}

function agendaRow(item, compact) {
  const live = item.s <= nowMin && nowMin < item.e;
  const row = w.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  row.spacing = 6;
  const tm = row.addStack();
  tm.size = new Size(compact ? 34 : 40, 0);
  addText(tm, live ? "now" : clock(item.s), compact ? 10 : 11, live ? accent : muted, { bold: live });
  const bar = row.addStack();
  bar.size = new Size(3, compact ? 14 : 16);
  bar.cornerRadius = 1.5;
  bar.backgroundColor = new Color(item.color);
  addText(row, `${item.task ? "○ " : ""}${item.title}`, compact ? 12 : 13, text, { bold: live });
  row.addSpacer();
  if (!compact) addText(row, dur(item.e - item.s), 11, muted);
}

function header(title, right) {
  const h = w.addStack();
  h.layoutHorizontally();
  h.centerAlignContent();
  addText(h, title, family === "small" ? 13 : 14, text, { bold: true });
  h.addSpacer();
  if (right) addText(h, right, 11, offline ? red : muted);
}

/* Lock Screen widgets */
if (family === "accessoryInline" || family === "accessoryRectangular" || family === "accessoryCircular") {
  const next = upcoming[0];
  if (family === "accessoryCircular") {
    w.addSpacer();
    const t = w.addText(`${upcoming.length}`); t.font = Font.boldSystemFont(20); t.centerAlignText();
    const l = w.addText("left"); l.font = Font.systemFont(9); l.centerAlignText();
    w.addSpacer();
  } else if (family === "accessoryInline") {
    w.addText(next ? `${next.s <= nowMin ? "Now" : clock(next.s)} ${next.title}` : "Nothing else today");
  } else {
    if (!next) w.addText("Nothing else today ✨").font = Font.systemFont(13);
    for (const item of upcoming.slice(0, 3)) {
      const t = w.addText(`${item.s <= nowMin ? "Now" : clock(item.s)}  ${item.title}`);
      t.font = Font.systemFont(12); t.lineLimit = 1;
    }
  }
} else if (!configured) {
  header("Productivity++");
  w.addSpacer(6);
  addText(w, "Open this script in Scriptable and set WIDGET_URL (from the app: Settings → Widgets).", 12, muted, { lines: 4 });
} else if (!data) {
  header("Productivity++", "offline");
  w.addSpacer(6);
  addText(w, "Couldn't load your agenda. Check your connection and the widget URL.", 12, muted, { lines: 4 });
} else {
  w.setPadding(12, 14, 12, 14);
  const dayName = now.toLocaleDateString([], { weekday: family === "small" ? "short" : "long", month: "short", day: "numeric" });
  header(family === "small" ? dayName : `Today · ${dayName}`, offline ? "offline" : upcoming.length ? `${upcoming.length} left` : "");
  w.addSpacer(family === "small" ? 6 : 8);

  const maxRows = { small: 4, medium: 4, large: 11, extraLarge: 11 }[family] ?? 4;
  if (allDay.length && family !== "small") {
    const ad = w.addStack();
    ad.layoutHorizontally();
    ad.spacing = 6;
    addText(ad, "All day", 11, muted);
    addText(ad, allDay.map((a) => a.title).join(" · "), 11, text, { lines: 1 });
    w.addSpacer(4);
  }
  if (!upcoming.length) {
    addText(w, timed.length ? "Done for the day ✨" : "Nothing scheduled today", 13, muted);
  } else {
    const shown = upcoming.slice(0, maxRows);
    shown.forEach((item, i) => {
      agendaRow(item, family === "small");
      if (i < shown.length - 1) w.addSpacer(family === "small" ? 3 : 5);
    });
    if (upcoming.length > maxRows) { w.addSpacer(3); addText(w, `+${upcoming.length - maxRows} more`, 11, muted); }
  }

  if (family === "medium" && untimed.length) {
    w.addSpacer(6);
    const late = untimed.filter((t) => t.overdue).length;
    addText(w, `${untimed.length} task${untimed.length === 1 ? "" : "s"} due${late ? ` · ${late} overdue` : ""}`, 11, late ? red : muted);
  }

  if (family === "large" || family === "extraLarge") {
    if (untimed.length) {
      w.addSpacer(10);
      addText(w, "TASKS", 10, muted, { bold: true });
      w.addSpacer(3);
      for (const t of untimed.slice(0, 4)) {
        const r = w.addStack(); r.layoutHorizontally(); r.centerAlignContent(); r.spacing = 6;
        const dot = r.addStack(); dot.size = new Size(7, 7); dot.cornerRadius = 3.5; dot.backgroundColor = new Color(QUAD[t.quadrant] || "#4f6bed");
        addText(r, t.title, 12, t.overdue ? red : text);
        w.addSpacer(2);
      }
      if (untimed.length > 4) addText(w, `+${untimed.length - 4} more`, 11, muted);
    }
    if (habits.length) {
      w.addSpacer(8);
      addText(w, habits.map((h) => `${h.done ? "✅" : "⬜️"}${h.icon || ""}`).join("  "), 13, text, { lines: 2 });
    }
  }
  if (doneCount && family !== "small") { w.addSpacer(4); addText(w, `${doneCount} done earlier`, 10, muted); }
}
w.addSpacer();

if (config.runsInWidget) Script.setWidget(w);
else await w.presentLarge();
Script.complete();
