// SMPS, Sega's sound driver for the Genesis (Sonic the Hedgehog and many Sega games): decoding songs into editable
// timelines and compiling them back.
//
// A song starts with a header: a pointer to its FM instruments ("voices"), how many FM and PSG tracks it has, a
// tempo divider and tempo, then for each track a pointer, a transposition and a volume (PSG tracks also a modulation
// and an envelope). The first FM track is the DAC (drum samples). Pointers in the header are relative to the song.
// A track is bytes:
//   $00-$7F      duration (in units of the tempo divider) for the note before it, or alone: play the last note again
//   $80          rest; $81-$DF notes ($81 is C0 on FM, C3 on PSG; on the DAC, sample numbers)
//   $E0-$FF      coordination flags: commands with parameters. $F6 jumps (the track's loop), $F7 loops a part n
//                times, $F8 calls a part, which returns with $E3; $F2 ends the track
// Jump, loop and call pointers are relative to their own position (Sonic 1's 68000 version).

// Parameter counts of the coordination flags, by flag - $E0 (Sonic 1's driver).
export const S1_FLAGS = {
  lengths: [1, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 4, 0, 0, 1, 0, 1, 2, 4, 2, 0],
  jump: 0xf6, loop: 0xf7, call: 0xf8, ret: 0xe3, stop: 0xf2, hold: 0xe7, tempoDiv: 0xe5, transpose: 0xe9,
  ends: [0xe4], // "fade back to the previous song" also ends the track (the extra-life jingle)
  names: {
    0xe0: "Pan", 0xe1: "Detune", 0xe2: "Communication", 0xe4: "Fade in", 0xe5: "Track tempo divider",
    0xe6: "Volume change", 0xe8: "Note fill", 0xe9: "Transpose", 0xea: "Tempo", 0xeb: "Tempo divider (all)",
    0xec: "PSG volume change", 0xed: "Clear push", 0xee: "Stop special FM4", 0xef: "Instrument", 0xf0: "Modulation",
    0xf1: "Modulation on", 0xf3: "PSG noise", 0xf4: "Modulation off", 0xf5: "PSG envelope", 0xf9: "Flag F9",
  },
};

const s16 = v => (v << 16) >> 16;
const w16 = (r, o) => (r[o] << 8) | r[o + 1];

// The song header: tracks with their kind (dac/fm/psg), start, transposition and volume.
export function readHeader(rom, at) {
  const voices = at + s16(w16(rom, at));
  const nfm = rom[at + 2], npsg = rom[at + 3], div = rom[at + 4], tempo = rom[at + 5];
  if (nfm > 7 || npsg > 4 || nfm + npsg === 0 || div === 0) throw new Error("not a song header");
  const tracks = [];
  let p = at + 6;
  for (let i = 0; i < nfm; i++) {
    tracks.push({ kind: i === 0 ? "dac" : "fm", start: at + w16(rom, p), transpose: (rom[p + 2] << 24) >> 24, volume: rom[p + 3], hdr: p });
    p += 4;
  }
  for (let i = 0; i < npsg; i++) {
    tracks.push({ kind: "psg", start: at + w16(rom, p), transpose: (rom[p + 2] << 24) >> 24, volume: rom[p + 3], mod: rom[p + 4], env: rom[p + 5], hdr: p });
    p += 6;
  }
  return { at, voices, nfm, npsg, div, tempo, tracks, headerEnd: p };
}

