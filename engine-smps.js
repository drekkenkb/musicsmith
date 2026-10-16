// SMPS (Sega Genesis), as a MusicSmith engine. See smps.js for the format, smps-locate.js for how the driver is
// found, and engines.js for what an engine provides.
//
// Songs play on the emulated Genesis running the game's own sound driver: the edited song is compiled onto the end
// of a copy of the ROM, the music table points at it, and the driver is asked to play it, just as the game would.
// Building the ROM does the same for real: edited songs go after the end of the ROM, which grows (up to 4 MB).
import { Genesis } from "./genesis.js";
import { YM_RATE } from "./ym2612.js";
import { locate, restore } from "./smps-locate.js";
import { decodeSong, compileSong, S1_FLAGS } from "./smps.js";
import { field, select, hint, commandControls } from "./ui.js";

const PPQ = 24; // songs count beats many ways; 24 divides into the usual note lengths
const COLORS = { dac: "#ff6b6b", fm: ["#ffd43b", "#4dabf7", "#8ce99a", "#da77f2", "#ffa94d", "#e9ecef"], psg: ["#66d9e8", "#74c0fc", "#b197fc", "#ced4da"] };
const NOTE_LO = 0x81, NOTE_HI = 0xdf;
const DRUM0 = 35; // the DAC's first sample as a MIDI drum key
// Note $81 is C0 on the FM channels and C3 on the PSG (as MIDI keys, 12 and 48), before the track's transposition.
const keyBase = ch => (ch.kind === "psg" ? 48 : 12) + ch.transpose;
const MAX_ROM = 0x400000;

const ARGS = {
  0xe0: [{ name: "Pan and LFO (bits 7/6: left/right on)", max: 255 }],
  0xe1: [{ name: "Detune", max: 127, signed: true }],
  0xe2: [{ name: "Value", max: 255 }],
  0xe5: [{ name: "Divider", min: 1, max: 255 }],
  0xe6: [{ name: "Volume change (+ is quieter)", max: 127, signed: true }],
  0xe8: [{ name: "Note fill (frames before the end it stops)", max: 255 }],
  0xe9: [{ name: "Semitones", max: 127, signed: true }],
  0xea: [{ name: "Tempo", max: 255 }],
  0xeb: [{ name: "Divider", min: 1, max: 255 }],
  0xec: [{ name: "Volume change (+ is quieter)", max: 127, signed: true }],
  0xef: [{ name: "Instrument", max: 255 }],
  0xf0: [{ name: "Delay", max: 255 }, { name: "Rate", max: 255 }, { name: "Step", max: 127, signed: true }, { name: "Steps", max: 255 }],
  0xf3: [{ name: "Noise mode", max: 255 }],
  0xf5: [{ name: "Envelope", max: 255 }],
};
const MARKS = { 0xe0: "P", 0xe1: "~", 0xe5: "T", 0xe6: "V", 0xe8: "F", 0xe9: "K", 0xea: "T", 0xeb: "T", 0xec: "V", 0xef: "I", 0xf0: "~", 0xf1: "~", 0xf4: "~", 0xf3: "N", 0xf5: "E" };
const ADDABLE = { fm: [0xef, 0xe6, 0xe0, 0xe1, 0xe8, 0xe9, 0xea, 0xf0, 0xf4, 0xf1], dac: [0xe6, 0xe0, 0xea], psg: [0xec, 0xf5, 0xe1, 0xe8, 0xe9, 0xea, 0xf3, 0xf0, 0xf4, 0xf1] };
const DEFAULT_ARGS = { 0xe0: [0xc0], 0xe1: [0], 0xe2: [0], 0xe5: [1], 0xe6: [0], 0xe8: [0], 0xe9: [0], 0xea: [3], 0xeb: [1], 0xec: [0], 0xef: [0], 0xf0: [1, 1, 1, 4], 0xf3: [0xe7], 0xf5: [0] };

const r32 = (r, o) => ((r[o] << 24) | (r[o + 1] << 16) | (r[o + 2] << 8) | r[o + 3]) >>> 0;

// ---------------------------------------------------------------- finding and reading

