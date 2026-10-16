// A Motorola 68000 interpreter, for running a Genesis game's sound driver. The bus is supplied by the caller:
// read8/read16/write8/write16 (32-bit accesses are made of two 16-bit ones). Timing is approximate: drivers are
// called once a frame, so only the order of their work matters.

const SIZE = [1, 2, 4];
const MASK = [0xff, 0xffff, 0xffffffff];
const SIGN = [0x80, 0x8000, 0x80000000];
const sx8 = v => (v << 24) >> 24, sx16 = v => (v << 16) >> 16;

export class M68K {
  constructor(bus) {
    this.bus = bus;
    this.d = new Int32Array(8); // stored as 32-bit; read with >>> 0 where unsigned matters
    this.a = new Int32Array(8);
    this.pc = 0;
    this.sr = 0x2700;
    this.usp = 0; this.ssp = 0;
    this.stopped = false;
    this.cycles = 0;
  }

  // ---- memory
  r8(a) { return this.bus.read8(a & 0xffffff) & 0xff; }
  r16(a) { return this.bus.read16(a & 0xfffffe) & 0xffff; }
  r32(a) { return ((this.r16(a) << 16) | this.r16(a + 2)) >>> 0; }
  w8(a, v) { this.bus.write8(a & 0xffffff, v & 0xff); }
  w16(a, v) { this.bus.write16(a & 0xfffffe, v & 0xffff); }
  w32(a, v) { this.w16(a, v >>> 16); this.w16(a + 2, v & 0xffff); }
  read(a, s) { return s === 0 ? this.r8(a) : s === 1 ? this.r16(a) : this.r32(a); }
  write(a, s, v) { if (s === 0) this.w8(a, v); else if (s === 1) this.w16(a, v); else this.w32(a, v); }
  fetch16() { const v = this.r16(this.pc); this.pc = (this.pc + 2) >>> 0; return v; }
  fetch32() { const v = this.r32(this.pc); this.pc = (this.pc + 4) >>> 0; return v; }

  // ---- flags (CCR: X N Z V C = bits 4..0)
  get X() { return (this.sr >> 4) & 1; }
  setNZ(v, s) { v &= MASK[s]; this.sr = (this.sr & ~0x0c) | (v & SIGN[s] ? 8 : 0) | (v === 0 ? 4 : 0); }
  setNZVC0(v, s) { this.setNZ(v, s); this.sr &= ~3; }
  ccr(x, n, z, v, c) { this.sr = (this.sr & 0xffe0) | (x << 4) | (n << 3) | (z << 2) | (v << 1) | c; }

  cond(c) {
    const sr = this.sr, C = sr & 1, V = (sr >> 1) & 1, Z = (sr >> 2) & 1, N = (sr >> 3) & 1;
    switch (c) {
      case 0: return true; case 1: return false;
      case 2: return !C && !Z; case 3: return !!(C || Z);
      case 4: return !C; case 5: return !!C;
      case 6: return !Z; case 7: return !!Z;
      case 8: return !V; case 9: return !!V;
      case 10: return !N; case 11: return !!N;
      case 12: return N === V; case 13: return N !== V;
      case 14: return !Z && N === V; default: return !!Z || N !== V;
    }
  }

  // ---- supervisor stack
  setSR(v) {
    const wasS = this.sr & 0x2000;
    if (wasS && !(v & 0x2000)) { this.ssp = this.a[7]; this.a[7] = this.usp; }
    else if (!wasS && v & 0x2000) { this.usp = this.a[7]; this.a[7] = this.ssp; }
    this.sr = v & 0xa71f;
  }
  push32(v) { this.a[7] -= 4; this.w32(this.a[7] >>> 0, v); }
  push16(v) { this.a[7] -= 2; this.w16(this.a[7] >>> 0, v); }
  pop32() { const v = this.r32(this.a[7] >>> 0); this.a[7] += 4; return v; }
  pop16() { const v = this.r16(this.a[7] >>> 0); this.a[7] += 2; return v; }
  exception(vec) {
    const old = this.sr;
    this.setSR((this.sr | 0x2000) & ~0x8000);
    this.push32(this.pc);
    this.push16(old);
    this.pc = this.r32(vec * 4);
  }

