// Nintendo's SNES sound driver, N-SPC, and the many games that licensed it (Zelda, Super Metroid, F-Zero, Kirby,
// EarthBound...). Finding it in a ROM, decoding songs into editable timelines, and compiling them back.
//
// The SNES CPU uploads the driver, samples and music into the sound chip's 64 KB of RAM ("ARAM") as a chain of
// blocks: length, ARAM address, data, ... and a zero length followed by the address to start running. Games often
// upload a second chain later with a different set of songs ("banks" here).
//
// A song is a list of patterns (16-bit pointers; $0000 ends the song, $00nn followed by a pointer jumps back nn
// times, nn >= $80 forever). A pattern is 8 track pointers, one per voice (0 = silent). A track is bytes:
//   $00          end of the track (the pattern ends when the first track does), or of a subroutine pass
//   $01-$7F      duration in ticks for the following notes, optionally followed by $00-$7F: gate (high nibble,
//                how much of the duration the note sounds) and velocity (low nibble)
//   $80-$C7      a note ($80 is C1); $C8 ties (holds the previous note), $C9 rests
//   $CA-$DF      percussion: plays instrument (base + n - $CA) at a fixed pitch
//   $E0-$FF      commands with parameters ($EF lo hi n calls a subroutine n times); the driver's own table says
//                how many parameter bytes each takes

import { SPC } from "./spc.js";

const STD_LENGTHS = [1, 1, 2, 3, 0, 1, 2, 1, 2, 1, 1, 3, 0, 1, 2, 3, 1, 3, 3, 0, 1, 3, 0, 3, 3, 3, 1];
const w16 = (r, o) => r[o] | r[o + 1] << 8;

export const CMD_NAMES = {
  0xe0: "Instrument", 0xe1: "Pan", 0xe2: "Pan fade", 0xe3: "Vibrato", 0xe4: "Vibrato off", 0xe5: "Master volume",
  0xe6: "Master volume fade", 0xe7: "Tempo", 0xe8: "Tempo fade", 0xe9: "Transpose (all)", 0xea: "Transpose",
  0xeb: "Tremolo", 0xec: "Tremolo off", 0xed: "Volume", 0xee: "Volume fade", 0xef: "Subroutine", 0xf0: "Vibrato fade",
  0xf1: "Pitch envelope to", 0xf2: "Pitch envelope from", 0xf3: "Pitch envelope off", 0xf4: "Tuning",
  0xf5: "Echo on", 0xf6: "Echo off", 0xf7: "Echo settings", 0xf8: "Echo volume fade", 0xf9: "Pitch slide",
  0xfa: "Percussion base",
};

// ---------------------------------------------------------------- finding the driver

function findSeq(r, seq, from = 0) {
  outer: for (let o = from; o + seq.length <= r.length; o++) {
    for (let k = 0; k < seq.length; k++) if (r[o + k] !== seq[k]) continue outer;
    return o;
  }
  return -1;
}

const okBlock = (len, addr) => len > 0 && addr + len <= 0x10000 && !(addr < 0x100 && addr + len > 0xf0);

// Follows a chain of upload blocks from ROM offset o to its terminator.
function chainFrom(r, o) {
  const blocks = [];
  for (let n = 0; n < 64; n++) {
    if (o + 4 > r.length) return null;
    const len = w16(r, o), addr = w16(r, o + 2);
    if (len === 0) return { blocks, end: o + 4, entry: addr };
    if (!okBlock(len, addr) || o + 4 + len > r.length) return null;
    blocks.push({ off: o, len, addr });
    o += 4 + len;
  }
  return null;
}

// The longest run of blocks that ends exactly where a chain starts: earlier parts of the same upload. A real
// upload's blocks don't overlap each other in sound RAM, which rules out stray bytes that happen to look like a
// header.
function extendBack(r, start, have, depth = 0) {
  if (depth > 24) return [];
  let best = [];
  for (let p = start - 5; p >= Math.max(0, start - 0x10004); p--) {
    const l = w16(r, p), a = w16(r, p + 2);
    if (p + 4 + l !== start || !okBlock(l, a)) continue;
    if (have.some(b => a < b.addr + b.len && b.addr < a + l)) continue;
    const more = extendBack(r, p, [...have, { addr: a, len: l }], depth + 1);
    if (more.length + 1 > best.length) best = [...more, p];
  }
  return best;
}

export function aramOf(r, blocks, base) {
  const m = base ? base.slice() : new Uint8Array(0x10000);
  for (const b of blocks) m.set(r.subarray(b.off + 4, b.off + 4 + b.len), b.addr);
  return m;
}

