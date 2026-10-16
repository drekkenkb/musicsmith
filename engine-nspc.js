// N-SPC (SNES), as a MusicSmith engine. See nspc.js for the format and engines.js for what an engine provides.
//
// Songs play on the emulated sound chip (spc.js) running the game's own driver: the edited song is compiled into a
// copy of the sound RAM and the driver is asked to play it, just as the game would.
import { SPC } from "./spc.js";
import {
  locate, aramOf, decodeSong, compileSong, compileSongs, layoutSong, layoutSongs, findQvTables, DEFAULT_GATES, setDurations, fitNotes,
  heardLength, tickTimes, settlePatterns, CMD_NAMES, KEY0,
} from "./nspc.js";
import { el, field, select, num, sep, hint, commandControls } from "./ui.js";
import { writeMidi } from "./midi.js";

const COLORS = ["#ffd43b", "#4dabf7", "#ff6b6b", "#8ce99a", "#da77f2", "#ffa94d", "#66d9e8", "#e9ecef"];
const PPQ = 48; // N-SPC songs mostly count a quarter note as 48 ticks; the ruler and MIDI files use that
const KEY_HI = KEY0 + 0x47; // $C7
const SNES_RATE = 32000;

// What each command's parameters mean, for the inspector. Parameters are bytes.
const ARGS = {
  0xe0: [{ name: "Instrument", max: 255 }],
  0xe1: [{ name: "Pan (0 right - 10 centre - 20 left)", max: 255 }],
  0xe2: [{ name: "Over ticks", max: 255 }, { name: "To pan", max: 255 }],
  0xe3: [{ name: "Delay (ticks)", max: 255 }, { name: "Rate", max: 255 }, { name: "Depth", max: 255 }],
  0xe5: [{ name: "Master volume", max: 255 }],
  0xe6: [{ name: "Over ticks", max: 255 }, { name: "To volume", max: 255 }],
  0xe7: [{ name: "Tempo", max: 255 }],
  0xe8: [{ name: "Over ticks", max: 255 }, { name: "To tempo", max: 255 }],
  0xe9: [{ name: "Semitones", max: 127, signed: true }],
  0xea: [{ name: "Semitones", max: 127, signed: true }],
  0xeb: [{ name: "Delay (ticks)", max: 255 }, { name: "Rate", max: 255 }, { name: "Depth", max: 255 }],
  0xed: [{ name: "Volume", max: 255 }],
  0xee: [{ name: "Over ticks", max: 255 }, { name: "To volume", max: 255 }],
  0xf0: [{ name: "Over ticks", max: 255 }],
  0xf1: [{ name: "Delay", max: 255 }, { name: "Length", max: 255 }, { name: "Semitones", max: 127, signed: true }],
  0xf2: [{ name: "Delay", max: 255 }, { name: "Length", max: 255 }, { name: "Semitones", max: 127, signed: true }],
  0xf4: [{ name: "Fine tuning", max: 255 }],
  0xf5: [{ name: "Voices (bit mask)", max: 255 }, { name: "Echo volume left", max: 255 }, { name: "Echo volume right", max: 255 }],
  0xf7: [{ name: "Delay", max: 15 }, { name: "Feedback", max: 255 }, { name: "Filter", max: 3 }],
  0xf8: [{ name: "Over ticks", max: 255 }, { name: "To left", max: 255 }, { name: "To right", max: 255 }],
  0xf9: [{ name: "Delay", max: 255 }, { name: "Length", max: 255 }, { name: "To note", max: 255 }],
  0xfa: [{ name: "First drum instrument", max: 255 }],
};
const MARKS = { 0xe0: "I", 0xe1: "P", 0xe2: "P", 0xe5: "M", 0xe6: "M", 0xe7: "T", 0xe8: "T", 0xed: "V", 0xee: "V", 0xe3: "~", 0xeb: "~", 0xe9: "K", 0xea: "K", 0xf5: "E", 0xf6: "E", 0xf7: "E", 0xf8: "E", 0xfa: "D" };
const ADDABLE = [0xe0, 0xed, 0xee, 0xe1, 0xe2, 0xe7, 0xe8, 0xe5, 0xe3, 0xe4, 0xea, 0xe9, 0xf9, 0xf5, 0xf6, 0xf4];
const DEFAULT_ARGS = { 0xe0: [0], 0xe1: [10], 0xe2: [48, 10], 0xe3: [0, 16, 32], 0xe5: [200], 0xe6: [48, 200], 0xe7: [32], 0xe8: [48, 32], 0xe9: [0], 0xea: [0], 0xeb: [0, 16, 32], 0xed: [200], 0xee: [48, 200], 0xf0: [48], 0xf1: [0, 12, 1], 0xf2: [0, 12, 1], 0xf4: [0], 0xf5: [0xff, 40, 40], 0xf7: [2, 64, 0], 0xf8: [48, 40, 40], 0xf9: [0, 12, 0xa4], 0xfa: [0] };