  // An autovectored interrupt at `level` (1-7), taken if the mask allows. Returns whether it was taken.
  interrupt(level) {
    if (level <= ((this.sr >> 8) & 7) && level < 7) return false;
    const old = this.sr;
    this.setSR((this.sr | 0x2000) & ~0x8000);
    this.sr = (this.sr & ~0x700) | (level << 8);
    this.push32(this.pc);
    this.push16(old);
    this.pc = this.r32((24 + level) * 4);
    this.stopped = false;
    return true;
  }

  // ---- effective addresses. Returns an object: { k: "d"|"a"|"m"|"i", r, addr, v }.
  ea(mode, reg, s) {
    switch (mode) {
      case 0: return { k: "d", r: reg };
      case 1: return { k: "a", r: reg };
      case 2: return { k: "m", addr: this.a[reg] >>> 0 };
      case 3: { const addr = this.a[reg] >>> 0; this.a[reg] += reg === 7 && s === 0 ? 2 : SIZE[s]; return { k: "m", addr }; }
      case 4: { this.a[reg] -= reg === 7 && s === 0 ? 2 : SIZE[s]; return { k: "m", addr: this.a[reg] >>> 0 }; }
      case 5: { const d = sx16(this.fetch16()); return { k: "m", addr: (this.a[reg] + d) >>> 0 }; }
      case 6: return { k: "m", addr: this.indexed(this.a[reg]) };
      case 7:
        switch (reg) {
          case 0: return { k: "m", addr: sx16(this.fetch16()) >>> 0 };
          case 1: return { k: "m", addr: this.fetch32() };
          case 2: { const base = this.pc; const d = sx16(this.fetch16()); return { k: "m", addr: (base + d) >>> 0 }; }
          case 3: { const base = this.pc; return { k: "m", addr: this.indexed(base) }; }
          case 4: {
            if (s === 2) return { k: "i", v: this.fetch32() };
            const w = this.fetch16();
            return { k: "i", v: s === 0 ? w & 0xff : w };
          }
        }
    }
    throw new Error(`68000: bad addressing mode ${mode}/${reg} at $${(this.pc >>> 0).toString(16)}`);
  }
  indexed(base) {
    const ext = this.fetch16();
    const r = (ext >> 12) & 7, isA = ext & 0x8000;
    let x = isA ? this.a[r] : this.d[r];
    if (!(ext & 0x800)) x = sx16(x);
    return (base + x + sx8(ext)) >>> 0;
  }
  get(e, s) {
    switch (e.k) {
      case "d": return (this.d[e.r] & MASK[s]) >>> 0;
      case "a": return (this.a[e.r] & MASK[s]) >>> 0;
      case "i": return e.v >>> 0;
      default: return this.read(e.addr, s);
    }
  }
  set(e, s, v) {
    v = (v & MASK[s]) >>> 0;
    switch (e.k) {
      case "d": this.d[e.r] = s === 2 ? v : (this.d[e.r] & ~MASK[s]) | v; break;
      case "a": this.a[e.r] = s === 1 ? sx16(v) : v; break;
      default: this.write(e.addr, s, v);
    }
  }

  // ---- arithmetic helpers (return the result, set flags)
  add(a, b, s, x = 0) {
    const m = MASK[s], sg = SIGN[s];
    const r = (a + b + x);
    const res = (r & m) >>> 0;
    const c = s === 2 ? (r > 0xffffffff ? 1 : 0) : (r > m ? 1 : 0);
    const v = ((~(a ^ b) & (a ^ res)) & sg) ? 1 : 0;
    return { res, c, v, n: res & sg ? 1 : 0, z: res === 0 ? 1 : 0 };
  }
  sub(a, b, s, x = 0) { // a - b - x
    const m = MASK[s], sg = SIGN[s];
    const r = a - b - x;
    const res = (r & m) >>> 0;
    const c = r < 0 ? 1 : 0;
    const v = (((a ^ b) & (a ^ res)) & sg) ? 1 : 0;
    return { res, c, v, n: res & sg ? 1 : 0, z: res === 0 ? 1 : 0 };
  }

  // ---- running
  run(maxInstructions) {
    for (let i = 0; i < maxInstructions && !this.stopped; i++) this.step();
  }

