// The piano roll: draws a song's channels and lets you add, move, resize and delete the notes of one of them, and
// pick the engine events (instrument changes, tempo...) shown in the strip along the bottom.

import { NOTE_BASE } from "./dw.js";

export const COLORS = ["#ffd43b", "#4dabf7", "#ff6b6b", "#8ce99a"];
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteName = key => { const m = key - NOTE_BASE + 36; return NAMES[m % 12] + (Math.floor(m / 12) - 1); };
const MARK = { ctrl0: "I", ctrl1: "S", tempo: "T", offset: "O", sync: "C", noisevol: "V" };
export const EVENT_NAMES = { ctrl0: "Instrument", ctrl1: "Sweep", tempo: "Tempo", offset: "Note offset", sync: "Cue", noisevol: "Noise volume" };

const KEYS_W = 44, RULER_H = 22, STRIP_H = 30, LO = NOTE_BASE, HI = 0xc8;

// The lanes a song has: a music song's three channels, or an effect's square and noise parts of one stream.
export function lanesOf(song) {
  if (song.sfx) return [{ ci: 0, type: "note", name: "Square 2", color: COLORS[1] }, { ci: 0, type: "noise", name: "Noise", color: COLORS[3] }];
  return ["Square 1", "Square 2", "Triangle"].map((name, ci) => ({ ci, type: "note", name, color: COLORS[ci] }));
}