// Follows one track into a timeline: notes (with durations in ticks, ties merged), rests, and commands, up to its
// end or the second time it reaches the place its final jump goes back to. Ticks are duration units x the track's
// tempo divider (frames, before the song tempo's occasional delays).
export function readTrack(rom, start, flags, div0, touched) {
  const ev = [];
  let p = start, t = 0, dur = 1, div = div0, prevNote = null, lastNote = null, holding = false;
  const stack = [], loops = new Map(); // call return addresses; loop counters by index
  let loopAt = null, end = null;
  const get = () => { touched?.add(p); return rom[p++]; };
  const seen = new Map(); // position+state -> tick, to find the jump back
  for (let guard = 0; guard < 200000; guard++) {
    // The tick each position is first reached at (per call depth), so a jump back can tell where the loop starts.
    const here = p + ":" + stack.length;
    if (!seen.has(here)) seen.set(here, { t, i: ev.length });
    const b = get();
    if (b >= 0xe0) {
      const n = flags.lengths[b - 0xe0];
      if (n === undefined) throw new Error(`unknown flag $${b.toString(16)}`);
      const args = [];
      for (let i = 0; i < n; i++) args.push(get());
      const rel = () => { const at = p - 2; return at + 1 + s16((args[n - 2] << 8) | args[n - 1]); };
      if (b === flags.stop) { end = t; break; }
      if (flags.ends?.includes(b)) { ev.push({ t, type: "cmd", op: b, args }); end = t; break; }
      if (b === flags.jump) {
        const to = rel();
        const key = to + ":" + stack.length;
        if (seen.has(key)) {
          const back = seen.get(key);
          loopAt = back.t;
          // Commands at the loop tick from before the place the jump lands only happen the first time through.
          for (let k = back.i - 1; k >= 0 && ev[k].t === back.t; k--) if (ev[k].type === "cmd") ev[k].pre = true;
          end = t;
          break;
        }
        p = to;
        continue;
      }
      if (b === flags.call) { stack.push(p); p = rel(); continue; }
      if (b === flags.ret) { if (!stack.length) throw new Error("return outside a call"); p = stack.pop(); continue; }
      if (b === flags.loop) {
        const idx = args[0], count = args[1], to = rel();
        const left = loops.has(idx) ? loops.get(idx) : count;
        if (left - 1 > 0) { loops.set(idx, left - 1); p = to; } else loops.delete(idx);
        continue;
      }
      if (b === flags.hold) { holding = true; continue; }
      if (b === flags.tempoDiv) div = args[0] || 1;
      ev.push({ t, type: "cmd", op: b, args });
      continue;
    }
    // a step: a note or rest (with an optional duration after it), or a bare duration (the last note again)
    let note;
    if (b >= 0x80) {
      note = b;
      if (rom[p] < 0x80) dur = get();
    } else { dur = b; note = (flags.bareReplaysNote ? lastNote : prevNote) ?? 0x80; }
    const len = dur * div;
    // "Hold" ties the next step to the note before it: the same note just carries on; a different one changes
    // pitch without a new attack (a slide).
    if (holding && ev.length) {
      const last = ev.findLast(e => e.type === "note");
      if (last && last.t + last.step === t && note === last.raw) {
        // a tied piece written as a bare duration (it carries on, where writing the note again restarts modulation)
        if (b < 0x80) (last.bareSeg ||= []).push(last.seg.length);
        last.step += len; last.seg.push(dur); holding = false; t += len; prevNote = lastNote = note; continue;
      }
    }
    const held = holding;
    holding = false;
    if (note !== 0x80) ev.push({ t, type: "note", raw: note, step: len, seg: [dur], bare: b < 0x80 || undefined, hold: held || undefined });
    else ev.push({ t, type: "rest", step: len, seg: [dur], bare: b < 0x80 || undefined, hold: held || undefined }); // a held rest lets the note ring on
    prevNote = note;
    if (note !== 0x80) lastNote = note;
    t += len;
  }
  if (end === null) throw new Error("track runs on");
  return { ev, loop: loopAt, end };
}

// Decodes a whole song: per track, the timeline, loop and end.
export function decodeSong(rom, at, flags) {
  const h = readHeader(rom, at);
  const touched = new Set();
  const channels = h.tracks.map(tr => {
    const d = readTrack(rom, tr.start, flags, h.div, touched);
    return { kind: tr.kind, transpose: tr.transpose, volume: tr.volume, mod: tr.mod, env: tr.env, events: d.ev, loop: d.loop, end: d.end };
  });
  for (let i = h.at; i < h.headerEnd; i++) touched.add(i);
  // instruments used: $EF n (FM voice) on FM tracks
  let voices = 0;
  for (const c of channels) for (const e of c.events) if (e.type === "cmd" && e.op === 0xef) voices = Math.max(voices, e.args[0] + 1);
  return { div: h.div, tempo: h.tempo, voicesAt: h.voices, voiceCount: voices, channels, touched };
}