  step() {
    const pc0 = this.pc;
    const op = this.fetch16();
    this.cycles += 4;
    switch (op >> 12) {
      case 0x0: return this.group0(op);
      case 0x1: return this.move(op, 0);
      case 0x2: return this.move(op, 2);
      case 0x3: return this.move(op, 1);
      case 0x4: return this.group4(op, pc0);
      case 0x5: return this.group5(op);
      case 0x6: return this.branch(op);
      case 0x7: { const r = (op >> 9) & 7; const v = sx8(op); this.d[r] = v; this.setNZVC0(v >>> 0, 2); return; }
      case 0x8: return this.group8(op);
      case 0x9: return this.addsub(op, false);
      case 0xb: return this.groupB(op);
      case 0xc: return this.groupC(op);
      case 0xd: return this.addsub(op, true);
      case 0xe: return this.shift(op);
      case 0xa: this.pc = pc0; return this.exception(10);
      case 0xf: this.pc = pc0; return this.exception(11);
    }
  }

  move(op, s) {
    const src = this.ea((op >> 3) & 7, op & 7, s);
    const v = this.get(src, s);
    const dm = (op >> 6) & 7, dr = (op >> 9) & 7;
    if (dm === 1) { this.a[dr] = s === 1 ? sx16(v) : v; return; } // MOVEA: no flags
    const dst = this.ea(dm, dr, s);
    this.set(dst, s, v);
    this.setNZVC0(v, s);
  }

  group0(op) {
    const mode = (op >> 3) & 7, reg = op & 7;
    if (op & 0x100 || (op >> 8) === 8) { // bit operations (dynamic: register number; static: immediate)
      if ((op & 0x138) === 0x108) return this.movep(op);
      const bitNum = op & 0x100 ? this.d[(op >> 9) & 7] : this.fetch16() & 0xff;
      const kind = (op >> 6) & 3; // 0 BTST 1 BCHG 2 BCLR 3 BSET
      if (mode === 0) {
        const b = bitNum & 31, v = this.d[reg] >>> 0;
        this.sr = (this.sr & ~4) | ((v >>> b) & 1 ? 0 : 4);
        if (kind === 1) this.d[reg] = v ^ (1 << b);
        else if (kind === 2) this.d[reg] = v & ~(1 << b);
        else if (kind === 3) this.d[reg] = v | (1 << b);
        return;
      }
      const e = this.ea(mode, reg, 0), b = bitNum & 7, v = this.get(e, 0);
      this.sr = (this.sr & ~4) | ((v >> b) & 1 ? 0 : 4);
      if (kind === 1) this.set(e, 0, v ^ (1 << b));
      else if (kind === 2) this.set(e, 0, v & ~(1 << b));
      else if (kind === 3) this.set(e, 0, v | (1 << b));
      return;
    }
    const kind = (op >> 9) & 7, s = (op >> 6) & 3;
    // to CCR / SR
    if ((op & 0xff) === 0x3c || (op & 0xff) === 0x7c) {
      const imm = this.fetch16();
      const toSR = (op & 0xff) === 0x7c;
      const cur = toSR ? this.sr : this.sr & 0xff;
      let v = kind === 0 ? cur | imm : kind === 1 ? cur & imm : cur ^ imm;
      if (toSR) this.setSR(v); else this.sr = (this.sr & 0xff00) | (v & 0x1f);
      return;
    }
    const imm = s === 0 ? this.fetch16() & 0xff : s === 1 ? this.fetch16() : this.fetch32();
    const e = this.ea(mode, reg, s);
    const cur = this.get(e, s);
    switch (kind) {
      case 0: { const r = (cur | imm) >>> 0; this.set(e, s, r); this.setNZVC0(r, s); return; } // ORI
      case 1: { const r = (cur & imm) >>> 0; this.set(e, s, r); this.setNZVC0(r, s); return; } // ANDI
      case 2: { const r = this.sub(cur, imm, s); this.set(e, s, r.res); this.ccr(r.c, r.n, r.z, r.v, r.c); return; } // SUBI
      case 3: { const r = this.add(cur, imm, s); this.set(e, s, r.res); this.ccr(r.c, r.n, r.z, r.v, r.c); return; } // ADDI
      case 5: { const r = (cur ^ imm) >>> 0; this.set(e, s, r); this.setNZVC0(r, s); return; } // EORI
      case 6: { const r = this.sub(cur, imm, s); this.ccr(this.X, r.n, r.z, r.v, r.c); return; } // CMPI
    }
    throw new Error(`68000: opcode $${op.toString(16)} not handled`);
  }