function detect(rom) {
  if (rom.length < 0x200 || rom.length > MAX_ROM) return null;
  const found = locate(rom);
  if (!found) return null;
  const L = found.L;
  if (L.stride !== 4) return null; // 16-bit table entries can't point past 64 KB of the table, so songs couldn't move
  L.songs = L.songs.filter(s => { try { decodeSong(rom, s.at, L.flags); return true; } catch { return false; } });
  return L.songs.length ? L : null;
}

// A decoded song in the app's terms: notes with a key and a length (dur), and commands. DAC notes are drums. Rests
// are the gaps between notes; where the song split a gap into several rests, a "rest" marker (no length, not shown)
// remembers it, so an unchanged passage compiles back to exactly the steps it had.
function fromDecoded(d, id) {
  const channels = d.channels.map(c => {
    const base = keyBase(c), events = [];
    for (const e of c.events) {
      if (e.type === "cmd") events.push({ t: e.t, type: "cmd", op: e.op, args: e.args, pre: e.pre });
      else if (e.type === "note") {
        const n = c.kind === "dac" ? { t: e.t, type: "drum", key: DRUM0 + e.raw - NOTE_LO } : { t: e.t, type: "note", key: base + e.raw - NOTE_LO };
        Object.assign(n, { dur: e.step, seg: e.seg, bareSeg: e.bareSeg, bare: e.bare, hold: e.hold });
        events.push(n);
      } else events.push({ t: e.t, type: "rest", seg: e.seg, bare: e.bare, hold: e.hold });
    }
    return { kind: c.kind, transpose: c.transpose, volume: c.volume, mod: c.mod, env: c.env, events, loop: c.loop, end: c.end };
  });
  const end = Math.max(...channels.map(c => c.end));
  return { id, name: "", sfx: false, div: d.div, tempo: d.tempo, voicesAt: d.voicesAt, voiceCount: d.voiceCount, channels, end };
}

function readSongs(rom, L) {
  return L.songs.map(s => {
    const song = fromDecoded(decodeSong(rom, s.at, L.flags), s.id);
    song.name = `Song $${s.id.toString(16).toUpperCase()}`;
    return song;
  });
}

// ---------------------------------------------------------------- back to the driver's form

// One channel as the compiler wants it: a step for every tick from 0 to the end (rests in the gaps), a note cut
// where the next starts, and steps split wherever a command or the loop point falls inside them (a split note
// carries on with "hold", so it isn't struck again).
function toTrack(ch, div, F) {
  const isNote = e => e.type === "note" || e.type === "drum";
  const evs = ch.events.slice().sort((a, b) => a.t - b.t || (isNote(a) ? 1 : 0) - (isNote(b) ? 1 : 0));
  const end = ch.end;
  const cuts = new Set(evs.filter(e => e.type === "cmd").map(e => e.t));
  if (ch.loop !== null) cuts.add(ch.loop);
  const raw = e => (e.type === "drum" ? NOTE_LO + e.key - DRUM0 : NOTE_LO + e.key - keyBase(ch));
  const notes = evs.filter(e => isNote(e) && e.t < end);
  const rests = new Map(evs.filter(e => e.type === "rest").map(e => [e.t, e]));
  const out = [];
  let t = 0, ni = 0;
  const pushStep = (type, from, len, src) => {
    // Pieces between cut points. A note keeps its stored tied pieces whole when a command falls on a boundary
    // between them (the compiler puts it back there); the loop point always splits.
    const kept = src?.seg && src.seg.reduce((x, y) => x + y, 0) * div === len;
    const bounds = new Set();
    if (kept) src.seg.reduce((x, y) => { bounds.add(from + (x + y) * div); return x + y; }, 0);
    let first = true;
    for (let a = from; a < from + len;) {
      let b = from + len;
      for (const c of cuts) if (c > a && c < b && (c === ch.loop || !bounds.has(c))) b = c;
      if (type === "rest") for (const c of rests.keys()) if (c > a && c < b) b = c;
      if (type === "rest") out.push({ t: a, type: "rest", step: b - a, seg: rests.get(a)?.seg, bare: rests.get(a)?.bare, hold: rests.get(a)?.hold });
      else {
        const whole = first && b === from + len;
        out.push({ t: a, type: "note", raw: Math.max(NOTE_LO, Math.min(NOTE_HI, raw(src))), step: b - a, seg: whole ? src.seg : undefined, bareSeg: whole ? src.bareSeg : undefined, bare: whole ? src.bare : undefined, hold: first ? src.hold : true });
      }
      first = false;
      a = b;
    }
  };
  const cmds = evs.filter(e => e.type === "cmd");
  // Steps, then commands slotted in front of the step that starts at their tick.
  while (t < end) {
    const n = notes[ni];
    if (n && n.t <= t) {
      const next = notes[ni + 1]?.t ?? end;
      const len = Math.max(1, Math.min(n.t + n.dur, next, end) - n.t);
      pushStep("note", n.t, len, n);
      t = n.t + len; ni++;
      continue;
    }
    const to = Math.min(n ? n.t : end, end);
    pushStep("rest", t, to - t);
    t = to;
  }
  const merged = [];
  let ci = 0;
  for (const s of out) {
    while (ci < cmds.length && cmds[ci].t <= s.t) merged.push(cmds[ci++]);
    merged.push(s);
  }
  while (ci < cmds.length) merged.push(cmds[ci++]);
  // Steps must be whole multiples of the tempo divider in force.
  let d = div;
  for (const e of merged) {
    if (e.type === "cmd") { if (e.op === F.tempoDiv) d = e.args[0] || 1; continue; }
    if (e.step % d) e.seg = undefined;
  }
  return { kind: ch.kind, transpose: ch.transpose, volume: ch.volume, mod: ch.mod, env: ch.env, events: merged, loop: ch.loop, end };
}