export class Roll {
  constructor(canvas, cb) {
    this.cv = canvas;
    this.cx = canvas.getContext("2d");
    this.cb = cb; // { edit(fn), select(sel), seek(tick) }
    this.zoom = 2; // pixels per tick
    this.rowH = matchMedia("(pointer: coarse)").matches ? 16 : 13;
    this.sx = 0; this.sy = 0;
    this.grid = 6;
    this.len = 12; // the length a new note gets
    this.song = null;
    this.lane = 0;
    this.sel = null; // { ev, kind: "note" | "event" }
    this.playhead = null;
    this.cursor = 0; // where Play starts
    this.pointers = new Map();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement);
    canvas.addEventListener("pointerdown", e => this.down(e));
    canvas.addEventListener("pointermove", e => this.move(e));
    canvas.addEventListener("pointerup", e => this.up(e));
    canvas.addEventListener("pointercancel", e => this.up(e, true));
    canvas.addEventListener("wheel", e => this.wheel(e), { passive: false });
  }

  resize() {
    const box = this.cv.parentElement.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    this.w = Math.max(100, box.width); this.h = Math.max(120, box.height);
    this.cv.width = Math.round(this.w * dpr); this.cv.height = Math.round(this.h * dpr);
    this.cv.style.width = this.w + "px"; this.cv.style.height = this.h + "px";
    this.cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.clamp();
    this.draw();
  }

  setSong(song, keepView) {
    const changed = !this.song || this.song.id !== song.id;
    this.song = song;
    if (this.sel && !this.contains(this.sel.ev)) this.select(null);
    if (changed && !keepView) {
      this.lane = 0; this.sx = 0; this.cursor = 0;
      this.select(null);
      this.centerOnNotes();
    }
    this.clamp();
    this.draw();
  }

  contains(ev) { return this.song.channels.some(ch => ch?.events.includes(ev)); }
  get lanes() { return lanesOf(this.song); }
  get rollH() { return this.h - RULER_H - STRIP_H; }
  rows() { return HI - LO + 1; }
  rowY(key) { return RULER_H + (HI - key) * this.rowH - this.sy; }
  keyAt(y) { return Math.max(LO, Math.min(HI, HI - Math.floor((y - RULER_H + this.sy) / this.rowH))); }
  x(t) { return KEYS_W + t * this.zoom - this.sx; }
  tickAt(x) { return Math.max(0, (x - KEYS_W + this.sx) / this.zoom); }
  snap(t) { return Math.max(0, Math.round(t / this.grid) * this.grid); }
  length() { return Math.max(96, ...this.song.channels.filter(Boolean).map(c => c.end)); }

  clamp() {
    if (!this.song) return;
    const maxX = Math.max(0, this.length() * this.zoom + 200 - (this.w - KEYS_W));
    const maxY = Math.max(0, this.rows() * this.rowH - this.rollH);
    this.sx = Math.max(0, Math.min(maxX, this.sx));
    this.sy = Math.max(0, Math.min(maxY, this.sy));
  }

  centerOnNotes() {
    const keys = this.laneNotes(this.lane).map(n => n.key);
    const all = keys.length ? keys : this.lanes.flatMap((_, i) => this.laneNotes(i)).map(n => n.key);
    const mid = all.length ? (Math.min(...all) + Math.max(...all)) / 2 : 0x98;
    this.sy = (HI - mid) * this.rowH - this.rollH / 2;
    this.clamp();
  }

  // Notes of a lane, as { ev, key } (noise notes sit on the keyboard at C2 and up, as in the MIDI files).
  laneNotes(i) {
    const l = this.lanes[i], ch = this.song.channels[l.ci];
    if (!ch) return [];
    return ch.events.filter(e => e.type === l.type).map(ev => ({ ev, key: l.type === "noise" ? NOTE_BASE + (ev.v - 0xe0) : ev.key }));
  }
  laneEvents(i) {
    const l = this.lanes[i], ch = this.song.channels[l.ci];
    if (!ch) return [];
    const mine = l.type === "noise" ? ["noisevol"] : ["ctrl0", "ctrl1", "tempo", "offset", "sync"];
    return ch.events.filter(e => mine.includes(e.type));
  }

  select(sel) {
    this.sel = sel;
    this.cb.select(sel);
    this.draw();
  }

  draw() {
    if (!this.song || !this.w) return;
    const c = this.cx, w = this.w, h = this.h, z = this.zoom;
    c.fillStyle = "#0b0c10"; c.fillRect(0, 0, w, h);
    const t0 = Math.floor(this.tickAt(KEYS_W)), t1 = Math.ceil(this.tickAt(w));
    // rows
    for (let k = LO; k <= HI; k++) {
      const y = this.rowY(k);
      if (y + this.rowH < RULER_H || y > RULER_H + this.rollH) continue;
      const black = [1, 3, 6, 8, 10].includes((k - LO) % 12);
      c.fillStyle = black ? "#101218" : "#151821";
      c.fillRect(KEYS_W, y, w - KEYS_W, this.rowH);
      if ((k - LO) % 12 === 0) { c.fillStyle = "#262a34"; c.fillRect(KEYS_W, y + this.rowH - 1, w - KEYS_W, 1); }
    }
    // loop and end of the current lane's channel
    const ch = this.song.channels[this.lanes[this.lane].ci];
    if (ch) {
      if (ch.loop !== null) { c.fillStyle = "rgba(77,171,247,.07)"; c.fillRect(this.x(ch.loop), RULER_H, (ch.end - ch.loop) * z, this.rollH); }
      c.fillStyle = "rgba(0,0,0,.45)"; c.fillRect(this.x(ch.end), RULER_H, w, this.rollH);
    }
    // grid
    const step = this.grid * z < 6 ? (24 * z < 6 ? 96 : 24) : this.grid;
    for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
      const x = Math.round(this.x(t)) + 0.5;
      c.fillStyle = t % 96 === 0 ? "#3a3f4d" : t % 24 === 0 ? "#272b36" : "#1a1d25";
      c.fillRect(x, RULER_H, 1, this.rollH);
    }
    // notes: the other lanes dimmed, then the current one
    const order = this.lanes.map((_, i) => i).filter(i => i !== this.lane).concat(this.lane);
    for (const i of order) {
      const l = this.lanes[i], cur = i === this.lane;
      c.globalAlpha = cur ? 1 : 0.28;
      for (const { ev, key } of this.laneNotes(i)) {
        const x = this.x(ev.t), nw = Math.max(2, ev.dur * z - 1), y = this.rowY(key);
        if (x > w || x + nw < KEYS_W || y > h || y + this.rowH < RULER_H) continue;
        c.fillStyle = l.color;
        c.fillRect(x, y + 1, nw, this.rowH - 2);
        if (nw > 4) { c.fillStyle = "rgba(0,0,0,.35)"; c.fillRect(x + nw - 1, y + 1, 1, this.rowH - 2); }
        if (cur && this.sel?.ev === ev) { c.strokeStyle = "#fff"; c.lineWidth = 2; c.strokeRect(x - 1, y, nw + 2, this.rowH); }
      }
    }
    c.globalAlpha = 1;
    // keys
    c.fillStyle = "#1e2129"; c.fillRect(0, RULER_H, KEYS_W, this.rollH);
    c.font = "10px ui-monospace, monospace"; c.textBaseline = "middle";
    const noise = this.lanes[this.lane].type === "noise";
    for (let k = LO; k <= HI; k++) {
      const y = this.rowY(k);
      if (y + this.rowH < RULER_H || y > RULER_H + this.rollH) continue;
      const black = [1, 3, 6, 8, 10].includes((k - LO) % 12);
      if (noise) {
        if (k - LO > 21) continue;
        c.fillStyle = "#9aa0ad"; c.fillText(`N${k - LO}`, 6, y + this.rowH / 2);
        continue;
      }
      if (black) { c.fillStyle = "#0b0c10"; c.fillRect(0, y, KEYS_W * 0.6, this.rowH); }
      if ((k - LO) % 12 === 0) { c.fillStyle = "#9aa0ad"; c.fillText(noteName(k), 6, y + this.rowH / 2); }
    }
    // ruler
    c.fillStyle = "#1e2129"; c.fillRect(0, 0, w, RULER_H);
    c.fillStyle = "#9aa0ad";
    const barStep = 96 * z < 40 ? 384 : 96;
    for (let t = Math.floor(t0 / barStep) * barStep; t <= t1; t += barStep) {
      const x = this.x(t);
      if (x < KEYS_W - 1) continue;
      c.fillRect(x, 12, 1, 10);
      c.fillText(String(t / 96 + 1), x + 3, 9);
    }
    c.fillStyle = "#e5484d";
    const cx = this.x(this.cursor);
    if (cx >= KEYS_W) { c.beginPath(); c.moveTo(cx - 5, 12); c.lineTo(cx + 5, 12); c.lineTo(cx, 21); c.fill(); }
    // event strip
    const sy = h - STRIP_H;
    c.fillStyle = "#1e2129"; c.fillRect(0, sy, w, STRIP_H);
    c.fillStyle = "#9aa0ad"; c.fillText("events", 4, sy + STRIP_H / 2);
    c.save(); c.beginPath(); c.rect(KEYS_W, sy, w - KEYS_W, STRIP_H); c.clip();
    c.textAlign = "center";
    for (const ev of this.laneEvents(this.lane)) {
      const x = this.x(ev.t);
      if (x < KEYS_W - 15 || x > w) continue;
      const selected = this.sel?.ev === ev;
      // Markers hang to the right of their tick, so one at the very start isn't hidden behind the keys.
      c.fillStyle = selected ? "#ffd43b" : ev.type === "sync" ? "#e5484d" : "#3a3f4d";
      c.fillRect(x, sy + 5, 15, STRIP_H - 10);
      c.fillStyle = selected ? "#14161c" : "#e9ebf0";
      c.fillText(MARK[ev.type], x + 7.5, sy + STRIP_H / 2 + 1);
    }
    c.restore();
    c.textAlign = "start";
    if (ch) {
      c.fillStyle = "#e5484d"; c.fillRect(this.x(ch.end), RULER_H, 2, this.rollH);
      if (ch.loop !== null) { c.fillStyle = "#4dabf7"; c.fillRect(this.x(ch.loop), RULER_H, 2, this.rollH); }
    }
    if (this.playhead !== null) {
      c.fillStyle = "#fff";
      c.fillRect(Math.round(this.x(this.playhead)), 0, 1, h - STRIP_H);
    }
  }

  // ---- input

  hitNote(x, y) {
    const notes = this.laneNotes(this.lane);
    for (let i = notes.length - 1; i >= 0; i--) {
      const { ev, key } = notes[i];
      const nx = this.x(ev.t), nw = Math.max(4, ev.dur * this.zoom), ny = this.rowY(key);
      if (x >= nx && x <= nx + nw && y >= ny && y < ny + this.rowH) {
        const edge = Math.min(10, nw / 3);
        return { ev, key, resize: x > nx + nw - edge };
      }
    }
    return null;
  }

  hitEvent(x) {
    let best = null, bd = 12;
    for (const ev of this.laneEvents(this.lane)) { const d = Math.abs(this.x(ev.t) + 7.5 - x); if (d < bd) { bd = d; best = ev; } }
    return best;
  }

  down(e) {
    if (!this.song) return;
    this.cv.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pointers.size === 2) { // pinch: zoom in time
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.abs(a.x - b.x) || 1, zoom: this.zoom, mid: (a.x + b.x) / 2, tick: this.tickAt((a.x + b.x) / 2) };
      this.drag = null;
      return;
    }
    const x = e.offsetX, y = e.offsetY;
    this.drag = { x0: x, y0: y, sx: this.sx, sy: this.sy, moved: false, mode: "pan" };
    if (y < RULER_H) { this.drag.mode = "seek"; this.seekTo(x); return; }
    if (y > this.h - STRIP_H) { this.drag.mode = "strip"; return; }
    const hit = x > KEYS_W && this.hitNote(x, y);
    if (hit) {
      this.drag = { ...this.drag, mode: hit.resize ? "resize" : "move", ev: hit.ev, key0: hit.key, t0: hit.ev.t, dur0: hit.ev.dur, started: false };
      if (this.sel?.ev !== hit.ev) this.select({ ev: hit.ev, kind: "note", lane: this.lane });
    }
  }

  move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.offsetX; p.y = e.offsetY;
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const z = Math.max(0.25, Math.min(16, this.pinch.zoom * (Math.abs(a.x - b.x) || 1) / this.pinch.d));
      this.zoom = z;
      this.sx = this.pinch.tick * z - (this.pinch.mid - KEYS_W);
      this.clamp(); this.draw();
      return;
    }
    const d = this.drag;
    if (!d) return;
    const dx = e.offsetX - d.x0, dy = e.offsetY - d.y0;
    if (!d.moved && Math.hypot(dx, dy) > 6) d.moved = true;
    if (!d.moved) return;
    if (d.mode === "seek") { this.seekTo(e.offsetX); return; }
    if (d.mode === "pan" || d.mode === "strip") {
      this.sx = d.sx - dx;
      if (d.mode === "pan") this.sy = d.sy - dy;
      this.clamp(); this.draw();
      return;
    }
    const lane = this.lanes[this.lane];
    if (d.mode === "move") {
      const t = this.snap(d.t0 + dx / this.zoom);
      let key = d.key0 + Math.round(-dy / this.rowH);
      key = lane.type === "noise" ? Math.max(LO, Math.min(LO + 15, key)) : Math.max(LO, Math.min(HI, key));
      this.cb.edit(() => {
        d.ev.t = t;
        if (lane.type === "noise") d.ev.v = 0xe0 + (key - LO); else d.ev.key = key;
      }, !d.started);
    } else {
      const end = Math.max(d.t0 + 1, this.snapEnd(d.t0 + d.dur0 + dx / this.zoom, d.t0));
      this.cb.edit(() => { d.ev.dur = end - d.t0; this.len = d.ev.dur; }, !d.started);
    }
    d.started = true;
  }

  snapEnd(t, start) {
    const s = Math.round(t / this.grid) * this.grid;
    return s > start ? s : start + Math.max(1, Math.round((t - start)));
  }

  up(e, cancel) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    const d = this.drag;
    this.drag = null;
    if (!d || cancel) return;
    if (d.mode === "strip" && !d.moved) {
      const ev = this.hitEvent(e.offsetX);
      this.select(ev ? { ev, kind: "event", lane: this.lane } : null);
      return;
    }
    if (d.mode === "pan" && !d.moved && e.offsetX > KEYS_W) {
      // A tap on an empty spot adds a note there (or clears the selection, if one was selected).
      if (this.sel) { this.select(null); return; }
      const t = Math.floor(this.tickAt(e.offsetX) / this.grid) * this.grid;
      const key = this.keyAt(e.offsetY), lane = this.lanes[this.lane];
      if (lane.type === "noise" && key > LO + 15) return;
      let made = null;
      this.cb.edit(song => {
        made = lane.type === "noise" ? { t, type: "noise", v: 0xe0 + (key - LO), dur: this.len } : { t, type: "note", key, dur: this.len };
        addEvent(song, lane.ci, made);
      }, true);
      this.select({ ev: made, kind: "note", lane: this.lane });
    }
    if (d.mode === "move" || d.mode === "resize") this.cb.edit(null, false, true);
  }

  seekTo(x) {
    this.cursor = this.snap(this.tickAt(x));
    this.cb.seek(this.cursor);
    this.draw();
  }

  wheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const tick = this.tickAt(e.offsetX);
      this.zoom = Math.max(0.25, Math.min(16, this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      this.sx = tick * this.zoom - (e.offsetX - KEYS_W);
    } else if (e.shiftKey) this.sx += e.deltaY || e.deltaX;
    else { this.sx += e.deltaX; this.sy += e.deltaY; }
    this.clamp(); this.draw();
  }

  zoomBy(f) {
    const mid = KEYS_W + (this.w - KEYS_W) / 2, tick = this.tickAt(mid);
    this.zoom = Math.max(0.25, Math.min(16, this.zoom * f));
    this.sx = tick * this.zoom - (mid - KEYS_W);
    this.clamp(); this.draw();
  }

  scrollTo(tick) {
    const x = this.x(tick);
    if (x < KEYS_W + 20 || x > this.w - 40) { this.sx = Math.max(0, tick * this.zoom - (this.w - KEYS_W) * 0.25); this.clamp(); }
  }
}

