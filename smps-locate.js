// Finding a game's SMPS driver by watching it run: boot the game on the emulated Genesis, see which routine the
// vertical-blank interrupt calls every frame (the driver's update), find the RAM byte the game writes a song number
// to (by trying), and find the music table from what the driver reads when asked for two different songs.
import { Genesis } from "./genesis.js";
import { readHeader, decodeSong } from "./smps.js";

const BOOT_FRAMES = 400;
const r32 = (r, o) => ((r[o] << 24) | (r[o + 1] << 16) | (r[o + 2] << 8) | r[o + 3]) >>> 0;
const r16 = (r, o) => (r[o] << 8) | r[o + 1];

// The coordination flag table: a run of 20+ BRA.W instructions.
export function flagTables(rom) {
  const out = [];
  for (let o = 0x200; o + 4 <= rom.length; o += 2) {
    let n = 0;
    while (rom[o + n * 4] === 0x60 && rom[o + n * 4 + 1] === 0) n++;
    if (n >= 20 && n <= 40) { out.push({ at: o, n }); o += n * 4; }
  }
  return out;
}

// Boots the game for a while. Returns the machine and the driver routine entries the interrupt handler made.
export function boot(rom, region) {
  const g = new Genesis(rom), cpu = g.cpu;
  cpu.sr = 0x2700; cpu.a[7] = cpu.r32(0); cpu.ssp = cpu.a[7]; cpu.pc = cpu.r32(4);
  const entries = new Map();
  let prev = 0;
  const step = cpu.step.bind(cpu);
  cpu.step = () => {
    const pc = cpu.pc;
    if (region && pc >= region[0] && pc < region[1] && !(prev >= region[0] && prev < region[1])) entries.set(pc, (entries.get(pc) || 0) + 1);
    prev = pc;
    return step();
  };
  for (let f = 0; f < BOOT_FRAMES; f++) {
    for (let i = 0; i < 16000 && !cpu.stopped; i++) cpu.step();
    cpu.interrupt(6);
    g.soundFrame();
  }
  cpu.step = step;
  return { g, entries };
}

// A booted machine taken over by us: from here only the sound driver runs, once a frame.
export function takeOver(g) {
  g.cpu.a[7] = 0xfffd00;
  g.cpu.sr = 0x2700;
}

export function save(g) {
  const z = g.z80, c = g.cpu;
  return {
    ram: g.ram.slice(), zram: g.zram.slice(),
    cpu: { d: c.d.slice(), a: c.a.slice(), pc: c.pc, sr: c.sr, usp: c.usp, ssp: c.ssp },
    z80: Object.fromEntries(Object.entries(z).filter(([k, v]) => typeof v === "number" || typeof v === "boolean")),
    ym: structuredClone(Object.fromEntries(Object.entries(g.ym))),
    psg: structuredClone(Object.fromEntries(Object.entries(g.psg))),
    gen: { zBusReq: g.zBusReq, zReset: g.zReset, zBank: g.zBank, zBankBits: g.zBankBits, ymFrac: g.ymFrac, psgFrac: g.psgFrac, ymAddr: g.ymAddr.slice() },
  };
}

export function restore(g, s) {
  g.ram.set(s.ram); g.zram.set(s.zram);
  Object.assign(g.cpu, { pc: s.cpu.pc, sr: s.cpu.sr, usp: s.cpu.usp, ssp: s.cpu.ssp, stopped: false });
  g.cpu.d.set(s.cpu.d); g.cpu.a.set(s.cpu.a);
  Object.assign(g.z80, s.z80);
  Object.assign(g.ym, structuredClone(s.ym));
  Object.assign(g.psg, structuredClone(s.psg));
  Object.assign(g, structuredClone(s.gen));
}

// Runs the driver for `frames` frames, returning the YM2612 key-on count (and calling onFrame if given).
function runDriver(g, entry, frames, onFrame) {
  let kon = 0;
  const prev = g.onYmWrite;
  g.onYmWrite = (p, r, v, by) => { if (r === 0x28 && v & 0xf0) kon++; prev?.(p, r, v, by); };
  for (let f = 0; f < frames; f++) {
    g.soundFrame(null, null, entry);
    onFrame?.(f);
  }
  g.onYmWrite = prev;
  return kon;
}