function toDecoded(song, F) {
  return { div: song.div, tempo: song.tempo, voicesAt: song.voicesAt, voiceCount: song.voiceCount, channels: song.channels.map(c => toTrack(c, song.div, F)) };
}

// The bytes of an edited song, ready to sit at `base`.
const compiled = (song, rom, F, base) => compileSong(toDecoded(song, F), rom, F, base);

// A copy of the ROM with songs put after its end and the music table pointed at them. Returns the ROM and how many
// bytes the songs took.
function withSongs(rom, L, list) {
  const parts = [];
  let at = (rom.length + 1) & ~1, used = 0;
  for (const s of list) {
    const bytes = compiled(s, rom, L.flags, at);
    parts.push({ s, at, bytes });
    at = (at + bytes.length + 1) & ~1;
    used += bytes.length;
  }
  const out = new Uint8Array(Math.max(rom.length, at));
  out.set(rom);
  for (const p of parts) {
    out.set(p.bytes, p.at);
    const e = L.table + (p.s.id - L.first) * L.stride;
    out[e] = p.at >>> 24; out[e + 1] = (p.at >> 16) & 255; out[e + 2] = (p.at >> 8) & 255; out[e + 3] = p.at & 255;
  }
  return { rom: out, used, parts };
}

// Where the ROM must stop: 4 MB, or where save RAM starts if the header asks for it.
function romLimit(rom) {
  if (rom[0x1b0] === 0x52 && rom[0x1b1] === 0x41) { const s = r32(rom, 0x1b4) & 0xfffffe; if (s >= rom.length) return s; }
  return MAX_ROM;
}

// The header checksum (games like Sonic check it at boot). The added part ends with a word that makes it sum to zero,
// so the checksum is right whether a game sums the size it shipped at or the whole file. The header's end address
// stays as it was: some games check the ROM against it and won't start with a size they didn't ship at.
function fixHeader(rom, origLen) {
  let add = 0;
  for (let i = origLen; i + 3 < rom.length; i += 2) add = (add + ((rom[i] << 8) | rom[i + 1])) & 0xffff;
  const fix = (0x10000 - add) & 0xffff;
  rom[rom.length - 2] = fix >> 8; rom[rom.length - 1] = fix & 255;
  let sum = 0;
  for (let i = 0x200; i + 1 < rom.length; i += 2) sum = (sum + ((rom[i] << 8) | rom[i + 1])) & 0xffff;
  rom[0x18e] = sum >> 8; rom[0x18f] = sum & 255;
}

