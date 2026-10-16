// Dragon Warrior (NES), as a MusicSmith engine: wraps dw.js (the format), apu.js (the game's engine and the APU) and
// midi.js (its MIDI mapping). See engines.js for what an engine provides.
import { locate, readSongs, buildRom, previewMem, songLength, NOTE_BASE, NOTE_TOP } from "./dw.js";
import { Player, FRAME_HZ } from "./apu.js";
import { songToMidi, midiToSong, slotOf, usPerQuarter } from "./midi.js";
import { el, field, check, select, range, num, hex, sep, hint } from "./ui.js";

const COLORS = ["#ffd43b", "#4dabf7", "#ff6b6b", "#8ce99a"];
const MIDI_LO = 36, MIDI_HI = MIDI_LO + NOTE_TOP - NOTE_BASE;
const DUTIES = ["12.5%", "25%", "50%", "75%"];

const noteLane = (ci, name, color, events) => ({
  ci, type: "note", name, color, events, lo: MIDI_LO, hi: MIDI_HI,
  key: ev => ev.key - NOTE_BASE + MIDI_LO,
  setKey: (ev, k) => { ev.key = k - MIDI_LO + NOTE_BASE; },
  make: (t, k, dur) => ({ t, type: "note", key: k - MIDI_LO + NOTE_BASE, dur }),
});

