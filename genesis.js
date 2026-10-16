// Enough of a Sega Genesis to run a game's sound code: the 68000 and its RAM, the Z80 with its 8 KB of RAM, bank
// window and bus arbitration, the YM2612 and PSG, and a stand-in for the video chip (just the status bits games
// wait on). The Z80 runs interleaved with the YM2612 sample by sample, since DAC drivers time their samples by
// counting cycles.
import { M68K } from "./m68k.js";
import { Z80 } from "./z80.js";
import { YM2612, SN76489, YM_RATE, PSG_CLOCK } from "./ym2612.js";

export const FRAME_HZ = 60; // NTSC
const Z80_HZ = 3579545;

export class Genesis {
  constructor(rom) {
    this.rom = rom;
    this.ram = new Uint8Array(0x10000);
    this.zram = new Uint8Array(0x2000);
    this.ym = new YM2612();
    this.psg = new SN76489();
    this.zBusReq = false; this.zReset = true; this.zBank = 0; this.zBankBits = 0;
    this.vblank = false; this.frame = 0;
    this.onYmWrite = null; // (part, reg, value, by) for traces
    const self = this;
    this.cpu = new M68K({
      read8: a => self.read8(a), read16: a => (self.read8(a) << 8) | self.read8(a + 1),
      write8: (a, v) => self.write8(a, v), write16: (a, v) => self.write16(a, v),
    });
    this.z80 = new Z80({ read: a => self.zread(a), write: (a, v) => self.zwrite(a, v) });
    this.ymFrac = 0; this.psgFrac = 0;
    this.ymAddr = [0, 0];
  }

  // ---- 68000 side
  read8(a) {
    a &= 0xffffff;
    if (a < 0x400000) return this.rom[a] ?? 0xff;
    if (a >= 0xff0000) return this.ram[a & 0xffff];
    if (a >= 0xa00000 && a < 0xa10000) {
      const z = a & 0xffff;
      if (z < 0x4000) return this.zram[z & 0x1fff];
      if (z < 0x6000) return this.ym.read();
      return 0xff;
    }
    if (a >= 0xa10000 && a < 0xa10020) return a === 0xa10001 ? 0xa0 : 0xff; // version: overseas NTSC, no expansion
    if (a === 0xa11100 || a === 0xa11101) return this.zBusReq && !this.zReset ? 0 : 1;
    if (a >= 0xc00000 && a < 0xc00020) {
      const r = a & 0x1f;
      if (r === 4 || r === 6) return 0x34; // control port status, high byte: FIFO empty
      if (r === 5 || r === 7) { this.vblank = !this.vblank; return (this.vblank ? 8 : 0) | 0x80 | 4; } // toggle vblank so wait loops end
      if (r === 8 || r === 9) return (this.frame * 7) & 0xff; // HV counter
      return 0;
    }
    return 0xff;
  }
  write8(a, v) {
    a &= 0xffffff;
    if (a >= 0xff0000) { this.ram[a & 0xffff] = v; return; }
    if (a >= 0xa00000 && a < 0xa10000) {
      const z = a & 0xffff;
      if (z < 0x4000) this.zram[z & 0x1fff] = v;
      else if (z < 0x6000) this.ymWrite(z & 3, v, "68k");
      return;
    }
    if (a === 0xa11100) { this.zBusReq = !!(v & 1); return; }
    if (a === 0xa11200) { const reset = !(v & 1); if (this.zReset && !reset) this.z80Reset(); this.zReset = reset; return; }
    if (a === 0xc00011 || a === 0xc00013 || a === 0xc00015 || a === 0xc00017) { this.psg.write(v); return; }
  }
  write16(a, v) {
    a &= 0xffffff;
    if (a === 0xa11100 || a === 0xa11200) { this.write8(a, v >> 8); return; }
    if (a >= 0xc00010 && a < 0xc00018) { this.psg.write(v & 0xff); return; }
    if (a >= 0xc00000 && a < 0xc00020) return;
    this.write8(a, v >> 8); this.write8(a + 1, v & 0xff);
  }

