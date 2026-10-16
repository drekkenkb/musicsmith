// The sound engines MusicSmith knows. Every game stores music its own way, so each engine is a module that knows
// one family of games: how to find its music in a ROM, turn it into songs, write songs back, and play them.
//
// An engine is an object with:
//   id, name, system, ext           what it is; ext is the ROM file extension to save with
//   detect(rom) → L | null          finds the engine in a ROM; L (plain data) is passed back to everything below
//   readSongs(rom, L) → songs       [{ id, name, sfx, channels: [{ events, loop, end } | null] }]; events have t
//                                   (ticks); notes also have dur
//   ppq                             ticks per beat, for the ruler and grid
//   keyRange: [lo, hi]              MIDI notes the roll shows
//   lanes(song)                     the roll's lanes: { ci, type, name, color, events, lo, hi, key(ev), setKey(ev, k),
//                                   make(t, key, dur), label?(key) }; type is the event type of its notes
//   events                          { type: { name, mark, alert? } } for the event strip
//   hidden(song), number(song)      songs not to list; a song's number in file names
//   describe(song)                  the song bar's subtitle
//   player(rom, L, song, rate)      { render(left, right), clock(), active(), seek(tick) }: plays an edited song
//   recordLength(song)              ticks to record for a WAV (the loop is played once more)
//   build(rom, L, songs, edited)    → { rom, used, room }: the ROM with the songs written in (runs in the worker)
//   spaceText(used, room)
//   toMidi(song), fromMidi(midi, song) → { song, warnings }, slotOf(midi) → { sfx, index } | null, readme, midiHelp
//   noteControls(ctx, note), eventControls(ctx, ev), addable(ctx), newEvent(ctx, type, t), laneHint
import dw from "./engine-dw.js";
import nspc from "./engine-nspc.js";

export const ENGINES = [dw, nspc];

// What the event strip and inspector call an event: the engine's own description, or a plain one.
for (const e of ENGINES) {
  e.eventInfo ||= ev => e.events[ev.type] || { name: ev.type, mark: "?" };
}

export function detect(rom) {
  for (const engine of ENGINES) {
    const L = engine.detect(rom);
    if (L) return { engine, L };
  }
  return null;
}

export const engineById = id => ENGINES.find(e => e.id === id);
