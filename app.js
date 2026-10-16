import { detect, ENGINES } from "./engines.js";
import { writeMidi, readMidi } from "./midi.js";
import { zip, unzip, makeIPS, wav } from "./files.js";
import { Roll, addEvent, tidy } from "./roll.js";
import { el, field, check, select, num, sep, hint, midiName } from "./ui.js";

const $ = s => document.querySelector(s);
const S = { rom: null, name: "", engine: null, L: null, songs: [], orig: [], edited: new Set(), cur: 0, hist: [], fut: [] };
const cloneSong = s => JSON.parse(JSON.stringify(s));

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
  const found = detect(v.rom);
  if (!found) {
    const known = [...new Set(ENGINES.map(e => `${e.name} (${e.system})`))].join(", ");
    throw new Error(`MusicSmith doesn't know this game's sound engine. It knows: ${known}.`);
  }
  const { engine, L } = found;
  const orig = engine.readSongs(v.rom, L);
  stop();
  const keep = v.engine === engine.id || (!v.engine && engine.id === "dw");
  Object.assign(S, {
    rom: v.rom, name: v.name, engine, L, orig, songs: orig.map((s, i) => (keep && v.songs?.[i]) || cloneSong(s)),
    edited: new Set(keep ? v.edited || [] : []), cur: v.cur ?? orig.findIndex(s => !engine.hidden(s)), hist: [], fut: [],
  });
  roll.engine = engine;
  setGrid(engine.ppq);
  $("#midi-help").replaceChildren(...engine.midiHelp.map(t => el("p", { className: "hint", textContent: t })));
  document.body.classList.add("open");
  $("#welcome").hidden = true;
  $("#work").hidden = false;
  $("#rom-name").textContent = `${v.name} · ${engine.name}`;
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
const fileName = s => {
  const n = s.name.replace(/[^\w ()'-]+/g, "").trim(), k = String(S.engine.number(s)).padStart(2, "0");
  return s.sfx ? `sfx ${k} ${n}.mid` : `${k} ${n}.mid`;
};

function renderList() {
  $("#sfx-head").hidden = !S.songs.some(s => s.sfx && !S.engine.hidden(s));
  $("#music-head").hidden = !S.songs.some(s => !s.sfx && !S.engine.hidden(s));
  for (const [sel, sfx] of [["#music", false], ["#sfx", true]]) {
    const ul = $(sel);
    ul.replaceChildren();
    S.songs.forEach((s, i) => {
      if (s.sfx !== sfx || S.engine.hidden(s)) return;
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
  roll.lane = Math.min(lane, roll.lanes.length - 1);
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
  $("#song-sub").textContent = S.engine.describe(s) + (S.edited.has(S.cur) ? " · edited" : "");
  $("#revert").disabled = !S.edited.has(S.cur);
  $("#play").textContent = playing?.i === S.cur ? "Stop" : "Play";
  $("#play").classList.toggle("playing", playing?.i === S.cur);
}

function renderLanes() {
  const seg = $("#lanes");
  seg.replaceChildren();
  roll.lanes.forEach((l, i) => {
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
// Grid choices in the engine's ticks: whatever divides a beat evenly.
function setGrid(ppq) {
  const opts = [[1, "1 tick"], [ppq / 8, "1/32"], [ppq / 4, "1/16"], [ppq / 3, "1/8 triplet"], [ppq / 2, "1/8"], [ppq, "1/4"]]
    .filter(([v], i, a) => Number.isInteger(v) && v >= 1 && a.findIndex(x => x[0] === v) === i);
  $("#grid").replaceChildren(...opts.map(([v, t]) => el("option", { value: v, textContent: t })));
  const def = opts.find(o => o[0] === ppq / 4) || opts.at(-1);
  $("#grid").value = def[0];
  roll.grid = def[0];
  roll.len = ppq / 2;
}
$("#grid").onchange = e => { roll.grid = +e.target.value; roll.len = Math.max(roll.grid, roll.len - roll.len % roll.grid || roll.grid); roll.draw(); };
$("#zoom-in").onclick = () => roll.zoomBy(1.5);
$("#zoom-out").onclick = () => roll.zoomBy(1 / 1.5);

// ---------------------------------------------------------------- the inspector

// The value an engine setting has at tick t on a channel: the last change at or before it.
function valueAt(ch, type, t) {
  let v = null;
  for (const e of ch?.events || []) if (e.type === type && e.t <= t) v = e.v;
  return v;
}

// What an engine's controls get to work with. Their edits are each one undoable step.
function inspectCtx() {
  const s = song(), lane = roll.lanes[roll.lane], ch = s.channels[lane.ci];
  return {
    song: s, lane, ch, engine: S.engine, cursor: roll.cursor,
    edit: fn => edit(fn, true),
    valueAt: (type, t) => valueAt(ch, type, t),
    // Sets an engine setting at tick t, changing the event there or adding one.
    setAt: (type, t, v) => edit(x => {
      const c = x.channels[lane.ci];
      const ev = c?.events.find(e => e.type === type && e.t === t && !e.pre);
      if (ev) ev.v = v; else addEvent(x, lane.ci, { t, type, v });
    }, true),
  };
}

function renderInspector() {
  const box = $("#inspector");
  box.replaceChildren();
  $("#delete").disabled = !roll.sel;
  if (!S.rom) return;
  const ctx = inspectCtx(), { song: s, lane, ch } = ctx, E = S.engine;
  const sel = roll.sel;

  if (sel?.kind === "note") {
    const n = sel.ev, k = lane.key(n);
    box.append(el("h3", {}, lane.label ? lane.label(k) : midiName(k), el("small", { textContent: `${lane.name} · tick ${n.t} · ${n.dur} long` })));
    if (!lane.label) {
      const keys = [];
      for (let x = lane.hi; x >= lane.lo; x--) keys.push([x, midiName(x)]);
      box.append(field("Note", select(keys, k, v => edit(() => lane.setKey(n, +v), true))));
    }
    box.append(field("Start (tick)", num(0, 99999, n.t, x => edit(() => { n.t = x; }, true))));
    box.append(field("Length", num(1, 9999, n.dur, x => edit(() => { n.dur = x; roll.len = x; }, true))));
    box.append(...(E.noteControls?.(ctx, n) || []));
    return;
  }

  if (sel?.kind === "event") {
    const e = sel.ev, info = E.eventInfo(e);
    box.append(el("h3", {}, info.name, el("small", { textContent: `${lane.name} · tick ${e.t}${e.pre ? " · only the first time through" : ""}` })));
    box.append(field("Tick", num(0, 99999, e.t, x => edit(() => { if (e.until !== undefined) e.until += x - e.t; e.t = x; }, true))));
    box.append(...E.eventControls(ctx, e));
    box.append(sep(), el("button", { textContent: "Delete event", on: { click: deleteSelection } }));
    return;
  }

  // Nothing selected: the channel's loop and end, and adding events.
  box.append(el("h3", {}, lane.name, el("small", { textContent: ch ? "" : "silent in this song: tap the roll to add notes" })));
  if (ch) {
    // Some engines loop the whole song at once: then the loop and end apply to every channel.
    const chans = c => (E.sharedLoop ? c.channels.filter(Boolean) : [c.channels[lane.ci]]);
    if (!s.sfx) {
      box.append(check("Loop", ch.loop !== null, on => edit(c => { for (const o of chans(c)) o.loop = on ? 0 : null; }, true)));
      if (ch.loop !== null) box.append(field("Loop from (tick)", num(0, ch.end - 1, ch.loop, x => edit(c => { for (const o of chans(c)) o.loop = x; }, true))));
    }
    box.append(field(ch.loop !== null ? "Loop end (tick)" : "Ends at (tick)", num(1, 99999, ch.end, x => edit(c => { for (const o of chans(c)) o.end = x; }, true))));
    if (!s.sfx && !E.sharedLoop) {
      box.append(el("button", {
        textContent: "Same for all channels", title: "Copy this channel's loop and end to the others",
        on: { click: () => edit(c => { for (const o of c.channels) if (o) { o.loop = ch.loop; o.end = ch.end; } }, true) },
      }));
    }
  }
  const types = E.addable(ctx);
  if (types.length) {
    box.append(sep());
    const pick = select(types.map(t => [t, E.eventInfo({ type: t }).name]), types[0], () => {});
    box.append(field(`Add at the red marker (tick ${roll.cursor})`, pick));
    box.append(el("button", {
      textContent: "Add", on: {
        click: () => {
          const made = E.newEvent(ctx, pick.value, roll.cursor);
          edit(c => addEvent(c, lane.ci, made), true);
          roll.select({ ev: made, kind: "event", lane: roll.lane });
        },
      },
    }));
  }
  box.append(hint(E.laneHint));
}

// ---------------------------------------------------------------- playing

let ctx = null, playing = null;

function play(i, from = 0) {
  stop();
  const s = S.songs[i];
  ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  ctx.resume();
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}
  let p;
  try { p = S.engine.player(S.rom, S.L, s, ctx.sampleRate); } catch (e) { toast(e.message); return; }
  // Start partway in by running the engine silently up to there.
  p.seek(from);
  const clock = () => p.clock();
  const gain = ctx.createGain();
  gain.gain.value = 0.8;
  gain.connect(ctx.destination);
  playing = { i, p, gain, next: ctx.currentTime + 0.05, marks: [], end: null, sources: [] };
  const pl = playing;
  const pump = () => {
    if (playing !== pl) return;
    while (pl.next < ctx.currentTime + 0.3 && pl.end === null) {
      const buf = ctx.createBuffer(2, 2048, ctx.sampleRate);
      pl.marks.push([pl.next, clock()]);
      p.render(buf.getChannelData(0), buf.getChannelData(1));
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(gain); src.start(pl.next);
      pl.sources.push(src);
      if (pl.sources.length > 20) pl.sources.shift();
      pl.next += buf.duration;
      if (!p.active()) pl.end = pl.next + (s.sfx ? 0.2 : 0.8);
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
        const ch = s.channels[roll.lanes[roll.lane].ci] || s.channels.find(Boolean);
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

$("#mid-export").onclick = () => download(new Blob([writeMidi(S.engine.toMidi(song()))], { type: "audio/midi" }), fileName(song()));

$("#mid-import").onchange = async e => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const midi = readMidi(new Uint8Array(await f.arrayBuffer()));
    const from = S.engine.slotOf(midi);
    const s = song();
    if (from && from.sfx !== s.sfx) {
      if (!confirm(`That file is a ${from.sfx ? "sound effect" : "song"}, and ${s.name} is a ${s.sfx ? "sound effect" : "song"}. Import it anyway?`)) return;
    }
    const { song: made, warnings } = S.engine.fromMidi(midi, s);
    edit(cur => { Object.assign(cur, made); }, true);
    roll.select(null);
    roll.centerOnNotes();
    toast([`Imported ${f.name} into ${s.name}.`, ...warnings].join("\n"));
  } catch (err) { toast(err.message); }
};

$("#zip-export").onclick = async () => {
  const files = S.songs.map(s => (S.engine.hidden(s) ? null : {
    name: (s.sfx ? "sfx/" : "music/") + fileName(s), data: writeMidi(S.engine.toMidi(s)),
  })).filter(Boolean);
  files.push({ name: "README.txt", data: new TextEncoder().encode(S.engine.readme) });
  download(zip(files), `${baseName()} music.zip`);
};


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
      let slot = S.engine.slotOf(midi);
      const base = m.name.split("/").pop();
      if (!slot) {
        const mm = base.match(/^(sfx[\s_-]*)?(\d+)/i);
        if (mm) slot = { sfx: !!mm[1] || /(^|\/)sfx\//i.test(m.name), index: +mm[2] };
      }
      const i = slot ? S.songs.findIndex(s => s.sfx === slot.sfx && S.engine.number(s) === slot.index) : -1;
      if (i < 0 || S.engine.hidden(S.songs[i])) { skipped.push(base); continue; }
      const { song: made, warnings } = S.engine.fromMidi(midi, S.songs[i]);
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
    const r = await work({ cmd: "wav", engine: S.engine.id, rom: S.rom, L: S.L, song: JSON.parse(JSON.stringify(s)), rate: 44100 });
    download(wav(r.left, r.right, 44100), fileName(s).replace(/\.mid$/, ".wav"));
    toast(`Recorded ${s.name} (${(r.left.length / 44100).toFixed(1)} s).`);
  } catch (e) { toast(e.message); }
};

async function built() {
  if (!S.edited.size) return S.rom;
  const r = await work({ cmd: "build", engine: S.engine.id, rom: S.rom, L: S.L, songs: plainSongs(), edited: [...S.edited] });
  showMeter(r.used, r.room);
  return r.rom;
}

$("#save").onclick = async () => {
  try {
    const out = await built();
    download(new Blob([out]), `${baseName()} (MusicSmith).${S.engine.ext}`);
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
    const r = await work({ cmd: "build", engine: S.engine.id, rom: S.rom, L: S.L, songs: plainSongs(), edited: [...S.edited], measure: true });
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
  $("#meter-text").textContent = S.engine.spaceText(used, room);
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
    const n = roll.sel.ev, lane = roll.lanes[roll.lane];
    edit(() => {
      if (e.key === "ArrowLeft") n.t = Math.max(0, n.t - roll.grid);
      if (e.key === "ArrowRight") n.t += roll.grid;
      const d = e.key === "ArrowUp" ? (e.shiftKey ? 12 : 1) : e.key === "ArrowDown" ? (e.shiftKey ? -12 : -1) : 0;
      if (d) lane.setKey(n, Math.max(lane.lo, Math.min(lane.hi, lane.key(n) + d)));
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
    name: S.name, rom: S.rom, engine: S.engine.id, cur: S.cur, lane: roll.lane, edited: [...S.edited],
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

$("#engine-list").replaceChildren(...ENGINES.map(e => el("li", {}, el("b", { textContent: `${e.name} (${e.system})` }), e.examples ? `: ${e.examples}` : "")));

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