function build(rom, L, songs, edited) {
  const list = songs.filter((s, i) => edited.has(i));
  if (!list.length) return { rom: rom.slice(), used: 0, room: romLimit(rom) - rom.length };
  const r = withSongs(rom, L, list);
  const limit = romLimit(rom), room = limit - rom.length;
  if (r.rom.length + 2 > limit) throw new Error(`The changed songs need ${r.used} bytes after the end of the ROM, and there's room for ${room}.`);
  // Every song is read back from the new ROM and checked against what was meant before it's handed over.
  for (const p of r.parts) {
    const back = fromDecoded(decodeSong(r.rom, p.at, L.flags), p.s.id);
    if (!sameMusic(settled(p.s), back)) throw new Error(`${p.s.name} didn't compile back to the same music, so nothing was written. Please report this.`);
  }
  // A ROM size the console's mapping likes: padded to a multiple of 128 KB.
  const size = Math.min(limit, Math.ceil((r.rom.length + 2) / 0x20000) * 0x20000); // room for the balancing word
  const out = new Uint8Array(Math.max(size, r.rom.length));
  out.set(r.rom);
  fixHeader(out, rom.length);
  return { rom: out, used: r.used, room };
}

// A song as the driver will play it: notes cut where the next starts or the channel ends, and a held note of the same
// key that carries straight on from the one before merged into it.
function settled(song) {
  const s = JSON.parse(JSON.stringify(song));
  for (const ch of s.channels) {
    const isNote = e => e.dur !== undefined;
    ch.events.sort((a, b) => a.t - b.t || (isNote(a) ? 1 : 0) - (isNote(b) ? 1 : 0));
    ch.events = ch.events.filter(e => e.t < ch.end || (!isNote(e) && e.t === ch.end));
    const notes = ch.events.filter(isNote);
    notes.forEach((n, i) => { n.dur = Math.max(1, Math.min(n.t + n.dur, notes[i + 1]?.t ?? ch.end, ch.end) - n.t); });
    for (let i = notes.length - 1; i > 0; i--) {
      const a = notes[i - 1], b = notes[i];
      if (b.hold && b.key === a.key && a.t + a.dur === b.t) { a.dur += b.dur; ch.events.splice(ch.events.indexOf(b), 1); }
    }
  }
  return s;
}

function sameMusic(a, b) {
  const flat = sg => JSON.stringify(sg.channels.map(ch => [ch.loop, ch.end, ch.events.filter(e => e.type !== "rest").map(e => (e.type === "cmd" ? [e.t, e.op, e.args] : [e.t, e.type, e.key, e.dur]))]));
  return flat(a) === flat(b);
}

// ---------------------------------------------------------------- playing

// Frames per tick: the driver holds every track back one frame in every `tempo` frames.
const framesPerTick = tempo => { const t = tempo || 256; return t > 1 ? t / (t - 1) : 1; };