  movep(op) {
    const dr = (op >> 9) & 7, ar = op & 7, d16 = sx16(this.fetch16());
    const addr = (this.a[ar] + d16) >>> 0, mode = (op >> 6) & 3;
    if (mode === 0) this.d[dr] = (this.d[dr] & ~0xffff) | (this.r8(addr) << 8) | this.r8(addr + 2);
    else if (mode === 1) this.d[dr] = (this.r8(addr) << 24) | (this.r8(addr + 2) << 16) | (this.r8(addr + 4) << 8) | this.r8(addr + 6);
    else if (mode === 2) { const v = this.d[dr]; this.w8(addr, v >> 8); this.w8(addr + 2, v); }
    else { const v = this.d[dr]; this.w8(addr, v >>> 24); this.w8(addr + 2, v >> 16); this.w8(addr + 4, v >> 8); this.w8(addr + 6, v); }
  }

  group4(op, pc0) {
    const mode = (op >> 3) & 7, reg = op & 7;
    if ((op & 0x1c0) === 0x1c0) { // LEA
      const e = this.ea(mode, reg, 2);
      this.a[(op >> 9) & 7] = e.addr;
      return;
    }
    if ((op & 0x1c0) === 0x180) { // CHK.W
      const e = this.ea(mode, reg, 1), bound = sx16(this.get(e, 1)), v = sx16(this.d[(op >> 9) & 7]);
      this.sr = (this.sr & ~0x0f) | (v === 0 ? 4 : 0); // Z, V and C as the 68000 leaves them
      if (v < 0 || v > bound) { this.sr = (this.sr & ~8) | (v < 0 ? 8 : 0); this.exception(6); }
      return;
    }
    switch (op) {
      case 0x4e71: return; // NOP
      case 0x4e75: this.pc = this.pop32(); return; // RTS
      case 0x4e73: { const sr = this.pop16(); this.pc = this.pop32(); this.setSR(sr); return; } // RTE
      case 0x4e77: { const ccr = this.pop16(); this.sr = (this.sr & 0xff00) | (ccr & 0x1f); this.pc = this.pop32(); return; } // RTR
      case 0x4e70: return; // RESET
      case 0x4e72: this.setSR(this.fetch16()); this.stopped = true; return; // STOP
      case 0x4e76: if (this.sr & 2) this.exception(7); return; // TRAPV
      case 0x4afc: this.pc = pc0; this.exception(4); return; // ILLEGAL
    }
    const hi = op & 0xfff0;
    if (hi === 0x4e40) return this.exception(32 + (op & 15)); // TRAP
    if ((op & 0xfff8) === 0x4e50) { // LINK
      const d = sx16(this.fetch16());
      this.push32(this.a[reg] >>> 0); this.a[reg] = this.a[7]; this.a[7] += d; return;
    }
    if ((op & 0xfff8) === 0x4e58) { this.a[7] = this.a[reg]; this.a[reg] = this.pop32(); return; } // UNLK
    if ((op & 0xfff8) === 0x4e60) { this.usp = this.a[reg]; return; } // MOVE An,USP
    if ((op & 0xfff8) === 0x4e68) { this.a[reg] = this.usp; return; } // MOVE USP,An
    if ((op & 0xffc0) === 0x4e80) { const e = this.ea(mode, reg, 2); this.push32(this.pc); this.pc = e.addr; return; } // JSR
    if ((op & 0xffc0) === 0x4ec0) { const e = this.ea(mode, reg, 2); this.pc = e.addr; return; } // JMP
    if ((op & 0xfff8) === 0x4840) { const v = this.d[reg] >>> 0; const r = ((v >>> 16) | (v << 16)) >>> 0; this.d[reg] = r; this.setNZVC0(r, 2); return; } // SWAP
    if ((op & 0xffc0) === 0x4840) { const e = this.ea(mode, reg, 2); this.push32(e.addr); return; } // PEA
    if ((op & 0xfff8) === 0x4880) { const v = sx8(this.d[reg]) & 0xffff; this.d[reg] = (this.d[reg] & ~0xffff) | v; this.setNZVC0(v, 1); return; } // EXT.W
    if ((op & 0xfff8) === 0x48c0) { const v = sx16(this.d[reg]); this.d[reg] = v; this.setNZVC0(v >>> 0, 2); return; } // EXT.L
    if ((op & 0xfb80) === 0x4880) return this.movem(op); // MOVEM
    if ((op & 0xffc0) === 0x40c0) { const e = this.ea(mode, reg, 1); this.set(e, 1, this.sr); return; } // MOVE from SR
    if ((op & 0xffc0) === 0x44c0) { const e = this.ea(mode, reg, 1); this.sr = (this.sr & 0xff00) | (this.get(e, 1) & 0x1f); return; } // MOVE to CCR
    if ((op & 0xffc0) === 0x46c0) { const e = this.ea(mode, reg, 1); this.setSR(this.get(e, 1)); return; } // MOVE to SR
    if ((op & 0xffc0) === 0x4800) { // NBCD
      const e = this.ea(mode, reg, 0), v = this.get(e, 0);
      this.set(e, 0, this.nbcd(v)); return;
    }
    if ((op & 0xffc0) === 0x4ac0) { // TAS
      const e = this.ea(mode, reg, 0), v = this.get(e, 0);
      this.setNZVC0(v, 0); this.set(e, 0, v | 0x80); return;
    }
    const s = (op >> 6) & 3;
    if (s === 3) throw new Error(`68000: opcode $${op.toString(16)} not handled`);
    switch (op & 0xff00) {
      case 0x4000: { const e = this.ea(mode, reg, s), v = this.get(e, s); const r = this.sub(0, v, s, this.X); const z = r.z ? (this.sr >> 2) & 1 : 0; this.set(e, s, r.res); this.ccr(r.c, r.n, z, r.v, r.c); return; } // NEGX
      case 0x4200: { const e = this.ea(mode, reg, s); this.set(e, s, 0); this.sr = (this.sr & ~0xf) | 4; return; } // CLR
      case 0x4400: { const e = this.ea(mode, reg, s), v = this.get(e, s); const r = this.sub(0, v, s); this.set(e, s, r.res); this.ccr(r.c, r.n, r.z, r.v, r.c); return; } // NEG
      case 0x4600: { const e = this.ea(mode, reg, s), v = (~this.get(e, s)) >>> 0; this.set(e, s, v); this.setNZVC0(v, s); return; } // NOT
      case 0x4a00: { const e = this.ea(mode, reg, s); this.setNZVC0(this.get(e, s), s); return; } // TST
    }
    throw new Error(`68000: opcode $${op.toString(16)} not handled`);
  }