  ymWrite(port, v, by) {
    if (!(port & 1)) this.ymAddr[port >> 1] = v;
    else this.onYmWrite?.(port >> 1, this.ymAddr[port >> 1], v, by);
    this.ym.write(port, v);
  }

  // ---- Z80 side
  z80Reset() { const z = this.z80; z.pc = 0; z.iff1 = z.iff2 = 0; z.im = 0; z.halted = false; z.sp = 0xffff; }
  zread(a) {
    if (a < 0x4000) return this.zram[a & 0x1fff];
    if (a < 0x6000) return this.ym.read();
    if (a >= 0x8000) return this.read8(this.zBank * 0x8000 + (a & 0x7fff));
    return 0xff;
  }
  zwrite(a, v) {
    if (a < 0x4000) { this.zram[a & 0x1fff] = v; return; }
    if (a < 0x6000) { this.ymWrite(a & 3, v, "z80"); return; }
    if (a < 0x6100) { // bank register: nine single-bit writes, shifted in from the top
      this.zBankBits = ((this.zBankBits >> 1) | ((v & 1) << 8)) & 0x1ff;
      this.zBank = this.zBankBits;
      return;
    }
    if (a === 0x7f11) { this.psg.write(v); return; }
    if (a >= 0x8000) this.write8(this.zBank * 0x8000 + (a & 0x7fff), v);
  }

  // Runs one frame: the 68000 routine `entry` (the sound driver's update, called at the start of the frame as the
  // vertical blank would) alongside the Z80 and the sound chips, sample by sample, into out (stereo, at the YM's
  // rate) if given. The Z80 gets its once-a-frame interrupt at the start. Returns the number of samples.
  soundFrame(outL, outR, entry = null) {
    const z80On = !this.zReset && !this.zBusReq;
    if (z80On) this.z80.interrupt();
    const cpu = this.cpu, RET = 0xfffff0;
    let running = false;
    if (entry !== null) { cpu.push32(RET); cpu.pc = entry; cpu.stopped = false; running = true; }
    const samples = Math.round(YM_RATE / FRAME_HZ + this.ymFrac);
    this.ymFrac += YM_RATE / FRAME_HZ - samples;
    const zPer = Z80_HZ / YM_RATE, pPer = PSG_CLOCK / 16 / YM_RATE;
    let zDebt = 0, budget = 0;
    for (let i = 0; i < samples; i++) {
      if (running) { // about 144 68000 cycles a sample: ~18 instructions
        for (budget += 18; budget > 0 && running; budget--) { cpu.step(); if (cpu.pc === RET) running = false; }
      }
      if (!this.zReset && !this.zBusReq) { zDebt += zPer; while (zDebt > 0) zDebt -= this.z80.step(); }
      const [l, r] = this.ym.sample();
      this.psgFrac += pPer;
      const n = Math.floor(this.psgFrac); this.psgFrac -= n;
      const p = this.psg.run(n) * 0.5;
      if (outL) { outL.push((l + p) / 32768); outR.push((r + p) / 32768); }
    }
    // A driver still busy at the end of the frame finishes now (real ones take a fraction of a frame).
    for (let k = 0; running && k < 200000; k++) { cpu.step(); if (cpu.pc === RET) running = false; }
    this.frame++;
    return samples;
  }

  // Calls a 68000 routine and runs it until it returns (or gives up after `limit` instructions).
  call(addr, limit = 2000000) {
    const cpu = this.cpu;
    const RET = 0xfffff0; // a return address that marks the end
    cpu.push32(RET);
    cpu.pc = addr;
    cpu.stopped = false;
    for (let i = 0; i < limit; i++) {
      if (cpu.pc === RET) return true;
      cpu.step();
    }
    return false;
  }
}