const opOf = ev => (ev.type === "cmd" ? ev.op : parseInt(ev.type.slice(4), 16));

// ---------------------------------------------------------------- finding and reading

function detect(rom) {
  if (rom.length < 0x8000 || (rom.length % 0x8000 !== 0 && rom.length % 0x8000 !== 512)) return null;
  const L = locate(rom);
  if (!L || !L.banks.length) return null;
  const base = aramOf(rom, L.driver.blocks);
  const qt = findQvTables(base);
  L.gates = qt.gates >= 0 ? [...base.subarray(qt.gates, qt.gates + 8)] : DEFAULT_GATES;
  // How fast the driver's tempo counter runs: timer 0, as the driver sets it up.
  const spc = new SPC();
  spc.ram.set(base); spc.pc = L.driver.entry;
  spc.generate(4000);
  L.timerHz = 8000 / (spc.timers[0].target || 256);
  return L;
}

// Address ranges as [from, to) pairs, from a set of addresses.
function rangesOf(set) {
  const a = [...set].sort((x, y) => x - y), out = [];
  for (const v of a) { const r = out[out.length - 1]; if (r && r[1] === v) r[1]++; else out.push([v, v + 1]); }
  return out;
}

function readSongs(rom, L) {
  const base = aramOf(rom, L.driver.blocks), songs = [];
  L.banks.forEach((bank, bi) => {
    const m = aramOf(rom, bank.blocks, base);
    const byPtr = new Map();
    bank.touched = {};
    for (const n of bank.songs) {
      const ptr = m[L.songTbl + n * 2] | m[L.songTbl + n * 2 + 1] << 8;
      if (byPtr.has(ptr)) { byPtr.get(ptr).also.push(n); continue; } // the same song under two numbers
      let d;
      try { d = decodeSong(m, ptr, L.lengths); } catch { continue; }
      for (let i = 0; i < 2; i++) d.touched.add(L.songTbl + n * 2 + i);
      bank.touched[n] = rangesOf(d.touched);
      delete d.touched;
      const song = { id: bi * 256 + n, bank: bi, n, also: [], name: "", sfx: false, ...d };
      setDurations(song, L.gates);
      byPtr.set(ptr, song);
      songs.push(song);
    }
  });
  const many = L.banks.length > 1;
  for (const s of songs) {
    s.name = `Song ${s.n}${s.also.length ? ` (also ${s.also.join(", ")})` : ""}${many ? ` · bank ${s.bank + 1}` : ""}`;
  }
  return songs;
}

// ---------------------------------------------------------------- compiling into sound RAM

// The song as the driver will read it: notes fitted to their lengths and patterns to the end and loop point.
function prepared(song, L) {
  const s = JSON.parse(JSON.stringify(song));
  settlePatterns(s);
  fitNotes(s, L.gates);
  return s;
}

// First-fit allocation from address ranges (which it uses up).
function allocator(ranges) {
  return size => {
    const r = ranges.find(([a, b]) => b - a >= size);
    if (!r) throw Object.assign(new Error("full"), { full: true });
    const at = r[0];
    r[0] += size;
    return at;
  };
}
const compiledSize = c => (c.subs || []).reduce((n, b) => n + b.length, 0) + c.trackBytes.reduce((n, t) => n + t.reduce((k, u) => k + (u.call !== undefined ? 4 : u.bytes.length), 0) + 1, 0)
  + new Set(c.songs.flatMap(sg => sg.patternRefs.map(r => r.join()))).size * 16 + c.songs.reduce((n, sg) => n + sg.patternRefs.length * 2 + 6, 0);