  movem(op) {
    const toMem = !(op & 0x400), s = op & 0x40 ? 2 : 1, mode = (op >> 3) & 7, reg = op & 7;
    const mask = this.fetch16();
    const regs = i => (i < 8 ? ["d", i] : ["a", i - 8]);
    if (mode === 4) { // predecrement: registers stored A7..D0
      let addr = this.a[reg] >>> 0;
      for (let i = 15; i >= 0; i--) {
        if (!(mask & (1 << (15 - i)))) continue;
        addr -= SIZE[s];
        const [k, r] = regs(i);
        this.write(addr, s, this[k][r]);
      }
      this.a[reg] = addr;
      return;
    }
    let addr;
    if (mode === 3) addr = this.a[reg] >>> 0;
    else addr = this.ea(mode, reg, s).addr;
    for (let i = 0; i < 16; i++) {
      if (!(mask & (1 << i))) continue;
      const [k, r] = regs(i);
      if (toMem) this.write(addr, s, this[k][r]);
      else { const v = this.read(addr, s); this[k][r] = s === 1 ? sx16(v) : v; }
      addr += SIZE[s];
    }
    if (mode === 3) this.a[reg] = addr;
  }

  group5(op) {
    const mode = (op >> 3) & 7, reg = op & 7, s = (op >> 6) & 3;
    if (s === 3) {
      const c = (op >> 8) & 15;
      if (mode === 1) { // DBcc
        const d = sx16(this.fetch16());
        if (!this.cond(c)) {
          const v = ((this.d[reg] & 0xffff) - 1) & 0xffff;
          this.d[reg] = (this.d[reg] & ~0xffff) | v;
          if (v !== 0xffff) this.pc = (this.pc - 2 + d) >>> 0;
        }
        return;
      }
      const e = this.ea(mode, reg, 0); // Scc
      this.set(e, 0, this.cond(c) ? 0xff : 0);
      return;
    }
    let q = (op >> 9) & 7;
    if (q === 0) q = 8;
    const sub = op & 0x100;
    if (mode === 1) { this.a[reg] += sub ? -q : q; return; } // ADDQ/SUBQ to An: whole register, no flags
    const e = this.ea(mode, reg, s), v = this.get(e, s);
    const r = sub ? this.sub(v, q, s) : this.add(v, q, s);
    this.set(e, s, r.res);
    this.ccr(r.c, r.n, r.z, r.v, r.c);
  }