// Puts an event into a channel at its tick (after the events already at that tick), making the channel if needed.
export function addEvent(song, ci, ev) {
  if (!song.channels[ci]) {
    const other = song.channels.find(Boolean);
    song.channels[ci] = { events: [], loop: other ? other.loop : null, end: other ? other.end : 0, endSync: false };
  }
  const ch = song.channels[ci];
  let i = ch.events.findIndex(e => e.t > ev.t);
  if (i < 0) i = ch.events.length;
  ch.events.splice(i, 0, ev);
}

// Keeps a channel in order after an edit: sorted by tick, one note per tick (`keep` wins), long enough for its notes.
export function tidy(song, keep) {
  for (const ch of song.channels) {
    if (!ch) continue;
    ch.events.sort((a, b) => a.t - b.t || (a.type === "note" || a.type === "noise" ? 1 : 0) - (b.type === "note" || b.type === "noise" ? 1 : 0));
    for (const type of ["note", "noise"]) {
      const at = new Map();
      for (const e of ch.events) if (e.type === type && (!at.has(e.t) || e === keep)) at.set(e.t, e);
      ch.events = ch.events.filter(e => e.type !== type || at.get(e.t) === e);
    }
    const last = Math.max(0, ...ch.events.filter(e => e.type === "note" || e.type === "noise").map(e => e.t + e.dur));
    if (last > ch.end) ch.end = last;
  }
}
