// The Genesis sound chips: the YM2612 (six 4-operator FM channels, a DAC on channel 6, LFO, two timers) and the
// SN76489 PSG (three square waves and noise). The YM2612 follows Nuked-OPN2, which models the chip from its die:
// the same log-sine and exponent ROMs, envelope generator timing, detune and LFO arithmetic, worked out once per
// sample rather than per clock. It runs at the chip's own rate (clock / 144, about 53 kHz).
import { LOGSIN, EXP, LFO_SH1, LFO_SH2 } from "./ym-tables.js";

export const YM_CLOCK = 7670453; // NTSC
export const YM_RATE = YM_CLOCK / 144;

const FN_NOTE = [0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 3, 3];
const EG_STEPHI = [[0, 0, 0, 0], [1, 0, 0, 0], [1, 0, 1, 0], [1, 1, 1, 0]];
const AM_SHIFT = [7, 3, 1, 0];
const DETUNE = [16, 17, 19, 20, 22, 24, 27, 29];
const LFO_CYCLES = [108, 77, 71, 67, 62, 44, 8, 5];
const ATTACK = 0, DECAY = 1, SUSTAIN = 2, RELEASE = 3;

// Which inputs modulate each operator, per algorithm (Nuked's fm_algorithm). Operators are in register order:
// 0 = OP1 (+0), 1 = OP3 (+4), 2 = OP2 (+8), 3 = OP4 (+12). Inputs: OP1's latest output, OP2's output (from the
// previous sample when OP2 hasn't run yet), and "two back": the operator processed two places earlier.
const MOD_OP1 = [[], [0, 1, 0, 0, 0, 1, 0, 0], [], [0, 0, 1, 0, 0, 1, 0, 0]];
const MOD_OP2 = [[], [1, 1, 1, 0, 0, 0, 0, 0], [], [0, 0, 0, 1, 0, 0, 0, 0]];
const MOD_BACK2 = [[], [], [1, 0, 0, 1, 1, 1, 1, 0], [1, 1, 1, 1, 1, 0, 0, 0]];
const OUT = [[0, 0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 1, 1, 1], [0, 0, 0, 0, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1, 1, 1]];

function operator() {
  return {
    dt: 0, multi: 1, tl: 0, ks: 0, ar: 0, dr: 0, sr: 0, rr: 0, sl: 0, am: 0,
    phase: 0, level: 0x3ff, state: RELEASE, kon: false, out: 0,
  };
}

export class YM2612 {
  constructor() {
    this.ch = Array.from({ length: 6 }, () => ({
      ops: [operator(), operator(), operator(), operator()],
      fnum: 0, block: 0, hi: 0, algo: 0, fb: 0, op1: [0, 0], op2: 0, left: true, right: true, ams: 0, pms: 0,
    }));
    this.ch3 = { fnum: [0, 0, 0], block: [0, 0, 0], hi: 0 };
    this.mode = 0;
    this.addr = [0, 0];
    this.egTimer = 0; this.egQuot = 0;
    this.lfoEn = false; this.lfoFreq = 0; this.lfoCnt = 0; this.lfoQuot = 0;
    this.dacOn = false; this.dac = 0x80;
    this.timerA = 0; this.timerB = 0; this.taCnt = 0; this.tbCnt = 0; this.status = 0;
  }

  write(port, v) {
    v &= 0xff;
    if (!(port & 1)) { this.addr[port >> 1] = v; return; }
    const part = port >> 1, r = this.addr[part];
    if (part === 0 && r < 0x30) this.writeGlobal(r, v);
    else if (r >= 0x30) this.writeReg(part, r, v);
  }
  read() { return this.status; }

