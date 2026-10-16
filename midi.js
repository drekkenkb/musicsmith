// Standard MIDI files, and how a Dragon Warrior song maps onto one.
//
// One MIDI tick is one engine tick, at 24 per quarter note. Each channel is a track (a sound effect has a Square 2
// and a Noise track). Notes are the pitches you hear. Engine settings that have no MIDI equivalent are controller
// events on the channel's track, so editors keep them where they belong:
//   CC20/CC21  instrument byte ($4000 etc.), high and low nibble: duty and flags / volume or decay rate
//   CC22/CC23  sweep byte ($4001/$4005), high and low nibble
//   CC24/CC25  note offset (low 7 bits / top bit), applied by the engine to every channel
//   CC15       a tempo change comes from this channel (the tempo itself is a normal MIDI tempo event)
//   CC113      cue: the game waits for the music to reach this point: 127 where it starts, 0 where it ends
//   CC114      cue right after the end
//   CC111      loop start, CC110 end (of the loop, or of the song)
// A track with no CC20/CC21 at all (a song made from scratch) gets its volume from note velocities.

import { CHANNEL_NAMES, NOTE_BASE, channelKind } from "./dw.js";
import { ticksPerFrame, FRAME_HZ } from "./apu.js";

export const PPQ = 24;
const CC = { ctrlHi: 20, ctrlLo: 21, sweepHi: 22, sweepLo: 23, offLo: 24, offHi: 25, tempoHere: 15, cue: 113, cueAfter: 114, loop: 111, end: 110 };
const MIDI_BASE = 36; // the note table's first entry, C2

export const usPerQuarter = tempo => Math.round(PPQ * 1e6 / (ticksPerFrame(tempo) * FRAME_HZ));
export const SFX_US = Math.round(PPQ * 1e6 / FRAME_HZ);
// The engine's fastest is one tick a frame, at 150: above that the counter misbehaves and runs slower again.
export function tempoFromUs(us) {
  let best = 1;
  for (let t = 1; t <= 150; t++) if (Math.abs(usPerQuarter(t) - us) < Math.abs(usPerQuarter(best) - us)) best = t;
  return best;
}

// ---------------------------------------------------------------- the file format

const vlq = (n, out) => {
  const b = [n & 0x7f];
  while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80);
  out.push(...b);
};

// tracks: [[{ t, data: [status, ...] } | { t, meta: type, data: [...] }]]; events at the same tick keep their order.
export function writeMidi({ ppq = PPQ, tracks }) {
  const out = [...str("MThd"), 0, 0, 0, 6, 0, 1, tracks.length >> 8, tracks.length & 0xff, ppq >> 8, ppq & 0xff];
  for (const tr of tracks) {
    const body = [];
    let last = 0;
    const evs = tr.map((e, i) => ({ ...e, i })).sort((a, b) => a.t - b.t || a.i - b.i);
    for (const e of evs) {
      vlq(e.t - last, body);
      last = e.t;
      if (e.meta !== undefined) { body.push(0xff, e.meta); vlq(e.data.length, body); body.push(...e.data); }
      else body.push(...e.data);
    }
    body.push(0, 0xff, 0x2f, 0);
    out.push(...str("MTrk"), body.length >>> 24, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff, ...body);
  }
  return new Uint8Array(out);
}
const str = s => [...s].map(c => c.charCodeAt(0));

