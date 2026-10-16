import { locate, readSongs, previewMem, cloneSong, NOTE_BASE } from "./dw.js";
import { Player, FRAME_HZ } from "./apu.js";
import { songToMidi, midiToSong, writeMidi, readMidi, slotOf, usPerQuarter } from "./midi.js";
import { zip, unzip, makeIPS, wav } from "./files.js";
import { Roll, lanesOf, addEvent, tidy, noteName, EVENT_NAMES } from "./roll.js";

const $ = s => document.querySelector(s);
const S = { rom: null, name: "", L: null, songs: [], orig: [], edited: new Set(), cur: 0, hist: [], fut: [] };

// ---------------------------------------------------------------- the background worker

const worker = new Worker("worker.js", { type: "module" });
let jobs = 0;
const waiting = new Map();
worker.onmessage = ({ data }) => { const w = waiting.get(data.id); waiting.delete(data.id); data.ok ? w.resolve(data) : w.reject(new Error(data.error)); };
function work(msg) {
  const id = ++jobs;
  return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
}
const plainSongs = () => S.songs.map(s => JSON.parse(JSON.stringify(s)));

// ---------------------------------------------------------------- opening a ROM

async function openFile(file) {
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    start({ name: file.name, rom: bytes });
    saveNow();
  } catch (e) { toast(e.message); }
}

function start(v) {
  const L = locate(v.rom);
  const orig = readSongs(v.rom, L);
  stop();
  Object.assign(S, {
    rom: v.rom, name: v.name, L, orig, songs: orig.map((s, i) => v.songs?.[i] || cloneSong(s)),
    edited: new Set(v.edited || []), cur: v.cur ?? 1, hist: [], fut: [],
  });
  document.body.classList.add("open");
  $("#welcome").hidden = true;
  $("#work").hidden = false;
  $("#rom-name").textContent = v.name;
  renderList();
  openSong(Math.min(S.cur, S.songs.length - 1), v.lane);
  measure();
}

function closeRom() {
  stop();
  Object.assign(S, { rom: null, songs: [], orig: [], edited: new Set(), hist: [], fut: [] });
  document.body.classList.remove("open");
  $("#welcome").hidden = false;
  $("#work").hidden = true;
  $("#rom-name").textContent = "";
  idbDel("session").catch(() => {});
}

for (const id of ["#rom-file", "#rom-file-2"]) $(id).onchange = e => { openFile(e.target.files[0]); e.target.value = ""; };
$("#close").onclick = () => {
  if (S.edited.size && !confirm("Close this ROM? Changes you haven't saved into a ROM will be lost.")) return;
  closeRom();
};
addEventListener("dragover", e => { e.preventDefault(); document.body.classList.add("dragging"); });
addEventListener("dragleave", () => document.body.classList.remove("dragging"));
addEventListener("drop", e => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  if (S.rom && files.every(f => /\.(mid|midi|rmi|zip)$/i.test(f.name))) importFiles(files);
  else openFile(files[0]);
});

// ---------------------------------------------------------------- the song list