  branch(op) {
    const c = (op >> 8) & 15;
    const base = this.pc;
    let d = sx8(op);
    if (d === 0) d = sx16(this.fetch16());
    if (c === 1) { this.push32(this.pc); this.pc = (base + d) >>> 0; return; } // BSR
    if (this.cond(c)) this.pc = (base + d) >>> 0;
  }

  group8(op) { // OR, DIVU, DIVS, SBCD
    const mode = (op >> 3) & 7, reg = op & 7, dr = (op >> 9) & 7, opm = (op >> 6) & 7;
    if (opm === 3 || opm === 7) { // DIVU / DIVS
      const e = this.ea(mode, reg, 1), src = this.get(e, 1);
      if (src === 0) { this.exception(5); return; }
      const dv = this.d[dr] >>> 0;
      if (opm === 3) {
        const q = Math.floor(dv / src), r = dv % src;
        if (q > 0xffff) { this.sr |= 2; return; }
        this.d[dr] = ((r << 16) | q) >>> 0; this.setNZVC0(q, 1);
      } else {
        const sv = sx16(src), num = this.d[dr];
        const q = Math.trunc(num / sv), r = num - q * sv;
        if (q > 32767 || q < -32768) { this.sr |= 2; return; }
        this.d[dr] = (((r & 0xffff) << 16) | (q & 0xffff)) >>> 0; this.setNZVC0(q & 0xffff, 1);
      }
      return;
    }
    if ((op & 0x1f0) === 0x100) { // SBCD
      if (op & 8) { this.a[reg]--; this.a[dr]--; const a = this.r8(this.a[reg] >>> 0), b = this.r8(this.a[dr] >>> 0); this.w8(this.a[dr] >>> 0, this.bcdSub(b, a)); }
      else this.d[dr] = (this.d[dr] & ~0xff) | this.bcdSub(this.d[dr] & 0xff, this.d[reg] & 0xff);
      return;
    }
    const s = opm & 3;
    if (opm & 4) { const e = this.ea(mode, reg, s); const r = (this.get(e, s) | this.d[dr]) >>> 0; this.set(e, s, r); this.setNZVC0(r, s); }
    else { const e = this.ea(mode, reg, s); const r = (this.get(e, s) | this.d[dr]) >>> 0; this.set({ k: "d", r: dr }, s, r); this.setNZVC0(r, s); }
  }

  addsub(op, isAdd) { // ADD/SUB, ADDA/SUBA, ADDX/SUBX
    const mode = (op >> 3) & 7, reg = op & 7, dr = (op >> 9) & 7, opm = (op >> 6) & 7;
    if (opm === 3 || opm === 7) { // ADDA/SUBA
      const s = opm === 3 ? 1 : 2;
      const e = this.ea(mode, reg, s);
      let v = this.get(e, s);
      if (s === 1) v = sx16(v);
      this.a[dr] = isAdd ? this.a[dr] + v : this.a[dr] - v;
      return;
    }
    const s = opm & 3;
    if (opm & 4 && (mode === 0 || mode === 1)) { // ADDX/SUBX
      let a, b, dst;
      if (mode === 0) { a = this.d[dr] & MASK[s]; b = this.d[reg] & MASK[s]; dst = { k: "d", r: dr }; }
      else {
        this.a[reg] -= SIZE[s]; b = this.read(this.a[reg] >>> 0, s);
        this.a[dr] -= SIZE[s]; dst = { k: "m", addr: this.a[dr] >>> 0 }; a = this.read(dst.addr, s);
      }
      const r = isAdd ? this.add(a >>> 0, b >>> 0, s, this.X) : this.sub(a >>> 0, b >>> 0, s, this.X);
      this.set(dst, s, r.res);
      const z = r.z ? (this.sr >> 2) & 1 : 0;
      this.ccr(r.c, r.n, z, r.v, r.c);
      return;
    }
    const e = this.ea(mode, reg, s);
    if (opm & 4) { // <ea> op Dn -> <ea>
      const a = this.get(e, s), b = (this.d[dr] & MASK[s]) >>> 0;
      const r = isAdd ? this.add(a, b, s) : this.sub(a, b, s);
      this.set(e, s, r.res);
      this.ccr(r.c, r.n, r.z, r.v, r.c);
    } else { // Dn op <ea> -> Dn
      const b = this.get(e, s), a = (this.d[dr] & MASK[s]) >>> 0;
      const r = isAdd ? this.add(a, b, s) : this.sub(a, b, s);
      this.set({ k: "d", r: dr }, s, r.res);
      this.ccr(r.c, r.n, r.z, r.v, r.c);
    }
  }