  writeGlobal(r, v) {
    switch (r) {
      case 0x22: this.lfoEn = !!(v & 8); this.lfoFreq = v & 7; if (!this.lfoEn) this.lfoCnt = 0; break;
      case 0x24: this.timerA = (this.timerA & 3) | (v << 2); break;
      case 0x25: this.timerA = (this.timerA & 0x3fc) | (v & 3); break;
      case 0x26: this.timerB = v; break;
      case 0x27:
        if (v & 1 && !(this.mode & 1)) this.taCnt = 1024 - this.timerA;
        if (v & 2 && !(this.mode & 2)) this.tbCnt = (256 - this.timerB) * 16;
        if (v & 0x10) this.status &= ~1;
        if (v & 0x20) this.status &= ~2;
        this.mode = v;
        break;
      case 0x28: {
        const c = v & 3;
        if (c === 3) break;
        const ch = this.ch[c + (v & 4 ? 3 : 0)];
        // bits 4-7 key OP1, OP2, OP3, OP4: OP2 is at register +8 and OP3 at +4
        // A key-off followed by a key-on before the next sample still retriggers the note (a driver writes both
        // within a frame; on the real chip time passes between them).
        [0, 2, 1, 3].forEach((o, k) => { const op = ch.ops[o], on = !!(v & (0x10 << k)); if (!on && op.kon) op.offSeen = true; op.nkon = on; });
        break;
      }
      case 0x2a: this.dac = v; break;
      case 0x2b: this.dacOn = !!(v & 0x80); break;
    }
  }

  writeReg(part, r, v) {
    const c = r & 3;
    if (c === 3) return;
    const ch = this.ch[c + part * 3];
    if (r < 0xa0) {
      const o = ch.ops[(r >> 2) & 3];
      switch (r & 0xf0) {
        case 0x30: o.dt = (v >> 4) & 7; o.multi = (v & 15) ? (v & 15) * 2 : 1; break;
        case 0x40: o.tl = v & 0x7f; break;
        case 0x50: o.ks = v >> 6; o.ar = v & 0x1f; break;
        case 0x60: o.am = v >> 7; o.dr = v & 0x1f; break;
        case 0x70: o.sr = v & 0x1f; break;
        case 0x80: o.rr = v & 15; o.sl = v >> 4; o.sl |= (o.sl + 1) & 0x10; break;
      }
      return;
    }
    switch (r & 0xfc) {
      case 0xa0: ch.fnum = ((ch.hi & 7) << 8) | v; ch.block = (ch.hi >> 3) & 7; break;
      case 0xa4: ch.hi = v & 0x3f; break;
      case 0xa8: if (part === 0) { this.ch3.fnum[c] = ((this.ch3.hi & 7) << 8) | v; this.ch3.block[c] = (this.ch3.hi >> 3) & 7; } break;
      case 0xac: if (part === 0) this.ch3.hi = v & 0x3f; break;
      case 0xb0: ch.fb = (v >> 3) & 7; ch.algo = v & 7; break;
      case 0xb4: ch.left = !!(v & 0x80); ch.right = !!(v & 0x40); ch.ams = (v >> 4) & 3; ch.pms = v & 7; break;
    }
  }

  timers() {
    if (this.mode & 1 && --this.taCnt <= 0) {
      this.taCnt += 1024 - this.timerA;
      if (this.mode & 4) this.status |= 1;
    }
    if (this.mode & 2 && --this.tbCnt <= 0) {
      this.tbCnt += (256 - this.timerB) * 16;
      if (this.mode & 8) this.status |= 2;
    }
  }