const song = () => S.songs[S.cur];
const fileName = (s, i) => {
  const n = s.name.replace(/[^\w ()'-]+/g, "").trim();
  return s.sfx ? `sfx ${String(s.id & 0x7f).padStart(2, "0")} ${n}.mid` : `${String(i).padStart(2, "0")} ${n}.mid`;
};

function renderList() {
  for (const [sel, sfx] of [["#music", false], ["#sfx", true]]) {
    const ul = $(sel);
    ul.replaceChildren();
    S.songs.forEach((s, i) => {
      if (s.sfx !== sfx || (!sfx && s.id === 0)) return; // "no sound" is the engine's silence: not editable
      const li = document.createElement("li");
      li.dataset.i = i;
      li.className = (i === S.cur ? "current " : "") + (S.edited.has(i) ? "edited" : "");
      const pick = document.createElement("button");
      pick.className = "pick";
      pick.textContent = s.name;
      pick.onclick = () => {
        openSong(i);
        if (phone.matches) { $("#lists").open = false; $("#pane").scrollIntoView({ block: "start" }); }
      };
      const quick = document.createElement("button");
      quick.className = "quick";
      quick.title = "Play";
      quick.textContent = playing?.i === i ? "■" : "▶";
      quick.onclick = () => (playing?.i === i ? stop() : play(i, 0));
      li.append(pick, quick);
      ul.append(li);
    });
  }
}

// ---------------------------------------------------------------- the editor

const roll = new Roll($("#roll"), {
  edit: (fn, begin) => edit(fn, begin),
  select: () => renderInspector(),
  seek: () => { if (playing && playing.i === S.cur) play(S.cur, roll.cursor); },
});

function openSong(i, lane = 0) {
  S.cur = i;
  roll.setSong(song());
  roll.lane = Math.min(lane, lanesOf(song()).length - 1);
  roll.centerOnNotes();
  roll.draw();
  renderList();
  renderSongBar();
  renderLanes();
  renderInspector();
  saveSoon();
}

function renderSongBar() {
  const s = song();
  $("#song-name").textContent = s.name;
  $("#lists > summary").textContent = phone.matches ? `Songs and sounds: ${s.name}` : "Songs and sounds";
  const len = Math.max(...s.channels.filter(Boolean).map(c => c.end), 0);
  const loops = s.channels.some(c => c && c.loop !== null);
  const secs = s.sfx ? len / FRAME_HZ : null;
  $("#song-sub").textContent = s.sfx
    ? `Sound effect ${s.id & 0x7f} · ${secs.toFixed(2)} s${S.edited.has(S.cur) ? " · edited" : ""}`
    : `Song ${s.id} · ${(len / 96).toFixed(1)} bars${loops ? ", loops" : ""}${S.edited.has(S.cur) ? " · edited" : ""}`;
  $("#revert").disabled = !S.edited.has(S.cur);
  $("#play").textContent = playing?.i === S.cur ? "Stop" : "Play";
  $("#play").classList.toggle("playing", playing?.i === S.cur);
}

function renderLanes() {
  const seg = $("#lanes");
  seg.replaceChildren();
  lanesOf(song()).forEach((l, i) => {
    const b = document.createElement("button");
    b.setAttribute("aria-pressed", i === roll.lane);
    const dot = document.createElement("span");
    dot.className = "dot"; dot.style.background = l.color;
    b.append(dot, l.name);
    if (!song().channels[l.ci]) b.title = "Silent in this song: tap the roll to add notes";
    b.onclick = () => { roll.lane = i; roll.select(null); roll.centerOnNotes(); roll.draw(); renderLanes(); renderInspector(); };
    seg.append(b);
  });
}

// Every change goes through here: `fn` changes the current song; `begin` keeps the song as it was, for Undo.
function edit(fn, begin) {
  if (begin) {
    S.hist.push({ i: S.cur, song: cloneSong(song()), edited: S.edited.has(S.cur) });
    if (S.hist.length > 200) S.hist.shift();
    S.fut = [];
  }
  if (!fn) return;
  fn(song());
  tidy(song(), roll.sel?.ev);
  S.edited.add(S.cur);
  changed();
}

function changed() {
  roll.setSong(song(), true);
  renderSongBar();
  renderList();
  renderInspector();
  $("#undo").disabled = !S.hist.length;
  $("#redo").disabled = !S.fut.length;
  saveSoon();
  measureSoon();
}

function undo() {
  const h = S.hist.pop();
  if (!h) return;
  S.fut.push({ i: h.i, song: cloneSong(S.songs[h.i]), edited: S.edited.has(h.i) });
  restore(h);
}
function redo() {
  const h = S.fut.pop();
  if (!h) return;
  S.hist.push({ i: h.i, song: cloneSong(S.songs[h.i]), edited: S.edited.has(h.i) });
  restore(h);
}
function restore(h) {
  S.songs[h.i] = h.song;
  if (h.edited) S.edited.add(h.i); else S.edited.delete(h.i);
  if (S.cur !== h.i) openSong(h.i, 0);
  roll.select(null);
  changed();
}
$("#undo").onclick = undo;
$("#redo").onclick = redo;

$("#revert").onclick = () => {
  edit(s => { Object.assign(s, cloneSong(S.orig[S.cur])); }, true);
  S.edited.delete(S.cur);
  roll.select(null);
  changed();
};

function deleteSelection() {
  const sel = roll.sel;
  if (!sel) return;
  edit(s => { for (const ch of s.channels) if (ch) ch.events = ch.events.filter(e => e !== sel.ev); }, true);
  roll.select(null);
}
$("#delete").onclick = deleteSelection;
$("#grid").onchange = e => { roll.grid = +e.target.value; roll.len = Math.max(roll.grid, roll.len - roll.len % roll.grid || roll.grid); roll.draw(); };
$("#zoom-in").onclick = () => roll.zoomBy(1.5);
$("#zoom-out").onclick = () => roll.zoomBy(1 / 1.5);

// ---------------------------------------------------------------- the inspector

const hex = v => "$" + v.toString(16).toUpperCase().padStart(2, "0");
const DUTIES = ["12.5%", "25%", "50%", "75%"];

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "on") for (const [ev, f] of Object.entries(v)) e.addEventListener(ev, f);
    else if (k in e) e[k] = v; else e.setAttribute(k, v);
  }
  e.append(...kids.filter(k => k !== null && k !== undefined));
  return e;
}
const field = (label, input) => el("label", { className: "f" }, label, input);
const check = (label, checked, onchange) => el("label", { className: "check" }, el("input", { type: "checkbox", checked, on: { change: e => onchange(e.target.checked) } }), label);
const select = (opts, value, onchange) => {
  const s = el("select", { on: { change: e => onchange(e.target.value) } }, ...opts.map(([v, t]) => el("option", { value: v, textContent: t })));
  s.value = String(value);
  return s;
};
const range = (min, max, value, oninput, onchange) => el("input", { type: "range", min, max, value, on: { input: e => oninput(+e.target.value), change: e => onchange(+e.target.value) } });
const num = (min, max, value, onchange) => el("input", { type: "number", min, max, value, on: { change: e => { const v = Math.round(+e.target.value); if (Number.isFinite(v)) onchange(Math.max(min, Math.min(max, v))); } } });