// The parameter count of each coordination flag, measured by running its handler in the driver: the track pointer
// (A4) is set at a buffer of parameter bytes, and how far the handler moves it is how many it takes. Run twice with
// different parameters: jumps, loops and calls move it by their parameters. A handler that sets it from elsewhere (the
// same both times) is the return from a call; one that never comes back ends the track. Returns flags for smps.js,
// or null if the jump, loop and call aren't where and what they are in Sonic 1.
export function measureFlags(g, L) {
  const BUF = 0xfffe00, RET = 0xfffff0, POP = 0xffffe8;
  const run = (i, fill) => {
    restore(g, L.snapshot);
    const c = g.cpu;
    for (let k = 0; k < 32; k++) g.ram[(BUF + k) & 0xffff] = fill;
    c.a[7] = 0xfffd00; c.push32(POP); c.push32(RET);
    c.a[4] = BUF; c.a[5] = L.base + 0x40; c.a[6] = L.base; c.d[5] = 0xe0 + i;
    c.pc = L.flagTable + i * 4; c.stopped = false;
    try {
      for (let n = 0; n < 20000; n++) {
        if (c.pc === RET) return { back: true, d: (c.a[4] - BUF) | 0 };
        if (c.pc === POP) return { back: false };
        c.step();
      }
    } catch { /* ran into nonsense: it doesn't come back */ }
    return { back: false };
  };
  const lengths = [], ends = [];
  let ret = -1;
  for (let i = 0; i < L.flagCount; i++) {
    const a = run(i, 0x01), b = run(i, 0x10);
    if (!a.back || !b.back) { lengths.push(0); ends.push(0xe0 + i); continue; }
    if (a.d === b.d && a.d >= 0 && a.d <= 16) { lengths.push(a.d); continue; }
    lengths.push(i === 0x16 || i === 0x18 ? 2 : i === 0x17 ? 4 : 0);
    if (i >= 0x16 && i <= 0x18) {
      // relative pointers as Sonic 1 has them: target = (position of the pointer) + 1 + offset
      const ok = i === 0x17 ? a.d === 4 && b.d === 0x1010 + 3 : a.d === 0x0101 + 1 && b.d === 0x1010 + 1;
      if (!ok) return null;
    } else if (a.d === b.d && ret < 0) ret = 0xe0 + i;
    else ends.push(0xe0 + i);
  }
  if (L.flagCount < 0x19 || ret < 0) return null;
  const stop = ends.includes(0xf2) ? 0xf2 : ends[0];
  return { lengths, jump: 0xf6, loop: 0xf7, call: 0xf8, ret, stop, ends: ends.filter(f => f !== stop), hold: 0xe7, tempoDiv: lengths[5] === 1 ? 0xe5 : -1, transpose: 0xe9 };
}

// What a duration byte on its own plays after a rest: the rest again (Sonic 1), or the last note (later drivers).
// Found by playing a test song through the driver: note, rest, a bare duration, rest; one key-on or two.
function bareReplaysNote(rom, g, L) {
  const first = L.songs[0], h = readHeader(rom, first.at);
  // The first song's layout of tracks (drivers give out channels by how many there are), all silent but the first
  // FM track that plays notes (some drivers put FM 1 on the DAC's channel, so songs leave it empty), which plays the
  // test with that track's transposition, so the note is in a range the driver plays.
  let track = null, fmAt = -1;
  try {
    const d = decodeSong(rom, first.at, L.flags);
    fmAt = d.channels.findIndex(c => c.kind === "fm" && c.events.some(e => e.type === "note"));
    track = d.channels[fmAt];
  } catch { /* no song to copy */ }
  if (fmAt < 0) return false;
  // The test starts with that track's commands before its first note (voice, volume, pan...) and plays that note.
  const F = L.flags, firstNote = track.events.find(e => e.type === "note");
  const setup = track.events.filter(e => e.type === "cmd" && e.t <= firstNote.t && e.op !== F.tempoDiv).flatMap(e => [e.op, ...e.args]);
  const note = firstNote.raw;
  const silent = [0x80, 0x7f, F.stop], test = [...setup, note, 0x0c, 0x80, 0x0c, 0x0c, 0x80, 0x0c, F.stop];
  const head = [0, 0, h.nfm, h.npsg, 1, h.tempo], body = [];
  const hdrLen = 6 + h.nfm * 4 + h.npsg * 6;
  h.tracks.forEach((t, i) => {
    const ptr = hdrLen + body.length;
    head.push(ptr >> 8, ptr & 255, t.transpose & 255, t.volume);
    if (t.kind === "psg") head.push(t.mod, t.env);
    body.push(...(i === fmAt ? test : silent));
  });
  const song = [...head, ...body];
  if (song.length & 1) song.push(0);
  song[0] = song.length >> 8; song[1] = song.length & 255;
  for (let i = 0; i < 25; i++) song.push(rom[h.voices + i]);
  const at = (rom.length + 1) & ~1, r = new Uint8Array(at + song.length);
  r.set(rom); r.set(song, at);
  const e = L.table + (first.id - L.first) * L.stride;
  r[e] = at >>> 24; r[e + 1] = (at >> 16) & 255; r[e + 2] = (at >> 8) & 255; r[e + 3] = at & 255;
  restore(g, L.snapshot);
  g.rom = r;
  g.ram[L.queue & 0xffff] = first.id;
  let kon = 0;
  g.onYmWrite = (p, reg, v) => { if (reg === 0x28 && v & 0xf0) kon++; };
  for (let f = 0; f < 240; f++) g.soundFrame(null, null, L.entry);
  g.onYmWrite = null; g.rom = rom;
  restore(g, L.snapshot);
  return kon >= 2;
}