  // ---- one sample: returns [left, right], each channel's 14-bit output summed
  sample() {
    this.timers();
    // LFO
    let lfoPm = 0, lfoAm = 0;
    if (this.lfoEn) {
      if (++this.lfoQuot >= LFO_CYCLES[this.lfoFreq]) { this.lfoQuot = 0; this.lfoCnt = (this.lfoCnt + 1) & 0x7f; }
    }
    lfoPm = this.lfoCnt >> 2;
    lfoAm = (this.lfoCnt & 0x40 ? this.lfoCnt & 0x3f : this.lfoCnt ^ 0x3f) << 1;
    // Envelope timer: the generator steps every third sample; a step's size depends on the lowest set bit of a
    // counter.
    this.egQuot = (this.egQuot + 1) % 3;
    let egStep = false, shift = 0, low = 0;
    if (this.egQuot === 2) {
      this.egTimer = (this.egTimer + 1) & 0xfff;
      egStep = true;
      const t = this.egTimer;
      shift = t ? 32 - Math.clz32(t & -t) : 0; // index of the lowest set bit, plus one (0 if none)
      low = t & 3;
    }
    let L = 0, R = 0;
    for (let ci = 0; ci < 6; ci++) {
      const ch = this.ch[ci];
      let out = 0;
      const special = ci === 2 && (this.mode & 0xc0);
      for (let k = 0; k < 4; k++) {
        const o = ch.ops[k];
        let fnum = ch.fnum, block = ch.block;
        if (special && k < 3) { const r = [1, 0, 2][k]; fnum = this.ch3.fnum[r]; block = this.ch3.block[r]; }
        const kcode = (block << 2) | FN_NOTE[fnum >> 7];
        this.envelope(o, kcode, egStep, shift, low);
        // operator output
        let level = o.level + (o.am ? lfoAm >> AM_SHIFT[ch.ams] : 0) + (o.tl << 3);
        if (level > 0x3ff) level = 0x3ff;
        let mod;
        if (k === 0) mod = ch.fb ? (ch.op1[0] + ch.op1[1]) >> (10 - ch.fb) : 0;
        else {
          let m1 = 0, m2 = 0;
          if (MOD_OP1[k][ch.algo]) m1 += ch.op1[1];
          if (MOD_OP2[k][ch.algo]) m1 += ch.op2;
          if (MOD_BACK2[k][ch.algo]) m2 += ch.ops[k - 2].out;
          mod = (m1 + m2) >> 1;
        }
        const phase = (mod + (o.phase >> 10)) & 0x3ff;
        let lv = LOGSIN[phase & 0x100 ? (phase ^ 0xff) & 0xff : phase & 0xff] + (level << 2);
        if (lv > 0x1fff) lv = 0x1fff;
        let v = ((EXP[(lv & 0xff) ^ 0xff] | 0x400) << 2) >> (lv >> 8);
        if (phase & 0x200) v = -v;
        o.out = v;
        if (k === 0) { ch.op1[0] = ch.op1[1]; ch.op1[1] = v; }
        if (k === 2) ch.op2 = v;
        if (OUT[k][ch.algo]) out += v;
        // phase
        o.phase = (o.phase + this.increment(o, fnum, block, kcode, ch.pms, lfoPm)) & 0xfffff;
      }
      if (out > 8191) out = 8191; else if (out < -8192) out = -8192;
      if (ci === 5 && this.dacOn) out = (this.dac - 128) << 6;
      if (ch.left) L += out;
      if (ch.right) R += out;
    }
    return [L, R];
  }

  increment(o, fnum, block, kcode, pms, lfo) {
    let f = fnum << 1;
    // LFO pitch modulation
    if (pms) {
      let l = lfo & 15;
      if (l & 8) l ^= 15;
      const fh = fnum >> 4;
      let fm = (fh >> LFO_SH1[pms * 8 + l]) + (fh >> LFO_SH2[pms * 8 + l]);
      if (pms > 5) fm <<= pms - 5;
      fm >>= 2;
      f = lfo & 0x10 ? f - fm : f + fm;
      f &= 0xfff;
    }
    let base = (f << block) >> 2;
    const dl = o.dt & 3;
    if (dl) {
      const kc = Math.min(kcode, 0x1c), b = kc >> 2, note = kc & 3;
      const sum = b + 9 + ((dl === 3) | (dl & 2) ? 1 : 0);
      const det = DETUNE[((sum & 1) << 2) | note] >> (9 - (sum >> 1));
      base = o.dt & 4 ? base - det : base + det;
    }
    base &= 0x1ffff;
    return ((base * o.multi) >> 1) & 0xfffff;
  }

