// Dragon Warrior's sound engine and the NES APU, so songs play exactly as the game plays them. This is a port of
// dw-rogue's src/sound.c, which follows the disassembly of bank 1 ($8028-$8204).
//
// The engine keeps its state in zero page $E6-$FF and relies on how those bytes overlap (the noise channel's
// "length" is SFXActive, its "quiet" is Tempo), so the port keeps the same layout and indexing. X is a software
// channel (0 SQ1, 2 SQ2, 4 TRI, 6 noise/SFX) and Y a hardware register offset from $4000.

export const CPU_HZ = 1789773;
export const FRAME_HZ = CPU_HZ / 29780.5;

const ZP_INDEX = 0xe6, ZP_RETURN = 0xee, ZP_LENGTH = 0xf4, ZP_QUIET = 0xf5;
const ZP_SFX = 0xfa, ZP_TEMPO = 0xfb, ZP_TEMPO_C = 0xfc, ZP_NOTE_OF = 0xfd, ZP_SQ2_CFG = 0xff;
const CH_SQ1 = 0, CH_SQ2 = 2, CH_TRI = 4, CH_NOISE = 6;
const HW_SQ1 = 0, HW_SQ2 = 4, HW_TRI = 8, HW_DMC = 0x10;

const LENGTHS = [10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
  12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30];
const DUTY = [[0, 1, 0, 0, 0, 0, 0, 0], [0, 1, 1, 0, 0, 0, 0, 0], [0, 1, 1, 1, 1, 0, 0, 0], [1, 0, 0, 1, 1, 1, 1, 1]];
const NOISE_PERIODS = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
const TRI_SEQ = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

const envelope = () => ({ start: false, divider: 0, decay: 0 });
const pulse = second => ({
  ctrl: 0, timer: 0, length: 0, step: 0, next: 0, env: envelope(),
  sweepOn: false, sweepNeg: false, sweepReload: false, sweepPeriod: 0, sweepShift: 0, sweepDiv: 0, second,
});

// `mem` is the CPU's view of the cartridge ($8000-$FFFF; the engine's bank at $8000 and the fixed bank at $C000).
export class Player {
  constructor(mem, notesTbl, rate = 44100) {
    this.mem = mem;
    this.notes = notesTbl;
    this.rate = rate;
    this.zp = new Uint8Array(256);
    this.sq = [pulse(false), pulse(true)];
    this.tri = { ctrl: 0, timer: 0, length: 0, linear: 0, step: 0, reload: false, next: 0 };
    this.noise = { ctrl: 0, period: NOISE_PERIODS[0], length: 0, mode: false, lfsr: 1, next: 0, env: envelope() };
    this.enabled = 0;
    this.frameNext = CPU_HZ / 240;
    this.frameStep = 0;
    this.hp = 0; this.hpIn = 0; this.lp = 0;
    this.untilFrame = 0;
    this.ticks = 0; // music ticks since the song started
    this.frames = 0;
    this.onWrite = null;
    this.mute = [false, false, false, false];
    this.clear();
  }

  byte(addr) { return this.mem[addr & 0xffff]; }

  getAudio(x) {
    const zp = this.zp, p = zp[ZP_INDEX + x] | zp[ZP_INDEX + x + 1] << 8;
    const v = this.byte(p);
    zp[ZP_INDEX + x]++; // (a Uint8Array wraps the stored value, not the value of the ++ expression)
    if (zp[ZP_INDEX + x] === 0) zp[ZP_INDEX + x + 1]++;
    return v;
  }

