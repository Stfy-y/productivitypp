// The island's background while music plays: the same look as the app's full-screen "Now playing"
// (js/nowplaying-full.js + .npf-* in css/app.css): a dark base and soft blobs in the cover's own
// colours, slowly drifting, with a vignette. St can't blur or blend, so it's painted with cairo.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import St from 'gi://St';
import Cairo from 'cairo';

const FADE_MS = 1600; // colour change between songs (the app's 1.6s transition)
const FRAME_MS = 100; // the blobs move a few pixels per second, so 10 fps is smooth

/* ---------- Cover colours (port of extractPalette in js/nowplaying-full.js) ---------- */
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)]; // 0..1
}

const palettes = new Map(); // file uri -> [[r,g,b] x4] (0..1) or null

/** Up to 4 distinct, fairly vivid colours, toned so white text stays readable on top. */
export function paletteFor(uri) {
  if (palettes.has(uri)) return palettes.get(uri);
  let pal = null;
  try {
    const path = Gio.File.new_for_uri(uri).get_path();
    const N = 40;
    const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, N, N, false);
    const px = pb.get_pixels();
    const nc = pb.get_n_channels(), stride = pb.get_rowstride(), alpha = pb.get_has_alpha();
    const bins = new Map();
    for (let y = 0; y < pb.get_height(); y++) {
      for (let x = 0; x < pb.get_width(); x++) {
        const i = y * stride + x * nc;
        if (alpha && px[i + 3] < 128) continue;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const [, s, l] = rgbToHsl(r, g, b);
        const key = (r >> 5) << 6 | (g >> 5) << 3 | (b >> 5);
        const w = 1 + s * 3 * (1 - Math.abs(l - 0.5) * 1.4); // favour colourful mid-tones over greys
        const bin = bins.get(key) || { w: 0, r: 0, g: 0, b: 0, n: 0 };
        bin.w += w; bin.r += r; bin.g += g; bin.b += b; bin.n++;
        bins.set(key, bin);
      }
    }
    const sorted = [...bins.values()].sort((a, b) => b.w - a.w).map((b) => [b.r / b.n, b.g / b.n, b.b / b.n]);
    const picked = [];
    for (const col of sorted) {
      if (picked.every((p) => Math.hypot(p[0] - col[0], p[1] - col[1], p[2] - col[2]) > 70)) picked.push(col);
      if (picked.length === 4) break;
    }
    if (picked.length) {
      const hsl = picked.map(([r, g, b]) => rgbToHsl(r, g, b));
      while (hsl.length < 4) { const [h, s, l] = hsl[hsl.length % picked.length]; hsl.push([(h + 18) % 360, s, l * 0.7]); }
      pal = hsl.map(([h, s, l], i) => {
        const L = Math.min(0.52, Math.max(i === 3 ? 0.12 : 0.2, l)); // the base (4th) may go darker
        return hslToRgb(h, Math.min(1, s * 1.15), L);
      });
    }
  } catch (e) {
    console.warn(`Productivity++ island: could not read cover colours: ${e.message}`);
  }
  palettes.set(uri, pal);
  return pal;
}

/* ---------- The animated background ---------- */
// Blobs as in .npf-blob.b1–b4: [colour index, centre x/y (fraction of the long side, from the
// left/top or right/bottom edge), drift (fraction of width/height), end scale, period s, opacity].
const BLOBS = [
  { c: 0, x: 0.15, y: 0.1, fromRight: false, fromBottom: false, dx: 0.22, dy: 0.18, s: 1.15, p: 28, a: 0.75 },
  { c: 1, x: 0.15, y: 0.05, fromRight: true, fromBottom: true, dx: -0.2, dy: -0.14, s: 0.9, p: 34, a: 0.75 },
  { c: 2, x: 0.05, y: 0.45, fromRight: true, fromBottom: false, dx: -0.26, dy: 0.22, s: 1.1, p: 40, a: 0.75 },
  { c: 0, x: 0.2, y: 0.1, fromRight: false, fromBottom: true, dx: -0.2, dy: -0.14, s: 0.9, p: 46, a: 0.4, reverse: true },
];
const BLACK = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
const mix = (a, b, t) => a.map((col, i) => col.map((v, j) => v + (b[i][j] - v) * t));

// Painting with cairo is CPU work on the compositor's thread, so it's done as rarely as possible:
// the background is painted at the island's final size and only *stretched* (GPU, free) while the
// island grows or shrinks, and the drift repaints only every FRAME_MS while nothing is animating.
export class ArtBackground {
  constructor(island, clip) {
    this._island = island;
    this._clip = clip;
    this._w = this._h = 1;
    this.actor = new St.DrawingArea({ opacity: 0 });
    this._clipSignals = ['notify::width', 'notify::height'].map((n) => clip.connect(n, () => this._syncScale()));
    // At logout the shell tears actors down without calling disable(): stop listening once we're gone
    this.actor.connect('destroy', () => this._teardown());
    this.actor.connect('repaint', (area) => this._paint(area));
    this._from = BLACK;
    this._to = BLACK;
    this._fadeStart = 0;
    this._t0 = GLib.get_monotonic_time();
  }