// Sound RAM for previewing one song: its bank, with the song compiled over the bank's song data (nothing else
// plays during a preview, so all of it is free).
function previewRam(rom, L, song) {
  const bank = L.banks[song.bank];
  const m = aramOf(rom, bank.blocks, aramOf(rom, L.driver.blocks));
  const all = new Set();
  for (const rs of Object.values(bank.touched)) for (const [a, b] of rs) for (let x = a; x < b; x++) if (x < L.songTbl || x >= L.songTbl + 256) all.add(x);
  const c = compileSong(prepared(song, L), L.gates, L.lengths);
  let lay;
  try { lay = layoutSong(c, allocator(rangesOf(all))); } catch (e) { if (e.full) throw new Error("This song is too long to play: it doesn't fit in the sound chip's memory."); throw e; }
  for (const w of lay.writes) m.set(w.bytes, w.addr);
  for (const n of [song.n, ...song.also]) { m[L.songTbl + n * 2] = lay.listAddr & 0xff; m[L.songTbl + n * 2 + 1] = lay.listAddr >> 8; }
  return m;
}

// Writes edited songs into the ROM. First the changed songs alone go into the space they used before (bytes no
// other song shares), so the rest of the bank stays byte for byte as it was. If they don't fit, the whole bank is
// recompiled together into the space all its songs had: recompiled, the music comes out a little smaller than the
// original, which leaves room for additions. Each compiled song is decoded again and checked against what was
// meant before anything is written.
function build(rom, L, songs, edited) {
  const out = rom.slice();
  let used = 0, room = 0;
  const banks = new Set();
  songs.forEach((s, i) => { if (edited.has(i)) banks.add(s.bank); });
  for (const bi of banks) {
    const bank = L.banks[bi];
    const all = songs.filter(s => s.bank === bi), mine = songs.filter((s, i) => s.bank === bi && edited.has(i));
    const attempt = list => {
      const ns = new Set(list.flatMap(s => [s.n, ...s.also]));
      const free = new Set(), keep = new Set();
      for (const [n, rs] of Object.entries(bank.touched)) for (const [a, b] of rs) for (let x = a; x < b; x++) (ns.has(+n) ? free : keep).add(x);
      for (let x = L.songTbl; x < L.songTbl + 256; x++) free.delete(x); // the table stays where it is
      for (const x of keep) free.delete(x);
      const ranges = rangesOf(free), space = ranges.reduce((n, [a, b]) => n + b - a, 0);
      const ready = list.map(s => prepared(s, L));
      const c = compileSongs(ready, L.gates, L.lengths);
      const need = compiledSize(c);
      try { return { lay: layoutSongs(c, allocator(ranges)), ready, need, space, list }; } catch (e) {
        if (!e.full) throw e;
        return { need, space };
      }
    };
    let r = attempt(mine);
    if (!r.lay && mine.length < all.length) r = attempt(all);
    used += r.need; room += r.space;
    if (!r.lay) throw new Error(`The songs${L.banks.length > 1 ? ` in bank ${bi + 1}` : ""} need about ${r.need} bytes, and there's room for ${r.space}. Shorten or simplify the songs you changed by about ${r.need - r.space} bytes (repeated bars cost little).`);
    const m = aramOf(rom, bank.blocks, aramOf(rom, L.driver.blocks));
    for (const w of r.lay.writes) m.set(w.bytes, w.addr);
    r.ready.forEach((s, i) => {
      const back = decodeSong(m, r.lay.listAddrs[i], L.lengths);
      if (!sameMusic(s, back)) throw new Error(`Song ${s.n} didn't compile back to the same music, so nothing was written. Please report this.`);
    });
    const romAt = addr => {
      const b = bank.blocks.findLast(x => addr >= x.addr && addr < x.addr + x.len);
      if (!b) throw new Error(`Address $${addr.toString(16)} isn't in this bank's upload.`);
      return b.off + 4 + addr - b.addr;
    };
    for (const w of r.lay.writes) w.bytes.forEach((v, k) => { out[romAt(w.addr + k)] = v; });
    r.list.forEach((s, i) => {
      for (const n of [s.n, ...s.also]) { out[romAt(L.songTbl + n * 2)] = r.lay.listAddrs[i] & 0xff; out[romAt(L.songTbl + n * 2 + 1)] = r.lay.listAddrs[i] >> 8; }
    });
  }
  if (banks.size) fixSnesChecksum(out);
  return { rom: out, used, room };
}

