// Productivity++ top-bar widget for GNOME Shell 45+.
// Reads your widget data URL (Settings → Widgets in the app; needs the sync worker)
// from ~/.config/productivitypp/widget.json and shows today's schedule, tasks and habits.
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const CONFIG_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'productivitypp', 'widget.json']);
const REFRESH_SECONDS = 300;
const SETUP_URL = 'https://github.com/Stfy-y/productivitypp/tree/master/linux-widget';
const QUAD = { 1: '#e5484d', 2: '#f5a524', 3: '#3b82f6', 4: '#22a06b' };

function readConfig() {
  try {
    const [, bytes] = GLib.file_get_contents(CONFIG_PATH);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? +m[1] * 60 + +m[2] : -1; };
const nowMin = () => { const d = GLib.DateTime.new_now_local(); return d.get_hour() * 60 + d.get_minute(); };
const fmtDur = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);
const shorten = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const Indicator = GObject.registerClass(
class ProductivityIndicator extends PanelMenu.Button {
  _init(ext) {
    super._init(0.5, 'Productivity++');
    this._ext = ext;
    this._session = new Soup.Session({ timeout: 20 });
    this._data = null;
    this._error = null;
    this._loading = false;

    const box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });
    box.add_child(new St.Icon({
      gicon: Gio.icon_new_for_string(`${ext.path}/icons/productivitypp-symbolic.svg`),
      style_class: 'system-status-icon',
    }));
    this._label = new St.Label({ text: '…', y_align: Clutter.ActorAlign.CENTER, style_class: 'ppp-label' });
    box.add_child(this._label);
    this.add_child(box);
    this.menu.box.add_style_class_name('ppp-menu');

    this.menu.connect('open-state-changed', (_menu, open) => { if (open) this.refresh(); });
    this._render();
    this.refresh();
    this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
      this.refresh();
      return GLib.SOURCE_CONTINUE;
    });
    // Keep the "next up" label current between refreshes
    this._tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
      this._renderLabel();
      return GLib.SOURCE_CONTINUE;
    });
  }

  refresh() {
    const cfg = readConfig();
    this._cfg = cfg;
    if (!cfg?.widgetUrl) {
      this._error = 'not-configured';
      this._render();
      return;
    }
    if (this._loading) return;
    let msg;
    try {
      msg = Soup.Message.new('GET', cfg.widgetUrl);
    } catch {
      msg = null;
    }
    if (!msg) {
      this._error = 'The widget URL in widget.json is not valid';
      this._render();
      return;
    }
    this._loading = true;
    this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
      this._loading = false;
      if (this._destroyed) return;
      try {
        const bytes = session.send_and_read_finish(res);
        const status = msg.get_status();
        if (status === 401) throw new Error('Wrong token in the widget URL');
        if (status !== 200) throw new Error(`Server answered ${status}`);
        this._data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        this._error = null;
        this._updatedAt = GLib.DateTime.new_now_local();
      } catch (e) {
        this._error = e.message || String(e);
      }
      this._render();
    });
  }

  /** Timed items (events + tasks with a time) for today, sorted. */
  _schedule() {
    const d = this._data || {};
    const items = [];
    for (const e of d.events || []) {
      if (e.allDay) continue;
      items.push({ title: e.title, s: toMin(e.time), e: toMin(e.end), color: e.color, kind: 'event', location: e.location });
    }
    for (const t of d.tasks || []) {
      if (!t.time || t.overdue) continue;
      const s = toMin(t.time);
      items.push({ title: t.title, s, e: s + (t.duration || 30), color: QUAD[t.quadrant], kind: 'task' });
    }
    return items.filter((i) => i.s >= 0).sort((a, b) => a.s - b.s);
  }

  _renderLabel() {
    if (this._error === 'not-configured') { this._label.text = 'Set up'; return; }
    if (this._error && !this._data) { this._label.text = '!'; return; }
    const d = this._data || {};
    const due = (d.tasks || []).length;
    const now = nowMin();
    const current = this._schedule().find((i) => i.s <= now && now < i.e);
    const next = this._schedule().find((i) => i.s > now);
    let text = `${due}`;
    if (current) text += ` · Now: ${shorten(current.title, 22)}`;
    else if (next) text += ` · ${shorten(next.title, 22)} ${next.s >= 0 ? this._clock(next.s) : ''}`;
    this._label.text = text;
  }

  _clock(m) {
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }

  _row(text, { color, right, styleClass, onActivate } = {}) {
    const item = new PopupMenu.PopupBaseMenuItem({ reactive: !!onActivate, can_focus: !!onActivate });
    if (color) item.add_child(new St.Widget({ style_class: 'ppp-dot', style: `background-color: ${color};`, y_align: Clutter.ActorAlign.CENTER }));
    if (right !== undefined) item.add_child(new St.Label({ text: right, style_class: 'ppp-time', y_align: Clutter.ActorAlign.CENTER }));
    item.add_child(new St.Label({ text, style_class: styleClass || 'ppp-title', y_align: Clutter.ActorAlign.CENTER, x_expand: true }));
    if (onActivate) item.connect('activate', onActivate);
    this.menu.addMenuItem(item);
    return item;
  }

  _open(hash = '') {
    const base = this._cfg?.appUrl || 'https://stfy-y.github.io/productivitypp/';
    try {
      Gio.AppInfo.launch_default_for_uri(base.replace(/#.*$/, '') + hash, null);
    } catch (e) {
      Main.notify('Productivity++', `Could not open the app: ${e.message}`);
    }
  }

  _render() {
    this._renderLabel();
    this.menu.removeAll();

    if (this._error === 'not-configured') {
      this._row('Productivity++ widget is not set up yet', { styleClass: 'ppp-header' });
      this._row(`Create ${CONFIG_PATH.replace(GLib.get_home_dir(), '~')}`, { styleClass: 'ppp-summary' });
      this._row('with your widget data URL (run install.sh).', { styleClass: 'ppp-summary' });
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this._row('Open setup guide', { onActivate: () => Gio.AppInfo.launch_default_for_uri(SETUP_URL, null) });
      this._row('Refresh', { onActivate: () => this.refresh() });
      return;
    }

    const d = this._data;
    const header = GLib.DateTime.new_now_local().format('%A, %B %-d');
    this._row(header, { styleClass: 'ppp-header' });
    if (this._error) this._row(`⚠ ${this._error}`, { styleClass: 'ppp-error' });
    if (!d) {
      this._row('Loading…', { styleClass: 'ppp-summary' });
    } else {
      const now = nowMin();
      const schedule = this._schedule();
      const allDay = (d.events || []).filter((e) => e.allDay);
      const habits = d.habits || [];
      const done = habits.filter((h) => h.done).length;
      this._row(`${(d.tasks || []).length} tasks due · ${schedule.length} scheduled · ${done}/${habits.length} habits`, { styleClass: 'ppp-summary' });

      if (allDay.length || schedule.length) {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Schedule'));
        for (const e of allDay) this._row(e.title, { color: e.color, right: 'All day', onActivate: () => this._open('#/calendar') });
        for (const i of schedule) {
          const past = i.e <= now;
          const isNow = i.s <= now && now < i.e;
          const label = `${i.title}${i.location ? ` · ${i.location}` : ''}  (${fmtDur(Math.max(0, i.e - i.s))})`;
          this._row(shorten(label, 60), {
            color: i.color, right: this._clock(i.s),
            styleClass: past ? 'ppp-done' : isNow ? 'ppp-now' : 'ppp-title',
            onActivate: () => this._open('#/calendar'),
          });
        }
      }

      const tasks = (d.tasks || []).filter((t) => !t.time || t.overdue);
      if (tasks.length) {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Tasks'));
        for (const t of tasks.slice(0, 12)) {
          this._row(shorten(t.title, 60), {
            color: QUAD[t.quadrant], right: t.overdue ? 'Overdue' : '',
            styleClass: t.overdue ? 'ppp-overdue' : 'ppp-title', onActivate: () => this._open('#/today'),
          });
        }
        if (tasks.length > 12) this._row(`+${tasks.length - 12} more`, { styleClass: 'ppp-summary', onActivate: () => this._open('#/today') });
      }

      if (habits.length) {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Habits'));
        for (const h of habits) {
          const progress = h.goal > 1 ? ` ${h.count}/${h.goal}` : '';
          this._row(`${h.done ? '✅' : '⬜'}  ${h.icon || ''} ${h.name}${progress}`, {
            styleClass: h.done ? 'ppp-done' : 'ppp-title', onActivate: () => this._open('#/habits'),
          });
        }
      }

      if (!schedule.length && !allDay.length && !tasks.length && !habits.length) this._row('Nothing for today 🎉', { styleClass: 'ppp-summary' });
    }

    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    this._row('Open Productivity++', { onActivate: () => this._open('#/today') });
    this._row('Add task…', { onActivate: () => this._open('#/add') });
    this._row('Add event…', { onActivate: () => this._open('#/add-event') });
    this._row(this._updatedAt ? `Refresh (updated ${this._updatedAt.format('%H:%M')})` : 'Refresh', { onActivate: () => this.refresh() });
  }

  destroy() {
    this._destroyed = true;
    if (this._timer) GLib.source_remove(this._timer);
    if (this._tick) GLib.source_remove(this._tick);
    this._timer = this._tick = null;
    this._session?.abort();
    this._session = null;
    super.destroy();
  }
});

export default class ProductivityExtension extends Extension {
  enable() {
    this._indicator = new Indicator(this);
    Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');
  }

  disable() {
    this._indicator?.destroy();
    this._indicator = null;
  }
}