// Runs a candidate upload briefly: a real driver sets up the DSP, starts a timer and then sits in its main loop
// polling the timer counter (and the ports for commands). Code uploaded to the wrong place soon runs off into
// garbage instead.
function driverScore(r, c) {
  const spc = new SPC();
  spc.ram.set(aramOf(r, c.blocks));
  spc.pc = c.entry;
  const regs = new Set();
  spc.onDspWrite = reg => regs.add(reg);
  let polls = 0;
  const read = spc.read.bind(spc);
  try {
    spc.generate(1600);
    spc.read = a => { if (a >= 0xfd && a <= 0xff) polls++; return read(a); };
    spc.generate(1600);
  } catch { return 0; }
  if (polls < 20) return 0;
  return regs.size + (spc.timers.some(t => t.on) ? 10 : 0) + (regs.has(0x5d) ? 5 : 0);
}

// The song table: the driver loads a song's pattern list pointer from adjacent table bytes into a direct-page
// pointer, which it then reads through with [dp]+Y and INCW.
function findSongTable(m) {
  const reads = dp => {
    for (let p = 0x200; p < 0xfff0; p++) if (m[p] === 0xf7 && m[p + 1] === dp && m[p + 2] === 0x3a && m[p + 3] === dp) return true;
    return false;
  };
  const load = p => (m[p] === 0xf5 || m[p] === 0xf6 ? w16(m, p + 1) : -1); // mov a,!abs+x / +y
  for (let p = 0x200; p < 0xfff0; p++) {
    const a1 = load(p);
    if (a1 < 0) continue;
    // The high byte (table+1), then within a few bytes (some drivers check it for zero in between) the low byte
    // (table), then the pair stored to the pattern pointer: MOVW dp,YA, or MOV dp,A / MOV dp+1,...
    for (let q = p + 3; q < p + 14; q++) {
      if (load(q) !== a1 - 1) continue;
      if (m[q + 3] === 0xda && reads(m[q + 4])) return { tbl: a1 - 1, dp: m[q + 4] };
    }
    // Low byte first: MOV A,!t+X / MOV dp,A / MOV A,!t+1+X / MOV dp+1,A
    if (m[p + 3] === 0xc4 && load(p + 5) === a1 + 1 && m[p + 8] === 0xc4 && m[p + 9] === m[p + 4] + 1 && reads(m[p + 4])) return { tbl: a1, dp: m[p + 4] };
  }
  return null;
}

export function locate(rom) {
  const X = findSeq(rom, STD_LENGTHS);
  if (X < 0) return null;
  // Every chain whose block covers the table is a candidate; the one that runs like a driver wins.
  const cands = [];
  const tried = new Set();
  for (let o = X - 4; o >= Math.max(0, X - 0x10004); o--) {
    const len = w16(rom, o);
    if (o + 4 + len <= X || !okBlock(len, w16(rom, o + 2))) continue;
    const c = chainFrom(rom, o);
    if (!c || !c.blocks.some(b => c.entry >= b.addr && c.entry < b.addr + b.len)) continue;
    const prev = extendBack(rom, o, c.blocks).reverse();
    for (const p of prev) c.blocks.unshift({ off: p, len: w16(rom, p), addr: w16(rom, p + 2) });
    c.start = prev.length ? prev[prev.length - 1] : o;
    if (tried.has(c.start + ":" + c.end)) continue;
    tried.add(c.start + ":" + c.end);
    // The driver's code must read the command table at the address this upload puts it: an indexed load
    // (or, and, eor, cmp, adc, sbc, mov) of table - $E0 + X/Y. A stray header uploads the code elsewhere.
    const db = c.blocks.find(b => X >= b.off + 4 && X < b.off + 4 + b.len);
    const ref = (db.addr + X - db.off - 4 - 0xe0) & 0xffff;
    let reads = false;
    for (let q = db.off + 4; q + 2 < db.off + 4 + db.len && !reads; q++) {
      const op = rom[q];
      reads = ((op & 15) === 5 || (op & 15) === 6) && [1, 3, 5, 7, 9, 11, 15].includes(op >> 4) && w16(rom, q + 1) === ref;
    }
    if (!reads) { globalThis.NSPC_DEBUG?.("no table reference", c.start.toString(16)); continue; }
    c.score = driverScore(rom, c);
    globalThis.NSPC_DEBUG?.("candidate", c.start.toString(16), "score", c.score, c.blocks.map(b => b.addr.toString(16) + "+" + b.len.toString(16)).join(","));
    if (c.score >= 15) cands.push(c);
  }
  // Several uploads can look like a driver (a stray header can upload a copy of the code to the wrong place). The
  // real one is the one whose song table leads to songs that decode: most songs wins.
  let found = null;
  for (const c of cands.sort((x, y) => y.score - x.score)) {
    const L = finish(rom, X, c);
    if (L && (!found || L.banks.reduce((n, k) => n + k.songs.length, 0) > found.banks.reduce((n, k) => n + k.songs.length, 0))) found = L;
  }
  return found;
}