// Whether two decoded songs play the same notes and commands at the same ticks.
function sameMusic(a, b) {
  const flat = sg => JSON.stringify(sg.channels.map(ch => (ch ? ch.events.map(e => (e.type === "cmd" ? [e.t, e.op, e.args] : [e.t, e.type, e.key ?? e.perc, e.step, e.seg, e.qv ?? null, e.segQv ?? null])) : null)));
  return flat(a) === flat(b) && a.end === b.end && a.loop === b.loop;
}

// The header checksum, so emulators and flash carts don't complain.
function fixSnesChecksum(rom) {
  const base = rom.length % 1024 === 512 ? 512 : 0;
  for (const h of [0x7fc0, 0xffc0, 0x40ffc0]) {
    const o = base + h;
    if (o + 0x20 > rom.length) continue;
    const comp = rom[o + 0x1c] | rom[o + 0x1d] << 8, chk = rom[o + 0x1e] | rom[o + 0x1f] << 8;
    if ((comp ^ chk) !== 0xffff) continue;
    const body = rom.subarray(base), len = body.length;
    let p = 1;
    while (p * 2 <= len) p *= 2;
    let sum = 0;
    for (let i = 0; i < p; i++) sum += body[i];
    const rest = len - p;
    if (rest) { let r = 0; for (let i = p; i < len; i++) r += body[i]; sum += p % rest === 0 ? r * (p / rest) : r; }
    sum &= 0xffff;
    rom[o + 0x1e] = sum & 0xff; rom[o + 0x1f] = sum >> 8;
    rom[o + 0x1c] = ~sum & 0xff; rom[o + 0x1d] = (~sum >> 8) & 0xff;
    return;
  }
}

// ---------------------------------------------------------------- playing

function player(rom, L, song, rate) {
  const s = prepared(song, L);
  const m = previewRam(rom, L, song);
  const spc = new SPC();
  spc.ram.set(m); spc.pc = L.driver.entry;
  spc.generate(SNES_RATE / 4); // let the driver start up
  // The song starts with its first key-on; ticks are timed from there with the song's tempo changes.
  let made = 0, startAt = null;
  spc.onDspWrite = (reg, v) => { if (reg === 0x4c && v && startAt === null) startAt = made; };
  spc.portIn[0] = song.n;
  const at = tickTimes(s, L.timerHz);
  const firstNote = Math.min(s.end, ...s.channels.filter(Boolean).flatMap(c => c.events.filter(e => e.type === "note" || e.type === "perc").map(e => e.t)));
  const end = s.end, loop = s.loop;
  // Ticks since the song started, `secs` in: through the loop again and again if it loops.
  const find = (from, to, x) => {
    let lo = from, hi = to;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (at[mid] <= x) lo = mid; else hi = mid - 1; }
    return lo < to ? lo + (x - at[lo]) / (at[lo + 1] - at[lo]) : lo;
  };
  const tickAt = secs => {
    if (secs < at[end]) return find(0, end, secs);
    if (loop === null) return end + (secs - at[end]) / ((at[end] - at[end - 1]) || 0.02);
    const cycle = at[end] - at[loop], k = Math.floor((secs - at[end]) / cycle), r = secs - at[end] - k * cycle;
    return end + k * (end - loop) + find(loop, end, at[loop] + r) - loop;
  };
  const clock = () => (startAt === null ? 0 : tickAt((made - startAt) / SNES_RATE + at[firstNote]));
  // Resampling from the chip's 32 kHz.
  const buf = { l: new Float32Array(512), r: new Float32Array(512), n: 0, i: 0 };
  let pos = 0, prevL = 0, prevR = 0;
  const step = SNES_RATE / rate;
  const next = () => {
    if (buf.i >= buf.n) { spc.generate(512, buf.l, buf.r); made += 512; buf.n = 512; buf.i = 0; }
    prevL = buf.l[buf.i]; prevR = buf.r[buf.i]; buf.i++;
  };
  next();
  let curL = prevL, curR = prevR;
  return {
    clock,
    render(l, r) {
      for (let i = 0; i < l.length; i++) {
        pos += step;
        while (pos >= 1) { pos -= 1; const pl = curL, pr = curR; next(); curL = prevL; curR = prevR; prevL = pl; prevR = pr; }
        const a = curL * pos + prevL * (1 - pos), b = curR * pos + prevR * (1 - pos);
        l[i] = a / 32768; if (r) r[i] = b / 32768;
      }
    },
    active: () => loop !== null || clock() < end + PPQ,
    seek(t) {
      for (let guard = 0; guard < 4000 && (startAt === null || clock() < t); guard++) { spc.generate(512, buf.l, buf.r); made += 512; buf.n = 0; buf.i = 0; }
    },
  };
}