export default {
  id: "dw",
  name: "Dragon Warrior",
  system: "NES",
  examples: "Dragon Warrior (Dragon Quest)",
  ext: "nes",
  ppq: 24,
  keyRange: [MIDI_LO, MIDI_HI],
  events: {
    ctrl0: { name: "Instrument", mark: "I" }, ctrl1: { name: "Sweep", mark: "S" }, tempo: { name: "Tempo", mark: "T" },
    offset: { name: "Note offset", mark: "O" }, sync: { name: "Cue", mark: "C", alert: true }, noisevol: { name: "Noise volume", mark: "V" },
  },

  detect(rom) {
    try { return locate(rom); } catch { return null; }
  },
  readSongs,
  // "No sound" is the engine's silence: there's nothing to edit.
  hidden: s => !s.sfx && s.id === 0,
  number: s => s.id & 0x7f,

  lanes(song) {
    if (song.sfx) {
      return [
        noteLane(0, "Square 2", COLORS[1], ["ctrl0", "ctrl1", "tempo", "offset", "sync"]),
        {
          ci: 0, type: "noise", name: "Noise", color: COLORS[3], events: ["noisevol"], lo: MIDI_LO, hi: MIDI_LO + 15,
          key: ev => MIDI_LO + ev.v - 0xe0, setKey: (ev, k) => { ev.v = 0xe0 + k - MIDI_LO; },
          make: (t, k, dur) => ({ t, type: "noise", v: 0xe0 + k - MIDI_LO, dur }),
          label: k => `N${k - MIDI_LO}`,
        },
      ];
    }
    return ["Square 1", "Square 2", "Triangle"].map((name, ci) => noteLane(ci, name, COLORS[ci], ["ctrl0", "ctrl1", "tempo", "offset", "sync"]));
  },

  describe(song, frames) {
    const len = songLength(song), loops = song.channels.some(c => c && c.loop !== null);
    return song.sfx ? `Sound effect ${song.id & 0x7f} · ${(len / FRAME_HZ).toFixed(2)} s` : `Song ${song.id} · ${(len / 96).toFixed(1)} bars${loops ? ", loops" : ""}`;
  },

  // ---- playing

  player(rom, L, song, rate) {
    const pv = previewMem(rom, L, song);
    const p = new Player(pv.mem, L.notesTbl, rate);
    if (song.sfx) p.sfx(pv.ptrs[0]); else p.music(pv.ptrs, pv.silent);
    const clock = () => (song.sfx ? p.frames : p.ticks);
    return {
      clock,
      render(l, r) { p.render(l); r?.set(l); },
      active: () => (song.sfx ? p.sfxActive() : p.musicActive()),
      seek(t) { for (let f = 0; clock() < t && f < 200000; f++) p.frame(); },
      ticksDone: () => p.ticks,
    };
  },
  recordLength: songLength,

  build: (rom, L, songs) => buildRom(rom, L, songs),
  spaceText: (used, room) => `${used} of ${room} bytes used: room for about ${room - used} more bytes of music (a note is 1-2).`,

  // ---- MIDI files

  toMidi: songToMidi,
  fromMidi: midiToSong,
  slotOf,
  readme: `MusicSmith: Dragon Warrior music as MIDI files

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
`,
  midiHelp: [
    "One track per channel: Square 1, Square 2 and Triangle (sound effects: Square 2 and Noise). One note at a time per track. Notes run from C2 to C8. Times line up with 24 ticks per quarter note.",
    "Game settings are controller events on each track: CC20/21 instrument (duty, volume or fade), CC22/23 pitch sweep, CC24/25 note offset, CC111/110 loop start and end, CC113 a cue the game waits for. Keep them and the song stays faithful; a track with none gets its volume from note velocities.",
  ],

  // ---- the inspector

  noteControls(ctx, n) {
    const { lane, song } = ctx, isNoise = n.type === "noise";
    const kind = song.sfx ? (isNoise ? "noise" : "sfx") : lane.ci === 2 ? "tri" : "sq";
    const out = [];
    if (isNoise) out.push(field("Sound (0 highest)", num(0, 15, n.v - 0xe0, x => ctx.edit(() => { n.v = 0xe0 + x; }))));
    out.push(sep());
    const ctype = isNoise ? "noisevol" : "ctrl0";
    out.push(el("h3", {}, "Instrument", el("small", { textContent: "from this note until the next change" })));
    out.push(...instrumentControls(isNoise ? "noise" : kind, ctx.valueAt(ctype, n.t) ?? (kind === "tri" ? 0xff : 0xbf), v => ctx.setAt(ctype, n.t, v)));
    if (!isNoise && kind !== "tri") {
      out.push(sep());
      out.push(...sweepControls(ctx.valueAt("ctrl1", n.t) ?? 0x08, v => ctx.setAt("ctrl1", n.t, v)));
    }
    return out;
  },

  eventControls(ctx, e) {
    const { lane, song } = ctx;
    const kind = song.sfx ? (lane.type === "noise" ? "noise" : "sfx") : lane.ci === 2 ? "tri" : "sq";
    const set = v => ctx.edit(() => { e.v = v; });
    if (e.type === "ctrl0") return instrumentControls(kind === "noise" ? "sfx" : kind, e.v, set);
    if (e.type === "noisevol") return instrumentControls("noise", e.v, set);
    if (e.type === "ctrl1") return sweepControls(e.v, set);
    if (e.type === "tempo") return tempoControls(e.v, set);
    if (e.type === "offset") {
      return [field("Semitones", num(-128, 127, e.v > 127 ? e.v - 256 : e.v, x => set(x & 0xff))),
        hint("Shifts the notes of every channel from here on. The dungeon floors share one tune this way. Notes here show the pitch you hear, so changing this moves where the notes land.")];
    }
    if (e.type === "sync") {
      return [field("Until tick", num(e.t + 1, 99999, e.until, x => ctx.edit(() => { e.until = x; }))),
        hint("The game waits for the music to get here (the intro waits for one before showing the story; jingles end on one). Keep it, or the game may wait forever.")];
    }
    return [];
  },

  addable(ctx) {
    const { lane, song } = ctx;
    if (lane.type === "noise") return ["noisevol"];
    if (song.sfx) return ["ctrl0", "ctrl1"];
    return lane.ci === 2 ? ["ctrl0", "tempo", "offset", "sync"] : ["ctrl0", "ctrl1", "tempo", "offset", "sync"];
  },
  newEvent(ctx, type, t) {
    if (type === "sync") return { t, type, until: t + 24 };
    const tri = !ctx.song.sfx && ctx.lane.ci === 2;
    return { t, type, v: type === "tempo" ? 120 : type === "offset" ? 0 : type === "ctrl1" ? 0x08 : type === "noisevol" ? 0x3f : tri ? 0xff : 0xbf };
  },
  laneHint: "Tap the roll to add a note, drag a note to move it, drag its right end to change its length. Drag empty space to scroll; tap the ruler to choose where Play starts. Events (instruments, tempo, cues) are in the strip at the bottom.",
};

// Instrument controls for a byte: squares (DDLCVVVV), the triangle (CRRRRRRR) or noise (--LCVVVV).
function instrumentControls(kind, v, set) {
  const kids = [];
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
  kids.push(field("Byte", el("small", { textContent: hex(v) })));
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

function tempoControls(v, set) {
  const bpm = x => (60e6 / usPerQuarter(x)).toFixed(1);
  const lab = el("small", { textContent: `≈ ${bpm(v)} BPM` });
  return [field(el("span", {}, "Speed ", lab), range(1, 255, v, x => { lab.textContent = `≈ ${bpm(x)} BPM`; }, set)), field("Value", num(1, 255, v, set))];
}