// The value an engine setting has at tick t on a channel: the last change at or before it.
function valueAt(ch, type, t) {
  let v = null;
  for (const e of ch?.events || []) if (e.type === type && e.t <= t) v = e.v;
  return v;
}
// Sets an engine setting at tick t, changing the event there or adding one.
function setAt(ci, type, t, v) {
  edit(s => {
    const ch = s.channels[ci];
    const ev = ch?.events.find(e => e.type === type && e.t === t && !e.pre);
    if (ev) ev.v = v; else addEvent(s, ci, { t, type, v });
  }, true);
}

// Instrument controls for a byte: squares (DDLCVVVV), the triangle (CRRRRRRR) or noise (--LCVVVV).
function instrumentControls(kind, v, set) {
  const kids = [];
  const live = el("small", { textContent: hex(v) });
  if (kind === "tri") {
    kids.push(check("Hold the note", !!(v & 0x80), on => set((v & 0x7f) | (on ? 0x80 : 0))));
    kids.push(field(el("span", {}, "Length ", el("small", { textContent: `${v & 0x7f} (${((v & 0x7f) / 240).toFixed(2)} s, 0 = silent)` })),
      range(0, 127, v & 0x7f, x => { kids.at(-1).querySelector("small").textContent = `${x} (${(x / 240).toFixed(2)} s)`; }, x => set((v & 0x80) | x))));
    return kids;
  }
  const constant = !!(v & 0x10);
  if (kind !== "noise") kids.push(field("Duty", select(DUTIES.map((d, i) => [i, d]), v >> 6, d => set((v & 0x3f) | (+d << 6)))));
  kids.push(field("Volume", select([[1, "Steady"], [0, "Fades out"]], constant ? 1 : 0, c => set((v & 0xef) | (+c ? 0x10 : 0)))));
  const label = constant ? "Level" : "Fade time";
  const desc = x => (constant ? `${x}/15` : `${x} (${((x + 1) * 16 / 240).toFixed(2)} s)`);
  const lab = el("small", { textContent: desc(v & 15) });
  kids.push(field(el("span", {}, label + " ", lab), range(0, 15, v & 15, x => { lab.textContent = desc(x); }, x => set((v & 0xf0) | x))));
  kids.push(check(constant ? "Hold the note" : "Repeat the fade", !!(v & 0x20), on => set((v & 0xdf) | (on ? 0x20 : 0))));
  kids.push(field("Byte", live));
  return kids;
}