  groupB(op) { // CMP, CMPA, EOR, CMPM
    const mode = (op >> 3) & 7, reg = op & 7, dr = (op >> 9) & 7, opm = (op >> 6) & 7;
    if (opm === 3 || opm === 7) { // CMPA
      const s = opm === 3 ? 1 : 2;
      let v = this.get(this.ea(mode, reg, s), s);
      if (s === 1) v = sx16(v) >>> 0;
      const r = this.sub(this.a[dr] >>> 0, v >>> 0, 2);
      this.ccr(this.X, r.n, r.z, r.v, r.c);
      return;
    }
    const s = opm & 3;
    if (opm & 4) {
      if (mode === 1) { // CMPM
        const b = this.read(this.a[reg] >>> 0, s); this.a[reg] += reg === 7 && s === 0 ? 2 : SIZE[s];
        const a = this.read(this.a[dr] >>> 0, s); this.a[dr] += dr === 7 && s === 0 ? 2 : SIZE[s];
        const r = this.sub(a, b, s); this.ccr(this.X, r.n, r.z, r.v, r.c);
        return;
      }
      const e = this.ea(mode, reg, s); // EOR
      const r = (this.get(e, s) ^ this.d[dr]) >>> 0;
      this.set(e, s, r); this.setNZVC0(r, s);
      return;
    }
    const v = this.get(this.ea(mode, reg, s), s);
    const r = this.sub((this.d[dr] & MASK[s]) >>> 0, v, s);
    this.ccr(this.X, r.n, r.z, r.v, r.c);
  }

  groupC(op) { // AND, MULU, MULS, ABCD, EXG
    const mode = (op >> 3) & 7, reg = op & 7, dr = (op >> 9) & 7, opm = (op >> 6) & 7;
    if (opm === 3) { const v = this.get(this.ea(mode, reg, 1), 1); const r = ((this.d[dr] & 0xffff) * v) >>> 0; this.d[dr] = r; this.setNZVC0(r, 2); return; } // MULU
    if (opm === 7) { const v = sx16(this.get(this.ea(mode, reg, 1), 1)); const r = Math.imul(sx16(this.d[dr]), v); this.d[dr] = r; this.setNZVC0(r >>> 0, 2); return; } // MULS
    if ((op & 0x1f0) === 0x100) { // ABCD
      if (op & 8) { this.a[reg]--; this.a[dr]--; const a = this.r8(this.a[reg] >>> 0), b = this.r8(this.a[dr] >>> 0); this.w8(this.a[dr] >>> 0, this.bcdAdd(b, a)); }
      else this.d[dr] = (this.d[dr] & ~0xff) | this.bcdAdd(this.d[dr] & 0xff, this.d[reg] & 0xff);
      return;
    }
    if ((op & 0x1f8) === 0x140) { const t = this.d[dr]; this.d[dr] = this.d[reg]; this.d[reg] = t; return; } // EXG Dx,Dy
    if ((op & 0x1f8) === 0x148) { const t = this.a[dr]; this.a[dr] = this.a[reg]; this.a[reg] = t; return; } // EXG Ax,Ay
    if ((op & 0x1f8) === 0x188) { const t = this.d[dr]; this.d[dr] = this.a[reg]; this.a[reg] = t; return; } // EXG Dx,Ay
    const s = opm & 3;
    const e = this.ea(mode, reg, s);
    const r = (this.get(e, s) & this.d[dr]) >>> 0;
    if (opm & 4) this.set(e, s, r); else this.set({ k: "d", r: dr }, s, r);
    this.setNZVC0(r, s);
  }