function finish(rom, X, best) {
  const db = best.blocks.find(b => X >= b.off + 4 && X < b.off + 4 + b.len);
  const base = aramOf(rom, best.blocks);
  const st = findSongTable(base);
  globalThis.NSPC_DEBUG?.("song table", st && st.tbl.toString(16));
  if (!st) return null;
  const lenTbl = db.addr + X - db.off - 4;
  const lengths = Array.from({ length: 32 }, (_, i) => (i < 27 ? base[lenTbl + i] : -1));
  const L = {
    driver: { start: best.start, blocks: best.blocks.map(({ off, len, addr }) => ({ off, len, addr })), entry: best.entry },
    songTbl: st.tbl, lengths, banks: [],
  };
  // Banks: the driver's own upload if its songs are in it, and every other chain that writes songs into the table.
  const first = L.songTbl + 2;
  const seen = new Map();
  const addBank = (c, m, trusted = false) => {
    // Banks are told apart by the block that holds the song table (the last one written there). Of two chains
    // sharing it, the one starting closest to it wins: blocks before it may be stray bytes that look like a header.
    const ki = c.blocks.findLastIndex(x => x.addr < L.songTbl + 256 && x.addr + x.len > first);
    if (ki < 0) return;
    const key = c.blocks[ki].off, had = seen.get(key);
    if (had && had.before <= ki) return;
    const songs = songsIn(m, L, c.blocks);
    if (!songs.length) return;
    const bank = { start: c.start, blocks: c.blocks.map(({ off, len, addr }) => ({ off, len, addr })), songs };
    if (had) L.banks[L.banks.indexOf(had.bank)] = bank; else L.banks.push(bank);
    seen.set(key, { before: trusted ? -1 : ki, bank });
  };
  addBank({ start: best.start, blocks: best.blocks }, base, true);
  for (let o = 0; o + 4 < rom.length; o++) {
    const len = rom[o] | rom[o + 1] << 8, addr = rom[o + 2] | rom[o + 3] << 8;
    if (!len || addr > first || addr + len <= first + 1 || addr + len > 0x10000 || o + 4 + len > rom.length) continue;
    if (best.blocks.some(x => x.off === o)) continue;
    // Quick test before following the chain: some song pointer in the block lands inside the block.
    let any = false;
    for (let n = 0; n < 64 && !any; n++) {
      const q = o + 4 + first - addr + n * 2;
      if (q + 1 >= o + 4 + len) break;
      const ptr = w16(rom, q);
      any = ptr >= addr + (first - addr) + 2 && ptr < addr + len;
    }
    if (!any) continue;
    // A song upload ends by restarting the driver.
    const c = chainFrom(rom, o);
    if (!c || c.entry !== best.entry) continue;
    // Stray bytes before the real header can parse as a block that leads into it; a real upload's blocks don't
    // overlap, so drop leading blocks that do.
    while (c.blocks.length > 1 && c.blocks.slice(1).some(b => c.blocks[0].addr < b.addr + b.len && b.addr < c.blocks[0].addr + c.blocks[0].len)) c.blocks.shift();
    c.start = c.blocks[0].off;
    addBank(c, aramOf(rom, c.blocks, base));
  }
  // The driver's own upload first, then the others in ROM order: the same order whatever the scan met first.
  L.banks.sort((a, b) => (a.start === best.start ? -1 : b.start === best.start ? 1 : a.start - b.start));
  return L;
}

// The songs a bank brings: table entries that point into its own blocks and decode.
function songsIn(m, L, blocks) {
  const inside = a => blocks.some(b => a >= b.addr && a < b.addr + b.len);
  const out = [], budget = { left: 2000000 };
  for (let n = 1; n < 128; n++) {
    const at = L.songTbl + n * 2;
    if (!inside(at)) { if (n > 1 && out.length) break; else continue; }
    const p = w16(m, at);
    if (!inside(p)) continue;
    try {
      const s = decodeSong(m, p, L.lengths, budget);
      // Everything the song reads must be in what this bank uploads.
      if (s.end > 0 && s.patterns.every(x => x.len > 0) && [...s.touched].every(inside)) out.push(n);
    } catch {}
  }
  return out;
}

// ---------------------------------------------------------------- decoding

// Reads a song's pattern list: the patterns in the order they play (repeats unrolled), and where it loops.
function readPatternList(m, at) {
  const order = [], seen = new Map();
  let p = at, loopTo = null, count = 0;
  for (let guard = 0; guard < 1024; guard++) {
    const v = w16(m, p);
    if (v === 0) return { order, loop: null };
    if (v >> 8 === 0) {
      const n = v & 0xff, target = w16(m, p + 2);
      if (n === 0x80 || n === 0x81) { p += 2; continue; } // fast-forward flags
      if (n >= 0x80) { // forever: find the pattern index we jump back to
        const idx = seen.get(target);
        if (idx === undefined) throw new Error("bad loop");
        return { order, loop: idx };
      }
      // jump back n times: unroll
      if (count === 0) { count = n; p = target; continue; }
      if (--count > 0) { p = target; continue; }
      p += 4;
      continue;
    }
    if (!seen.has(p)) seen.set(p, order.length);
    order.push({ ptr: v, at: p });
    p += 2;
  }
  throw new Error("pattern list too long");
}

