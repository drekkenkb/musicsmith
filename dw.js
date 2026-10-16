// Dragon Warrior's music format: finding it in a ROM, decoding it into editable songs, and compiling songs back
// into the bytes the game's sound engine reads.
//
// Each song has a stream of bytes per channel (SQ1, SQ2, TRI); a sound effect has one stream that drives SQ2 and the
// noise channel. A stream is a list of commands, notes ($80-$DF, an index into the note table) and lengths
// ($01-$7F, in ticks). $FE jumps and remembers where it came from, $FD goes back there: so $FE is both "call" and
// "loop". $FC does nothing, but the game waits for the stream to reach one (the end of a jingle, the intro's cue).
// $F7 n makes every following note last n ticks without a length byte; $F6 turns that off. $F9 sets a note offset
// that applies to every channel (the dungeon floors share one melody, transposed). $00 ends the stream.

const MUSIC_NAMES = [
  "No sound", "Intro", "Throne room", "Tantegel castle", "Village", "Overworld", "Dungeon floor 1", "Dungeon floor 2",
  "Dungeon floor 3", "Dungeon floor 4", "Dungeon floor 5", "Dungeon floor 6", "Dungeon floor 7", "Dungeon floor 8",
  "Battle start", "Dragonlord battle", "Ending", "Silver harp", "Fairy flute", "Rainbow bridge", "Death", "Inn",
  "Princess Gwaelin", "Cursed", "Battle", "Victory", "Level up",
];
const SFX_NAMES = [
  "Force field", "Wings", "Stairs", "Run away", "Swamp", "Menu", "Confirm", "Enemy hit", "Excellent move", "Attack",
  "Hit 1", "Hit 2", "Attack prep", "Missed 1", "Missed 2", "Wall bump", "Text", "Spell", "Radiant", "Open chest",
  "Open door", "Fire breath",
];

export const CHANNEL_NAMES = ["Square 1", "Square 2", "Triangle"];
export const NOTE_BASE = 0x80; // C2 (MIDI 36)
export const NOTE_TOP = 0xc8; // C8, the last entry in the note table

// Bytes that take an argument.
const ARGS = { 0xfe: 2, 0xff: 1, 0xfa: 1, 0xfb: 1, 0xf8: 1, 0xf9: 1, 0xf7: 1 };
const CMD = { tempo: 0xff, ctrl0: 0xfb, ctrl1: 0xfa, noisevol: 0xf8, offset: 0xf9 };
const CMD_TYPE = Object.fromEntries(Object.entries(CMD).map(([k, v]) => [v, k]));

// ---------------------------------------------------------------- finding the engine

