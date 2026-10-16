// Builds ROMs and renders recordings off the main thread: compiling everything (and finding repeated phrases to
// save space) takes about a second, longer on a phone.
import { engineById } from "./engines.js";

onmessage = ({ data: m }) => {
  try {
    const engine = engineById(m.engine);
    if (m.cmd === "build") {
      const r = engine.build(m.rom, m.L, m.songs, new Set(m.edited || []));
      postMessage({ id: m.id, ok: true, rom: m.measure ? null : r.rom, used: r.used, room: r.room });
    } else if (m.cmd === "wav") {
      postMessage({ id: m.id, ok: true, ...record(engine, m.rom, m.L, m.song, m.rate) });
    }
  } catch (e) {
    postMessage({ id: m.id, ok: false, error: e.message });
  }
};

// Plays the song once through (and its loop once more), then a moment of tail.
function record(engine, rom, L, song, rate) {
  const p = engine.player(rom, L, song, rate);
  const loops = song.channels.filter(c => c && c.loop !== null);
  const target = engine.recordLength(song) + (loops.length ? Math.max(...loops.map(c => c.end - c.loop)) : 0);
  const size = 1024, ls = [], rs = [];
  const limit = rate * 600;
  let n = 0, tail = -1;
  while (n < limit) {
    const l = new Float32Array(size), r = new Float32Array(size);
    p.render(l, r);
    ls.push(l); rs.push(r);
    n += size;
    const done = loops.length && !song.sfx ? p.clock() > target : !p.active();
    if (done && tail < 0) tail = n + Math.round(rate * (song.sfx ? 0.3 : 1));
    if (tail >= 0 && n >= tail) break;
  }
  const left = new Float32Array(n), right = new Float32Array(n);
  ls.forEach((c, i) => left.set(c, i * size));
  rs.forEach((c, i) => right.set(c, i * size));
  if (loops.length && !song.sfx) { // fade out the last second, as the song would keep going
    const f = Math.min(n, rate);
    for (let i = 0; i < f; i++) { const g = 1 - i / f; left[n - f + i] *= g; right[n - f + i] *= g; }
  }
  return { left, right };
}