// ---------------------------------------------------------------- MIDI files
//
// One track per voice (MIDI channels 1-8), drums on channel 10 of the voice's track. 48 ticks per quarter note,
// one MIDI tick per driver tick. Instruments are program changes, volume CC7; everything the driver does that MIDI
// has no word for is a run of controllers: CC102 = command - $80, then each parameter byte as CC103 (high bit) and
// CC104 (low 7 bits). CC106 holds a note's gate/velocity byte. CC111 loop start, CC110 end.

const CC = { cmd: 102, argHi: 103, argLo: 104, qv: 106, loop: 111, end: 110 };

function toMidi(song) {
  const us = tempo => Math.round(PPQ * 1e6 * 256 / (this.timerHz * Math.max(1, tempo)));
  const conductor = [
    { t: 0, meta: 0x03, data: [...new TextEncoder().encode(song.name)] },
    { t: 0, meta: 0x01, data: [...new TextEncoder().encode(`MusicSmith: N-SPC song ${song.id}`)] },
  ];
  const tracks = [conductor];
  song.channels.forEach((ch, v) => {
    const tr = [{ t: 0, meta: 0x03, data: [...new TextEncoder().encode(`Voice ${v + 1}`)] }];
    tracks.push(tr);
    if (!ch) return;
    const cc = (t, c, val, mc = v) => tr.push({ t, data: [0xb0 | mc, c, val] });
    const offs = [];
    let lastQv = null;
    if (ch.loop !== null) cc(ch.loop, CC.loop, 0);
    for (const e of ch.events) {
      if (e.type === "cmd") {
        cc(e.t, CC.cmd, e.op - 0x80);
        for (const a of e.args) { cc(e.t, CC.argHi, a >> 7); cc(e.t, CC.argLo, a & 0x7f); }
        if (e.op === 0xe0 && e.args[0] < 128) tr.push({ t: e.t, data: [0xc0 | v, e.args[0]] });
        if (e.op === 0xed) cc(e.t, 7, e.args[0] >> 1);
        if (e.op === 0xe7 && this.timerHz) conductor.push({ t: e.t, meta: 0x51, data: (x => [x >> 16 & 255, x >> 8 & 255, x & 255])(us(e.args[0])) });
      } else if (e.type === "note" || e.type === "perc") {
        const qv = e.qv ?? null;
        if (qv !== null && qv !== lastQv) { cc(e.t, CC.qv, qv); lastQv = qv; }
        const mc = e.type === "perc" ? 9 : v, key = e.type === "perc" ? 35 + e.perc : e.key;
        const vel = Math.max(1, (((qv ?? 0x7f) & 15) + 1) * 8 - 1);
        tr.push({ t: e.t, data: [0x90 | mc, key, vel] });
        offs.push({ t: e.t + e.dur, data: [0x80 | mc, key, 0], off: true });
      }
    }
    cc(ch.end, CC.end, 0);
    tr.push(...offs);
    tr.sort((a, b) => a.t - b.t || (b.off ? 1 : 0) - (a.off ? 1 : 0));
  });
  return { ppq: PPQ, tracks };
}

