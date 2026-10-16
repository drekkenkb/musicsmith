// Builds ROMs and renders recordings off the main thread: compiling everything (and finding repeated phrases to
// save space) takes about a second, longer on a phone.
import { buildRom, previewMem, songLength } from "./dw.js";
import { Player } from "./apu.js";

onmessage = ({ data: m }) => {
  try {
    if (m.cmd === "build") {
      const r = buildRom(m.rom, m.L, m.songs);
      postMessage({ id: m.id, ok: true, rom: m.measure ? null : r.rom, used: r.used, room: r.room });
    } else if (m.cmd === "wav") {
      postMessage({ id: m.id, ok: true, samples: record(m.rom, m.L, m.song, m.rate) });
    }
  } catch (e) {
    postMessage({ id: m.id, ok: false, error: e.message });
  }
};

// Plays the song once through (and its loop once more), then a moment of tail.
function record(rom, L, song, rate) {
  const { mem, ptrs, silent } = previewMem(rom, L, song);
  const p = new Player(mem, L.notesTbl, rate);
  if (song.sfx) p.sfx(ptrs[0]); else p.music(ptrs, silent);
  const loops = song.channels.filter(c => c && c.loop !== null);
  const target = songLength(song) + (loops.length ? Math.max(...loops.map(c => c.end - c.loop)) : 0);
  const chunk = new Float32Array(1024), parts = [];
  const limit = rate * 600;
  let n = 0, tail = -1;
  while (n < limit) {
    p.render(chunk);
    parts.push(chunk.slice());
    n += chunk.length;
    const done = song.sfx ? !p.sfxActive() : loops.length ? p.ticks > target : !p.musicActive();
    if (done && tail < 0) tail = n + Math.round(rate * (song.sfx ? 0.3 : 1));
    if (tail >= 0 && n >= tail) break;
  }
  const out = new Float32Array(n);
  parts.forEach((c, i) => out.set(c, i * chunk.length));
  if (loops.length) { // fade out the last second, as the song would keep going
    const f = Math.min(n, rate);
    for (let i = 0; i < f; i++) out[n - f + i] *= 1 - i / f;
  }
  return out;
}