function player(rom, L, song, rate) {
  const { rom: r2 } = withSongs(rom, L, [song]);
  const g = new Genesis(r2);
  restore(g, L.snapshot);
  g.ram[L.queue & 0xffff] = song.id;
  // Tempo changes ($EA) anywhere in the song change the clock for all of it.
  const changes = song.channels.flatMap(c => c.events.filter(e => e.type === "cmd" && e.op === 0xea).map(e => ({ t: e.t, tempo: e.args[0] }))).sort((a, b) => a.t - b.t);
  const tickAtFrame = f => {
    let t = 0, fpt = framesPerTick(song.tempo), left = Math.max(0, f - 1);
    for (const c of changes) {
      const need = (c.t - t) * fpt;
      if (c.t <= t) { fpt = framesPerTick(c.tempo); continue; }
      if (left < need) break;
      left -= need; t = c.t; fpt = framesPerTick(c.tempo);
    }
    return t + left / fpt;
  };
  const end = song.end;
  const loops = song.channels.some(c => c.loop !== null);
  let frames = 0;
  const clock = () => tickAtFrame(frames);
  // Resampling from the YM2612's ~53 kHz.
  let bl = [], br = [], bi = 0;
  const step = YM_RATE / rate;
  let pos = 0, prevL = 0, prevR = 0, curL = 0, curR = 0;
  const next = () => {
    if (bi >= bl.length) { bl = []; br = []; bi = 0; g.soundFrame(bl, br, L.entry); frames++; }
    prevL = curL; prevR = curR; curL = bl[bi]; curR = br[bi]; bi++;
  };
  next();
  return {
    clock,
    render(l, r) {
      for (let i = 0; i < l.length; i++) {
        pos += step;
        while (pos >= 1) { pos -= 1; next(); }
        l[i] = prevL + (curL - prevL) * pos;
        if (r) r[i] = prevR + (curR - prevR) * pos;
      }
    },
    active: () => loops || clock() < end + PPQ,
    seek(t) {
      for (let guard = 0; guard < 36000 && clock() < t; guard++) { g.soundFrame(null, null, L.entry); frames++; }
      bl = []; br = []; bi = 0;
    },
  };
}

// ---------------------------------------------------------------- MIDI files
//
// One track per channel, named DAC, FM 1-5 and PSG 1-3 as the song has them. FM and PSG tracks use MIDI channels
// 1-9 in order, the DAC (drum samples) channel 10. 24 MIDI ticks per quarter note, one per driver tick. Instruments
// are program changes; driver commands are CC102 (command - $80) with CC103/CC104 parameter bytes (high bit, low 7
// bits); CC111 loop start and CC110 end, per track.

const CC = { cmd: 102, argHi: 103, argLo: 104, loop: 111, end: 110 };
const trackNames = song => {
  let fm = 0, psg = 0;
  return song.channels.map(c => (c.kind === "dac" ? "DAC" : c.kind === "fm" ? `FM ${++fm}` : `PSG ${++psg}`));
};
const midiCh = (song, i) => (song.channels[i].kind === "dac" ? 9 : i - (song.channels[0].kind === "dac" ? 1 : 0));

function toMidi(song) {
  const us = tempo => Math.round(1e6 / 60 * framesPerTick(tempo) * PPQ);
  const enc = s => [...new TextEncoder().encode(s)];
  const conductor = [{ t: 0, meta: 0x03, data: enc(song.name) }, { t: 0, meta: 0x01, data: enc(`MusicSmith: SMPS song ${song.id}`) }];
  const tempoEv = (t, tp) => ({ t, meta: 0x51, data: (x => [x >> 16 & 255, x >> 8 & 255, x & 255])(us(tp)) });
  conductor.push(tempoEv(0, song.tempo));
  const tracks = [conductor];
  const names = trackNames(song);
  song.channels.forEach((ch, i) => {
    const mc = midiCh(song, i);
    const tr = [{ t: 0, meta: 0x03, data: enc(names[i]) }], offs = [];
    tracks.push(tr);
    const cc = (t, c, v) => tr.push({ t, data: [0xb0 | mc, c, v] });
    if (ch.loop !== null) cc(ch.loop, CC.loop, 0);
    for (const e of ch.events) {
      if (e.type === "cmd") {
        cc(e.t, CC.cmd, e.op - 0x80);
        for (const a of e.args) { cc(e.t, CC.argHi, a >> 7); cc(e.t, CC.argLo, a & 0x7f); }
        if (e.op === 0xef && e.args[0] < 128) tr.push({ t: e.t, data: [0xc0 | mc, e.args[0]] });
        if (e.op === 0xea) conductor.push(tempoEv(e.t, e.args[0]));
      } else if (e.dur !== undefined) {
        const key = Math.max(0, Math.min(127, e.key));
        tr.push({ t: e.t, data: [0x90 | mc, key, 100] });
        offs.push({ t: e.t + e.dur, data: [0x80 | mc, key, 0], off: true });
      }
    }
    cc(ch.end, CC.end, 0);
    tr.push(...offs);
    tr.sort((a, b) => a.t - b.t || (b.off ? 1 : 0) - (a.off ? 1 : 0));
  });
  conductor.sort((a, b) => a.t - b.t);
  return { ppq: PPQ, tracks };
}