  // ProcessAudioByte ($80D3). Returns A as the original leaves it.
  process(x, y) {
    const zp = this.zp;
    for (let guard = 0; guard < 100000; guard++) {
      let a = this.getAudio(x);
      if (a === 0xfe) { // jump, remembering where to return
        const lo = this.getAudio(x), hi = this.getAudio(x);
        zp[ZP_RETURN + x] = zp[ZP_INDEX + x];
        zp[ZP_RETURN + x + 1] = zp[ZP_INDEX + x + 1];
        zp[ZP_INDEX + x] = lo;
        zp[ZP_INDEX + x + 1] = hi;
        continue;
      }
      if (a === 0xff) { zp[ZP_TEMPO] = this.getAudio(x); continue; }
      if (a === 0xfc) continue;
      let note = false;
      if (a === 0xfd) {
        zp[ZP_INDEX + x] = zp[ZP_RETURN + x];
        zp[ZP_INDEX + x + 1] = zp[ZP_RETURN + x + 1];
        if (zp[ZP_INDEX + x + 1]) continue;
        a = 0; // falls into LoadMusicNote, as the original would
        note = true;
      } else if (a === 0xfa) { this.write(0x4001 + y, this.getAudio(x)); continue; }
      else if (a === 0xfb) {
        const v = this.getAudio(x);
        if (x === CH_SQ2) zp[ZP_SQ2_CFG] = v;
        this.write(0x4000 + y, v);
        continue;
      }
      else if (a === 0xf8) { this.write(0x400c, this.getAudio(x)); continue; }
      else if (a === 0xf9) { zp[ZP_NOTE_OF] = this.getAudio(x); continue; }
      else if (a === 0xf6) { zp[ZP_QUIET + x] = 0; continue; }
      else if (a === 0xf7) { zp[ZP_QUIET + x] = this.getAudio(x); continue; }
      else if (a >= 0xe0) {
        this.write(0x400e, a & 0x0f);
        this.write(0x400f, 0x08);
        continue;
      }
      if (note || a >= 0x80) {
        const i = ((a + zp[ZP_NOTE_OF]) << 1) & 0xff;
        this.write(0x4002 + y, this.byte(this.notes + i));
        this.write(0x4003 + y, this.byte(this.notes + i + 1));
        if (x === CH_NOISE) continue;
        a = zp[ZP_QUIET + x];
        if (!a) continue;
      }
      zp[ZP_LENGTH + x] = a; // a note length
      return a;
    }
    zp[ZP_LENGTH + x] = 0; // data that never reaches a length: stop the channel rather than hang
    return 0;
  }

  // GetNextNote ($80CB).
  nextNote(x, y) {
    const a = this.zp[ZP_LENGTH + x];
    if (!a) return 0;
    if (--this.zp[ZP_LENGTH + x]) return a;
    return this.process(x, y);
  }

  // UpdateSound ($8028): once per frame.
  frame() {
    const zp = this.zp;
    this.frames++;
    if (zp[ZP_SFX]) {
      const ofs = zp[ZP_NOTE_OF];
      zp[ZP_NOTE_OF] = 0;
      const a = this.nextNote(CH_NOISE, HW_SQ2);
      zp[ZP_NOTE_OF] = ofs;
      if (!a) { // the effect is over: give SQ2 back to the music
        this.write(0x4015, 0x05);
        this.write(0x4015, 0x0f);
        this.write(0x4004, zp[ZP_SQ2_CFG]);
        this.write(0x4005, 0x08);
        this.write(0x400c, 0x30);
      }
    }
    const t = zp[ZP_TEMPO_C] + zp[ZP_TEMPO];
    zp[ZP_TEMPO_C] = t;
    if (t < 0x100) return;
    zp[ZP_TEMPO_C] = zp[ZP_TEMPO_C] - 0x96;
    this.ticks++;
    this.nextNote(CH_TRI, HW_TRI);
    this.nextNote(CH_SQ2, zp[ZP_SFX] ? HW_DMC : HW_SQ2);
    this.nextNote(CH_SQ1, HW_SQ1);
  }

  // ClearSoundRegs ($8178).
  clear() {
    const zp = this.zp;
    this.write(0x4010, 0);
    this.write(0x4017, 0);
    this.write(0x4015, 0);
    zp[ZP_LENGTH + CH_SQ1] = zp[ZP_LENGTH + CH_SQ2] = zp[ZP_LENGTH + CH_TRI] = 0;
    zp[ZP_SFX] = 0;
    this.write(0x4015, 0x0f);
    zp[ZP_TEMPO] = 0xff;
    this.write(0x4001, 0x08);
    this.write(0x4005, 0x08);
  }

  // InitMusicSFX ($81A0) for music, with the table entry already looked up: a pointer of 0 is replaced by the
  // "no sound" entry's pointer for that channel, as the game does.
  music(ptrs, silent) {
    const zp = this.zp;
    for (let x = 4, c = 2; x >= 0; x -= 2, c--) {
      const p = ptrs[c] || silent[c];
      zp[ZP_INDEX + x] = p & 0xff;
      zp[ZP_INDEX + x + 1] = p >> 8;
      zp[ZP_LENGTH + x] = 1;
    }
    zp[ZP_NOTE_OF] = 0;
    zp[ZP_QUIET + CH_SQ1] = zp[ZP_QUIET + CH_SQ2] = zp[ZP_QUIET + CH_TRI] = 0;
    this.ticks = 0;
  }

