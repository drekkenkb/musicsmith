// A Zilog Z80 interpreter with exact T-state counts (Genesis drivers time their sample playback by counting
// cycles), including the undocumented flag bits 3 and 5. The bus is supplied by the caller: read(addr),
// write(addr, v), and optionally input(port) / output(port, v).

const C = 1, N = 2, PV = 4, X = 8, H = 16, Y = 32, Z = 64, S = 128;
const SZ53 = new Uint8Array(256), SZ53P = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  SZ53[i] = (i & (S | X | Y)) | (i ? 0 : Z);
  let p = i; p ^= p >> 4; p ^= p >> 2; p ^= p >> 1;
  SZ53P[i] = SZ53[i] | (p & 1 ? 0 : PV);
}

// Base T-states of unprefixed opcodes (conditional jumps/calls/returns add their extra when taken).
const T = [
  4, 10, 7, 6, 4, 4, 7, 4, 4, 11, 7, 6, 4, 4, 7, 4, 8, 10, 7, 6, 4, 4, 7, 4, 12, 11, 7, 6, 4, 4, 7, 4,
  7, 10, 16, 6, 4, 4, 7, 4, 7, 11, 16, 6, 4, 4, 7, 4, 7, 10, 13, 6, 11, 11, 10, 4, 7, 11, 13, 6, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4, 7, 7, 7, 7, 7, 7, 4, 7, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  5, 10, 10, 10, 10, 11, 7, 11, 5, 10, 10, 0, 10, 17, 7, 11, 5, 10, 10, 11, 10, 11, 7, 11, 5, 4, 10, 11, 10, 0, 7, 11,
  5, 10, 10, 19, 10, 11, 7, 11, 5, 4, 10, 4, 10, 0, 7, 11, 5, 10, 10, 4, 10, 11, 7, 11, 5, 6, 10, 4, 10, 0, 7, 11,
];

export class Z80 {
  constructor(bus) {
    this.bus = bus;
    this.a = 0xff; this.f = 0xff; this.b = 0; this.c = 0; this.d = 0; this.e = 0; this.h = 0; this.l = 0;
    this.a_ = 0; this.f_ = 0; this.b_ = 0; this.c_ = 0; this.d_ = 0; this.e_ = 0; this.h_ = 0; this.l_ = 0;
    this.ix = 0xffff; this.iy = 0xffff; this.sp = 0xffff; this.pc = 0;
    this.i = 0; this.r = 0; this.iff1 = 0; this.iff2 = 0; this.im = 0; this.halted = false;
    this.wz = 0;
    this.cycles = 0;
    this.eiDelay = false;
  }

  rd(a) { return this.bus.read(a & 0xffff) & 0xff; }
  wr(a, v) { this.bus.write(a & 0xffff, v & 0xff); }
  fetch() { const v = this.rd(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  fetch16() { const lo = this.fetch(); return lo | this.fetch() << 8; }
  push(v) { this.sp = (this.sp - 1) & 0xffff; this.wr(this.sp, v >> 8); this.sp = (this.sp - 1) & 0xffff; this.wr(this.sp, v & 0xff); }
  pop() { const lo = this.rd(this.sp); this.sp = (this.sp + 1) & 0xffff; const hi = this.rd(this.sp); this.sp = (this.sp + 1) & 0xffff; return lo | hi << 8; }
  incR() { this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f); }

  get bc() { return this.b << 8 | this.c; } set bc(v) { this.b = (v >> 8) & 0xff; this.c = v & 0xff; }
  get de() { return this.d << 8 | this.e; } set de(v) { this.d = (v >> 8) & 0xff; this.e = v & 0xff; }
  get hl() { return this.h << 8 | this.l; } set hl(v) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }
  get af() { return this.a << 8 | this.f; } set af(v) { this.a = (v >> 8) & 0xff; this.f = v & 0xff; }

  // ---- interrupts
  interrupt(data = 0xff) {
    if (!this.iff1 || this.eiDelay) return false;
    this.halted = false;
    this.iff1 = this.iff2 = 0;
    this.incR();
    if (this.im === 2) { this.push(this.pc); const v = (this.i << 8) | data; this.pc = this.rd(v) | this.rd(v + 1) << 8; this.cycles += 19; }
    else if (this.im === 1) { this.push(this.pc); this.pc = 0x38; this.cycles += 13; }
    else { this.push(this.pc); this.pc = data & 0x38; this.cycles += 13; }
    this.wz = this.pc;
    return true;
  }