// Decodes one track from `ptr` for up to `limit` ticks. State (duration, gate/velocity, percussion base) carries
// over from the previous pattern. Returns events with ticks relative to the pattern start, and the track's length.
function readTrack(m, ptr, st, lengths, touched, budget) {
  const ev = [];
  let p = ptr, t = 0, ret = null, retStart = 0, reps = 0;
  const get = () => {
    if (budget && --budget.left < 0) throw new Error("song too long to be real");
    touched?.add(p); const v = m[p]; p = (p + 1) & 0xffff; return v;
  };
  for (let guard = 0; guard < 100000; guard++) {
    const b = get();
    if (b === 0) {
      if (ret !== null) {
        if (--reps > 0) { p = retStart; continue; }
        p = ret; ret = null; continue;
      }
      return { ev, len: t };
    }
    if (b < 0x80) {
      st.dur = b;
      if (m[p] < 0x80) st.qv = get();
      continue;
    }
    if (b < 0xe0) {
      ev.push({ t, type: "step", b, d: st.dur, qv: st.qv });
      t += st.dur;
      continue;
    }
    if (b === 0xef) {
      const lo = get(), hi = get(), n = get();
      if (ret !== null) throw new Error("nested subroutine");
      ret = p; retStart = lo | hi << 8; reps = n || 256; p = retStart;
      continue;
    }
    const n = lengths[b - 0xe0];
    if (n === undefined || n < 0) throw new Error(`unknown command $${b.toString(16)}`);
    const args = [];
    for (let i = 0; i < n; i++) args.push(get());
    ev.push({ t, type: "cmd", op: b, args });
  }
  throw new Error("track runs on");
}

export const KEY0 = 24; // MIDI note of $80 (C1)

// Turns a pattern sequence into per-voice timelines of notes and commands.
export function decodeSong(m, at, lengths, budget = { left: 400000 }) {
  const { order, loop } = readPatternList(m, at);
  if (!order.length) throw new Error("empty song");
  const voices = Array.from({ length: 8 }, () => ({ events: [], st: { dur: 1, qv: null }, open: null, active: false }));
  const patterns = [];
  let T = 0, loopT = null;
  const touched = new Set();
  for (const [pi, pat] of order.entries()) {
    if (pi === loop) loopT = T;
    const ptrs = Array.from({ length: 8 }, (_, i) => w16(m, pat.ptr + i * 2));
    for (let i = 0; i < 16; i++) touched.add(pat.ptr + i);
    const tracks = ptrs.map((p, i) => (p ? readTrack(m, p, voices[i].st, lengths, touched, budget) : null));
    const lens = tracks.filter(Boolean).map(x => x.len);
    if (!lens.length) throw new Error("pattern with no tracks");
    // The pattern ends when the first track (in voice order, at the earliest tick) does.
    const len = Math.min(...lens);
    patterns.push({ t: T, len, ptr: pat.ptr });
    tracks.forEach((tr, i) => {
      const v = voices[i];
      if (!tr) return;
      v.active = true;
      for (const e of tr.ev) {
        if (e.t >= len) break;
        const t = T + e.t;
        if (e.type === "step") {
          const { b, d } = e;
          const room = Math.min(d, len - e.t);
          if (b === 0xc8) { // tie: extend the open note
            if (v.open) {
              v.open.seg.push(room); v.open.step += room;
              // A tie can bring its own gate/velocity byte.
              if (e.qv !== v.open.qv || v.open.segQv) (v.open.segQv ||= v.open.seg.slice(0, -1).map(() => v.open.qv ?? null)).push(e.qv);
            }
            continue;
          }
          v.open = null;
          if (b === 0xc9) continue; // rest
          const note = { t, type: "note", key: b < 0xca ? b - 0x80 + KEY0 : 0, step: room, seg: [room], qv: e.qv };
          if (note.qv === null) delete note.qv;
          if (b >= 0xca) { note.type = "perc"; note.perc = b - 0xca; delete note.key; }
          v.events.push(note);
          v.open = note;
        } else if (e.type === "cmd") {
          v.events.push({ t, type: "cmd", op: e.op, args: e.args });
        }
      }
      // A track that ends early leaves its voice idle until the pattern ends.
    });
    T += len;
  }
  const channels = voices.map(v => (v.active ? { events: v.events, loop: loopT, end: T } : null));
  return { channels, patterns, loop: loopT, loopPattern: loop, end: T, touched };
}

// Note lengths as heard: the gate cuts each note short of its step (ties keep it going).
export function setDurations(song, gates) {
  for (const ch of song.channels) {
    if (!ch) continue;
    for (const e of ch.events) {
      if (e.type !== "note" && e.type !== "perc") continue;
      const g = gates[(((e.segQv ? e.segQv.at(-1) : e.qv) ?? 0x7f) >> 4) & 7];
      const last = e.seg[e.seg.length - 1];
      e.dur = Math.max(1, e.step - last + Math.max(1, (last * g) >> 8));
    }
  }
}