function sweepControls(v, set) {
  const on = !!(v & 0x80);
  const kids = [check("Pitch sweep", on, x => set(x ? 0x80 | (v & 0x78) | (v & 7 || 3) : 0x08))];
  if (on) {
    kids.push(field("Direction", select([[0, "Down"], [1, "Up"]], (v >> 3) & 1, d => set((v & 0xf7) | (+d << 3)))));
    kids.push(field("Speed (0 fastest)", num(0, 7, (v >> 4) & 7, x => set((v & 0x8f) | (x << 4)))));
    kids.push(field("Step (1 biggest)", num(0, 7, v & 7, x => set((v & 0xf8) | x))));
  }
  return kids;
}

function renderInspector() {
  const box = $("#inspector");
  box.replaceChildren();
  $("#delete").disabled = !roll.sel;
  if (!S.rom) return;
  const s = song(), lane = lanesOf(s)[roll.lane], ch = s.channels[lane.ci];
  const kind = s.sfx ? (lane.type === "noise" ? "noise" : "sfx") : lane.ci === 2 ? "tri" : "sq";
  const sel = roll.sel;

  if (sel?.kind === "note") {
    const n = sel.ev, t = n.t;
    const isNoise = n.type === "noise";
    const pitch = isNoise ? `Noise ${n.v - 0xe0}` : noteName(n.key);
    box.append(el("h3", {}, pitch, el("small", { textContent: `${lane.name} · tick ${t} · ${n.dur} long` })));
    if (isNoise) box.append(field("Sound (0 highest)", num(0, 15, n.v - 0xe0, x => edit(() => { n.v = 0xe0 + x; }, true))));
    else box.append(field("Note", select(Array.from({ length: 0xc8 - NOTE_BASE + 1 }, (_, i) => [NOTE_BASE + i, noteName(NOTE_BASE + i)]).reverse(), n.key, k => edit(() => { n.key = +k; }, true))));
    box.append(field("Start (tick)", num(0, 99999, t, x => edit(() => { n.t = x; }, true))));
    box.append(field("Length", num(1, 9999, n.dur, x => edit(() => { n.dur = x; roll.len = x; }, true))));
    box.append(el("div", { className: "sep" }));
    const ctype = isNoise ? "noisevol" : "ctrl0";
    const cur = valueAt(ch, ctype, t);
    box.append(el("h3", {}, "Instrument", el("small", { textContent: "from this note until the next change" })));
    box.append(...instrumentControls(isNoise ? "noise" : kind, cur ?? (kind === "tri" ? 0xff : 0xbf), v => setAt(lane.ci, ctype, t, v)));
    if (!isNoise && kind !== "tri") {
      box.append(el("div", { className: "sep" }));
      box.append(...sweepControls(valueAt(ch, "ctrl1", t) ?? 0x08, v => setAt(lane.ci, "ctrl1", t, v)));
    }
    return;
  }

  if (sel?.kind === "event") {
    const e = sel.ev;
    box.append(el("h3", {}, EVENT_NAMES[e.type], el("small", { textContent: `${lane.name} · tick ${e.t}${e.pre ? " · only the first time through" : ""}` })));
    box.append(field("Tick", num(0, 99999, e.t, x => edit(() => { e.t = x; if (e.type === "sync") { const len = e.until - e.t; e.until = x + len; } }, true))));
    const set = v => edit(() => { e.v = v; }, true);
    if (e.type === "ctrl0") box.append(...instrumentControls(kind === "noise" ? "sfx" : kind, e.v, set));
    else if (e.type === "noisevol") box.append(...instrumentControls("noise", e.v, set));
    else if (e.type === "ctrl1") box.append(...sweepControls(e.v, set));
    else if (e.type === "tempo") box.append(...tempoControls(e.v, set));
    else if (e.type === "offset") {
      box.append(field("Semitones", num(-128, 127, e.v > 127 ? e.v - 256 : e.v, x => set(x & 0xff))));
      box.append(el("p", { className: "hint note", textContent: "Shifts the notes of every channel from here on. The dungeon floors share one tune this way. Notes here show the pitch you hear, so changing this moves where the notes land." }));
    } else if (e.type === "sync") {
      box.append(field("Until tick", num(e.t + 1, 99999, e.until, x => edit(() => { e.until = x; }, true))));
      box.append(el("p", { className: "hint note", textContent: "The game waits for the music to get here (the intro waits for one before showing the story; jingles end on one). Keep it, or the game may wait forever." }));
    }
    box.append(el("div", { className: "sep" }), el("button", { textContent: "Delete event", on: { click: deleteSelection } }));
    return;
  }

  // Nothing selected: the channel's loop and end, the song's tempo, and adding events.
  box.append(el("h3", {}, lane.name, el("small", { textContent: ch ? "" : "silent in this song: tap the roll to add notes" })));
  if (ch) {
    if (!s.sfx) {
      box.append(check("Loop", ch.loop !== null, on => edit(c => { c.channels[lane.ci].loop = on ? 0 : null; }, true)));
      if (ch.loop !== null) box.append(field("Loop from (tick)", num(0, ch.end - 1, ch.loop, x => edit(c => { c.channels[lane.ci].loop = x; }, true))));
    }
    box.append(field(ch.loop !== null ? "Loop end (tick)" : "Ends at (tick)", num(1, 99999, ch.end, x => edit(c => { c.channels[lane.ci].end = x; }, true))));
    if (!s.sfx && S.songs.length) {
      box.append(el("button", {
        textContent: "Same for all channels", title: "Copy this channel's loop and end to the others",
        on: { click: () => edit(c => { for (const o of c.channels) if (o) { o.loop = ch.loop; o.end = ch.end; } }, true) },
      }));
    }
  }
  box.append(el("div", { className: "sep" }));
  const types = lane.type === "noise" ? ["noisevol"] : s.sfx ? ["ctrl0", "ctrl1"] : kind === "tri" ? ["ctrl0", "tempo", "offset", "sync"] : ["ctrl0", "ctrl1", "tempo", "offset", "sync"];
  const pick = select(types.map(t => [t, EVENT_NAMES[t]]), types[0], () => {});
  box.append(field(`Add at the red marker (tick ${roll.cursor})`, pick));
  box.append(el("button", {
    textContent: "Add", on: {
      click: () => {
        const type = pick.value, t = roll.cursor;
        const v = type === "tempo" ? 120 : type === "offset" ? 0 : type === "ctrl1" ? 0x08 : type === "noisevol" ? 0x3f : kind === "tri" ? 0xff : 0xbf;
        let made;
        edit(c => { made = type === "sync" ? { t, type, until: t + 24 } : { t, type, v }; addEvent(c, lane.ci, made); }, true);
        roll.select({ ev: made, kind: "event", lane: roll.lane });
      },
    },
  }));
  box.append(el("p", { className: "hint note", textContent: "Tap the roll to add a note, drag a note to move it, drag its right end to change its length. Drag empty space to scroll; tap the ruler to choose where Play starts. Events (instruments, tempo, cues) are in the strip at the bottom." }));
}