  // ---- ALU
  add8(v, carry = 0) {
    const a = this.a, r = a + v + carry;
    this.f = SZ53[r & 0xff] | ((r >> 8) & C) | ((a ^ v ^ r) & H) | (((a ^ ~v) & (a ^ r) & 0x80) ? PV : 0);
    this.a = r & 0xff;
  }
  sub8(v, carry = 0, store = true) {
    const a = this.a, r = a - v - carry;
    const f = ((r & 0xff) & (S | X | Y)) | ((r & 0xff) ? 0 : Z) | ((r >> 8) & C) | N | ((a ^ v ^ r) & H) | (((a ^ v) & (a ^ r) & 0x80) ? PV : 0);
    if (store) { this.f = f; this.a = r & 0xff; }
    else this.f = (f & ~(X | Y)) | (v & (X | Y)); // CP takes bits 3 and 5 from the operand
  }
  and8(v) { this.a &= v; this.f = SZ53P[this.a] | H; }
  xor8(v) { this.a ^= v; this.f = SZ53P[this.a]; }
  or8(v) { this.a |= v; this.f = SZ53P[this.a]; }
  alu(k, v) {
    switch (k) {
      case 0: return this.add8(v);
      case 1: return this.add8(v, this.f & C);
      case 2: return this.sub8(v);
      case 3: return this.sub8(v, this.f & C);
      case 4: return this.and8(v);
      case 5: return this.xor8(v);
      case 6: return this.or8(v);
      default: return this.sub8(v, 0, false);
    }
  }
  inc8(v) { const r = (v + 1) & 0xff; this.f = (this.f & C) | SZ53[r] | (r === 0x80 ? PV : 0) | ((r & 15) === 0 ? H : 0); return r; }
  dec8(v) { const r = (v - 1) & 0xff; this.f = (this.f & C) | N | SZ53[r] | (r === 0x7f ? PV : 0) | ((v & 15) === 0 ? H : 0); return r; }
  add16(a, b) {
    const r = a + b;
    this.f = (this.f & (S | Z | PV)) | ((r >> 16) & C) | (((a ^ b ^ r) >> 8) & H) | ((r >> 8) & (X | Y));
    this.wz = (a + 1) & 0xffff;
    return r & 0xffff;
  }
  adc16(v) {
    const a = this.hl, r = a + v + (this.f & C);
    this.f = ((r >> 16) & C) | (((a ^ v ^ r) >> 8) & H) | ((r >> 8) & (S | X | Y)) | ((r & 0xffff) ? 0 : Z) | (((a ^ ~v) & (a ^ r) & 0x8000) ? PV : 0);
    this.wz = (a + 1) & 0xffff;
    this.hl = r & 0xffff;
  }
  sbc16(v) {
    const a = this.hl, r = a - v - (this.f & C);
    this.f = ((r >> 16) & C) | N | (((a ^ v ^ r) >> 8) & H) | ((r >> 8) & (S | X | Y)) | ((r & 0xffff) ? 0 : Z) | (((a ^ v) & (a ^ r) & 0x8000) ? PV : 0);
    this.wz = (a + 1) & 0xffff;
    this.hl = r & 0xffff;
  }
  rot(k, v) { // CB rotates and shifts: RLC RRC RL RR SLA SRA SLL SRL
    let r, c;
    switch (k) {
      case 0: c = v >> 7; r = ((v << 1) | c) & 0xff; break;
      case 1: c = v & 1; r = (v >> 1) | (c << 7); break;
      case 2: c = v >> 7; r = ((v << 1) | (this.f & C)) & 0xff; break;
      case 3: c = v & 1; r = (v >> 1) | ((this.f & C) << 7); break;
      case 4: c = v >> 7; r = (v << 1) & 0xff; break;
      case 5: c = v & 1; r = (v >> 1) | (v & 0x80); break;
      case 6: c = v >> 7; r = ((v << 1) | 1) & 0xff; break;
      default: c = v & 1; r = v >> 1; break;
    }
    this.f = SZ53P[r] | c;
    return r;
  }