export function locate(rom) {
  if (rom.length < 0x200 || !String.fromCharCode(...rom.subarray(0x100, 0x110)).includes("SEGA")) return null;
  const tables = flagTables(rom);
  if (!tables.length) return null;
  for (const tbl of tables) {
    const region = [Math.max(0, tbl.at - 0x2000), tbl.at + 0x1800];
    const { g, entries } = boot(rom, region);
    // The update: entered from outside about once a frame.
    const cands = [...entries].filter(([, n]) => n > BOOT_FRAMES / 4 && n <= BOOT_FRAMES * 2).sort((a, b) => b[1] - a[1]);
    for (const [entry] of cands) {
      // The driver's RAM base: LEA (abs).L,A6 near the start of the update.
      let base = -1;
      for (let o = entry; o < entry + 0x60; o += 2) if (r16(rom, o) === 0x4df9) { base = r32(rom, o + 2) & 0xffffff; break; }
      if (base < 0xff0000) continue;
      takeOver(g);
      const snap = save(g);
      // The request byte: of the first 0x40 bytes of driver RAM, the one where writing a song number makes the
      // driver read a song table entry for it.
      const probe = (off, id) => {
        restore(g, snap);
        g.ram[(base + off) & 0xffff] = id;
        const reads = new Set();
        const r8 = g.read8.bind(g);
        g.read8 = a => { if (a < 0x400000) reads.add(a); return r8(a); };
        g.soundFrame(null, null, entry);
        g.read8 = r8;
        return reads;
      };
      const idle = probe(0x3f, 0); // a byte that's not the request (most likely)
      for (let off = 0; off < 0x40; off++) {
        const a = probe(off, 0x81), b = probe(off, 0x82);
        const onlyA = [...a].filter(x => !b.has(x) && !idle.has(x)), onlyB = new Set([...b].filter(x => !a.has(x) && !idle.has(x)));
        let stride = 0, table = -1;
        for (const s of [4, 2]) {
          const hit = onlyA.filter(x => onlyB.has(x + s)).sort((x, y) => x - y)[0];
          if (hit !== undefined) { stride = s; table = hit - (s === 4 ? 0 : 0); break; }
        }
        if (table < 0) continue;
        // The entry read for song $81 is entry 0 or 1 of the table (some tables start at $80).
        const L = { driver: "smps68k", flagTable: tbl.at, flagCount: tbl.n, entry, base, queue: base + off, stride, table, first: 0x81 };
        // How many songs: entries that point at plausible song headers.
        L.songs = [];
        for (let i = 0; i < 64; i++) {
          const at = stride === 4 ? r32(rom, table + i * 4) : table + r16(rom, table + i * 2);
          if (at >= rom.length || at < 0x200) break;
          const nfm = rom[at + 2], npsg = rom[at + 3];
          if (nfm > 7 || npsg > 4 || nfm + npsg === 0 || rom[at + 4] === 0) break;
          L.songs.push({ id: 0x81 + i, at });
        }
        if (!L.songs.length) continue;
        L.snapshot = snap;
        L.flags = measureFlags(g, L);
        if (L.flags) L.flags.bareReplaysNote = bareReplaysNote(rom, g, L);
        if (!L.flags) continue;
        restore(g, snap);
        return { L, g };
      }
    }
  }
  return null;
}

export { runDriver };