  // InitMusicSFX for an effect.
  sfx(ptr) {
    const zp = this.zp;
    zp[ZP_SFX] = 1;
    zp[ZP_INDEX + CH_NOISE] = ptr & 0xff;
    zp[ZP_INDEX + CH_NOISE + 1] = ptr >> 8;
    this.write(0x4005, 0x08);
    this.write(0x4004, 0x30);
    this.write(0x400c, 0x30);
  }

  sfxActive() { return this.zp[ZP_SFX] !== 0; }
  musicActive() { return [CH_SQ1, CH_SQ2, CH_TRI].some(x => this.zp[ZP_LENGTH + x]); }
  tempo() { return this.zp[ZP_TEMPO]; }

  // WaitForMusicEnd ($815E): a jingle ends on a no-op after its last note.
  atSync() {
    for (const x of [CH_SQ1, CH_NOISE, CH_TRI]) {
      const zp = this.zp;
      if (this.byte(zp[ZP_INDEX + x] | zp[ZP_INDEX + x + 1] << 8) === 0xfc) return true;
    }
    return false;
  }

  // ---- the APU

  write(addr, v) {
    if (this.onWrite) this.onWrite(addr, v);
    if (addr >= 0x4000 && addr < 0x4008) {
      const ch = (addr - 0x4000) >> 2, p = this.sq[ch];
      switch (addr & 3) {
        case 0: p.ctrl = v; break;
        case 1:
          p.sweepOn = !!(v & 0x80);
          p.sweepPeriod = (v >> 4) & 7;
          p.sweepNeg = !!(v & 0x08);
          p.sweepShift = v & 7;
          p.sweepReload = true;
          break;
        case 2: p.timer = (p.timer & 0x700) | v; break;
        case 3:
          p.timer = (p.timer & 0xff) | (v & 7) << 8;
          if (this.enabled & (1 << ch)) p.length = LENGTHS[v >> 3];
          p.step = 0;
          p.env.start = true;
          break;
      }
      return;
    }
    const tri = this.tri, noise = this.noise;
    switch (addr) {
      case 0x4008: tri.ctrl = v; break;
      case 0x400a: tri.timer = (tri.timer & 0x700) | v; break;
      case 0x400b:
        tri.timer = (tri.timer & 0xff) | (v & 7) << 8;
        if (this.enabled & 4) tri.length = LENGTHS[v >> 3];
        tri.reload = true;
        break;
      case 0x400c: noise.ctrl = v; break;
      case 0x400e:
        noise.mode = !!(v & 0x80);
        noise.period = NOISE_PERIODS[v & 0x0f];
        break;
      case 0x400f:
        if (this.enabled & 8) noise.length = LENGTHS[v >> 3];
        noise.env.start = true;
        break;
      case 0x4015:
        this.enabled = v & 0x0f;
        if (!(v & 1)) this.sq[0].length = 0;
        if (!(v & 2)) this.sq[1].length = 0;
        if (!(v & 4)) tri.length = 0;
        if (!(v & 8)) noise.length = 0;
        break;
    }
  }

  // The frame sequencer, 4-step mode: envelopes and the triangle's linear counter every quarter, lengths and
  // sweeps every half.
  quarterFrame() {
    const tri = this.tri;
    for (const p of this.sq) envClock(p.env, p.ctrl);
    envClock(this.noise.env, this.noise.ctrl);
    if (tri.reload) tri.linear = tri.ctrl & 0x7f;
    else if (tri.linear) tri.linear--;
    if (!(tri.ctrl & 0x80)) tri.reload = false;

    if (++this.frameStep & 1) return;
    for (const p of this.sq) {
      if (p.length && !(p.ctrl & 0x20)) p.length--;
      if (p.sweepDiv === 0 && p.sweepOn && p.sweepShift && !pulseMuted(p)) {
        const t = sweepTarget(p);
        if (t >= 0) p.timer = t;
      }
      if (p.sweepDiv === 0 || p.sweepReload) {
        p.sweepDiv = p.sweepPeriod;
        p.sweepReload = false;
      } else p.sweepDiv--;
    }
    if (tri.length && !(tri.ctrl & 0x80)) tri.length--;
    if (this.noise.length && !(this.noise.ctrl & 0x20)) this.noise.length--;
  }