  // ---- registers by index: 0 B 1 C 2 D 3 E 4 H 5 L 6 (HL) 7 A; with a prefix, H/L are IXH/IXL (or IY)
  getR(i, px) {
    switch (i) {
      case 0: return this.b; case 1: return this.c; case 2: return this.d; case 3: return this.e;
      case 4: return px ? this[px] >> 8 : this.h;
      case 5: return px ? this[px] & 0xff : this.l;
      case 7: return this.a;
    }
  }
  setR(i, v, px) {
    v &= 0xff;
    switch (i) {
      case 0: this.b = v; break; case 1: this.c = v; break; case 2: this.d = v; break; case 3: this.e = v; break;
      case 4: if (px) this[px] = (this[px] & 0xff) | (v << 8); else this.h = v; break;
      case 5: if (px) this[px] = (this[px] & 0xff00) | v; else this.l = v; break;
      case 7: this.a = v; break;
    }
  }
  getRP(i, px) { return i === 0 ? this.bc : i === 1 ? this.de : i === 2 ? (px ? this[px] : this.hl) : this.sp; }
  setRP(i, v, px) { v &= 0xffff; if (i === 0) this.bc = v; else if (i === 1) this.de = v; else if (i === 2) { if (px) this[px] = v; else this.hl = v; } else this.sp = v; }
  cond(c) {
    const f = this.f;
    switch (c) {
      case 0: return !(f & Z); case 1: return !!(f & Z); case 2: return !(f & C); case 3: return !!(f & C);
      case 4: return !(f & PV); case 5: return !!(f & PV); case 6: return !(f & S); default: return !!(f & S);
    }
  }

  // ---- one instruction; returns T-states
  step() {
    if (this.halted) { this.incR(); this.cycles += 4; return 4; }
    this.eiDelay = false;
    const start = this.cycles;
    let op = this.fetch();
    this.incR();
    if (op === 0xdd || op === 0xfd) {
      let px = op === 0xdd ? "ix" : "iy";
      op = this.fetch(); this.incR();
      while (op === 0xdd || op === 0xfd) { this.cycles += 4; px = op === 0xdd ? "ix" : "iy"; op = this.fetch(); this.incR(); }
      if (op === 0xcb) this.indexedCB(px);
      else if (op === 0xed) this.groupED();
      else this.main(op, px);
      this.cycles += 4;
    } else if (op === 0xcb) this.groupCB();
    else if (op === 0xed) this.groupED();
    else this.main(op, null);
    return this.cycles - start;
  }

  // The address an (HL) operand uses: HL, or IX/IY plus a displacement (read here).
  memAddr(px) {
    if (!px) return this.hl;
    const d = (this.fetch() << 24) >> 24;
    const a = (this[px] + d) & 0xffff;
    this.wz = a;
    return a;
  }