// Compiles a track's timeline back into bytes. Returns { bytes, fixups: [{ at, to }] } where `to` is a byte
// position in the same track that a relative pointer at `at` must reach.
export function compileTrack(ch, div0, flags) {
  const out = [], marks = new Map(); // tick -> byte position (first step starting there)
  let dur = -1, div = div0, prev = null, lastNote = null;
  const at = t => { if (!marks.has(t)) marks.set(t, out.length); };
  const steps = (len, d) => {
    const units = Math.round(len / d);
    const res = [];
    let left = units;
    while (left > 0x7f) { res.push(0x7f); left -= 0x7f; }
    if (left > 0) res.push(left);
    return res.length ? res : [1];
  };
  const done = new Set(); // commands already written between the tied pieces of a held note
  const cmd = e => {
    if (!e.pre) at(e.t);
    out.push(e.op, ...e.args);
    if (e.op === flags.tempoDiv) div = e.args[0] || 1;
  };
  ch.events.forEach((e, k) => {
    if (done.has(e)) return;
    if (e.type === "cmd") { cmd(e); return; }
    if (!e.pre) at(e.t);
    const raw = e.type === "rest" ? 0x80 : e.raw;
    // keep the stored segment split if it still adds up, else split into durations of at most $7F
    const kept = e.seg && e.seg.reduce((a, b) => a + b, 0) * div === e.step;
    const segs = kept ? e.seg : steps(e.step, div);
    // Commands that fall inside the note go between its tied pieces, where they were.
    const inside = [];
    for (let j = k + 1; j < ch.events.length && ch.events[j].t < e.t + e.step; j++) if (ch.events[j].type === "cmd" && ch.events[j].t > e.t) inside.push(ch.events[j]);
    let from = e.t;
    // Every note gets its duration written, so a following duration-only replay can't be misread as it.
    segs.forEach((d, i) => {
      if (i > 0) {
        // the loop can go back to the middle of a held note: after the commands that only run the first time
        const here = inside.filter(c => c.t === from && !done.has(c));
        for (const c of here) if (c.pre) { cmd(c); done.add(c); }
        if (from === ch.loop) at(from);
        for (const c of here) if (!c.pre) { cmd(c); done.add(c); }
      }
      from += d * div;
      if (i > 0 || e.hold) out.push(flags.hold);
      if (i > 0 && kept && e.bareSeg?.includes(i)) { out.push(d); dur = d; return; }
      if (i === 0 && e.bare && (flags.bareReplaysNote ? lastNote : prev) === raw) { out.push(d); dur = d; return; }
      out.push(raw, d);
      dur = d;
    });
    prev = raw;
    if (raw !== 0x80) lastNote = raw;
  });
  const fixups = [];
  const lastEnds = ch.events.length && ch.events[ch.events.length - 1].type === "cmd" && flags.ends?.includes(ch.events[ch.events.length - 1].op);
  if (!lastEnds) {
    if (ch.loop !== null && ch.loop !== undefined) {
      out.push(flags.jump, 0, 0);
      fixups.push({ at: out.length - 2, to: marks.get(ch.loop) ?? 0 });
    } else out.push(flags.stop);
  }
  return { bytes: out, fixups };
}

// Compiles a song (decoded as above) into one block of bytes placed at `base`: header, tracks, then the voices
// it uses (copied, so the song doesn't depend on where it sits). Returns the bytes.
export function compileSong(song, rom, flags, base) {
  const tracks = song.channels.map(ch => compileTrack(ch, song.div, flags));
  const nfm = song.channels.filter(c => c.kind !== "psg").length, npsg = song.channels.length - nfm;
  let hdrLen = 6 + nfm * 4 + npsg * 6;
  const out = new Array(hdrLen).fill(0);
  const put16 = (o, v) => { out[o] = (v >> 8) & 0xff; out[o + 1] = v & 0xff; };
  out[2] = nfm; out[3] = npsg; out[4] = song.div; out[5] = song.tempo;
  let p = 6;
  song.channels.forEach((ch, i) => {
    const t = tracks[i];
    const start = out.length;
    // fix relative pointers: target - (pointer position + 1), as the driver reads it
    for (const f of t.fixups) {
      const ptrAt = start + f.at, to = start + f.to;
      const rel = to - (ptrAt + 1);
      t.bytes[f.at] = (rel >> 8) & 0xff; t.bytes[f.at + 1] = rel & 0xff;
    }
    out.push(...t.bytes);
    put16(p, start);
    out[p + 2] = ch.transpose & 0xff; out[p + 3] = ch.volume;
    if (ch.kind === "psg") { out[p + 4] = ch.mod ?? 0; out[p + 5] = ch.env ?? 0; p += 6; } else p += 4;
  });
  if (out.length & 1) out.push(0);
  put16(0, out.length);
  for (let i = 0; i < song.voiceCount * 25; i++) out.push(rom[song.voicesAt + i]);
  void base;
  return Uint8Array.from(out);
}