function tempoControls(v, set) {
  const bpm = x => (60e6 / usPerQuarter(x)).toFixed(1);
  const lab = el("small", { textContent: `≈ ${bpm(v)} BPM` });
  return [field(el("span", {}, "Speed ", lab), range(1, 255, v, x => { lab.textContent = `≈ ${bpm(x)} BPM`; }, set)), field("Value", num(1, 255, v, set))];
}

// ---------------------------------------------------------------- playing

let ctx = null, playing = null;

function play(i, from = 0) {
  stop();
  const s = S.songs[i];
  let pv;
  try { pv = previewMem(S.rom, S.L, s); } catch (e) { toast(e.message); return; }
  ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  ctx.resume();
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}
  const p = new Player(pv.mem, S.L.notesTbl, ctx.sampleRate);
  if (s.sfx) p.sfx(pv.ptrs[0]); else p.music(pv.ptrs, pv.silent);
  // Start partway in by running the engine silently up to there.
  const clock = () => (s.sfx ? p.frames : p.ticks);
  for (let f = 0; clock() < from && f < 200000; f++) p.frame();
  const gain = ctx.createGain();
  gain.gain.value = 0.8;
  gain.connect(ctx.destination);
  playing = { i, p, gain, next: ctx.currentTime + 0.05, marks: [], end: null, sources: [] };
  const pl = playing;
  const pump = () => {
    if (playing !== pl) return;
    while (pl.next < ctx.currentTime + 0.3 && pl.end === null) {
      const buf = ctx.createBuffer(1, 2048, ctx.sampleRate);
      pl.marks.push([pl.next, clock()]);
      p.render(buf.getChannelData(0));
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(gain); src.start(pl.next);
      pl.sources.push(src);
      if (pl.sources.length > 20) pl.sources.shift();
      pl.next += buf.duration;
      const over = s.sfx ? !p.sfxActive() : !p.musicActive();
      if (over) pl.end = pl.next + (s.sfx ? 0.2 : 0.8);
    }
    if (pl.end !== null && ctx.currentTime > pl.end) { stop(); return; }
  };
  pl.timer = setInterval(pump, 30);
  pump();
  const draw = () => {
    if (playing !== pl) return;
    const now = ctx.currentTime;
    let k = pl.marks.findLastIndex(m => m[0] <= now);
    if (k >= 0) {
      if (pl.marks.length > 64) { pl.marks.splice(0, k); k = 0; }
      const [t0, c0] = pl.marks[k], nx = pl.marks[k + 1];
      let t = nx ? c0 + (nx[1] - c0) * (now - t0) / (nx[0] - t0) : c0;
      t = Math.max(0, t - 1);
      if (S.cur === i) {
        const ch = s.channels[lanesOf(s)[roll.lane].ci] || s.channels.find(Boolean);
        if (ch && ch.loop !== null && t >= ch.end) t = ch.loop + (t - ch.end) % (ch.end - ch.loop);
        roll.playhead = t;
        roll.scrollTo(t);
        roll.draw();
      }
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  renderList();
  renderSongBar();
}

function stop() {
  if (!playing) return;
  clearInterval(playing.timer);
  for (const src of playing.sources) try { src.stop(); } catch {}
  playing.gain.disconnect();
  playing = null;
  roll.playhead = null;
  roll.draw();
  if (S.rom) { renderList(); renderSongBar(); }
}

$("#play").onclick = () => (playing?.i === S.cur ? stop() : play(S.cur, roll.cursor));

// ---------------------------------------------------------------- files

const baseName = () => S.name.replace(/\.[^.]+$/, "");

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

$("#mid-export").onclick = () => download(new Blob([writeMidi(songToMidi(song()))], { type: "audio/midi" }), fileName(song(), S.cur));

$("#mid-import").onchange = async e => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const midi = readMidi(new Uint8Array(await f.arrayBuffer()));
    const from = slotOf(midi);
    const s = song();
    if (from && from.sfx !== s.sfx) {
      if (!confirm(`That file is a ${from.sfx ? "sound effect" : "song"}, and ${s.name} is a ${s.sfx ? "sound effect" : "song"}. Import it anyway?`)) return;
    }
    const { song: made, warnings } = midiToSong(midi, s);
    edit(cur => { Object.assign(cur, made); }, true);
    roll.select(null);
    roll.centerOnNotes();
    toast([`Imported ${f.name} into ${s.name}.`, ...warnings].join("\n"));
  } catch (err) { toast(err.message); }
};