  main(op, px) {
    this.cycles += T[op];
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    if (x === 1) { // LD r,r' (HALT at 76)
      if (op === 0x76) { this.halted = true; return; } // PC stays past the HALT; an interrupt returns there
      if (y === 6) { const a = this.memAddr(px); if (px) this.cycles += 8; this.wr(a, this.getR(z, null)); return; }
      if (z === 6) { const a = this.memAddr(px); if (px) this.cycles += 8; this.setR(y, this.rd(a), null); return; }
      this.setR(y, this.getR(z, px), px);
      return;
    }
    if (x === 2) { // ALU A,r
      let v;
      if (z === 6) { const a = this.memAddr(px); if (px) this.cycles += 8; v = this.rd(a); } else v = this.getR(z, px);
      this.alu(y, v);
      return;
    }
    if (x === 0) {
      switch (z) {
        case 0:
          if (y === 0) return; // NOP
          if (y === 1) { const t = this.af; this.af = this.a_ << 8 | this.f_; this.a_ = t >> 8; this.f_ = t & 0xff; return; } // EX AF,AF'
          if (y === 2) { const d = (this.fetch() << 24) >> 24; this.b = (this.b - 1) & 0xff; if (this.b) { this.pc = (this.pc + d) & 0xffff; this.wz = this.pc; this.cycles += 5; } return; } // DJNZ
          { const d = (this.fetch() << 24) >> 24; if (y === 3 || this.cond(y - 4)) { this.pc = (this.pc + d) & 0xffff; this.wz = this.pc; if (y !== 3) this.cycles += 5; } return; } // JR / JR cc
        case 1:
          if (y & 1) { const p = y >> 1; const r = this.add16(px && true ? this.getRP(2, px) : this.hl, this.getRP(p, px)); if (px) this[px] = r; else this.hl = r; return; } // ADD HL,rr
          this.setRP(y >> 1, this.fetch16(), px); return; // LD rr,nn
        case 2:
          switch (y) {
            case 0: this.wr(this.bc, this.a); this.wz = ((this.bc + 1) & 0xff) | (this.a << 8); return;
            case 1: this.a = this.rd(this.bc); this.wz = (this.bc + 1) & 0xffff; return;
            case 2: this.wr(this.de, this.a); this.wz = ((this.de + 1) & 0xff) | (this.a << 8); return;
            case 3: this.a = this.rd(this.de); this.wz = (this.de + 1) & 0xffff; return;
            case 4: { const a = this.fetch16(); const v = px ? this[px] : this.hl; this.wr(a, v & 0xff); this.wr(a + 1, v >> 8); this.wz = (a + 1) & 0xffff; return; }
            case 5: { const a = this.fetch16(); const v = this.rd(a) | this.rd(a + 1) << 8; if (px) this[px] = v; else this.hl = v; this.wz = (a + 1) & 0xffff; return; }
            case 6: { const a = this.fetch16(); this.wr(a, this.a); this.wz = ((a + 1) & 0xff) | (this.a << 8); return; }
            default: { const a = this.fetch16(); this.a = this.rd(a); this.wz = (a + 1) & 0xffff; return; }
          }
        case 3: this.setRP(y >> 1, this.getRP(y >> 1, px) + (y & 1 ? -1 : 1), px); return; // INC/DEC rr
        case 4: case 5: { // INC/DEC r
          const f = z === 4 ? v => this.inc8(v) : v => this.dec8(v);
          if (y === 6) { const a = this.memAddr(px); if (px) this.cycles += 8; this.wr(a, f(this.rd(a))); }
          else this.setR(y, f(this.getR(y, px)), px);
          return;
        }
        case 6: { // LD r,n
          if (y === 6) { const a = this.memAddr(px); if (px) this.cycles += 5; this.wr(a, this.fetch()); }
          else this.setR(y, this.fetch(), px);
          return;
        }
        case 7:
          switch (y) {
            case 0: { const c = this.a >> 7; this.a = ((this.a << 1) | c) & 0xff; this.f = (this.f & (S | Z | PV)) | (this.a & (X | Y)) | c; return; } // RLCA
            case 1: { const c = this.a & 1; this.a = (this.a >> 1) | (c << 7); this.f = (this.f & (S | Z | PV)) | (this.a & (X | Y)) | c; return; } // RRCA
            case 2: { const c = this.a >> 7; this.a = ((this.a << 1) | (this.f & C)) & 0xff; this.f = (this.f & (S | Z | PV)) | (this.a & (X | Y)) | c; return; } // RLA
            case 3: { const c = this.a & 1; this.a = (this.a >> 1) | ((this.f & C) << 7); this.f = (this.f & (S | Z | PV)) | (this.a & (X | Y)) | c; return; } // RRA
            case 4: { // DAA
              const a = this.a, f = this.f;
              let corr = 0, c = f & C;
              if (f & H || (a & 15) > 9) corr |= 6;
              if (c || a > 0x99) { corr |= 0x60; c = C; }
              const r = f & N ? (a - corr) & 0xff : (a + corr) & 0xff;
              const h = f & N ? (f & H && (a & 15) < 6 ? H : 0) : ((a & 15) > 9 ? H : 0);
              this.a = r; this.f = SZ53P[r] | c | (f & N) | h;
              return;
            }
            case 5: this.a ^= 0xff; this.f = (this.f & (S | Z | PV | C)) | H | N | (this.a & (X | Y)); return; // CPL
            case 6: this.f = (this.f & (S | Z | PV)) | C | (this.a & (X | Y)); return; // SCF
            default: { const c = this.f & C; this.f = (this.f & (S | Z | PV)) | (c ? H : C) | (this.a & (X | Y)); return; } // CCF
          }
      }
    }
    // x === 3
    switch (z) {
      case 0: if (this.cond(y)) { this.pc = this.pop(); this.wz = this.pc; this.cycles += 6; } return; // RET cc
      case 1:
        if (!(y & 1)) { const v = this.pop(); if (y >> 1 === 3) this.af = v; else this.setRP(y >> 1, v, px); return; } // POP
        switch (y >> 1) {
          case 0: this.pc = this.pop(); this.wz = this.pc; return; // RET
          case 1: { // EXX
            for (const r of ["b", "c", "d", "e", "h", "l"]) { const t = this[r]; this[r] = this[r + "_"]; this[r + "_"] = t; }
            return;
          }
          case 2: this.pc = px ? this[px] : this.hl; return; // JP (HL)
          default: this.sp = px ? this[px] : this.hl; return; // LD SP,HL
        }
      case 2: { const a = this.fetch16(); this.wz = a; if (this.cond(y)) this.pc = a; return; } // JP cc,nn
      case 3:
        switch (y) {
          case 0: { const a = this.fetch16(); this.pc = a; this.wz = a; return; } // JP nn
          case 2: { const n = this.fetch(); this.out(n | (this.a << 8), this.a); this.wz = ((n + 1) & 0xff) | (this.a << 8); return; } // OUT (n),A
          case 3: { const n = this.fetch(); const port = n | (this.a << 8); this.wz = (port + 1) & 0xffff; this.a = this.in(port); return; } // IN A,(n)
          case 4: { // EX (SP),HL
            const lo = this.rd(this.sp), hi = this.rd(this.sp + 1), v = px ? this[px] : this.hl;
            this.wr(this.sp, v & 0xff); this.wr(this.sp + 1, v >> 8);
            const n = lo | hi << 8; if (px) this[px] = n; else this.hl = n; this.wz = n;
            return;
          }
          case 5: { const t = this.de; this.de = this.hl; this.hl = t; return; } // EX DE,HL
          case 6: this.iff1 = this.iff2 = 0; return; // DI
          default: this.iff1 = this.iff2 = 1; this.eiDelay = true; return; // EI
        }
      case 4: { const a = this.fetch16(); this.wz = a; if (this.cond(y)) { this.push(this.pc); this.pc = a; this.cycles += 7; } return; } // CALL cc
      case 5:
        if (!(y & 1)) { const v = y >> 1 === 3 ? this.af : this.getRP(y >> 1, px); this.push(v); return; } // PUSH
        { const a = this.fetch16(); this.wz = a; this.push(this.pc); this.pc = a; return; } // CALL nn
      case 6: this.alu(y, this.fetch()); return; // ALU A,n
      default: this.push(this.pc); this.pc = y * 8; this.wz = this.pc; return; // RST
    }
  }