const find = (b, pat, from = 0) => {
  outer: for (let i = from; i + pat.length <= b.length; i++) {
    for (let j = 0; j < pat.length; j++) if (pat[j] !== null && b[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
};
const _ = null;

// Looks for the engine's code in each PRG bank and reads its table addresses from the instructions that use them.
export function locate(rom) {
  if (rom[0] !== 0x4e || rom[1] !== 0x45 || rom[2] !== 0x53 || rom[3] !== 0x1a) throw new Error("That isn't an NES ROM (no iNES header).");
  const prg = rom[4], base = 16 + (rom[6] & 4 ? 512 : 0);
  for (let bank = 0; bank < prg; bank++) {
    const b = rom.subarray(base + bank * 0x4000, base + (bank + 1) * 0x4000);
    // InitMusicSFX: LDX #$FF / STX abs / TAX / BMI / ASL / STA zp / ASL / ADC zp / ADC #4 / TAY / LDX #4 / LDA tbl+1,Y
    const init = find(b, [0xa2, 0xff, 0x8e, _, _, 0xaa, 0x30, _, 0x0a, 0x85, _, 0x0a, 0x65, _, 0x69, 0x04, 0xa8, 0xa2, 0x04, 0xb9]);
    // DoSFX: ASL / TAX / LDA #1 / STA zp / LDA tbl,X
    const sfx = find(b, [0x0a, 0xaa, 0xa9, 0x01, 0x85, _, 0xbd]);
    // LoadMusicNote: CLC / ADC zp / ASL / STX zp / TAX / LDA tbl,X
    const note = find(b, [0x18, 0x65, _, 0x0a, 0x86, _, 0xaa, 0xbd]);
    if (init < 0 || sfx < 0 || note < 0) continue;
    const word = o => b[o] | b[o + 1] << 8;
    const L = {
      prg, base, bank,
      musicTbl: word(init + 20) - 1, sfxTbl: word(sfx + 7), notesTbl: word(note + 8),
    };
    const mem = cpuView(rom, L);
    const w = a => mem[a] | mem[a + 1] << 8;
    L.songCount = Math.floor((L.sfxTbl - L.musicTbl) / 6);
    if (L.songCount < 1 || L.songCount > 64) continue;
    let lowest = 0x10000;
    for (let i = 0; i < L.songCount * 3; i++) { const p = w(L.musicTbl + i * 2); if (p) lowest = Math.min(lowest, p); }
    let n = 0;
    while (L.sfxTbl + n * 2 < lowest && n < 128) { lowest = Math.min(lowest, w(L.sfxTbl + n * 2)); n++; }
    L.sfxCount = n;
    L.isDW = L.musicTbl === 0x8297 && L.sfxTbl === 0x8339 && L.songCount === 27 && n === 22;
    return L;
  }
  throw new Error("This ROM doesn't have Dragon Warrior's sound engine. MusicSmith only knows Dragon Warrior (and Dragon Quest) so far.");
}

// The CPU's view: the engine's bank at $8000 and the last (fixed) bank at $C000.
export function cpuView(rom, L) {
  const mem = new Uint8Array(0x10000);
  mem.set(rom.subarray(L.base + L.bank * 0x4000, L.base + (L.bank + 1) * 0x4000), 0x8000);
  mem.set(rom.subarray(L.base + (L.prg - 1) * 0x4000, L.base + L.prg * 0x4000), 0xc000);
  return mem;
}

export function romOffset(L, addr) {
  return addr < 0xc000 ? L.base + L.bank * 0x4000 + (addr - 0x8000) : L.base + (L.prg - 1) * 0x4000 + (addr - 0xc000);
}

// ---------------------------------------------------------------- decoding

// Follows one stream tick by tick and turns it into timed events. A loop is found when the stream comes back to a
// place it has been before in the same state (position, $F7 length, and the return address if a $FD is coming).
// Commands at the loop's tick that ran before the loop point are marked `pre`: they happen only the first time.
// A $FC only matters where the stream stops between steps: the game sees it for the whole step before it. So a
// "sync" event's tick is the start of that step and `until` its end; one the game could never see is dropped.
function decodeStream(mem, start, sfx) {
  const events = [], touched = new Set();
  let ptr = start, ret = 0, quiet = 0, t = 0, loop = null, end = null, endSync = false, prev = 0, first = true;
  const get = () => { touched.add(ptr); const v = mem[ptr]; ptr = (ptr + 1) & 0xffff; return v; };
  // Whether the return address matters from `p` on: only if a $FD comes before the next $FE or $00.
  const retMatters = p => {
    for (let n = 0; n < 4096; n++) {
      const v = mem[p];
      if (v === 0xfd) return true;
      if (v === 0xfe || v === 0x00) return false;
      p += 1 + (ARGS[v] || 0);
    }
    return false;
  };
  const seen = new Map();
  const where = `The stream at $${start.toString(16).toUpperCase()}`;

  steps: for (let step = 0; step < 20000; step++) {
    let len = 0;
    for (let guard = 0; ; guard++) {
      if (guard > 4096) throw new Error(`${where} never reaches a note length.`);
      const k = `${ptr},${quiet},${retMatters(ptr) ? ret : -1}`;
      const been = seen.get(k);
      if (been) {
        if (been.t === t) throw new Error(`${where} loops without any time passing.`);
        loop = been.t; end = t;
        for (let i = 0; i < been.i; i++) if (events[i].t === loop) events[i].pre = true;
        break steps;
      }
      seen.set(k, { t, i: events.length });
      const a = get(), wasFirst = first;
      first = false;
      if (a === 0xfe) {
        const lo = get(), hi = get();
        ret = ptr;
        ptr = lo | hi << 8;
        continue;
      }
      if (a === 0xfd) {
        if (!(ret >> 8)) throw new Error(`${where} returns without a jump.`);
        ptr = ret;
        continue;
      }
      if (a === 0xfc) { if (wasFirst) events.push({ t: prev, type: "sync", until: t }); continue; }
      if (a === 0xf6) { quiet = 0; continue; }
      if (a === 0xf7) { quiet = get(); continue; }
      if (CMD_TYPE[a]) { events.push({ t, type: CMD_TYPE[a], v: get() }); continue; }
      if (a >= 0xe0) { events.push({ t, type: "noise", v: a }); continue; }
      if (a >= 0x80) {
        events.push({ t, type: "note", raw: a });
        if (!sfx && quiet) { len = quiet; break; }
        continue;
      }
      if (a === 0) {
        end = t;
        if (mem[ptr] === 0xfc) { touched.add(ptr); endSync = true; }
        break steps;
      }
      len = a;
      break;
    }
    prev = t;
    t += len;
    first = true;
  }
  if (end === null) throw new Error(`${where} doesn't end or loop.`);
  return { events: events.filter(e => e.t < end || (e.t === end && e.type !== "note" && e.type !== "noise")), loop, end, endSync, touched };
}

// Channels are processed TRI, SQ2, SQ1 each tick, which decides whose note offset change a note at the same tick sees.
const ORDER = [2, 1, 0];

// The note offset in effect for a note on channel `ci` at tick `t`.
export function offsetAt(song, ci, t) {
  if (song.sfx) return 0;
  let best = null, bestKey = -1;
  song.channels.forEach((ch, c) => {
    if (!ch) return;
    for (const e of ch.events) {
      if (e.type !== "offset" || e.t > t || e.t >= ch.end) continue;
      if (e.t === t && ORDER[c] > ORDER[ci]) continue;
      const k = e.t * 4 + (3 - ORDER[c]);
      if (k >= bestKey) { bestKey = k; best = e.v; }
    }
  });
  return best ?? 0;
}

const silentCtrl = (kind, v) => (kind === "tri" ? (v & 0x7f) === 0 : (v & 0x10) !== 0 && (v & 0x0f) === 0);
export const channelKind = (song, ci) => (song.sfx ? "sfx" : ci === 2 ? "tri" : "sq");

// Notes hold until the channel's next note, an instrument change that silences it, or the end. These are the
// lengths the editor and MIDI files show; the engine itself has no note-offs.
export function setDurations(song) {
  song.channels.forEach((ch, ci) => {
    if (!ch) return;
    const kind = channelKind(song, ci);
    for (const [lane, silencer] of [["note", "ctrl0"], ["noise", "noisevol"]]) {
      const notes = ch.events.filter(e => e.type === lane);
      const silences = ch.events.filter(e => e.type === silencer && silentCtrl(lane === "noise" ? "sq" : kind, e.v)).map(e => e.t);
      notes.forEach((n, i) => {
        let stop = i + 1 < notes.length ? notes[i + 1].t : ch.end;
        for (const s of silences) if (s > n.t && s < stop) { stop = s; break; }
        n.dur = Math.max(1, stop - n.t);
      });
    }
  });
}

function decodeSong(mem, ptrs, sfx, name, id) {
  const song = { id, name, sfx, channels: [], touched: new Set() };
  for (const p of ptrs) {
    if (!p) { song.channels.push(null); continue; }
    const d = decodeStream(mem, p, sfx);
    d.touched.forEach(a => song.touched.add(a));
    delete d.touched;
    song.channels.push(d);
  }
  song.channels.forEach((ch, ci) => {
    for (const e of ch?.events || []) if (e.type === "note") { e.key = (e.raw + offsetAt(song, ci, e.t)) & 0xff; delete e.raw; }
  });
  setDurations(song);
  return song;
}

// Reads every song and sound effect, and works out which bytes of the ROM hold them.
export function readSongs(rom, L) {
  const mem = cpuView(rom, L), w = a => mem[a] | mem[a + 1] << 8;
  const songs = [], touched = new Set();
  for (let i = 0; i < L.songCount; i++) {
    const ptrs = [0, 1, 2].map(c => w(L.musicTbl + i * 6 + c * 2));
    const name = L.isDW ? MUSIC_NAMES[i] : `Song ${i}`;
    songs.push(decodeSong(mem, ptrs, false, name, i));
  }
  for (let i = 0; i < L.sfxCount; i++) {
    const name = L.isDW ? SFX_NAMES[i] : `Sound ${i}`;
    songs.push(decodeSong(mem, [w(L.sfxTbl + i * 2)], true, name, 0x80 | i));
  }
  for (const s of songs) { s.touched.forEach(a => touched.add(a)); delete s.touched; }
  L.region = regionOf(touched);
  L.free = freeSpace(mem, L);
  return songs;
}

// The span of the engine's bank that the music occupies. Everything between the first and last byte the streams use
// is taken to be music data (in Dragon Warrior it's one block, $8365-$9353).
function regionOf(touched) {
  let lo = 0xffff, hi = 0;
  for (const a of touched) if (a >= 0x8000 && a < 0xc000) { lo = Math.min(lo, a); hi = Math.max(hi, a); }
  return [lo, hi + 1];
}

// Runs of $FF at least 64 long in the engine's bank, outside the music; their first and last bytes are left alone
// in case they end or start something.
function freeSpace(mem, L) {
  const out = [];
  for (let a = 0x8000; a < 0xc000;) {
    if (mem[a] !== 0xff || (a >= L.region[0] && a < L.region[1])) { a++; continue; }
    let b = a;
    while (b < 0xc000 && mem[b] === 0xff && !(b >= L.region[0] && b < L.region[1])) b++;
    if (b - a >= 64) out.push([a + 1, b - 1]);
    a = b;
  }
  return out;
}

export function capacity(L) {
  return [L.region, ...L.free].reduce((s, [a, b]) => s + b - a, 0);
}

// ---------------------------------------------------------------- compiling

// The instrument a channel falls back to when it has to come back from a silence it was never given a sound for.
const DEFAULT_CTRL = { sq: 0xb8, tri: 0xff, sfx: 0xb8, noise: 0x38 };

// Compiles one channel into tokens: { b: bytes }, { label }, { jump: label }. Notes are stored as the pitch you
// hear, so the note offset in effect is taken back off here.
export function compileChannel(song, ci) {
  const ch = song.channels[ci];
  if (!ch) return null;
  const kind = channelKind(song, ci), sfx = song.sfx;
  const end = ch.end;
  let evs = ch.events.filter(e => e.t < end || (e.t === end && e.type !== "note" && e.type !== "noise"))
    .map(e => ({ ...e }));
  for (const e of evs) {
    if (e.type !== "note") continue;
    e.raw = (e.key - offsetAt(song, ci, e.t)) & 0xff;
    if (e.raw < 0x80 || e.raw >= 0xe0) {
      throw new Error(`${song.name}, ${sfx ? "" : CHANNEL_NAMES[ci] + ", "}tick ${e.t}: that note is out of the engine's range.`);
    }
  }

  // A note made shorter than the gap to the next one needs the channel silenced where it ends, and its sound put
  // back before the next note.
  const add = [];
  for (const [lane, ctrlType, k] of [["note", "ctrl0", kind], ["noise", "noisevol", "noise"]]) {
    const notes = evs.filter(e => e.type === lane).sort((a, b) => a.t - b.t);
    const ctrls = evs.filter(e => e.type === ctrlType);
    const ctrlAt = t => { let v = null; for (const c of ctrls) if (c.t <= t) v = c.v; return v; };
    const silent = v => silentCtrl(k === "noise" ? "sq" : k, v);
    notes.forEach((n, i) => {
      const stop = n.t + (n.dur || 1), next = notes[i + 1]?.t ?? end;
      if (stop >= next) return;
      if (ctrls.some(c => c.t > n.t && c.t <= stop && silent(c.v))) return;
      const cur = ctrlAt(stop) ?? DEFAULT_CTRL[k];
      if (silent(cur)) return;
      add.push({ t: stop, type: ctrlType, v: k === "tri" ? 0 : (cur & 0xc0) | 0x30, synth: true });
      if (i + 1 < notes.length && !ctrls.some(c => c.t > stop && c.t <= next)) add.push({ t: next, type: ctrlType, v: cur, synth: true, first: true });
    });
  }
  for (const a of add) {
    if (a.first) evs.unshift(a); else evs.push(a);
  }
  evs.sort((a, b) => a.t - b.t); // stable: keeps the order of events at the same tick

  const times = [...new Set(evs.filter(e => e.t < end).flatMap(e => (e.type === "sync" && e.until < end ? [e.t, e.until] : [e.t])))];
  if (ch.loop !== null && ch.loop < end && !times.includes(ch.loop)) times.push(ch.loop);
  times.sort((a, b) => a - b);
  const loop = ch.loop !== null && ch.loop < end ? ch.loop : null;

  const out = [];
  const bytes = (...b) => out.push({ b });
  const waits = n => { while (n > 0) { const c = Math.min(n, 127); bytes(c); n -= c; } };
  const commands = (t, pre) => {
    // In a fixed order, so a song read back from a MIDI file (where tracks don't interleave) compiles the same.
    const at = evs.filter(e => e.t === t && !!e.pre === pre).sort((a, b) => (RANK[a.type] ?? 9) - (RANK[b.type] ?? 9));
    for (const e of at) if (CMD[e.type] !== undefined) bytes(CMD[e.type], e.v);
  };
  const syncAt = t => evs.some(e => e.t === t && e.type === "sync");
  const fc = () => out.push({ b: [0xfc], sync: true });
  const noteAt = t => evs.find(e => e.t === t && e.type === "note");
  const noiseAt = t => evs.find(e => e.t === t && e.type === "noise");

  // Note lengths: a note is followed by a length byte, unless $F7 has set a length every note gets (a longer gap is
  // then the note plus a wait). Which $F7 values to use, and where, is chosen to make the fewest bytes. Where the
  // loop starts, $F7 must be the same coming from the start and coming round from the end.
  const steps = times.map((t, i) => ({ t, d: (times[i + 1] ?? end) - t, n: noteAt(t), nz: noiseAt(t), cue: syncAt(t) }));
  const chunks = x => Math.ceil(x / 127);
  const noteCost = (q, d, cue) => (q === d ? 1 : q === 0 ? 1 + chunks(d) : q > 0 && d > q && !cue ? 1 + chunks(d - q) : Infinity);
  const trans = (q, v) => (q === v ? 0 : v === 0 ? 1 : 2);
  const noteSteps = sfx ? [] : steps.filter(st => st.n);
  const V = [0, ...new Set(noteSteps.map(st => st.d).filter(d => d <= 255))];
  const plan = (list, start, target) => {
    let cost = new Map([[start, 0]]);
    const back = [];
    for (const st of list) {
      const next = new Map(), from = new Map();
      for (const v of V) {
        const c = noteCost(v, st.d, st.cue);
        if (c === Infinity) continue;
        let best = Infinity, arg = null;
        for (const [q, k] of cost) { const x = k + trans(q, v); if (x < best) { best = x; arg = q; } }
        if (arg !== null) { next.set(v, best + c); from.set(v, arg); }
      }
      cost = next;
      back.push(from);
    }
    let best = Infinity, last = start;
    for (const [q, k] of cost) { const x = k + (target === null ? 0 : trans(q, target)); if (x < best) { best = x; last = q; } }
    const states = [];
    for (let i = list.length - 1, q = last; i >= 0; i--) { states[i] = q; q = back[i].get(q); }
    return { cost: best, states, last };
  };
  const quietOf = new Map();
  let label = 0;
  if (!sfx) {
    const pre = noteSteps.filter(st => loop === null || st.t < loop), body = noteSteps.filter(st => loop !== null && st.t >= loop);
    if (loop === null) {
      const r = plan(pre, 0, null);
      pre.forEach((st, i) => quietOf.set(st, r.states[i]));
    } else {
      let best = null;
      for (const qL of V) {
        const a = plan(pre, 0, qL), b = plan(body, qL, qL);
        if (!best || a.cost + b.cost < best.cost) best = { cost: a.cost + b.cost, a, b, qL };
      }
      pre.forEach((st, i) => quietOf.set(st, best.a.states[i]));
      body.forEach((st, i) => quietOf.set(st, best.b.states[i]));
      label = best.qL;
    }
  }
  const setQuiet = (q, v) => { if (q !== v) { if (v) bytes(0xf7, v); else bytes(0xf6); } return v; };

  waits(times.length ? times[0] : end); // a channel that starts late
  let quiet = 0;
  for (const st of steps) {
    const { t, d, n, nz, cue } = st;
    if (t === loop) { commands(t, true); quiet = setQuiet(quiet, label); out.push({ label: "loop" }); }
    commands(t, false);
    if (nz) bytes(nz.v);
    if (sfx || !n) {
      if (n) bytes(n.raw);
      waits(d);
    } else {
      // A cue has to follow the whole step, so a step before one isn't split into note-then-wait.
      quiet = setQuiet(quiet, quietOf.get(st));
      bytes(n.raw);
      if (quiet === 0) waits(d);
      else if (d > quiet) waits(d - quiet);
    }
    if (cue) fc();
  }
  if (loop !== null) quiet = setQuiet(quiet, label);
  commands(end, false);
  if (loop !== null) out.push({ jump: "loop" });
  else {
    bytes(0);
    if (ch.endSync) out.push({ b: [0xfc], sync: true });
  }
  return out;
}

const RANK = { tempo: 0, offset: 1, ctrl0: 2, ctrl1: 3, noisevol: 4 };
const tokenSize = tk => (tk.b ? tk.b.length : tk.label ? 0 : 3);

// Turns repeated runs of tokens into subroutines ($FE to them, $FD back) until nothing more can be saved, taking the
// run that saves the most each time. Calls can't nest (the engine keeps one
// return address), so a call is never part of a run, and a run can't start with or be followed by a $FC: the game
// looks for $FC at the stream's current position. Sound effects are left alone: the noise channel's return address
// is where Square 1 keeps its note length, so a jump in an effect would break the music.
function factor(streams, sfx) {
  const subs = [], ids = new Map();
  let barrier = -1;
  const idOf = (tk, s) => {
    if (sfx[s] || !tk.b || (tk.b.length === 1 && tk.b[0] === 0)) return barrier--;
    const k = tk.b.join(",");
    if (!ids.has(k)) ids.set(k, ids.size + 1);
    return ids.get(k);
  };
  const FC = idOf({ b: [0xfc] }, sfx.indexOf(false));
  const isFC = v => v === FC;
  const B = 0x9e3779b1;

  for (let round = 0; round < 2000; round++) {
    const seqs = streams.map((st, s) => st.map(tk => idOf(tk, s)));
    const sums = streams.map(st => { const p = [0]; for (const tk of st) p.push(p[p.length - 1] + tokenSize(tk)); return p; });
    // Where the next barrier is, from each position.
    const nb = seqs.map(seq => { const r = new Int32Array(seq.length + 1); r[seq.length] = seq.length; for (let i = seq.length - 1; i >= 0; i--) r[i] = seq[i] < 0 ? i : r[i + 1]; return r; });
    const hashes = seqs.map(seq => new Int32Array(seq.length));
    // Candidates grow one token at a time: a run can only repeat if the run one shorter does.
    let cand = [];
    seqs.forEach((seq, s) => { for (let i = 0; i < seq.length; i++) if (seq[i] >= 0 && !isFC(seq[i])) { cand.push(s, i); hashes[s][i] = seq[i]; } });
    let best = null;
    for (let len = 1; cand.length; len++) {
      if (len > 1) {
        const next = [];
        for (let c = 0; c < cand.length; c += 2) {
          const s = cand[c], i = cand[c + 1];
          if (nb[s][i] < i + len) continue;
          hashes[s][i] = Math.imul(hashes[s][i], B) + seqs[s][i + len - 1] | 0;
          next.push(s, i);
        }
        cand = next;
      }
      const groups = new Map();
      for (let c = 0; c < cand.length; c += 2) {
        const h = hashes[cand[c]][cand[c + 1]];
        let g = groups.get(h);
        if (!g) groups.set(h, g = []);
        g.push(cand[c], cand[c + 1]);
      }
      const keep = [];
      for (const g of groups.values()) {
        if (g.length < 4) continue;
        for (let c = 0; c < g.length; c++) keep.push(g[c]);
        if (len < 2) continue;
        // Count the non-overlapping uses that aren't followed by a $FC.
        let n = 0, lastS = -1, lastEnd = -1;
        for (let c = 0; c < g.length; c += 2) {
          const s = g[c], i = g[c + 1];
          if (isFC(seqs[s][i + len])) continue;
          if (s === lastS && i < lastEnd) continue;
          n++; lastS = s; lastEnd = i + len;
        }
        const bytes = sums[g[0]][g[1] + len] - sums[g[0]][g[1]];
        const save = (n - 1) * bytes - 3 * n - 1;
        if (save > 0 && (!best || save > best.save)) best = { save, len, s: g[0], i: g[1] };
      }
      cand = keep;
    }
    if (!best) break;
    const pat = seqs[best.s].slice(best.i, best.i + best.len);
    const id = subs.length;
    subs.push({ body: streams[best.s].slice(best.i, best.i + best.len), size: sums[best.s][best.i + best.len] - sums[best.s][best.i] });
    streams.forEach((st, s) => {
      const seq = seqs[s], out = [];
      for (let i = 0; i < st.length;) {
        let hit = i + best.len < seq.length && !isFC(seq[i + best.len]);
        for (let j = 0; hit && j < best.len; j++) if (seq[i + j] !== pat[j]) hit = false;
        if (hit) { out.push({ call: id }); i += best.len; } else out.push(st[i++]);
      }
      streams[s] = out;
    });
  }
  return subs;
}

// Compiles every song and lays the result out in the ROM's music space. Returns the new ROM, or throws if it
// doesn't fit.
export function buildRom(rom, L, songs) {
  const room = capacity(L);
  const keyOf = toks => JSON.stringify(toks);
  const streams = [], isSfx = [], index = new Map(); // unique streams, shared where identical
  const refs = songs.map(song => song.channels.map((ch, ci) => {
    const toks = compileChannel(song, ci);
    if (!toks) return -1;
    const k = (song.sfx ? "s" : "m") + keyOf(toks);
    if (!index.has(k)) { index.set(k, streams.length); streams.push(toks); isSfx.push(song.sfx); }
    return index.get(k);
  }));
  const subs = factor(streams, isSfx);

  // Place the biggest pieces first, each in the first space it fits.
  const pieces = [
    ...streams.map((st, i) => ({ kind: "stream", i, toks: st, size: st.reduce((a, tk) => a + tokenSize(tk), 0) })),
    ...subs.map((sb, i) => ({ kind: "sub", i, toks: [...sb.body, { b: [0xfd] }], size: sb.size + 1 })),
  ];
  const need = pieces.reduce((s, p) => s + p.size, 0);
  const spaces = [L.region, ...L.free].map(([a, b]) => ({ at: a, end: b }));
  for (const p of [...pieces].sort((a, b) => b.size - a.size)) {
    const sp = spaces.find(s => s.end - s.at >= p.size);
    if (!sp) {
      throw new Error(`The music needs ${need} bytes but there's room for ${room}. Shorten or simplify a song by about ${need - room} bytes.`);
    }
    p.addr = sp.at;
    sp.at += p.size;
  }
  const subAddr = pieces.filter(p => p.kind === "sub").map(p => p.addr);
  const streamAddr = pieces.filter(p => p.kind === "stream").map(p => p.addr);

  const out = rom.slice();
  const put = (addr, v) => { out[romOffset(L, addr)] = v; };
  for (let a = L.region[0]; a < L.region[1]; a++) put(a, 0xff);
  for (const p of pieces) {
    let a = p.addr;
    const labels = {};
    for (const tk of p.toks) { if (tk.label) labels[tk.label] = a; a += tokenSize(tk); }
    a = p.addr;
    for (const tk of p.toks) {
      if (tk.b) for (const v of tk.b) put(a++, v);
      else if (tk.label) continue;
      else {
        const to = tk.jump ? labels[tk.jump] : subAddr[tk.call];
        put(a++, 0xfe); put(a++, to & 0xff); put(a++, to >> 8);
      }
    }
  }
  const putWord = (addr, v) => { put(addr, v & 0xff); put(addr + 1, v >> 8); };
  songs.forEach((song, s) => {
    if (song.sfx) putWord(L.sfxTbl + (song.id & 0x7f) * 2, streamAddr[refs[s][0]]);
    else for (let c = 0; c < 3; c++) putWord(L.musicTbl + song.id * 6 + c * 2, refs[s][c] < 0 ? 0 : streamAddr[refs[s][c]]);
  });
  return { rom: out, used: need, room };
}

// Where a song's streams start in a CPU view, after compiling just that song into the music space, so it can be
// previewed without the rest of the ROM having to fit.
export function previewMem(rom, L, song) {
  const mem = cpuView(rom, L);
  let a = L.region[0];
  const ptrs = song.channels.map((ch, ci) => {
    const toks = compileChannel(song, ci);
    if (!toks) return 0;
    const start = a;
    const labels = {};
    for (const tk of toks) { if (tk.label) labels[tk.label] = a; a += tokenSize(tk); }
    a = start;
    for (const tk of toks) {
      if (tk.b) for (const v of tk.b) mem[a++] = v;
      else if (tk.jump) { mem[a++] = 0xfe; mem[a++] = labels[tk.jump] & 0xff; mem[a++] = labels[tk.jump] >> 8; }
    }
    return start;
  });
  if (a > 0xc000) throw new Error("This song is too long to preview.");
  const w = p => mem[p] | mem[p + 1] << 8;
  const silent = [0, 1, 2].map(c => w(L.musicTbl + c * 2));
  return { mem, ptrs, silent };
}

// The tick at which a song is done with its first time through: the longest channel, loops included once.
export function songLength(song) {
  return Math.max(1, ...song.channels.filter(Boolean).map(ch => ch.end));
}

export const cloneSong = s => JSON.parse(JSON.stringify(s));