$("#zip-export").onclick = async () => {
  const files = S.songs.map((s, i) => (!s.sfx && s.id === 0 ? null : {
    name: (s.sfx ? "sfx/" : "music/") + fileName(s, i), data: writeMidi(songToMidi(s)),
  })).filter(Boolean);
  files.push({ name: "README.txt", data: new TextEncoder().encode(README) });
  download(zip(files), `${baseName()} music.zip`);
};

const README = `MusicSmith: Dragon Warrior music as MIDI files

music/ has every song, sfx/ every sound effect. Edit them in any MIDI editor, then import the ZIP (or just the files
you changed) back into MusicSmith. Each file knows which song it is, so keep the text event in it, or the number at
the start of the file name.

Each track is one NES channel and plays one note at a time: Square 1, Square 2, Triangle (sound effects: Square 2 and
Noise). Notes go from C2 to C8. 24 ticks per quarter note is the engine's timing; finer timing is rounded.

Controller events hold what MIDI can't say:
  CC20/CC21  instrument byte, high/low nibble (duty and flags / volume or fade time)
  CC22/CC23  pitch sweep byte
  CC24/CC25  note offset (shifts every channel)
  CC15       this channel sets the tempo here (the tempo is the normal tempo event)
  CC111      loop start      CC110  loop end (or end of the song)
  CC113      cue the game waits for: 127 where it starts, 0 where it ends   CC114  cue after the end
A track without CC20/CC21 gets its volume from note velocities.
`;