  groupCB() {
    const op = this.fetch();
    this.incR();
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    if (z === 6) {
      const a = this.hl, v = this.rd(a);
      if (x === 1) { this.bitFlags(y, v, this.wz >> 8); this.cycles += 12; return; }
      this.cycles += 15;
      this.wr(a, x === 0 ? this.rot(y, v) : x === 2 ? v & ~(1 << y) : v | (1 << y));
      return;
    }
    this.cycles += 8;
    const v = this.getR(z, null);
    if (x === 0) this.setR(z, this.rot(y, v), null);
    else if (x === 1) this.bitFlags(y, v, v);
    else this.setR(z, x === 2 ? v & ~(1 << y) : v | (1 << y), null);
  }
  bitFlags(b, v, xy) {
    const r = v & (1 << b);
    this.f = (this.f & C) | H | (xy & (X | Y)) | (r ? 0 : Z | PV) | (b === 7 && r ? S : 0);
  }

  indexedCB(px) {
    const d = (this.fetch() << 24) >> 24;
    const op = this.fetch();
    const a = (this[px] + d) & 0xffff;
    this.wz = a;
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    const v = this.rd(a);
    if (x === 1) { this.bitFlags(y, v, a >> 8); this.cycles += 16; return; }
    this.cycles += 19;
    const r = x === 0 ? this.rot(y, v) : x === 2 ? v & ~(1 << y) : v | (1 << y);
    this.wr(a, r);
    if (z !== 6) this.setR(z, r, null); // undocumented: the result also goes to a register
  }

  in(port) { return this.bus.input ? this.bus.input(port) & 0xff : 0xff; }
  out(port, v) { this.bus.output?.(port, v); }