function fromMidi(midi, slot) {
  const warnings = [];
  const scale = PPQ / midi.ppq;
  let rounded = false;
  const tk = t => { const x = t * scale; if (Math.abs(x - Math.round(x)) > 1e-6) rounded = true; return Math.round(x); };
  const tracks = midi.tracks.filter(tr => tr.events.some(e => e.kind === "on" || e.kind === "cc"));
  if (rounded) warnings.push("Some notes didn't line up with the driver's ticks (48 per quarter note) and were moved slightly.");
  const byName = tracks.map(tr => ({ tr, v: (tr.name.match(/voice\s*(\d)/i) || [])[1] - 1 }));
  const channels = Array(8).fill(null);
  let next = 0;
  const marked = tracks.some(tr => tr.events.some(e => e.kind === "cc" && e.cc === CC.end));
  let end = 0, loop = null;
  const tempos = midi.tracks.flatMap(tr => tr.events.filter(e => e.kind === "tempo")).map(e => ({ ...e, t: tk(e.t) }));
  const generic = tracks.some(tr => tr.events.some(e => e.kind === "cc" && e.cc === CC.cmd));
  for (const { tr, v: named } of byName) {
    let v = named >= 0 && named < 8 && !channels[named] ? named : -1;
    if (v < 0) { while (next < 8 && channels[next]) next++; v = next; }
    if (v >= 8) { warnings.push(`${tr.name || "A track"} had nowhere to go: the SNES has 8 voices.`); continue; }
    const evs = [];
    const ccs = tr.events.filter(e => e.kind === "cc").map(e => ({ ...e, t: tk(e.t) }));
    // Commands: a CC102 starts one, CC103/104 pairs are its parameter bytes.
    let cur = null, hi = 0, qv = null;
    const qvAt = new Map();
    for (const e of ccs) {
      if (e.cc === CC.cmd) { cur = { t: e.t, type: "cmd", op: 0x80 + e.val, args: [] }; evs.push(cur); }
      else if (e.cc === CC.argHi) hi = e.val;
      else if (e.cc === CC.argLo && cur) { cur.args.push(hi << 7 | e.val); hi = 0; }
      else if (e.cc === CC.qv) qvAt.set(e.t, e.val);
      else if (e.cc === CC.loop) loop = e.t;
      else if (e.cc === CC.end) end = Math.max(end, e.t);
    }
    if (!generic) { // a file made elsewhere: programs and volume become driver commands
      for (const e of tr.events) {
        if (e.kind === "program") evs.push({ t: tk(e.t), type: "cmd", op: 0xe0, args: [e.val] });
        if (e.kind === "cc" && e.cc === 7) evs.push({ t: tk(e.t), type: "cmd", op: 0xed, args: [Math.min(255, e.val * 2)] });
      }
    }
    // Notes: one at a time per voice; drums (MIDI channel 10) become percussion.
    const open = new Map(), notes = [];
    for (const e of tr.events) {
      const t = tk(e.t);
      if (e.kind === "on") { const n = { t, ch: e.ch, key: e.key, vel: e.vel, dur: null }; notes.push(n); open.set(e.ch * 128 + e.key, n); }
      else if (e.kind === "off") { const n = open.get(e.ch * 128 + e.key); if (n && n.dur === null) n.dur = Math.max(1, t - n.t); open.delete(e.ch * 128 + e.key); }
    }
    notes.sort((a, b) => a.t - b.t || b.key - a.key);
    const mono = notes.filter((n, i) => i === 0 || notes[i - 1].t !== n.t);
    if (mono.length < notes.length) warnings.push(`${tr.name || "A track"} has chords; each SNES voice plays one note at a time, so only the top note of each was kept.`);
    let clamped = 0;
    for (const [i, n] of mono.entries()) {
      const nxt = mono[i + 1]?.t;
      let dur = n.dur ?? (nxt ?? n.t + PPQ) - n.t;
      if (nxt !== undefined) dur = Math.min(dur, nxt - n.t);
      if (qvAt.has(n.t)) qv = qvAt.get(n.t);
      const q = qv ?? (0x70 | Math.min(15, Math.round(n.vel / 8)));
      if (n.ch === 9) evs.push({ t: n.t, type: "perc", perc: Math.max(0, Math.min(21, n.key - 35)), dur: Math.max(1, dur), qv: q });
      else {
        let k = n.key;
        while (k < KEY0) { k += 12; clamped++; }
        while (k > KEY_HI) { k -= 12; clamped++; }
        evs.push({ t: n.t, type: "note", key: k, dur: Math.max(1, dur), qv: q });
      }
    }
    if (clamped) warnings.push(`${clamped} note${clamped > 1 ? "s were" : " was"} outside the driver's range (C1-B6) and moved by octaves.`);
    evs.sort((a, b) => a.t - b.t || (a.type === "cmd" ? 0 : 1) - (b.type === "cmd" ? 0 : 1));
    if (evs.length) channels[v] = { events: evs, loop: null, end: 0 };
  }
  if (!generic && tempos.length && this.timerHz) {
    const v0 = channels.findIndex(Boolean);
    if (v0 >= 0) for (const tp of tempos) channels[v0].events.push({ t: tp.t, type: "cmd", op: 0xe7, args: [Math.max(1, Math.min(255, Math.round(PPQ * 1e6 * 256 / (this.timerHz * tp.us))))] });
    if (v0 >= 0) channels[v0].events.sort((a, b) => a.t - b.t || (a.type === "cmd" ? 0 : 1) - (b.type === "cmd" ? 0 : 1));
  }
  const last = Math.max(1, ...channels.filter(Boolean).flatMap(c => c.events.map(e => e.t + (e.dur || 0))));
  if (!marked) { end = last; loop = slot.loop !== null ? 0 : null; if (loop !== null) warnings.push("The song it replaces loops, so this one loops from the start too. Change that under the roll, or with CC111 (loop start) and CC110 (end) in the file."); }
  end = Math.max(end, 1);
  for (const c of channels) if (c) { c.end = end; c.loop = loop !== null && loop < end ? loop : null; c.events = c.events.filter(e => e.t < end); }
  // Notes that came back unchanged keep exactly how the song stored them (step, ties, each tie's gate): MIDI only
  // says how long a note sounds, and many stored forms sound that long.
  channels.forEach((c, v) => {
    const orig = slot.channels[v]?.events.filter(e => e.type === "note" || e.type === "perc");
    if (!c || !orig) return;
    const at = new Map(orig.map(e => [e.t + ":" + (e.key ?? "p" + e.perc), e]));
    for (const e of c.events) {
      if (e.type !== "note" && e.type !== "perc") continue;
      const o = at.get(e.t + ":" + (e.key ?? "p" + e.perc));
      if (o && o.dur === e.dur && (o.qv ?? null) === (e.qv ?? null)) { e.step = o.step; e.seg = o.seg.slice(); if (o.segQv) e.segQv = o.segQv.slice(); }
    }
  });
  const song = { ...JSON.parse(JSON.stringify(slot)), channels };
  settlePatterns(song);
  fitNotes(song, this.gates || DEFAULT_GATES);
  return { song, warnings };
}