  mix() {
    const m = this.mute;
    const sq = (m[0] ? 0 : pulseOut(this.sq[0])) + (m[1] ? 0 : pulseOut(this.sq[1]));
    const t = m[2] ? 0 : TRI_SEQ[this.tri.step];
    const nz = this.noise;
    const n = !m[3] && nz.length && !(nz.lfsr & 1) ? envVolume(nz.env, nz.ctrl) : 0;
    let out = sq ? 95.88 / (8128 / sq + 100) : 0;
    const tnd = t / 8227 + n / 12241;
    if (tnd > 0) out += 159.79 / (1 / tnd + 100);
    return out;
  }

  // Advance everything by `cycles` CPU cycles, stepping each channel's sequencer as its timer runs out.
  advance(cycles) {
    for (const p of this.sq) for (p.next -= cycles; p.next <= 0; p.next += (p.timer + 1) * 2) p.step = (p.step + 1) & 7;
    const tri = this.tri;
    for (tri.next -= cycles; tri.next <= 0; tri.next += tri.timer + 1) {
      if (tri.length && tri.linear && tri.timer >= 2) tri.step = (tri.step + 1) & 31;
    }
    const nz = this.noise;
    for (nz.next -= cycles; nz.next <= 0; nz.next += nz.period) {
      const r = nz.lfsr, bit = (r ^ (r >> (nz.mode ? 6 : 1))) & 1;
      nz.lfsr = (r >> 1) | bit << 14;
    }
    for (this.frameNext -= cycles; this.frameNext <= 0; this.frameNext += CPU_HZ / 240) this.quarterFrame();
  }

  untilNextEvent() {
    return Math.min(this.frameNext, this.sq[0].next, this.sq[1].next, this.tri.next, this.noise.next);
  }

  // Fills `out` with samples, running the engine once per NES frame along the way.
  render(out) {
    const perSample = CPU_HZ / this.rate, perFrame = 29780.5;
    for (let s = 0; s < out.length; s++) {
      if (this.untilFrame <= 0) { this.frame(); this.untilFrame += perFrame; }
      this.untilFrame -= perSample;
      // Average the output over the sample period, so high notes and noise do not alias.
      let left = perSample, acc = 0;
      while (left > 0) {
        let step = Math.min(this.untilNextEvent(), left);
        if (step < 0.01) step = 0.01;
        acc += this.mix() * step;
        this.advance(step);
        left -= step;
      }
      const v = acc / perSample;
      // The NES's high-pass at ~90Hz and low-pass at ~14kHz.
      this.hp = 0.9872 * (this.hp + v - this.hpIn);
      this.hpIn = v;
      this.lp += 0.86 * (this.hp - this.lp);
      out[s] = Math.max(-1, Math.min(1, this.lp * 1.6));
    }
    return out;
  }
}

function envVolume(e, ctrl) { return ctrl & 0x10 ? ctrl & 0x0f : e.decay; }

function envClock(e, ctrl) {
  if (e.start) {
    e.start = false;
    e.decay = 15;
    e.divider = ctrl & 0x0f;
  } else if (e.divider-- === 0) {
    e.divider = ctrl & 0x0f;
    if (e.decay) e.decay--;
    else if (ctrl & 0x20) e.decay = 15;
  }
}

function sweepTarget(p) {
  const delta = p.timer >> p.sweepShift;
  return p.sweepNeg ? p.timer - delta - (p.second ? 0 : 1) : p.timer + delta;
}

function pulseMuted(p) { return p.timer < 8 || (!p.sweepNeg && sweepTarget(p) > 0x7ff); }

function pulseOut(p) {
  if (!p.length || pulseMuted(p) || !DUTY[p.ctrl >> 6][p.step]) return 0;
  return envVolume(p.env, p.ctrl);
}

// Music ticks per frame for a tempo byte: each frame adds the tempo to a counter, and a tick happens (and 150 is
// taken off) whenever it carries past 255. Averaged over a long run.
const rates = new Float64Array(256);
export function ticksPerFrame(tempo) {
  if (!rates[tempo]) {
    let c = 0, ticks = 0;
    const frames = 60000;
    for (let f = 0; f < frames; f++) {
      const t = c + tempo;
      c = t & 0xff;
      if (t >= 0x100) { c = (c - 0x96) & 0xff; ticks++; }
    }
    rates[tempo] = ticks / frames || 1e-9;
  }
  return rates[tempo];
}