// ---------------------------------------------------------------- the driver's tables

// The gate and velocity tables a duration's second byte indexes: XCN / AND #7 / MOV Y,A / MOV A,!gates+Y, and
// AND #$0F / MOV Y,A / MOV A,!velocities+Y.
export function findQvTables(m) {
  let gates = -1, vels = -1;
  for (let p = 0x200; p < 0xfff8 && (gates < 0 || vels < 0); p++) {
    if (gates < 0 && m[p] === 0x9f && m[p + 1] === 0x28 && m[p + 2] === 0x07 && m[p + 3] === 0xfd && m[p + 4] === 0xf6) gates = w16(m, p + 5);
    if (vels < 0 && m[p] === 0x28 && m[p + 1] === 0x0f && m[p + 2] === 0xfd && m[p + 3] === 0xf6) vels = w16(m, p + 4);
  }
  return { gates, vels };
}
export const DEFAULT_GATES = [0x32, 0x65, 0x7f, 0x98, 0xb2, 0xcb, 0xe5, 0xfc];

// ---------------------------------------------------------------- compiling

// Turns a song back into bytes: { list, patterns, tracks } as separate pieces with symbolic pointers, ready to be
// laid out. `gates` is the driver's gate table. Each pattern keeps the song's original pattern boundaries.
function compileTracks(song, gates) {
  const tracks = new Map(); // bytes key -> index
  const trackBytes = [];
  const patternRefs = []; // per pattern: 8 track indexes or -1
  const states = Array.from({ length: 8 }, () => ({ dur: -1, qv: -1 }));
  const isNote = e => e.type === "note" || e.type === "perc";
  const chans = song.channels.map(ch => {
    if (!ch) return null;
    const evs = ch.events.filter(e => e.t < song.end);
    return { evs, notes: evs.filter(isNote) };
  });

  for (const [pi, P] of song.patterns.entries()) {
    const T = P.t, E = P.t + P.len;
    const refs = [];
    chans.forEach((c, vi) => {
      if (!c) { refs.push(-1); return; }
      // Each pattern's track states its own duration and gate, so the same music makes the same track bytes
      // wherever it plays (and a repeated pattern is stored once).
      const st = states[vi];
      st.dur = -1; st.qv = -1;
      const out = [];
      // Notes overlapping this pattern, and commands in it.
      const notes = c.notes.filter(n => n.t < E && n.t + noteStep(n, c.notes, song.end) > T);
      const cmds = c.evs.filter(e => e.type === "cmd" && e.t >= T && e.t < E);
      if (!notes.length && !cmds.length) { refs.push(-1); return; }
      // Cut points: pattern start, every note start and its segment ends, every command.
      const pieces = []; // { t, len, kind: note|tie|rest, n }
      let cur = T;
      const cmdTicks = new Set(cmds.map(e => e.t));
      const pushSpan = (from, to, kind, n, qv) => {
        // split at commands and at 127 ticks
        let a = from;
        const cuts = [...cmdTicks].filter(x => x > from && x < to).sort((x, y) => x - y);
        for (const b of [...cuts, to]) {
          while (b - a > 0x7f) { pieces.push({ t: a, len: 0x7f, kind, n, qv }); kind = kind === "note" ? "tie" : kind; a += 0x7f; }
          if (b > a) { pieces.push({ t: a, len: b - a, kind, n, qv }); kind = kind === "note" ? "tie" : kind; a = b; }
        }
      };
      for (const n of notes) {
        const step = noteStep(n, c.notes, song.end);
        const start = Math.max(n.t, T), stop = Math.min(n.t + step, E);
        if (start > cur) pushSpan(cur, start, "rest");
        // Keep the note's own segment boundaries (and each segment's gate/velocity) where they still fit.
        const keep = n.seg && n.seg.reduce((x, y) => x + y, 0) === step;
        const segs = keep ? n.seg : [step];
        let a = n.t, from = start, first = n.t >= T;
        for (const [j, d] of segs.entries()) {
          a += d;
          if (a <= start) continue;
          const to = Math.min(a, stop);
          const qv = keep && n.segQv ? n.segQv[j] : n.qv;
          if (to > from) { pushSpan(from, to, first ? "note" : "tie", n, qv); first = false; from = to; }
          if (to >= stop) break;
        }
        cur = stop;
      }
      if (E > cur) pushSpan(cur, E, "rest");

      // Emit: commands at a piece's tick come first; a duration byte when it changes, with the gate/velocity
      // byte when that changes (it can only follow a duration).
      const cmdAt = new Map();
      for (const e of cmds) { if (!cmdAt.has(e.t)) cmdAt.set(e.t, []); cmdAt.get(e.t).push(e); }
      for (const p of pieces) {
        for (const e of cmdAt.get(p.t) || []) out.push(e.op, ...e.args);
        cmdAt.delete(p.t);
        const qv = p.kind === "rest" ? st.qv : (p.qv ?? st.qv);
        if (p.len !== st.dur || (qv !== st.qv && qv !== null && qv >= 0)) {
          out.push(p.len);
          if (qv !== st.qv && qv !== null && qv >= 0) { out.push(qv); st.qv = qv; }
          st.dur = p.len;
        }
        if (p.kind === "rest") out.push(0xc9);
        else if (p.kind === "tie") out.push(0xc8);
        else out.push(p.n.type === "perc" ? 0xca + p.n.perc : p.n.key - KEY0 + 0x80);
      }
      for (const es of cmdAt.values()) for (const e of es) out.push(e.op, ...e.args); // commands at the very end
      out.push(0);
      const key = out.join(",");
      if (!tracks.has(key)) { tracks.set(key, trackBytes.length); trackBytes.push(out); }
      refs.push(tracks.get(key));
    });
    patternRefs.push(refs);
  }
  return { trackBytes, patternRefs, loop: song.loopPattern ?? null };
}