function fromMidi(midi, slot) {
  const warnings = [];
  const scale = PPQ / midi.ppq;
  let rounded = false;
  const tk = t => { const x = t * scale; if (Math.abs(x - Math.round(x)) > 1e-6) rounded = true; return Math.round(x); };
  const names = trackNames(slot);
  const tracks = midi.tracks.filter(tr => tr.events.some(e => e.kind === "on" || e.kind === "cc"));
  const generic = tracks.some(tr => tr.events.some(e => e.kind === "cc" && e.cc === CC.cmd));
  const song = JSON.parse(JSON.stringify(slot));
  const filled = new Set();
  // Tracks go to the channel of the same name, else the next free channel of a kind that suits them (drums on MIDI
  // channel 10 go to the DAC).
  const place = tr => {
    const named = names.findIndex(n => n.toLowerCase() === tr.name.trim().toLowerCase());
    if (named >= 0 && !filled.has(named)) return named;
    const drums = tr.events.some(e => e.kind === "on" && e.ch === 9);
    return slot.channels.findIndex((c, i) => !filled.has(i) && (drums ? c.kind === "dac" : c.kind !== "dac"));
  };
  let chords = 0, moved = 0;
  for (const tr of tracks) {
    const ci = place(tr);
    if (ci < 0) { warnings.push(`${tr.name || "A track"} had nowhere to go: this song has ${slot.channels.length} channels.`); continue; }
    filled.add(ci);
    const ch = song.channels[ci], evs = [];
    let cur = null, hi = 0, loop = null, end = null;
    for (const e of tr.events) {
      if (e.kind !== "cc") continue;
      const t = tk(e.t);
      if (e.cc === CC.cmd) { cur = { t, type: "cmd", op: 0x80 + e.val, args: [] }; evs.push(cur); }
      else if (e.cc === CC.argHi) hi = e.val;
      else if (e.cc === CC.argLo && cur) { cur.args.push(hi << 7 | e.val); hi = 0; }
      else if (e.cc === CC.loop) loop = t;
      else if (e.cc === CC.end) end = t;
    }
    if (!generic) {
      // A file made elsewhere keeps the original's commands, with program changes as instruments.
      evs.push(...ch.events.filter(e => e.type === "cmd" && e.op !== 0xef));
      if (ch.kind === "fm") for (const e of tr.events) if (e.kind === "program") evs.push({ t: tk(e.t), type: "cmd", op: 0xef, args: [e.val] });
    }
    const open = new Map(), notes = [];
    for (const e of tr.events) {
      const t = tk(e.t);
      if (e.kind === "on") { const n = { t, key: e.key, dur: null }; notes.push(n); open.set(e.ch * 128 + e.key, n); }
      else if (e.kind === "off") { const n = open.get(e.ch * 128 + e.key); if (n && n.dur === null) n.dur = Math.max(1, t - n.t); open.delete(e.ch * 128 + e.key); }
    }
    notes.sort((a, b) => a.t - b.t || b.key - a.key);
    const mono = notes.filter((n, i) => i === 0 || notes[i - 1].t !== n.t);
    chords += notes.length - mono.length;
    const lo = ch.kind === "dac" ? DRUM0 : keyBase(ch), hi2 = lo + NOTE_HI - NOTE_LO;
    // Notes that come back unchanged keep how the song stored them (ties, repeated lengths).
    const orig = new Map(ch.events.filter(e => e.dur !== undefined).map(e => [e.t + ":" + e.key + ":" + e.dur, e]));
    for (const [i, n] of mono.entries()) {
      const nxt = mono[i + 1]?.t;
      let dur = n.dur ?? (nxt ?? n.t + PPQ) - n.t;
      if (nxt !== undefined) dur = Math.min(dur, nxt - n.t);
      let k = n.key;
      while (k < lo) { k += 12; moved++; }
      while (k > hi2) { k -= 12; moved++; }
      const o = orig.get(n.t + ":" + k + ":" + dur);
      evs.push(o ? { ...o } : { t: n.t, type: ch.kind === "dac" ? "drum" : "note", key: k, dur: Math.max(1, dur) });
    }
    evs.push(...ch.events.filter(e => e.type === "rest").map(e => ({ ...e })));
    // Commands at the loop point that only run the first time through (before the place the loop goes back to).
    const pre = new Set(ch.events.filter(e => e.pre).map(e => JSON.stringify([e.t, e.op, e.args])));
    for (const e of evs) if (e.type === "cmd" && pre.has(JSON.stringify([e.t, e.op, e.args]))) e.pre = true;
    evs.sort((a, b) => a.t - b.t || (a.type === "cmd" ? 0 : 1) - (b.type === "cmd" ? 0 : 1));
    const last = Math.max(1, ...evs.filter(e => e.type !== "rest").map(e => e.t + (e.dur || 0)));
    ch.events = evs;
    ch.end = end ?? last;
    ch.loop = end !== null ? (loop !== null && loop < ch.end ? loop : null) : ch.loop !== null ? 0 : null;
    ch.events = ch.events.filter(e => e.t < ch.end || (e.type === "cmd" && e.t === ch.end)); // commands at the end run before the loop jump
  }
  // Channels the file had no track for fall silent.
  song.channels.forEach((c, i) => { if (!filled.has(i)) { c.events = c.events.filter(e => e.type === "cmd"); } });
  if (rounded) warnings.push(`Some notes didn't line up with the driver's ticks (${PPQ} per quarter note) and were moved slightly.`);
  if (chords) warnings.push("Some tracks have chords; each channel plays one note at a time, so only the top note of each was kept.");
  if (moved) warnings.push(`${moved} note${moved > 1 ? "s were" : " was"} outside a channel's range and moved by octaves.`);
  if (!generic && tracks.length && !tracks.some(tr => tr.events.some(e => e.kind === "cc" && e.cc === CC.end)) && slot.channels.some(c => c.loop !== null)) warnings.push("The song it replaces loops, so this one loops from the start too. Change that under the roll, or with CC111 (loop start) and CC110 (end) in the file.");
  song.end = Math.max(...song.channels.map(c => c.end));
  return { song, warnings };
}