  groupED() {
    const op = this.fetch();
    this.incR();
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    if (x === 1) {
      switch (z) {
        case 0: { this.cycles += 12; const v = this.in(this.bc); this.wz = (this.bc + 1) & 0xffff; if (y !== 6) this.setR(y, v, null); this.f = (this.f & C) | SZ53P[v]; return; } // IN r,(C)
        case 1: this.cycles += 12; this.out(this.bc, y === 6 ? 0 : this.getR(y, null)); this.wz = (this.bc + 1) & 0xffff; return; // OUT (C),r
        case 2: this.cycles += 15; if (y & 1) this.adc16(this.getRP(y >> 1, null)); else this.sbc16(this.getRP(y >> 1, null)); return;
        case 3: { // LD (nn),rr / LD rr,(nn)
          this.cycles += 20;
          const a = this.fetch16();
          if (y & 1) this.setRP(y >> 1, this.rd(a) | this.rd(a + 1) << 8, null);
          else { const v = this.getRP(y >> 1, null); this.wr(a, v & 0xff); this.wr(a + 1, v >> 8); }
          this.wz = (a + 1) & 0xffff;
          return;
        }
        case 4: { this.cycles += 8; const v = this.a; this.a = 0; this.sub8(v); return; } // NEG
        case 5: this.cycles += 14; this.pc = this.pop(); this.wz = this.pc; this.iff1 = this.iff2; return; // RETN / RETI
        case 6: this.cycles += 8; this.im = [0, 0, 1, 2, 0, 0, 1, 2][y]; return; // IM
        default:
          switch (y) {
            case 0: this.cycles += 9; this.i = this.a; return;
            case 1: this.cycles += 9; this.r = this.a; return;
            case 2: this.cycles += 9; this.a = this.i; this.f = (this.f & C) | SZ53[this.a] | (this.iff2 ? PV : 0); return;
            case 3: this.cycles += 9; this.a = this.r; this.f = (this.f & C) | SZ53[this.a] | (this.iff2 ? PV : 0); return;
            case 4: { // RRD
              this.cycles += 18;
              const v = this.rd(this.hl);
              this.wr(this.hl, ((this.a << 4) | (v >> 4)) & 0xff);
              this.a = (this.a & 0xf0) | (v & 15);
              this.f = (this.f & C) | SZ53P[this.a]; this.wz = (this.hl + 1) & 0xffff;
              return;
            }
            case 5: { // RLD
              this.cycles += 18;
              const v = this.rd(this.hl);
              this.wr(this.hl, ((v << 4) | (this.a & 15)) & 0xff);
              this.a = (this.a & 0xf0) | (v >> 4);
              this.f = (this.f & C) | SZ53P[this.a]; this.wz = (this.hl + 1) & 0xffff;
              return;
            }
            default: this.cycles += 8; return;
          }
      }
    }
    if (x === 2 && y >= 4 && z <= 3) return this.block(y, z);
    this.cycles += 8; // undefined ED opcodes act as two NOPs
  }

  block(y, z) {
    const inc = !(y & 1), repeat = y >= 6;
    const step = v => (v + (inc ? 1 : -1)) & 0xffff;
    if (z === 0) { // LDI LDD LDIR LDDR
      const v = this.rd(this.hl);
      this.wr(this.de, v);
      this.hl = step(this.hl); this.de = step(this.de); this.bc = (this.bc - 1) & 0xffff;
      const n = (v + this.a) & 0xff;
      this.f = (this.f & (S | Z | C)) | (this.bc ? PV : 0) | (n & X) | ((n << 4) & Y);
      this.cycles += 16;
      if (repeat && this.bc) { this.pc = (this.pc - 2) & 0xffff; this.wz = (this.pc + 1) & 0xffff; this.cycles += 5; }
      return;
    }
    if (z === 1) { // CPI CPD CPIR CPDR
      const v = this.rd(this.hl), r = (this.a - v) & 0xff;
      const h = (this.a ^ v ^ r) & H;
      this.hl = step(this.hl); this.bc = (this.bc - 1) & 0xffff;
      const n = (r - (h ? 1 : 0)) & 0xff;
      this.f = (this.f & C) | N | (r & S) | (r ? 0 : Z) | h | (this.bc ? PV : 0) | (n & X) | ((n << 4) & Y);
      this.wz = step(this.wz);
      this.cycles += 16;
      if (repeat && this.bc && r) { this.pc = (this.pc - 2) & 0xffff; this.wz = (this.pc + 1) & 0xffff; this.cycles += 5; }
      return;
    }
    // INI IND INIR INDR / OUTI OUTD OTIR OTDR (approximate flags; Genesis drivers don't use port I/O)
    this.cycles += 16;
    if (z === 2) { const v = this.in(this.bc); this.wr(this.hl, v); }
    else { const v = this.rd(this.hl); this.b = (this.b - 1) & 0xff; this.out(this.bc, v); this.b = (this.b + 1) & 0xff; }
    this.b = (this.b - 1) & 0xff; this.hl = step(this.hl);
    this.f = (this.f & C) | N | SZ53[this.b];
    if (repeat && this.b) { this.pc = (this.pc - 2) & 0xffff; this.cycles += 5; }
  }

  // Runs for at least `n` T-states (interrupts are the caller's business). Returns T-states run.
  run(n) {
    let done = 0;
    while (done < n) done += this.step();
    return done;
  }
}