// Compiles songs together, so phrases, tracks and patterns they have in common are stored once.
export function compileSongs(songs, gates, lengths) {
  const all = [], per = [];
  for (const song of songs) {
    const c = compileTracks(song, gates);
    const base = all.length;
    all.push(...c.trackBytes);
    per.push({ patternRefs: c.patternRefs.map(r => r.map(i => (i < 0 ? -1 : base + i))), loop: c.loop });
  }
  // The same track in two songs is one track.
  const key = new Map(), uniq = [], remap = all.map(b => { const k = b.join(); if (!key.has(k)) { key.set(k, uniq.length); uniq.push(b); } return key.get(k); });
  for (const p of per) p.patternRefs = p.patternRefs.map(r => r.map(i => (i < 0 ? -1 : remap[i])));
  const f = factor(uniq, lengths);
  return { trackBytes: f.tracks, subs: f.subs, songs: per };
}

export function compileSong(song, gates, lengths) {
  const c = compileSongs([song], gates, lengths);
  return { trackBytes: c.trackBytes, subs: c.subs, patternRefs: c.songs[0].patternRefs, loop: c.songs[0].loop };
}

// ---------------------------------------------------------------- subroutines

// Splits a track into units the driver reads as one step or command, each with the duration and gate/velocity
// state it starts in (which decides how its bytes play).
function units(bytes, lengths) {
  const out = [];
  let st = "-1/-1", dur = -1, qv = -1;
  for (let i = 0; i < bytes.length - 1;) { // the final $00 isn't a unit
    const b = bytes[i], start = i;
    // A duration (and gate/velocity) stays with the note after it: the driver reads whatever follows a duration
    // as a gate byte if it's below $80, so a subroutine can't end on one.
    if (b < 0x80) { i++; dur = b; if (bytes[i] < 0x80) { qv = bytes[i]; i++; } if (bytes[i] >= 0x80 && bytes[i] < 0xe0) i++; }
    else if (b >= 0xe0) i += 1 + lengths[b - 0xe0];
    else i++;
    out.push({ bytes: bytes.slice(start, i), key: bytes.slice(start, i).join(","), st });
    st = dur + "/" + qv;
  }
  return out;
}