function slotOf(midi) {
  for (const t of midi.texts || []) {
    const m = t.match(/MusicSmith: N-SPC song (\d+)/);
    if (m) return { sfx: false, index: +m[1] };
  }
  return null;
}

// ---------------------------------------------------------------- the engine

const engine = {
  id: "nspc",
  name: "N-SPC, Nintendo's sound driver",
  system: "SNES",
  examples: "Zelda: A Link to the Past, Super Metroid, F-Zero, Mario Paint and many games that licensed it",
  ext: "smc",
  ppq: PPQ,
  keyRange: [KEY0, KEY_HI],
  sharedLoop: true,
  events: {},
  detect,
  readSongs(rom, L) { this.timerHz = L.timerHz; this.gates = L.gates; return readSongs(rom, L); },
  hidden: () => false,
  number: s => s.id,
  eventInfo(ev) {
    const op = opOf(ev);
    const name = CMD_NAMES[op] || `Command $${op.toString(16).toUpperCase()}`;
    const args = ev.args ? `: ${ev.args.join(", ")}` : "";
    return { name: ev.args ? name + args : name, mark: MARKS[op] || "•" };
  },
  lanes(song) {
    const out = [];
    for (let v = 0; v < 8; v++) {
      out.push({
        ci: v, type: "note", name: `Voice ${v + 1}`, color: COLORS[v], events: ["cmd"], lo: KEY0, hi: KEY_HI,
        key: ev => ev.key, setKey: (ev, k) => { ev.key = k; }, make: (t, k, dur) => ({ t, type: "note", key: k, dur }),
      });
      if (song.channels[v]?.events.some(e => e.type === "perc")) {
        out.push({
          ci: v, type: "perc", name: `Voice ${v + 1} drums`, color: COLORS[v], events: [], lo: KEY0, hi: KEY0 + 21,
          key: ev => KEY0 + ev.perc, setKey: (ev, k) => { ev.perc = k - KEY0; }, make: (t, k, dur) => ({ t, type: "perc", perc: k - KEY0, dur }),
          label: k => `D${k - KEY0}`,
        });
      }
    }
    return out;
  },
  describe(song) {
    const loops = song.channels.some(c => c && c.loop !== null);
    return `Song ${song.n}${song.also.length ? ` (also ${song.also.join(", ")})` : ""} · ${(song.end / (PPQ * 4)).toFixed(1)} bars${loops ? ", loops" : ""}`;
  },
  player,
  recordLength: s => s.end,
  build,
  spaceText: (used, room) => (room ? `${used} of ${room} bytes used: room for about ${room - used} more. (If the songs you changed outgrow their own space, the rest of their bank is repacked to make room.)` : "Change a song to see how much room there is."),
  toMidi(song) { return toMidi.call(this, song); },
  fromMidi(midi, slot) { return fromMidi.call(this, midi, slot); },
  slotOf,
  readme: `MusicSmith: SNES (N-SPC) music as MIDI files

Each file is one song. Edit them in any MIDI editor, then import the ZIP (or just the files you changed) back into
MusicSmith. Each file knows which song it is, so keep the text event in it, or the number at the start of the file
name.

Each track is one of the SNES's 8 voices and plays one note at a time (drums are on MIDI channel 10 of the voice's
track). Timing is 48 ticks per quarter note, one tick per driver tick. Notes go from C1 to B6; the instrument decides
what that sounds like.

Program changes pick instruments and CC7 sets volume. Everything else the driver does is a run of controllers:
  CC102      a driver command (the command byte - $80); CC103/CC104 its parameter bytes (high bit / low 7 bits)
  CC106      a note's gate and velocity byte (high nibble: how much of its length it sounds; low: velocity)
  CC111      loop start      CC110  end of the song
A file without CC102 events (made from scratch) gets its instruments from program changes, volume from CC7 and
tempo from the MIDI tempo.
`,
  midiHelp: [
    "One track per voice (8 voices), one note at a time; drums are on MIDI channel 10 of their voice's track. Times line up with 48 ticks per quarter note.",
    "Program changes pick instruments and CC7 sets volume. Other driver commands are CC102 (command) with CC103/104 parameter bytes; CC106 is a note's gate and velocity; CC111/110 loop start and end. Keep them and the song stays faithful.",
  ],

  noteControls(ctx, n) {
    const gates = ctx.L?.gates || this.gates || DEFAULT_GATES;
    const qv = n.qv ?? 0x7f, g = (qv >> 4) & 7, vel = qv & 15;
    const set = q => ctx.edit(() => { n.qv = q; delete n.segQv; n.dur = heardLength({ ...n, qv: q, segQv: undefined }, gates); });
    return [
      field("Gate", select(gates.map((x, i) => [i, `${i}: ${Math.round(x / 2.56)}%`]), g, x => set((+x << 4) | vel))),
      field("Velocity", num(0, 15, vel, x => set((g << 4) | x))),
      hint("Gate is how much of its step the note sounds; velocity picks a loudness from the driver's table."),
    ];
  },
  eventControls(ctx, e) {
    const info = { args: ARGS[e.op] || e.args.map((_, i) => ({ name: `Parameter ${i + 1}`, max: 255 })) };
    if (e.op === 0xe7 && this.timerHz) info.hint = `≈ ${(60 / (PPQ * 256 / (this.timerHz * Math.max(1, e.args[0])))).toFixed(1)} BPM at 48 ticks a beat.`;
    return commandControls(info, e, args => ctx.edit(() => { e.args = args; }));
  },
  addable: () => ADDABLE.map(op => "cmd:" + op.toString(16)),
  newEvent(ctx, type, t) {
    const op = parseInt(type.slice(4), 16);
    return { t, type: "cmd", op, args: (DEFAULT_ARGS[op] || []).slice() };
  },
  laneHint: "Tap the roll to add a note, drag a note to move it, drag its right end to change its length. Drag empty space to scroll; tap the ruler to choose where Play starts. Driver commands (instrument, volume, tempo...) are in the strip at the bottom.",
};
export default engine;