function slotOf(midi) {
  for (const t of midi.texts || []) {
    const m = t.match(/MusicSmith: SMPS song (\d+)/);
    if (m) return { sfx: false, index: +m[1] };
  }
  return null;
}

// ---------------------------------------------------------------- the engine

const engine = {
  id: "smps",
  name: "SMPS, Sega's sound driver",
  system: "Genesis",
  examples: "Sonic the Hedgehog and other Sega games with the 68000 version of the driver",
  ext: "gen",
  ppq: PPQ,
  keyRange: [12, 127],
  events: {},
  detect,
  // Commands are named as in Sonic 1's driver where they take as many parameters there.
  readSongs(rom, L) {
    this.names = Object.fromEntries(Object.entries(S1_FLAGS.names).filter(([op]) => L.flags.lengths[op - 0xe0] === S1_FLAGS.lengths[op - 0xe0]));
    return readSongs(rom, L);
  },
  hidden: () => false,
  number: s => s.id,
  eventInfo(ev) {
    const op = ev.type === "cmd" ? ev.op : parseInt(ev.type.slice(4), 16);
    const name = this.names?.[op] || `Command $${op.toString(16).toUpperCase()}`;
    return { name: ev.args?.length ? `${name}: ${ev.args.join(", ")}` : name, mark: MARKS[op] || "•" };
  },
  lanes(song) {
    const names = trackNames(song);
    let fm = 0, psg = 0;
    return song.channels.map((c, ci) => {
      if (c.kind === "dac") {
        return {
          // the samples the song uses and a few more to choose from
          ci, type: "drum", name: names[ci], color: COLORS.dac, events: ["cmd"], lo: DRUM0, hi: Math.min(DRUM0 + NOTE_HI - NOTE_LO, Math.max(DRUM0 + 7, ...c.events.filter(e => e.type === "drum").map(e => e.key + 3))),
          key: ev => ev.key, setKey: (ev, k) => { ev.key = k; }, make: (t, k, dur) => ({ t, type: "drum", key: k, dur }),
          label: k => `S${(k - DRUM0 + 1)}`,
        };
      }
      const lo = keyBase(c), color = c.kind === "fm" ? COLORS.fm[fm++ % 6] : COLORS.psg[psg++ % 4];
      return {
        ci, type: "note", name: names[ci], color, events: ["cmd"], lo: Math.max(0, lo), hi: Math.min(127, lo + NOTE_HI - NOTE_LO),
        key: ev => ev.key, setKey: (ev, k) => { ev.key = k; }, make: (t, k, dur) => ({ t, type: "note", key: k, dur }),
      };
    });
  },
  describe(song) {
    const loops = song.channels.some(c => c.loop !== null);
    const secs = song.end * framesPerTick(song.tempo) / 60;
    return `Song $${song.id.toString(16).toUpperCase()} · ${song.channels.length} channels · ${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, "0")}${loops ? ", loops" : ""}`;
  },
  player,
  recordLength: s => s.end,
  build,
  spaceText: (used, room) => `Changed songs go after the end of the ROM: ${used} bytes used, room for ${room - used} more.`,
  toMidi,
  fromMidi,
  slotOf,
  readme: `MusicSmith: Genesis (SMPS) music as MIDI files

Each file is one song. Edit them in any MIDI editor, then import the ZIP (or just the files you changed) back into
MusicSmith. Each file knows which song it is, so keep the text event in it, or the number at the start of the file
name.

Each track is one of the song's channels: DAC (drum samples, on MIDI channel 10; each key is a sample), FM 1-5 and
PSG 1-3. Each plays one note at a time. Timing is 24 ticks per quarter note, one tick per driver tick.

Program changes pick FM instruments (the song's own voices). Everything else the driver does is a run of
controllers:
  CC102      a driver command (the command byte - $80); CC103/CC104 its parameter bytes (high bit / low 7 bits)
  CC111      loop start      CC110  end of the track
A file without CC102 events (made from scratch) keeps the original song's commands and takes instruments from
program changes.
`,
  midiHelp: [
    "One track per channel (DAC, FM 1-5, PSG 1-3), one note at a time; the DAC's drum samples are on MIDI channel 10. Times line up with 24 ticks per quarter note.",
    "Program changes pick FM instruments. Other driver commands are CC102 (command) with CC103/104 parameter bytes; CC111/110 are loop start and end. Keep them and the song stays faithful.",
  ],

  noteControls: () => [hint("A note plays for its whole length; the channel's note fill command (F) cuts notes short.")],
  eventControls(ctx, e) {
    const info = { args: (this.names[e.op] && ARGS[e.op]) || e.args.map((_, i) => ({ name: `Parameter ${i + 1}`, max: 255 })) };
    if (e.op === 0xef) {
      const n = ctx.song.voiceCount;
      return [field("Instrument", select([...Array(Math.max(n, e.args[0] + 1)).keys()].map(i => [i, `Voice ${i}`]), e.args[0], x => ctx.edit(() => { e.args = [+x]; }))), hint("The song's own FM voices.")];
    }
    if (e.op === 0xea) info.hint = `≈ ${(3600 / framesPerTick(e.args[0]) / PPQ).toFixed(0)} BPM at ${PPQ} ticks a beat.`;
    return commandControls(info, e, args => ctx.edit(() => { e.args = args; }));
  },
  addable(ctx) { return (ADDABLE[ctx.song.channels[ctx.lane.ci].kind] || []).filter(op => this.names[op]).map(op => "cmd:" + op.toString(16)); },
  newEvent(ctx, type, t) {
    const op = parseInt(type.slice(4), 16);
    return { t, type: "cmd", op, args: (DEFAULT_ARGS[op] || []).slice() };
  },
  laneHint: "Tap the roll to add a note, drag a note to move it, drag its right end to change its length. Drag empty space to scroll; tap the ruler to choose where Play starts. Driver commands (instrument, volume, pan...) are in the strip at the bottom.",
};
export default engine;