// Replaces repeated phrases with subroutine calls ($EF lo hi count): first runs of the same phrase played back to
// back, then phrases that recur anywhere in the song. A phrase can only become a subroutine where the duration and
// gate state it starts in is the same everywhere it's used, so it plays the same from the subroutine.
// Tracks come back as lists of { bytes } and { call, count } items; subroutines as byte lists (with their $00).
function factor(trackBytes, lengths) {
  const subs = [], subKey = new Map();
  // The driver's look-ahead (does a tie follow this note?) reads into a subroutine but treats its end as the end of
  // the track, so a subroutine needs a note, tie or rest in it to look the same.
  const sounds = us => us.some(u => u.bytes.some(b => b >= 0x80 && b < 0xe0) && !(u.bytes[0] >= 0xe0));
  const subOf = (us) => {
    const k = us[0].st + "|" + us.map(u => u.key).join(";");
    if (!subKey.has(k)) { subKey.set(k, subs.length); subs.push([...us.flatMap(u => u.bytes), 0]); }
    return subKey.get(k);
  };
  const size = us => us.reduce((n, u) => n + u.bytes.length, 0);
  const same = (us, i, j, L) => { for (let k = 0; k < L; k++) if (us[i + k].key !== us[j + k].key || us[i + k].st !== us[j + k].st) return false; return true; };
  let tracks = trackBytes.map(b => units(b, lengths));

  // 1. Back-to-back repeats.
  tracks = tracks.map(us => {
    const out = [];
    for (let i = 0; i < us.length;) {
      let best = null;
      for (let L = 1; L <= 48 && i + 2 * L <= us.length; L++) {
        let k = 1;
        while (k < 255 && i + (k + 1) * L <= us.length && same(us, i, i + k * L, L)) k++;
        if (k < 2 || !sounds(us.slice(i, i + L))) continue;
        // The state after each pass must equal the state the phrase starts in, or the repeats would play differently.
        if (i + k * L < us.length && us[i + k * L].st !== us[i + L].st) continue;
        const save = size(us.slice(i, i + k * L)) - 4 - (size(us.slice(i, i + L)) + 1);
        if (save > 0 && (!best || save > best.save)) best = { L, k, save };
      }
      if (best) { out.push({ call: subOf(us.slice(i, i + best.L)), count: best.k, st: us[i].st, after: us[i + best.L * best.k]?.st }); i += best.L * best.k; }
      else out.push(us[i++]);
    }
    return out;
  });

  // 2. Phrases that recur anywhere (in any track of the song), longest savings first.
  for (let round = 0; round < 64; round++) {
    const seen = new Map();
    for (const [ti, us] of tracks.entries()) {
      for (let i = 0; i < us.length; i++) {
        if (us[i].call !== undefined) continue;
        let k = "", bytes = 0;
        for (let L = 1; L <= 32 && i + L <= us.length; L++) {
          const u = us[i + L - 1];
          if (u.call !== undefined) break;
          k += (L > 1 ? ";" : us[i].st + "|") + u.key;
          bytes += u.bytes.length;
          if (bytes < 6) continue;
          if (!seen.has(k)) seen.set(k, { L, bytes, at: [], sounds: sounds(us.slice(i, i + L)) });
          const e = seen.get(k), last = e.at[e.at.length - 1];
          if (!last || last.ti !== ti || last.i + L <= i) e.at.push({ ti, i });
        }
      }
    }
    let best = null;
    for (const e of seen.values()) {
      const n = e.at.length;
      if (n < 2 || !e.sounds) continue;
      const save = n * e.bytes - n * 4 - (e.bytes + 1);
      if (save > 0 && (!best || save > best.save)) best = { ...e, save };
    }
    if (!best) break;
    // Replace from the end so indexes stay valid.
    const first = best.at[0], sub = subOf(tracks[first.ti].slice(first.i, first.i + best.L));
    for (const { ti, i } of [...best.at].reverse()) tracks[ti].splice(i, best.L, { call: sub, count: 1, st: tracks[ti][i].st });
  }
  return { tracks, subs };
}

// How long a note occupies its voice in the byte stream: its original step if the next note doesn't start
// sooner, else up to the next note.
export function noteStep(n, notes, end) {
  const i = notes.indexOf(n), next = i + 1 < notes.length ? notes[i + 1].t : end;
  return Math.max(1, Math.min(n.step ?? next - n.t, next - n.t));
}

// Lays a compiled song out at `place(size) → address` and returns the bytes to write: [{ addr, bytes }] and the
// pattern list's address.
export function layoutSongs(c, alloc) {
  const writes = [];
  const subAddr = (c.subs || []).map(b => { const a = alloc(b.length); writes.push({ addr: a, bytes: b }); return a; });
  const trackAddr = c.trackBytes.map(items => {
    const bytes = [];
    for (const it of items) {
      if (it.call !== undefined) { const a = subAddr[it.call]; bytes.push(0xef, a & 0xff, a >> 8, it.count); }
      else bytes.push(...it.bytes);
    }
    bytes.push(0);
    const a = alloc(bytes.length);
    writes.push({ addr: a, bytes });
    return a;
  });
  const patKeys = new Map();
  const listAddrs = c.songs.map(sg => {
    const patAddr = sg.patternRefs.map(refs => {
      const bytes = [];
      for (const r of refs) { const a = r < 0 ? 0 : trackAddr[r]; bytes.push(a & 0xff, a >> 8); }
      const key = bytes.join(",");
      if (!patKeys.has(key)) { const a = alloc(16); writes.push({ addr: a, bytes }); patKeys.set(key, a); }
      return patKeys.get(key);
    });
    const list = [];
    for (const a of patAddr) list.push(a & 0xff, a >> 8);
    const listAddr = alloc(list.length + (sg.loop !== null ? 4 : 0) + 2);
    if (sg.loop !== null) { const to = listAddr + sg.loop * 2; list.push(0xff, 0x00, to & 0xff, to >> 8); }
    list.push(0, 0);
    writes.push({ addr: listAddr, bytes: list });
    return listAddr;
  });
  return { writes, listAddrs };
}

export function layoutSong(c, alloc) {
  const r = layoutSongs({ trackBytes: c.trackBytes, subs: c.subs, songs: [{ patternRefs: c.patternRefs, loop: c.loop }] }, alloc);
  return { writes: r.writes, listAddr: r.listAddrs[0] };
}

// ---------------------------------------------------------------- editing helpers