  /** The size the island is animating to: paint at that size, stretch to the current one. */
  setTargetSize(w, h) {
    if (w === this._w && h === this._h) return;
    this._w = Math.max(1, w);
    this._h = Math.max(1, h);
    this.actor.set_size(this._w, this._h);
    this._syncScale();
  }

  _syncScale() {
    if (this._dead) return;
    this.actor.set_scale(this._clip.width / this._w, this._clip.height / this._h);
  }

  /** New cover colours (null = none: fades to plain black). */
  setPalette(pal) {
    this._from = this._colors();
    this._to = pal || BLACK;
    this._fadeStart = GLib.get_monotonic_time();
    this._syncIslandColor();
  }

  // The pill under the painting gets the base colour, so its anti-aliased edge doesn't show as a dark rim
  _syncIslandColor() {
    const [r, g, b] = this._to[3].map((v) => Math.round(v * 255));
    this._island.style = this._active ? `background-color: rgb(${r}, ${g}, ${b});` : null;
  }

  _animating() {
    return !!(this._clip.get_transition('width') || this._clip.get_transition('height') || this._island.get_transition('scale-x'));
  }

  /** Show while music is in the island; animates only while shown. */
  setActive(active) {
    if (active === this._active) return;
    this._active = active;
    if (active) this._island.add_style_class_name('colored');
    else this._island.remove_style_class_name('colored');
    this._syncIslandColor();
    this.actor.ease({ opacity: active ? 255 : 0, duration: 400 });
    if (active && !this._frame) {
      this._frame = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
        if (!this._animating() && this._island.visible) this.actor.queue_repaint();
        return GLib.SOURCE_CONTINUE;
      });
    } else if (!active && this._frame) {
      GLib.source_remove(this._frame);
      this._frame = 0;
    }
  }

  _colors() {
    const t = Math.min(1, (GLib.get_monotonic_time() - this._fadeStart) / (FADE_MS * 1000));
    return mix(this._from, this._to, t);
  }

  _paint(area) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    const node = this._island.get_theme_node();
    const r = Math.max(0, Math.min(node.get_border_radius(St.Corner.TOPLEFT), w / 2, h / 2));
    const cols = this._colors();
    const time = (GLib.get_monotonic_time() - this._t0) / 1e6;

    // Rounded shape of the island
    cr.newPath();
    cr.arc(w - r, r, r, -Math.PI / 2, 0);
    cr.arc(w - r, h - r, r, 0, Math.PI / 2);
    cr.arc(r, h - r, r, Math.PI / 2, Math.PI);
    cr.arc(r, r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
    cr.clip();

    // Base colour (the 4th, darkest)
    cr.setSourceRGB(...cols[3]);
    cr.paint();

    // Drifting blobs, blended like mix-blend-mode: screen
    const M = Math.max(w, h);
    cr.setOperator(Cairo.Operator.SCREEN);
    for (const b of BLOBS) {
      // ease-in-out "alternate": 0 → 1 → 0 over two periods
      let k = 0.5 - 0.5 * Math.cos((Math.PI * time) / b.p);
      if (b.reverse) k = 1 - k;
      const cx = (b.fromRight ? w - b.x * M : b.x * M) + b.dx * w * k;
      const cy = (b.fromBottom ? h - b.y * M : b.y * M) + b.dy * h * k;
      const radius = 0.38 * M * (1 + (b.s - 1) * k);
      const [cR, cG, cB] = cols[b.c];
      const g = new Cairo.RadialGradient(cx, cy, 0, cx, cy, radius);
      // softer than the app's blobs: the island is small, so they overlap much more
      g.addColorStopRGBA(0, cR, cG, cB, b.a * 0.7);
      g.addColorStopRGBA(0.45, cR, cG, cB, b.a * 0.35);
      g.addColorStopRGBA(1, cR, cG, cB, 0);
      cr.setSource(g);
      cr.paint();
    }

    // Vignette (.npf-bg::after)
    cr.setOperator(Cairo.Operator.OVER);
    const v = new Cairo.RadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
    v.addColorStopRGBA(0, 0, 0, 0, 0.05);
    v.addColorStopRGBA(1, 0, 0, 0, 0.45);
    cr.setSource(v);
    cr.paint();

    cr.$dispose();
  }

  _teardown() {
    if (this._dead) return;
    this._dead = true;
    if (this._frame) GLib.source_remove(this._frame);
    this._frame = 0;
    for (const id of this._clipSignals) this._clip.disconnect(id);
    this._clipSignals = [];
  }

  destroy() {
    this._teardown();
    this.actor.destroy();
  }
}