  envelope(o, kcode, step, shift, low) {
    const nkon = !!o.nkon;
    const konEvent = nkon && (!o.kon || o.offSeen), koffEvent = o.kon && !nkon;
    o.offSeen = false;
    o.kon = nkon;
    if (konEvent) o.phase = 0;
    // rate for the current state (a fresh key-on uses the attack rate)
    const state = konEvent ? ATTACK : o.state;
    const r = state === ATTACK ? o.ar : state === DECAY ? o.dr : state === SUSTAIN ? o.sr : (o.rr << 1) | 1;
    let rate = r ? (r << 1) + (kcode >> (o.ks ^ 3)) : 0;
    if (rate > 0x3f) rate = 0x3f;
    let inc = 0;
    if (step && r) {
      const sum = ((rate >> 2) + shift) & 15;
      if (rate < 48) inc = sum === 12 ? 1 : sum === 13 ? (rate >> 1) & 1 : sum === 14 ? rate & 1 : 0;
      else { inc = EG_STEPHI[rate & 3][low] + (rate >> 2) - 11; if (inc > 4) inc = 4; }
    }
    const rateMax = (rate >> 1) === 0x1f;
    let level = o.level, next = level, nstate = o.state, add = 0;
    const off = (level & 0x3f0) === 0x3f0;
    if (konEvent) {
      nstate = ATTACK;
      if (rateMax) next = 0;
      else if (o.state === ATTACK && level !== 0 && inc && nkon) add = (~level << inc) >> 5;
    } else {
      switch (o.state) {
        case ATTACK:
          if (level === 0) nstate = DECAY;
          else if (inc && !rateMax && nkon) add = (~level << inc) >> 5;
          break;
        case DECAY:
          if ((level >> 4) === (o.sl << 1)) nstate = SUSTAIN;
          else if (!off && inc) add = 1 << (inc - 1);
          break;
        default:
          if (!off && inc) add = 1 << (inc - 1);
      }
      if (!nkon) nstate = RELEASE;
    }
    if (!konEvent && o.state !== ATTACK && off) { nstate = RELEASE; next = 0x3ff; }
    void koffEvent;
    o.level = (next + add) & 0x3ff;
    o.state = nstate;
  }
}

// ---------------------------------------------------------------- SN76489

export const PSG_CLOCK = 3579545;
const PSG_VOL = Array.from({ length: 16 }, (_, i) => (i === 15 ? 0 : Math.round(4096 * Math.pow(10, -i * 2 / 20))));

export class SN76489 {
  constructor() {
    this.period = [0x3ff, 0x3ff, 0x3ff, 0x10]; this.vol = [15, 15, 15, 15];
    this.cnt = [0, 0, 0, 0]; this.out = [1, 1, 1, 1];
    this.latch = 0; this.noise = 0; this.lfsr = 0x8000;
    this.frac = 0;
  }
  write(v) {
    if (v & 0x80) {
      this.latch = (v >> 4) & 7;
      const ch = this.latch >> 1;
      if (this.latch & 1) this.vol[ch] = v & 15;
      else if (ch === 3) { this.noise = v & 7; this.lfsr = 0x8000; this.period[3] = [0x10, 0x20, 0x40, 0][v & 3]; }
      else this.period[ch] = (this.period[ch] & 0x3f0) | (v & 15);
    } else {
      const ch = this.latch >> 1;
      if (this.latch & 1) this.vol[ch] = v & 15;
      else if (ch === 3) { this.noise = v & 7; this.lfsr = 0x8000; this.period[3] = [0x10, 0x20, 0x40, 0][v & 3]; }
      else this.period[ch] = (this.period[ch] & 15) | ((v & 0x3f) << 4);
    }
  }
  // Advances `clocks` PSG clocks (the chip's clock / 16) and returns the mixed level.
  run(clocks) {
    let acc = 0;
    for (let k = 0; k < clocks; k++) {
      for (let i = 0; i < 3; i++) {
        if (--this.cnt[i] <= 0) { this.cnt[i] = this.period[i] || 1; this.out[i] ^= 1; }
      }
      if (--this.cnt[3] <= 0) {
        this.cnt[3] = (this.period[3] || this.period[2] || 1);
        this.out[3] ^= 1;
        if (this.out[3]) { // shift on rising edges
          const fb = this.noise & 4 ? ((this.lfsr & 1) ^ ((this.lfsr >> 3) & 1)) : this.lfsr & 1;
          this.lfsr = (this.lfsr >> 1) | (fb << 15);
        }
      }
      let s = 0;
      for (let i = 0; i < 3; i++) s += (this.out[i] || this.period[i] < 2 ? PSG_VOL[this.vol[i]] : -PSG_VOL[this.vol[i]]);
      s += this.lfsr & 1 ? PSG_VOL[this.vol[3]] : -PSG_VOL[this.vol[3]];
      acc += s;
    }
    return clocks ? acc / clocks : 0;
  }
}