// How long a note sounds, from how it's stored: all its segments but the last, then the last cut by its gate.
export function heardLength(n, gates) {
  const last = n.seg[n.seg.length - 1];
  const qv = n.segQv ? n.segQv.at(-1) : n.qv;
  return Math.max(1, n.step - last + Math.max(1, (last * gates[((qv ?? 0x7f) >> 4) & 7]) >> 8));
}

const splitSteps = S => { const out = []; while (S > 0x7f) { out.push(0x7f); S -= 0x7f; } if (S) out.push(S); return out; };

// After an edit, makes each note's stored step, segments and gate give the length it now shows (dur), and fit
// before the next note. Notes that weren't changed keep their exact bytes.
export function fitNotes(song, gates) {
  for (const ch of song.channels) {
    if (!ch) continue;
    const notes = ch.events.filter(e => e.type === "note" || e.type === "perc");
    notes.forEach((n, i) => {
      if (n.qv === undefined && i > 0 && notes[i - 1].qv !== undefined) n.qv = notes[i - 1].qv; // a new note sounds like the one before
      const next = i + 1 < notes.length ? notes[i + 1].t : Math.max(song.end, n.t + 1);
      const avail = Math.max(1, next - n.t);
      if (!n.seg) { n.step = Math.min(n.dur, avail); n.seg = splitSteps(n.step); }
      if (n.step > avail) { n.step = avail; n.seg = splitSteps(avail); delete n.segQv; }
      if (n.dur === heardLength(n, gates)) return;
      // Pick the step and gate that come closest to the wanted length, preferring the note's own gate.
      const want = Math.min(n.dur, avail), vel = (n.qv ?? 0x7f) & 15, cur = ((n.qv ?? 0x7f) >> 4) & 7;
      let best = null;
      for (let S = want; S <= avail; S++) {
        const seg = splitSteps(S), last = seg[seg.length - 1];
        for (let g = 0; g < 8; g++) {
          const heard = S - last + Math.max(1, (last * gates[g]) >> 8);
          const cost = Math.abs(heard - want) * 100 + (g === cur ? 0 : 1) + (S === avail ? 0 : 2);
          if (!best || cost < best.cost) best = { cost, S, seg, g, heard };
        }
        if (best.cost === 0) break;
      }
      n.step = best.S; n.seg = best.seg; delete n.segQv;
      n.qv = best.g << 4 | vel;
      n.dur = best.heard;
    });
  }
}

// Seconds per tick at each tick of a song (tempo commands and fades on any voice), for the playhead and seeking.
// timerHz is how often the driver's tempo counter advances.
export function tickTimes(song, timerHz, startTempo = 0x20) {
  const tempos = song.channels.flatMap(ch => (ch ? ch.events.filter(e => e.type === "cmd" && (e.op === 0xe7 || e.op === 0xe8)) : [])).sort((a, b) => a.t - b.t);
  const n = Math.max(1, song.end), at = new Float64Array(n + 1);
  let tempo = startTempo, acc = 0, ti = 0, fade = null;
  for (let t = 0; t <= n; t++) {
    while (ti < tempos.length && tempos[ti].t <= t) {
      const e = tempos[ti++];
      if (e.op === 0xe7) { tempo = e.args[0]; fade = null; } else fade = { from: tempo, to: e.args[1], n: e.args[0] || 1, k: 0 };
    }
    at[t] = acc;
    if (fade && fade.k < fade.n) { fade.k++; tempo = fade.from + (fade.to - fade.from) * fade.k / fade.n; }
    acc += 256 / (timerHz * Math.max(1, tempo));
  }
  return at;
}

// Brings a song's pattern boundaries in line with its (possibly edited) end and loop point: patterns past the end
// are dropped or cut, a longer song gets a pattern for the extra time, and the loop point starts a pattern.
export function settlePatterns(song) {
  const chans = song.channels.filter(Boolean);
  const end = Math.max(1, ...chans.map(c => c.end));
  const loop = chans.find(c => c.loop !== null)?.loop ?? null;
  let pats = [];
  for (const p of song.patterns) {
    if (p.t >= end) break;
    pats.push({ ...p, len: Math.min(p.len, end - p.t) });
  }
  const covered = pats.length ? pats[pats.length - 1].t + pats[pats.length - 1].len : 0;
  if (covered < end) pats.push({ t: covered, len: end - covered });
  if (loop !== null && loop < end && !pats.some(p => p.t === loop)) {
    const i = pats.findIndex(p => p.t < loop && p.t + p.len > loop);
    const p = pats[i];
    pats.splice(i, 1, { ...p, len: loop - p.t }, { t: loop, len: p.t + p.len - loop });
  }
  song.patterns = pats;
  song.end = end;
  song.loop = loop;
  song.loopPattern = loop === null ? null : pats.findIndex(p => p.t === loop);
  for (const c of chans) { c.end = end; c.loop = loop; }
}