// Returns { ppq, texts, tracks: [{ name, events: [{ t, kind: on|off|cc|tempo|program, ch, key, vel, cc, val, us }] }] }.
export function readMidi(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = o => String.fromCharCode(...bytes.subarray(o, o + 4));
  let p = 0;
  // RIFF-wrapped MIDI (.rmi)
  if (tag(0) === "RIFF") { p = 12; while (p < bytes.length && tag(p) !== "data") p += 8 + dv.getUint32(p + 4, true); p += 8; }
  if (tag(p) !== "MThd") throw new Error("That isn't a MIDI file.");
  const hlen = dv.getUint32(p + 4), ntracks = dv.getUint16(p + 10), div = dv.getUint16(p + 12);
  if (div & 0x8000) throw new Error("This MIDI file counts time in SMPTE frames, which isn't supported. Save it with ticks per quarter note.");
  p += 8 + hlen;
  const tracks = [], texts = [];
  for (let n = 0; n < ntracks && p + 8 <= bytes.length; n++) {
    const len = dv.getUint32(p + 4), endp = Math.min(bytes.length, p + 8 + len);
    const isTrack = tag(p) === "MTrk";
    p += 8;
    const tr = { name: "", events: [] };
    let t = 0, status = 0;
    const rd = () => {
      let v = 0, b;
      do { b = bytes[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && p < endp);
      return v;
    };
    while (isTrack && p < endp) {
      t += rd();
      let s = bytes[p];
      if (s & 0x80) p++; else s = status;
      if (s === 0xff) {
        const type = bytes[p++], l = rd(), d = bytes.subarray(p, p + l);
        p += l;
        if (type === 0x03 && !tr.name) tr.name = new TextDecoder().decode(d);
        else if (type === 0x01) texts.push(new TextDecoder().decode(d));
        else if (type === 0x51 && l === 3) tr.events.push({ t, kind: "tempo", us: d[0] << 16 | d[1] << 8 | d[2] });
        else if (type === 0x2f) break;
        continue;
      }
      if (s === 0xf0 || s === 0xf7) { p += rd(); continue; }
      if (s < 0x80) throw new Error("This MIDI file is damaged.");
      status = s;
      const ch = s & 0x0f, hi = s & 0xf0, a = bytes[p++], b = hi === 0xc0 || hi === 0xd0 ? 0 : bytes[p++];
      if (hi === 0x90 && b > 0) tr.events.push({ t, kind: "on", ch, key: a, vel: b });
      else if (hi === 0x80 || hi === 0x90) tr.events.push({ t, kind: "off", ch, key: a });
      else if (hi === 0xb0) tr.events.push({ t, kind: "cc", ch, cc: a, val: b });
      else if (hi === 0xc0) tr.events.push({ t, kind: "program", ch, val: a });
    }
    p = endp;
    if (isTrack) tracks.push(tr);
  }
  return { ppq: div, tracks, texts };
}

// ---------------------------------------------------------------- songs to MIDI

const volumeOf = v => ((v & 0x10) ? v & 0x0f : 15);
const velocity = vol => Math.max(1, Math.round(vol / 15 * 127));

export function songToMidi(song) {
  const conductor = [
    { t: 0, meta: 0x03, data: [...new TextEncoder().encode(song.name)] },
    { t: 0, meta: 0x01, data: str(`MusicSmith: Dragon Warrior ${song.sfx ? "sound effect" : "song"} ${song.id & 0x7f}`) },
    { t: 0, meta: 0x58, data: [4, 2, PPQ, 8] },
  ];
  if (song.sfx) conductor.push({ t: 0, meta: 0x51, data: us3(SFX_US) });
  const tracks = [conductor];
  const name = n => ({ t: 0, meta: 0x03, data: str(n) });
  const cc = (t, ch, c, v) => ({ t, data: [0xb0 | ch, c, v] });

  song.channels.forEach((chan, ci) => {
    const kind = channelKind(song, ci);
    const lanes = song.sfx ? [["Square 2", 1, "note"], ["Noise", 9, "noise"]] : [[CHANNEL_NAMES[ci], ci, "note"]];
    for (const [trackName, mch, lane] of lanes) {
      const tr = [name(trackName)];
      tracks.push(tr);
      if (mch !== 9) tr.push({ t: 0, data: [0xc0 | mch, kind === "tri" ? 79 : 80] });
      if (!chan) continue;
      const structure = lane === "note"; // cues, loop and end live on the first track
      let ctrl = lane === "noise" ? 0x30 : 0xbf;
      const offs = [], cues = [];
      for (const e of chan.events) {
        const t = e.t;
        if (structure && chan.loop === t && !e.pre && !tr.loopDone) { tr.push(cc(t, mch, CC.loop, 0)); tr.loopDone = true; }
        if (lane === "note") {
          if (e.type === "ctrl0") { tr.push(cc(t, mch, CC.ctrlHi, e.v >> 4), cc(t, mch, CC.ctrlLo, e.v & 15)); ctrl = e.v; }
          else if (e.type === "ctrl1") tr.push(cc(t, mch, CC.sweepHi, e.v >> 4), cc(t, mch, CC.sweepLo, e.v & 15));
          else if (e.type === "offset") tr.push(cc(t, mch, CC.offHi, e.v >> 7), cc(t, mch, CC.offLo, e.v & 0x7f));
          else if (e.type === "tempo") {
            tr.push(cc(t, mch, CC.tempoHere, 0));
            if (!song.sfx) conductor.push({ t, meta: 0x51, data: us3(usPerQuarter(e.v)) });
          } else if (e.type === "sync") cues.push(cc(t, mch, CC.cue, 127), cc(e.until, mch, CC.cue, 0));
          else if (e.type === "note") {
            const k = Math.min(127, e.key - NOTE_BASE + MIDI_BASE);
            offs.push({ t: t + e.dur, data: [0x80 | mch, k, 0] });
            tr.push({ t, data: [0x90 | mch, k, kind === "tri" ? 100 : velocity(volumeOf(ctrl))] });
          }
        } else {
          if (e.type === "noisevol") { tr.push(cc(t, mch, CC.ctrlHi, e.v >> 4), cc(t, mch, CC.ctrlLo, e.v & 15)); ctrl = e.v; }
          else if (e.type === "noise") {
            const k = MIDI_BASE + (e.v - 0xe0);
            offs.push({ t: t + e.dur, data: [0x80 | mch, k, 0] });
            tr.push({ t, data: [0x90 | mch, k, velocity(volumeOf(ctrl))] });
          }
        }
      }
      if (structure) {
        if (chan.loop !== null && !tr.loopDone) tr.push(cc(chan.loop, mch, CC.loop, 0));
        if (chan.endSync) tr.push(cc(chan.end, mch, CC.cueAfter, 0));
        tr.push(cc(chan.end, mch, CC.end, 0));
      }
      // Note-offs go first at their tick, so a note ending where the next begins doesn't cut the new one.
      tr.splice(1, 0, ...offs.map(o => ({ ...o, off: true })), ...cues);
      tr.sort((a, b) => a.t - b.t || (b.off ? 1 : 0) - (a.off ? 1 : 0));
    }
  });
  return { ppq: PPQ, tracks };
}
const us3 = us => [us >> 16 & 0xff, us >> 8 & 0xff, us & 0xff];

// ---------------------------------------------------------------- MIDI to songs

// Builds a song for the slot `slot` (which says whether it's music or a sound effect, and what it's called) from a
// parsed MIDI file. Returns { song, warnings }.
export function midiToSong(midi, slot) {
  const warnings = [];
  const scale = PPQ / midi.ppq;
  let rounded = false;
  const tk = t => { const v = t * scale; if (Math.abs(v - Math.round(v)) > 1e-6) rounded = true; return Math.round(v); };
  const tracks = midi.tracks.map((tr, i) => ({
    ...tr, i,
    events: tr.events.map((e, j) => ({ ...e, t: tk(e.t), j })),
    hasNotes: tr.events.some(e => e.kind === "on"),
    ch: tr.events.find(e => e.ch !== undefined)?.ch,
  }));
  if (rounded) warnings.push("Some notes didn't line up with the engine's timing (24 ticks per quarter note) and were moved slightly.");
  const used = tracks.filter(t => t.hasNotes || t.events.some(e => e.kind === "cc" && Object.values(CC).includes(e.cc)));

  // Which track feeds which lane.
  const pick = (re, ch) => used.find(t => !t.taken && re.test(t.name)) || used.find(t => !t.taken && t.ch === ch && !/noise|drum|perc/i.test(t.name));
  const lanes = slot.sfx ? ["sq2", "noise"] : ["sq1", "sq2", "tri"];
  const want = {
    sq1: [/square\s*1|pulse\s*1|\bsq\s*1|\bp1\b/i, 0], sq2: [/square\s*2|pulse\s*2|\bsq\s*2|\bp2\b/i, 1],
    tri: [/tri/i, 2], noise: [/noise|drum|perc/i, 9],
  };
  const chosen = {};
  for (const l of lanes) { const t = pick(...want[l]); if (t) { t.taken = true; chosen[l] = t; } }
  for (const l of lanes) {
    if (chosen[l]) continue;
    const t = used.find(x => !x.taken && x.hasNotes && (l === "noise") === (x.ch === 9));
    if (t) { t.taken = true; chosen[l] = t; }
  }
  const left = used.filter(t => !t.taken && t.hasNotes);
  if (left.length) warnings.push(`${left.length} track${left.length > 1 ? "s" : ""} had nowhere to go (${left.map(t => t.name || `track ${t.i + 1}`).join(", ")}): ${slot.sfx ? "a sound effect has Square 2 and Noise" : "Dragon Warrior's music uses Square 1, Square 2 and Triangle"}.`);

  const tempos = tracks.flatMap(t => t.events.filter(e => e.kind === "tempo"));
  const markers = new Set(tracks.flatMap(t => t.events.filter(e => e.kind === "cc" && e.cc === CC.tempoHere).map(e => e.t)));
  const structureCCs = tracks.flatMap(t => t.events.filter(e => e.kind === "cc" && [CC.cue, CC.cueAfter, CC.loop, CC.end].includes(e.cc)));
  let clamped = 0;

  const laneEvents = (tr, lane, kind) => {
    const evs = [];
    if (!tr) return evs;
    const ccs = tr.events.filter(e => e.kind === "cc");
    const fromVelocity = !ccs.some(e => e.cc === CC.ctrlHi || e.cc === CC.ctrlLo);
    const ctrlType = lane === "noise" ? "noisevol" : "ctrl0";
    let ctrl = lane === "noise" ? 0x30 : 0xb0, sweep = 0x08, off = 0;
    // Controller pairs become one engine command per tick.
    const byTick = new Map();
    for (const e of ccs) { if (!byTick.has(e.t)) byTick.set(e.t, []); byTick.get(e.t).push(e); }
    for (const [t, list] of [...byTick].sort((a, b) => a[0] - b[0])) {
      const has = c => list.some(e => e.cc === c);
      const val = c => list.filter(e => e.cc === c).at(-1).val & 15;
      const order = list[0].j;
      if (has(CC.ctrlHi) || has(CC.ctrlLo)) {
        ctrl = (has(CC.ctrlHi) ? val(CC.ctrlHi) << 4 : ctrl & 0xf0) | (has(CC.ctrlLo) ? val(CC.ctrlLo) : ctrl & 15);
        evs.push({ t, type: ctrlType, v: ctrl, j: list.find(e => e.cc === CC.ctrlHi || e.cc === CC.ctrlLo).j });
      }
      if (lane !== "noise" && (has(CC.sweepHi) || has(CC.sweepLo))) {
        sweep = (has(CC.sweepHi) ? val(CC.sweepHi) << 4 : sweep & 0xf0) | (has(CC.sweepLo) ? val(CC.sweepLo) : sweep & 15);
        evs.push({ t, type: "ctrl1", v: sweep, j: list.find(e => e.cc === CC.sweepHi || e.cc === CC.sweepLo).j });
      }
      if (lane !== "noise" && !slot.sfx && (has(CC.offLo) || has(CC.offHi))) {
        const lo = has(CC.offLo) ? list.filter(e => e.cc === CC.offLo).at(-1).val : off & 0x7f;
        const hi = has(CC.offHi) ? list.filter(e => e.cc === CC.offHi).at(-1).val & 1 : off >> 7;
        off = hi << 7 | lo;
        evs.push({ t, type: "offset", v: off, j: list.find(e => e.cc === CC.offLo || e.cc === CC.offHi).j });
      }
      void order;
    }
    // Notes: pair each note-on with its note-off, keep one note at a time.
    const open = new Map(), notes = [];
    for (const e of tr.events) {
      if (e.kind === "on") {
        const n = { t: e.t, key: e.key, vel: e.vel, dur: null, j: e.j };
        notes.push(n);
        if (!open.has(e.key)) open.set(e.key, []);
        open.get(e.key).push(n);
      } else if (e.kind === "off") {
        const n = open.get(e.key)?.shift();
        if (n) n.dur = e.t - n.t;
      }
    }
    notes.sort((a, b) => a.t - b.t || b.key - a.key);
    const mono = notes.filter((n, i) => i === 0 || notes[i - 1].t !== n.t);
    if (mono.length < notes.length) warnings.push(`${tr.name || "A track"} has chords; the NES plays one note per channel, so only the top note of each was kept.`);
    let lastVol = null;
    mono.forEach((n, i) => {
      const next = mono[i + 1]?.t;
      let dur = n.dur ?? ((next ?? n.t + PPQ) - n.t);
      if (next !== undefined) dur = Math.min(dur, next - n.t);
      dur = Math.max(1, dur);
      if (lane === "noise") {
        let v = n.key - MIDI_BASE;
        if (v < 0 || v > 15) { v = ((n.key % 16) + 16) % 16; clamped++; }
        if (fromVelocity) {
          const vol = Math.max(1, Math.round(n.vel / 127 * 15));
          if (vol !== lastVol) { evs.push({ t: n.t, type: "noisevol", v: 0x30 | vol, j: n.j - 0.5 }); lastVol = vol; }
        }
        evs.push({ t: n.t, type: "noise", v: 0xe0 + v, dur, j: n.j });
      } else {
        let k = n.key;
        while (k < MIDI_BASE) { k += 12; clamped++; }
        while (k > MIDI_BASE + 0x48) { k -= 12; clamped++; }
        if (fromVelocity) {
          if (kind === "tri") { if (lastVol === null) { evs.push({ t: n.t, type: "ctrl0", v: 0xff, j: n.j - 0.5 }); lastVol = 0; } }
          else {
            const vol = Math.max(1, Math.round(n.vel / 127 * 15));
            if (vol !== lastVol) { evs.push({ t: n.t, type: "ctrl0", v: 0xb0 | vol, j: n.j - 0.5 }); lastVol = vol; }
          }
        }
        evs.push({ t: n.t, type: "note", key: k - MIDI_BASE + NOTE_BASE, dur, j: n.j });
      }
    });
    for (const e of ccs) if (e.cc === CC.tempoHere) evs.push({ t: e.t, type: "tempoHere", j: e.j });
    return evs;
  };

  // A file without loop and end markers (made from scratch) ends all its channels together, and loops from the
  // start if the song it replaces looped.
  const marked = structureCCs.some(e => e.cc === CC.end);
  const slotLoops = !slot.sfx && slot.channels.some(c => c && c.loop !== null);
  const channels = [];
  const build = (laneList, kinds) => {
    const evs = laneList.flatMap((l, n) => laneEvents(chosen[l], l, kinds[n]).map(e => ({ ...e, lane: n })));
    const structTrack = chosen[laneList[0]] || chosen[laneList[1]];
    const struct = (slot.sfx ? structureCCs : (structTrack?.events || []).filter(e => e.kind === "cc" && [CC.cue, CC.cueAfter, CC.loop, CC.end].includes(e.cc)));
    if (!evs.length && !struct.length) return null;
    const endCC = struct.filter(e => e.cc === CC.end).map(e => e.t);
    const loopCC = struct.find(e => e.cc === CC.loop);
    let end = endCC.length ? Math.max(...endCC) : Math.max(1, ...evs.map(e => e.t + (e.dur || 0)));
    end = Math.max(end, ...evs.filter(e => e.type === "note" || e.type === "noise").map(e => e.t + 1));
    let loop = slot.sfx ? null : loopCC ? loopCC.t : !marked && slotLoops ? 0 : null;
    if (loop !== null && loop >= end) loop = null;
    const endSync = struct.some(e => e.cc === CC.cueAfter);
    const cues = struct.filter(e => e.cc === CC.cue).sort((a, b) => a.t - b.t || a.j - b.j);
    cues.forEach((e, i) => {
      if (e.val < 64) return;
      const off = cues.slice(i + 1).find(o => o.val < 64);
      evs.push({ t: e.t, type: "sync", until: off ? off.t : end, j: e.j, lane: 0 });
    });
    // Commands at the loop tick written before the loop marker happen only the first time through.
    if (loopCC) for (const e of evs) if (e.t === loop && e.lane === 0 && e.j < loopCC.j && e.type !== "note") e.pre = true;
    evs.sort((a, b) => a.t - b.t || a.lane - b.lane || a.j - b.j);
    return { events: evs, loop, end, endSync };
  };
  if (slot.sfx) channels.push(build(["sq2", "noise"], ["sfx", "noise"]) || { events: [], loop: null, end: 1, endSync: false });
  else for (const [n, l] of lanes.entries()) channels.push(build([l], [n === 2 ? "tri" : "sq"]));
  if (!marked) {
    const end = Math.max(1, ...channels.filter(Boolean).map(c => c.end));
    for (const c of channels) if (c) c.end = end;
    if (slotLoops) warnings.push("The song it replaces loops, so this one loops from the start too. Change that under the roll, or with CC111 (loop start) and CC110 (end) in the file.");
  }
  if (tempos.some(tp => tp.us < usPerQuarter(150) - 1)) warnings.push("The tempo is faster than the engine can go (150 BPM at 24 ticks a beat), so it plays at 150.");
  if (clamped) warnings.push(`${clamped} note${clamped > 1 ? "s were" : " was"} outside the NES's range and moved by octaves.`);

  // Tempo changes go on the channel marked with CC15 at that tick, or the first channel there is.
  if (!slot.sfx) {
    for (const tp of tempos) {
      if (markers.size && !markers.has(tp.t) && tp.t === 0 && tp.us === 500000) continue; // an editor's default
      let ci = channels.findIndex(ch => ch?.events.some(e => e.type === "tempoHere" && e.t === tp.t));
      if (ci < 0) ci = channels.findIndex(Boolean);
      if (ci < 0) continue;
      const ch = channels[ci];
      if (ch.events.some(e => e.type === "tempo" && e.t === tp.t)) continue;
      const at = ch.events.findIndex(e => e.type === "tempoHere" && e.t === tp.t);
      const ev = { t: tp.t, type: "tempo", v: tempoFromUs(tp.us), pre: at >= 0 ? ch.events[at].pre : undefined };
      if (at >= 0) ch.events.splice(at, 0, ev);
      else ch.events.splice(ch.events.findIndex(e => e.t >= tp.t) >>> 0, 0, ev);
    }
  }
  for (const ch of channels) {
    if (!ch) continue;
    ch.events = ch.events.filter(e => e.type !== "tempoHere" && (e.t < ch.end || (e.t === ch.end && e.type !== "note" && e.type !== "noise")))
      .map(({ j, lane, ...e }) => { if (!e.pre) delete e.pre; return e; });
  }
  return { song: { id: slot.id, name: slot.name, sfx: slot.sfx, channels }, warnings };
}

// The slot a MusicSmith file came from, from the text it carries: { sfx, index }, or null.
export function slotOf(midi) {
  for (const t of midi.texts || []) {
    const m = t.match(/MusicSmith: Dragon Warrior (song|sound effect) (\d+)/);
    if (m) return { sfx: m[1] !== "song", index: +m[2] };
  }
  return null;
}