  // BCD arithmetic as the 68000 does it, including what it does with invalid digits and the undefined N and V.
  bcdAdd(dst, src) {
    let res = (src & 15) + (dst & 15) + this.X;
    let v = ~res;
    if (res > 9) res += 6;
    res += (src & 0xf0) + (dst & 0xf0);
    const c = res > 0x99 ? 1 : 0;
    if (c) res -= 0xa0;
    v &= res;
    const n = res & 0x80 ? 1 : 0;
    res &= 0xff;
    this.sr = (this.sr & ~0x1b) | (c ? 0x11 : 0) | (n << 3) | (v & 0x80 ? 2 : 0);
    if (res) this.sr &= ~4; // Z is only ever cleared, so a chain of digits tests all of them
    return res;
  }
  bcdSub(dst, src) {
    let res = ((dst & 15) - (src & 15) - this.X) >>> 0;
    let v = ~res;
    if (res > 9) res -= 6;
    res = (res + (dst & 0xf0) - (src & 0xf0)) >>> 0;
    const c = res > 0x99 ? 1 : 0;
    if (c) res += 0xa0;
    res &= 0xff;
    v &= res;
    this.sr = (this.sr & ~0x1b) | (c ? 0x11 : 0) | (res & 0x80 ? 8 : 0) | (v & 0x80 ? 2 : 0);
    if (res) this.sr &= ~4;
    return res;
  }
  nbcd(dst) {
    let res = (0x9a - dst - this.X) & 0xff;
    if (res !== 0x9a) {
      let v = ~res;
      if ((res & 15) === 0xa) res = ((res & 0xf0) + 0x10) & 0xff;
      v &= res;
      this.sr = (this.sr & ~0x1b) | 0x11 | (res & 0x80 ? 8 : 0) | (v & 0x80 ? 2 : 0);
      if (res) this.sr &= ~4;
    } else this.sr = (this.sr & ~0x1b) | (res & 0x80 ? 8 : 0);
    return res;
  }

  shift(op) {
    const dr = op & 7;
    if (((op >> 6) & 3) === 3) { // memory shift by one, word
      const e = this.ea((op >> 3) & 7, op & 7, 1);
      const kind = (op >> 9) & 3, left = op & 0x100;
      const r = this.doShift(kind, left, this.get(e, 1), 1, 1);
      this.set(e, 1, r);
      return;
    }
    const s = (op >> 6) & 3, kind = (op >> 3) & 3, left = op & 0x100;
    let cnt = (op >> 9) & 7;
    if (op & 0x20) cnt = this.d[cnt] & 63; else if (cnt === 0) cnt = 8;
    const r = this.doShift(kind, left, (this.d[dr] & MASK[s]) >>> 0, s, cnt);
    this.set({ k: "d", r: dr }, s, r);
  }

  // 0 AS, 1 LS, 2 ROX, 3 RO. Sets flags; returns the result.
  doShift(kind, left, v, s, cnt) {
    const bits = SIZE[s] * 8, m = MASK[s], sg = SIGN[s];
    let c = 0, x = this.X, vflag = 0;
    if (cnt === 0) {
      const res = v & m;
      this.sr = (this.sr & ~0x0f) | (res & sg ? 8 : 0) | (res === 0 ? 4 : 0) | (kind === 2 ? x : 0);
      return res >>> 0;
    }
    for (let i = 0; i < cnt; i++) {
      if (left) {
        const out = v & sg ? 1 : 0;
        if (kind === 3) v = ((v << 1) | out) & m;
        else if (kind === 2) { v = ((v << 1) | x) & m; x = out; }
        else { const nv = (v << 1) & m; if (kind === 0 && (nv & sg ? 1 : 0) !== out) vflag = 1; v = nv; }
        c = out;
      } else {
        const out = v & 1;
        if (kind === 3) v = (v >>> 1) | (out ? sg : 0);
        else if (kind === 2) { v = (v >>> 1) | (x ? sg : 0); x = out; }
        else if (kind === 0) v = (v >>> 1) | (v & sg);
        else v = v >>> 1;
        v = (v & m) >>> 0;
        c = out;
      }
      v >>>= 0;
    }
    if (kind === 0 || kind === 1) x = c;
    if (kind === 2) c = x;
    const xbit = kind === 3 ? this.X : x;
    this.sr = (this.sr & 0xffe0) | (xbit << 4) | (v & sg ? 8 : 0) | ((v & m) === 0 ? 4 : 0) | (vflag << 1) | c;
    return (v & m) >>> 0;
  }
}