$("#zip-import").onclick = () => $("#multi-import").click();
$("#multi-import").onchange = e => { importFiles([...e.target.files]); e.target.value = ""; };

// Imports MIDI files (or ZIPs of them) into the songs they came from.
async function importFiles(files) {
  const mids = [];
  for (const f of files) {
    const data = new Uint8Array(await f.arrayBuffer());
    if (/\.zip$/i.test(f.name)) {
      try { for (const z of await unzip(data)) if (/\.(mid|midi|rmi)$/i.test(z.name)) mids.push({ name: z.name, data: z.data }); }
      catch (err) { toast(`${f.name}: ${err.message}`); return; }
    } else mids.push({ name: f.name, data });
  }
  const done = [], skipped = [], notes = [];
  for (const m of mids) {
    try {
      const midi = readMidi(m.data);
      let slot = slotOf(midi);
      const base = m.name.split("/").pop();
      if (!slot) {
        const mm = base.match(/^(sfx[\s_-]*)?(\d+)/i);
        if (mm) slot = { sfx: !!mm[1] || /(^|\/)sfx\//i.test(m.name), index: +mm[2] };
      }
      const i = slot ? S.songs.findIndex(s => s.sfx === slot.sfx && (s.id & 0x7f) === slot.index) : -1;
      if (i < 0 || (!S.songs[i].sfx && S.songs[i].id === 0)) { skipped.push(base); continue; }
      const { song: made, warnings } = midiToSong(midi, S.songs[i]);
      // Files that didn't change (re-exported untouched) are left alone.
      if (JSON.stringify(made.channels) === JSON.stringify(S.songs[i].channels)) continue;
      S.hist.push({ i, song: cloneSong(S.songs[i]), edited: S.edited.has(i) });
      S.fut = [];
      S.songs[i] = made;
      S.edited.add(i);
      done.push(S.songs[i].name);
      for (const w of warnings) notes.push(`${S.songs[i].name}: ${w}`);
    } catch (err) { notes.push(`${m.name}: ${err.message}`); }
  }
  roll.select(null);
  openSong(S.cur, roll.lane);
  changed();
  const msg = [done.length ? `Imported ${done.length}: ${done.join(", ")}.` : "Nothing changed: those files match the songs already here."];
  if (skipped.length) msg.push(`Couldn't tell which song ${skipped.length > 1 ? "these are" : "this is"}: ${skipped.join(", ")}. Name them like the exported files (e.g. "05 Overworld.mid").`);
  toast([...msg, ...notes].join("\n"));
}

$("#wav").onclick = async () => {
  const s = song();
  toast("Recording…");
  try {
    const r = await work({ cmd: "wav", rom: S.rom, L: S.L, song: JSON.parse(JSON.stringify(s)), rate: 44100 });
    download(wav(r.samples, 44100), fileName(s, S.cur).replace(/\.mid$/, ".wav"));
    toast(`Recorded ${s.name} (${(r.samples.length / 44100).toFixed(1)} s).`);
  } catch (e) { toast(e.message); }
};

async function built() {
  if (!S.edited.size) return S.rom;
  const r = await work({ cmd: "build", rom: S.rom, L: S.L, songs: plainSongs() });
  showMeter(r.used, r.room);
  return r.rom;
}

$("#save").onclick = async () => {
  try {
    const out = await built();
    download(new Blob([out]), `${baseName()} (MusicSmith).nes`);
    toast(S.edited.size ? "Saved. Your music is in the new ROM." : "Nothing has changed yet, so that's the original ROM.");
  } catch (e) { toast(e.message); }
};

$("#ips").onclick = async () => {
  try {
    const out = await built();
    const p = makeIPS(S.rom, out);
    if (!p) { toast("Nothing has changed yet, so there's no patch to make."); return; }
    download(new Blob([p]), `${baseName()} music.ips`);
  } catch (e) { toast(e.message); }
};

// ---------------------------------------------------------------- the space meter

let measureTimer = 0;
function measureSoon() { clearTimeout(measureTimer); measureTimer = setTimeout(measure, 900); }
async function measure() {
  if (!S.rom) return;
  try {
    const r = await work({ cmd: "build", rom: S.rom, L: S.L, songs: plainSongs(), measure: true });
    showMeter(r.used, r.room);
  } catch (e) {
    $("#meter-bar").style.width = "100%";
    $("#meter-bar").classList.add("full");
    $("#meter-text").textContent = e.message;
    $("#meter-text").classList.add("err");
  }
}
function showMeter(used, room) {
  $("#meter-bar").style.width = `${Math.min(100, used / room * 100)}%`;
  $("#meter-bar").classList.toggle("full", used > room);
  $("#meter-text").classList.remove("err");
  $("#meter-text").textContent = `${used} of ${room} bytes used: room for about ${room - used} more bytes of music (a note is 1-2).`;
}

// ---------------------------------------------------------------- keys

addEventListener("keydown", e => {
  if (!S.rom || e.target.closest("input, select, textarea")) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
  else if (e.key === " ") { e.preventDefault(); $("#play").click(); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelection(); }
  else if (roll.sel?.kind === "note" && e.key.startsWith("Arrow")) {
    e.preventDefault();
    const n = roll.sel.ev, noise = n.type === "noise";
    edit(() => {
      if (e.key === "ArrowLeft") n.t = Math.max(0, n.t - roll.grid);
      if (e.key === "ArrowRight") n.t += roll.grid;
      const d = e.key === "ArrowUp" ? (e.shiftKey ? 12 : 1) : e.key === "ArrowDown" ? (e.shiftKey ? -12 : -1) : 0;
      if (noise) n.v = Math.max(0xe0, Math.min(0xef, n.v - d));
      else n.key = Math.max(NOTE_BASE, Math.min(0xc8, n.key + d));
    }, true);
  }
});

// ---------------------------------------------------------------- keeping work across reloads

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("musicsmith", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", mode), req = fn(tx.objectStore("kv"));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}
const idbGet = k => idbDo("readonly", s => s.get(k));
const idbPut = (k, v) => idbDo("readwrite", s => s.put(v, k));
const idbDel = k => idbDo("readwrite", s => s.delete(k));

let saveTimer = 0;
function saveSoon() { clearTimeout(saveTimer); if (S.rom) saveTimer = setTimeout(saveNow, 800); }
function saveNow() {
  if (!S.rom) return;
  idbPut("session", {
    name: S.name, rom: S.rom, cur: S.cur, lane: roll.lane, edited: [...S.edited],
    songs: S.songs.map((s, i) => (S.edited.has(i) ? JSON.parse(JSON.stringify(s)) : null)),
  }).catch(() => {});
}
addEventListener("pagehide", saveNow);

let toastTimer = 0;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2500 + msg.length * 40);
}
$("#toast").onclick = () => { $("#toast").hidden = true; };

// On a phone the side panel sits above the editor, so it starts folded up.
const phone = matchMedia("(max-width: 760px)");
if (phone.matches) document.querySelectorAll("#side > details").forEach(d => { d.open = false; });

(async () => {
  try {
    const v = await idbGet("session");
    if (!v?.rom) return;
    start(v);
  } catch {}
})();

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js");
