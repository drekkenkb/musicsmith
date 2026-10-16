// The SNES sound chip: an SPC700 processor, its timers and ports, and the S-DSP that mixes eight voices of BRR
// samples (with ADSR/GAIN envelopes, noise, pitch modulation and echo). MusicSmith runs a game's own sound driver
// on it, so what you hear is what the game plays.

const CYCLES = [
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 6, 8, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 4, 6,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 5, 4, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 3, 8,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 6, 6, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 4, 5, 2, 2, 4, 3,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 5, 5, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 6,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 2, 4, 5, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 12, 5,
  3, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 2, 4, 4, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 4,
  3, 8, 4, 5, 4, 5, 4, 7, 2, 5, 6, 4, 5, 2, 4, 9, 2, 8, 4, 5, 5, 6, 6, 7, 4, 5, 5, 5, 2, 2, 6, 3,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 4, 5, 3, 4, 3, 4, 3, 2, 8, 4, 5, 4, 5, 5, 6, 3, 4, 5, 4, 2, 2, 4, 3,
];

// Envelope and noise rates: how many samples between steps, for rate 0-31 (0 = never).
const RATES = [0, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1];
const OFFSETS = [1, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 0];

// The DSP's interpolation kernel: the hardware's 512-entry table, read as four 256-point quarters.
const GAUSS = Int16Array.from([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2,
  2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 8, 8, 8, 9, 9, 9, 10, 10, 10,
  11, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 15, 16, 16, 17, 17, 18, 19, 19, 20, 20, 21, 21, 22, 23, 23, 24, 24, 25, 26, 27, 27,
  28, 29, 29, 30, 31, 32, 32, 33, 34, 35, 36, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56,
  58, 59, 60, 61, 62, 64, 65, 66, 67, 69, 70, 71, 73, 74, 76, 77, 78, 80, 81, 83, 84, 86, 87, 89, 90, 92, 94, 95, 97, 99, 100, 102,
  104, 106, 107, 109, 111, 113, 115, 117, 118, 120, 122, 124, 126, 128, 130, 132, 134, 137, 139, 141, 143, 145, 147, 150, 152, 154, 156, 159, 161, 163, 166, 168,
  171, 173, 175, 178, 180, 183, 186, 188, 191, 193, 196, 199, 201, 204, 207, 210, 212, 215, 218, 221, 224, 227, 230, 233, 236, 239, 242, 245, 248, 251, 254, 257,
  260, 263, 267, 270, 273, 276, 280, 283, 286, 290, 293, 297, 300, 304, 307, 311, 314, 318, 321, 325, 328, 332, 336, 339, 343, 347, 351, 354, 358, 362, 366, 370,
  374, 378, 381, 385, 389, 393, 397, 401, 405, 410, 414, 418, 422, 426, 430, 434, 439, 443, 447, 451, 456, 460, 464, 469, 473, 477, 482, 486, 491, 495, 499, 504,
  508, 513, 517, 522, 527, 531, 536, 540, 545, 550, 554, 559, 563, 568, 573, 577, 582, 587, 592, 596, 601, 606, 611, 615, 620, 625, 630, 635, 640, 644, 649, 654,
  659, 664, 669, 674, 678, 683, 688, 693, 698, 703, 708, 713, 718, 723, 728, 732, 737, 742, 747, 752, 757, 762, 767, 772, 777, 782, 787, 792, 797, 802, 806, 811,
  816, 821, 826, 831, 836, 841, 846, 851, 855, 860, 865, 870, 875, 880, 884, 889, 894, 899, 904, 908, 913, 918, 923, 927, 932, 937, 941, 946, 951, 955, 960, 965,
  969, 974, 978, 983, 988, 992, 997, 1001, 1005, 1010, 1014, 1019, 1023, 1027, 1032, 1036, 1040, 1045, 1049, 1053, 1057, 1061, 1066, 1070, 1074, 1078, 1082, 1086, 1090, 1094, 1098, 1102,
  1106, 1109, 1113, 1117, 1121, 1125, 1128, 1132, 1136, 1139, 1143, 1146, 1150, 1153, 1157, 1160, 1164, 1167, 1170, 1174, 1177, 1180, 1183, 1186, 1190, 1193, 1196, 1199, 1202, 1205, 1207, 1210,
  1213, 1216, 1219, 1221, 1224, 1227, 1229, 1232, 1234, 1237, 1239, 1241, 1244, 1246, 1248, 1251, 1253, 1255, 1257, 1259, 1261, 1263, 1265, 1267, 1269, 1270, 1272, 1274, 1275, 1277, 1279, 1280,
  1282, 1283, 1284, 1286, 1287, 1288, 1290, 1291, 1292, 1293, 1294, 1295, 1296, 1297, 1297, 1298, 1299, 1300, 1300, 1301, 1302, 1302, 1303, 1303, 1303, 1304, 1304, 1304, 1304, 1304, 1305, 1305,
]);

const clamp16 = v => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);
const s8 = v => (v << 24) >> 24;

export class SPC {
  constructor() {
    this.ram = new Uint8Array(0x10000);
    this.dsp = new Uint8Array(128);
    this.a = 0; this.x = 0; this.y = 0; this.sp = 0xef; this.pc = 0; this.psw = 0;
    this.portIn = new Uint8Array(4); // what the SNES CPU has written for the driver to read
    this.portOut = new Uint8Array(4); // what the driver has written back
    this.dspAddr = 0;
    this.timers = [0, 1, 2].map(i => ({ on: false, target: 0, stage: 0, count: 0, out: 0, div: i === 2 ? 16 : 128 }));
    this.cycles = 0; // since the last DSP sample
    this.voices = Array.from({ length: 8 }, () => ({
      ring: new Int16Array(16), rpos: 0, have: 0, pos: 0, // decoded samples from ring[rpos], and the read fraction
      addr: 0, brrHeader: 0, p1: 0, p2: 0, env: 0, mode: 3, out: 0, konDelay: 0, ended: false,
    }));
    this.konPending = 0;
    this.counter = 0;
    this.noise = 0x4000;
    this.echoPos = 0;
    this.echoHist = [new Int16Array(8), new Int16Array(8)];
    this.histPos = 0;
    this.stopped = false;
    this.onDspWrite = null; // (reg, value): for traces
    this.mute = 0; // voices to leave out of the mix
  }

  // ---------------------------------------------------------------- memory

  read(addr) {
    if (addr >= 0xf0 && addr <= 0xff) {
      switch (addr) {
        case 0xf2: return this.dspAddr;
        case 0xf3: return this.readDsp(this.dspAddr & 0x7f);
        case 0xf4: case 0xf5: case 0xf6: case 0xf7: return this.portIn[addr - 0xf4];
        case 0xfd: case 0xfe: case 0xff: { const t = this.timers[addr - 0xfd], v = t.out; t.out = 0; return v; }
        default: return addr === 0xf0 || addr === 0xf1 || (addr >= 0xfa && addr <= 0xfc) ? 0 : this.ram[addr];
      }
    }
    return this.ram[addr];
  }

  write(addr, v) {
    if (addr >= 0xf0 && addr <= 0xff) {
      switch (addr) {
        case 0xf1:
          for (let i = 0; i < 3; i++) {
            const on = !!(v & (1 << i)), t = this.timers[i];
            if (on && !t.on) { t.stage = 0; t.out = 0; }
            t.on = on;
          }
          if (v & 0x10) { this.portIn[0] = 0; this.portIn[1] = 0; }
          if (v & 0x20) { this.portIn[2] = 0; this.portIn[3] = 0; }
          break;
        case 0xf2: this.dspAddr = v; break;
        case 0xf3: if (this.dspAddr < 0x80) this.writeDsp(this.dspAddr, v); break;
        case 0xf4: case 0xf5: case 0xf6: case 0xf7: this.portOut[addr - 0xf4] = v; break;
        case 0xfa: case 0xfb: case 0xfc: this.timers[addr - 0xfa].target = v; break;
      }
    }
    this.ram[addr] = v;
  }

  readDsp(r) {
    const lo = r & 15, vi = r >> 4;
    if (lo === 8) return this.voices[vi].env >> 4;
    if (lo === 9) return (this.voices[vi].out >> 8) & 0xff;
    return this.dsp[r];
  }

  writeDsp(r, v) {
    this.onDspWrite?.(r, v);
    if (r === 0x7c) { this.dsp[r] = 0; return; } // writing ENDX clears it
    if (r === 0x4c) this.konPending |= v;
    this.dsp[r] = v;
  }

  // ---------------------------------------------------------------- the processor

  get dp() { return this.psw & 0x20 ? 0x100 : 0; }
  fetch() { const v = this.read(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  fetchW() { const lo = this.fetch(); return lo | this.fetch() << 8; }
  push(v) { this.ram[0x100 | this.sp] = v; this.sp = (this.sp - 1) & 0xff; }
  pop() { this.sp = (this.sp + 1) & 0xff; return this.ram[0x100 | this.sp]; }
  nz(v) { this.psw = (this.psw & ~0x82) | (v & 0x80) | ((v & 0xff) === 0 ? 2 : 0); return v & 0xff; }
  get c() { return this.psw & 1; }
  setC(on) { this.psw = on ? this.psw | 1 : this.psw & ~1; }
  readDpW(d) { return this.read(this.dp | d) | this.read(this.dp | ((d + 1) & 0xff)) << 8; }
  writeDpW(d, v) { this.write(this.dp | d, v & 0xff); this.write(this.dp | ((d + 1) & 0xff), v >> 8); }

  adc(a, b) {
    const r = a + b + this.c;
    this.psw = (this.psw & ~0x49) | (r > 0xff ? 1 : 0) | ((~(a ^ b) & (a ^ r) & 0x80) ? 0x40 : 0) | (((a ^ b ^ r) & 0x10) ? 8 : 0);
    return this.nz(r);
  }
  sbc(a, b) { return this.adc(a, ~b & 0xff); }
  cmp(a, b) { const r = a - b; this.setC(r >= 0); this.nz(r); }

  // Effective addresses for the operand forms. Each reads its operand bytes.
  aD() { return this.dp | this.fetch(); }
  aDX() { return this.dp | ((this.fetch() + this.x) & 0xff); }
  aDY() { return this.dp | ((this.fetch() + this.y) & 0xff); }
  aAbs() { return this.fetchW(); }
  aAbsX() { return (this.fetchW() + this.x) & 0xffff; }
  aAbsY() { return (this.fetchW() + this.y) & 0xffff; }
  aIX() { return this.dp | this.x; }
  aIndX() { const d = (this.fetch() + this.x) & 0xff; return this.readDpW(d); }
  aIndY() { const d = this.fetch(); return (this.readDpW(d) + this.y) & 0xffff; }
  memBit() { const v = this.fetchW(); return { addr: v & 0x1fff, bit: v >> 13 }; }
  branch(cond) { const r = s8(this.fetch()); if (cond) { this.pc = (this.pc + r) & 0xffff; return 2; } return 0; }

  // The ALU group (OR AND EOR CMP ADC SBC) by the opcode's high bits.
  alu(k, a, b) {
    switch (k) {
      case 0: return this.nz(a | b);
      case 1: return this.nz(a & b);
      case 2: return this.nz(a ^ b);
      case 3: this.cmp(a, b); return a;
      case 4: return this.adc(a, b);
      default: return this.sbc(a, b);
    }
  }

  step() {
    const op = this.fetch();
    let extra = 0;
    const hi = op >> 4, lo = op & 15;
    // ALU block: rows 0-B even/odd pairs with A, using columns 4-9.
    if (hi <= 0xb && lo >= 4 && lo <= 9) {
      const k = hi >> 1, odd = hi & 1;
      if (lo === 9) { // dd,ds  or (X),(Y)
        let src, dst;
        if (!odd) { const s = this.fetch(); dst = this.dp | this.fetch(); src = this.read(this.dp | s); }
        else { src = this.read(this.dp | this.y); dst = this.dp | this.x; }
        const r = this.alu(k, this.read(dst), src);
        if (k !== 3) this.write(dst, r);
        return CYCLES[op];
      }
      if (lo === 8 && odd) { // d,#i
        const i = this.fetch(), d = this.dp | this.fetch();
        const r = this.alu(k, this.read(d), i);
        if (k !== 3) this.write(d, r);
        return CYCLES[op];
      }
      let addr = -1, val;
      if (!odd) {
        if (lo === 4) addr = this.aD();
        else if (lo === 5) addr = this.aAbs();
        else if (lo === 6) addr = this.aIX();
        else if (lo === 7) addr = this.aIndX();
        else if (lo === 8) val = this.fetch();
      } else {
        if (lo === 4) addr = this.aDX();
        else if (lo === 5) addr = this.aAbsX();
        else if (lo === 6) addr = this.aAbsY();
        else if (lo === 7) addr = this.aIndY();
      }
      if (addr >= 0) val = this.read(addr);
      this.a = this.alu(k, this.a, val);
      return CYCLES[op];
    }
    if (lo === 1) { // TCALL n
      this.push(this.pc >> 8); this.push(this.pc & 0xff);
      const v = 0xffde - hi * 2;
      this.pc = this.read(v) | this.read(v + 1) << 8;
      return CYCLES[op];
    }
    if (lo === 2) { // SET1/CLR1 d.b
      const d = this.aD(), bit = 1 << (hi >> 1);
      this.write(d, hi & 1 ? this.read(d) & ~bit : this.read(d) | bit);
      return CYCLES[op];
    }
    if (lo === 3) { // BBS/BBC d.b,r
      const v = this.read(this.aD()), r = s8(this.fetch()), set = !!(v & (1 << (hi >> 1)));
      if (set === !(hi & 1)) { this.pc = (this.pc + r) & 0xffff; extra = 2; }
      return CYCLES[op] + extra;
    }
    switch (op) {
      case 0x00: break;
      case 0x0a: case 0x2a: case 0x4a: case 0x6a: case 0x8a: case 0xaa: { // OR1 / OR1 / AND1 / AND1 / EOR1 / MOV1 C,m
        const { addr, bit } = this.memBit(), m = (this.read(addr) >> bit) & 1;
        if (op === 0x0a) this.setC(this.c | m);
        else if (op === 0x2a) this.setC(this.c | (m ^ 1));
        else if (op === 0x4a) this.setC(this.c & m);
        else if (op === 0x6a) this.setC(this.c & (m ^ 1));
        else if (op === 0x8a) this.setC(this.c ^ m);
        else this.setC(m);
        break;
      }
      case 0xca: { const { addr, bit } = this.memBit(); const v = this.read(addr); this.write(addr, this.c ? v | (1 << bit) : v & ~(1 << bit)); break; }
      case 0xea: { const { addr, bit } = this.memBit(); this.write(addr, this.read(addr) ^ (1 << bit)); break; }
      case 0x0b: case 0x2b: case 0x4b: case 0x6b: { const d = this.aD(); this.write(d, this.shift(op >> 5, this.read(d))); break; }
      case 0x0c: case 0x2c: case 0x4c: case 0x6c: { const d = this.aAbs(); this.write(d, this.shift(op >> 5, this.read(d))); break; }
      case 0x1b: case 0x3b: case 0x5b: case 0x7b: { const d = this.aDX(); this.write(d, this.shift(op >> 5, this.read(d))); break; }
      case 0x1c: case 0x3c: case 0x5c: case 0x7c: this.a = this.shift(op >> 5, this.a); break;
      case 0x0d: this.push(this.psw); break;
      case 0x2d: this.push(this.a); break;
      case 0x4d: this.push(this.x); break;
      case 0x6d: this.push(this.y); break;
      case 0x8e: this.psw = this.pop(); break;
      case 0xae: this.a = this.pop(); break;
      case 0xce: this.x = this.pop(); break;
      case 0xee: this.y = this.pop(); break;
      case 0x0e: case 0x4e: { // TSET1 / TCLR1 !a
        const d = this.aAbs(), v = this.read(d);
        this.nz((this.a - v) & 0xff);
        this.write(d, op === 0x0e ? v | this.a : v & ~this.a);
        break;
      }
      case 0x0f: // BRK
        this.push(this.pc >> 8); this.push(this.pc & 0xff); this.push(this.psw);
        this.psw = (this.psw | 0x10) & ~0x04;
        this.pc = this.read(0xffde) | this.read(0xffdf) << 8;
        break;
      case 0x10: extra = this.branch(!(this.psw & 0x80)); break;
      case 0x30: extra = this.branch(this.psw & 0x80); break;
      case 0x50: extra = this.branch(!(this.psw & 0x40)); break;
      case 0x70: extra = this.branch(this.psw & 0x40); break;
      case 0x90: extra = this.branch(!(this.psw & 1)); break;
      case 0xb0: extra = this.branch(this.psw & 1); break;
      case 0xd0: extra = this.branch(!(this.psw & 2)); break;
      case 0xf0: extra = this.branch(this.psw & 2); break;
      case 0x2f: extra = this.branch(true); break;
      case 0x1a: case 0x3a: { const d = this.fetch(), v = (this.readDpW(d) + (op === 0x3a ? 1 : -1)) & 0xffff; this.writeDpW(d, v); this.nz16(v); break; }
      case 0x1d: this.x = this.nz(this.x - 1); break;
      case 0x3d: this.x = this.nz(this.x + 1); break;
      case 0xdc: this.y = this.nz(this.y - 1); break;
      case 0xfc: this.y = this.nz(this.y + 1); break;
      case 0x9c: this.a = this.nz(this.a - 1); break;
      case 0xbc: this.a = this.nz(this.a + 1); break;
      case 0x8b: { const d = this.aD(); this.write(d, this.nz(this.read(d) - 1)); break; }
      case 0xab: { const d = this.aD(); this.write(d, this.nz(this.read(d) + 1)); break; }
      case 0x9b: { const d = this.aDX(); this.write(d, this.nz(this.read(d) - 1)); break; }
      case 0xbb: { const d = this.aDX(); this.write(d, this.nz(this.read(d) + 1)); break; }
      case 0x8c: { const d = this.aAbs(); this.write(d, this.nz(this.read(d) - 1)); break; }
      case 0xac: { const d = this.aAbs(); this.write(d, this.nz(this.read(d) + 1)); break; }
      case 0x1e: this.cmp(this.x, this.read(this.aAbs())); break;
      case 0x3e: this.cmp(this.x, this.read(this.aD())); break;
      case 0xc8: this.cmp(this.x, this.fetch()); break;
      case 0x5e: this.cmp(this.y, this.read(this.aAbs())); break;
      case 0x7e: this.cmp(this.y, this.read(this.aD())); break;
      case 0xad: this.cmp(this.y, this.fetch()); break;
      case 0x1f: { const a = this.aAbsX(); this.pc = this.read(a) | this.read((a + 1) & 0xffff) << 8; break; }
      case 0x5f: this.pc = this.fetchW(); break;
      case 0x3f: { const a = this.fetchW(); this.push(this.pc >> 8); this.push(this.pc & 0xff); this.pc = a; break; }
      case 0x4f: { const u = this.fetch(); this.push(this.pc >> 8); this.push(this.pc & 0xff); this.pc = 0xff00 | u; break; }
      case 0x6f: { const l = this.pop(); this.pc = l | this.pop() << 8; break; }
      case 0x7f: { this.psw = this.pop(); const l = this.pop(); this.pc = l | this.pop() << 8; break; }
      case 0x20: this.psw &= ~0x20; break;
      case 0x40: this.psw |= 0x20; break;
      case 0x60: this.psw &= ~1; break;
      case 0x80: this.psw |= 1; break;
      case 0xa0: this.psw |= 4; break;
      case 0xc0: this.psw &= ~4; break;
      case 0xe0: this.psw &= ~0x48; break;
      case 0xed: this.psw ^= 1; break;
      case 0x2e: { const v = this.read(this.aD()), r = s8(this.fetch()); if (this.a !== v) { this.pc = (this.pc + r) & 0xffff; extra = 2; } break; }
      case 0xde: { const v = this.read(this.aDX()), r = s8(this.fetch()); if (this.a !== v) { this.pc = (this.pc + r) & 0xffff; extra = 2; } break; }
      case 0x6e: { const d = this.aD(), v = (this.read(d) - 1) & 0xff, r = s8(this.fetch()); this.write(d, v); if (v) { this.pc = (this.pc + r) & 0xffff; extra = 2; } break; }
      case 0xfe: { const r = s8(this.fetch()); this.y = (this.y - 1) & 0xff; if (this.y) { this.pc = (this.pc + r) & 0xffff; extra = 2; } break; }
      case 0x5a: { const w = this.readDpW(this.fetch()), ya = this.y << 8 | this.a, r = ya - w; this.setC(r >= 0); this.nz16(r & 0xffff); break; }
      case 0x7a: case 0x9a: { // ADDW / SUBW YA,d
        const w = this.readDpW(this.fetch()), ya = this.y << 8 | this.a;
        let r, v, h;
        if (op === 0x7a) { r = ya + w; this.setC(r > 0xffff); v = ~(ya ^ w) & (ya ^ r) & 0x8000; h = (ya ^ w ^ r) & 0x1000; }
        else { r = ya - w; this.setC(r >= 0); v = (ya ^ w) & (ya ^ r) & 0x8000; h = !((ya ^ w ^ r) & 0x1000); }
        r &= 0xffff;
        this.psw = (this.psw & ~0x48) | (v ? 0x40 : 0) | (h ? 8 : 0);
        this.a = r & 0xff; this.y = r >> 8; this.nz16(r);
        break;
      }
      case 0xba: { const w = this.readDpW(this.fetch()); this.a = w & 0xff; this.y = w >> 8; this.nz16(w); break; }
      case 0xda: { const d = this.fetch(); this.writeDpW(d, this.y << 8 | this.a); break; }
      case 0xcf: { const r = this.y * this.a; this.a = r & 0xff; this.y = r >> 8; this.nz(this.y); break; }
      case 0x9e: { // DIV YA,X
        const ya = this.y << 8 | this.a, x = this.x;
        this.psw = (this.psw & ~0x48) | (this.y >= x ? 0x40 : 0) | ((this.y & 15) >= (x & 15) ? 8 : 0);
        let a, y;
        if (this.y < x << 1) { a = Math.floor(ya / x); y = ya - a * x; }
        else { a = 255 - Math.floor((ya - (x << 9)) / (256 - x)); y = x + (ya - (x << 9)) % (256 - x); }
        this.a = a & 0xff; this.y = y & 0xff; this.nz(this.a);
        break;
      }
      case 0x9f: this.a = this.nz((this.a >> 4) | (this.a << 4)); break;
      case 0xdf: { // DAA
        let a = this.a;
        if (this.c || a > 0x99) { a += 0x60; this.setC(true); }
        if (this.psw & 8 || (a & 15) > 9) a += 6;
        this.a = this.nz(a);
        break;
      }
      case 0xbe: { // DAS
        let a = this.a;
        if (!this.c || a > 0x99) { a -= 0x60; this.setC(false); }
        if (!(this.psw & 8) || (a & 15) > 9) a -= 6;
        this.a = this.nz(a);
        break;
      }
      case 0x5d: this.x = this.nz(this.a); break;
      case 0x7d: this.a = this.nz(this.x); break;
      case 0xdd: this.a = this.nz(this.y); break;
      case 0xfd: this.y = this.nz(this.a); break;
      case 0x9d: this.x = this.nz(this.sp); break;
      case 0xbd: this.sp = this.x; break;
      case 0xaf: this.write(this.dp | this.x, this.a); this.x = (this.x + 1) & 0xff; break;
      case 0xbf: this.a = this.nz(this.read(this.dp | this.x)); this.x = (this.x + 1) & 0xff; break;
      case 0x8d: this.y = this.nz(this.fetch()); break;
      case 0xcd: this.x = this.nz(this.fetch()); break;
      case 0xe8: this.a = this.nz(this.fetch()); break;
      case 0x8f: { const i = this.fetch(), d = this.aD(); this.read(d); this.write(d, i); break; }
      case 0xfa: { const s = this.read(this.aD()), d = this.aD(); this.write(d, s); break; }
      case 0xc4: this.write(this.aD(), this.a); break;
      case 0xc5: this.write(this.aAbs(), this.a); break;
      case 0xc6: this.write(this.aIX(), this.a); break;
      case 0xc7: this.write(this.aIndX(), this.a); break;
      case 0xd4: this.write(this.aDX(), this.a); break;
      case 0xd5: this.write(this.aAbsX(), this.a); break;
      case 0xd6: this.write(this.aAbsY(), this.a); break;
      case 0xd7: this.write(this.aIndY(), this.a); break;
      case 0xc9: this.write(this.aAbs(), this.x); break;
      case 0xd8: this.write(this.aD(), this.x); break;
      case 0xd9: this.write(this.aDY(), this.x); break;
      case 0xcb: this.write(this.aD(), this.y); break;
      case 0xcc: this.write(this.aAbs(), this.y); break;
      case 0xdb: this.write(this.aDX(), this.y); break;
      case 0xe4: this.a = this.nz(this.read(this.aD())); break;
      case 0xe5: this.a = this.nz(this.read(this.aAbs())); break;
      case 0xe6: this.a = this.nz(this.read(this.aIX())); break;
      case 0xe7: this.a = this.nz(this.read(this.aIndX())); break;
      case 0xf4: this.a = this.nz(this.read(this.aDX())); break;
      case 0xf5: this.a = this.nz(this.read(this.aAbsX())); break;
      case 0xf6: this.a = this.nz(this.read(this.aAbsY())); break;
      case 0xf7: this.a = this.nz(this.read(this.aIndY())); break;
      case 0xe9: this.x = this.nz(this.read(this.aAbs())); break;
      case 0xf8: this.x = this.nz(this.read(this.aD())); break;
      case 0xf9: this.x = this.nz(this.read(this.aDY())); break;
      case 0xeb: this.y = this.nz(this.read(this.aD())); break;
      case 0xec: this.y = this.nz(this.read(this.aAbs())); break;
      case 0xfb: this.y = this.nz(this.read(this.aDX())); break;
      case 0xef: case 0xff: this.stopped = true; this.pc = (this.pc - 1) & 0xffff; break; // SLEEP, STOP
      default: throw new Error(`SPC700 opcode $${op.toString(16)} not handled`);
    }
    return CYCLES[op] + extra;
  }

  nz16(v) { this.psw = (this.psw & ~0x82) | (v & 0x8000 ? 0x80 : 0) | ((v & 0xffff) === 0 ? 2 : 0); }

  shift(kind, v) { // 0 ASL, 1 ROL, 2 LSR, 3 ROR
    let r;
    if (kind === 0) { r = v << 1; this.setC(v & 0x80); }
    else if (kind === 1) { r = v << 1 | this.c; this.setC(v & 0x80); }
    else if (kind === 2) { r = v >> 1; this.setC(v & 1); }
    else { r = v >> 1 | this.c << 7; this.setC(v & 1); }
    return this.nz(r);
  }

  // Runs the processor for `n` cycles, clocking the timers. Returns cycles actually run.
  run(n) {
    let done = 0;
    while (done < n) {
      const c = this.stopped ? 2 : this.step();
      done += c;
      for (const t of this.timers) {
        if (!t.on) continue;
        t.acc = (t.acc || 0) + c;
        while (t.acc >= t.div) {
          t.acc -= t.div;
          t.stage = (t.stage + 1) & 0xff;
          if (t.stage === t.target) { t.stage = 0; t.out = (t.out + 1) & 15; }
        }
      }
    }
    return done;
  }

  // ---------------------------------------------------------------- the DSP

  // Makes one 32 kHz stereo sample. Returns [left, right] as 16-bit values.
  sample() {
    const d = this.dsp, ram = this.ram;
    if (--this.counter < 0) this.counter = 0x77ff;
    const due = rate => rate && (this.counter + OFFSETS[rate]) % RATES[rate] === 0;
    const flg = d[0x6c];

    if (due(flg & 0x1f)) {
      const fb = ((this.noise << 13) ^ (this.noise << 14)) & 0x4000;
      this.noise = fb ^ (this.noise >> 1);
    }
    const kon = this.konPending;
    this.konPending = 0;
    const koff = d[0x5c], non = d[0x3d], pmon = d[0x2d], eon = d[0x4d];
    const dir = d[0x5d] << 8;
    let mainL = 0, mainR = 0, echoL = 0, echoR = 0, prevOut = 0;

    for (let i = 0; i < 8; i++) {
      const v = this.voices[i], base = i << 4, bit = 1 << i;
      if (kon & bit) {
        const e = (dir + d[base + 4] * 4) & 0xffff;
        v.addr = ram[e] | ram[(e + 1) & 0xffff] << 8;
        v.konDelay = 5; v.env = 0; v.mode = 0; v.have = 0; v.rpos = 0; v.pos = 0; v.p1 = 0; v.p2 = 0; v.brrNib = undefined;
        d[0x7c] &= ~bit;
        v.ended = false;
      }
      if (koff & bit || flg & 0x80) v.mode = 3;
      if (flg & 0x80) v.env = 0;
      if (v.konDelay > 0) { v.konDelay--; v.out = 0; prevOut = 0; continue; }

      // Pitch, with modulation from the previous voice's output.
      let pitch = (d[base + 2] | d[base + 3] << 8) & 0x3fff;
      if (pmon & bit & 0xfe) pitch += ((prevOut >> 5) * pitch) >> 10;
      // Keep four decoded samples ahead of the read position.
      while (v.have < (v.pos >> 12) + 4) this.decodeBrr(v, i, dir);
      const idx = v.rpos + (v.pos >> 12), f = (v.pos >> 4) & 0xff, r = v.ring;
      const s0 = r[idx & 15], s1 = r[(idx + 1) & 15], s2 = r[(idx + 2) & 15], s3 = r[(idx + 3) & 15];
      let s = (GAUSS[255 - f] * s0) >> 11;
      s += (GAUSS[511 - f] * s1) >> 11;
      s += (GAUSS[256 + f] * s2) >> 11;
      s = clamp16(s + ((GAUSS[f] * s3) >> 11)) & ~1;
      if (non & bit) s = ((this.noise << 17) >> 16) & ~1;
      v.pos += pitch;
      // Drop consumed samples from the count, keeping the ring aligned.
      const consumed = v.pos >> 12;
      if (consumed) { v.pos &= 0xfff; v.have -= consumed; v.rpos = (v.rpos + consumed) & 15; }

      this.envelope(v, base);
      const out = (s * v.env) >> 11;
      v.out = out;
      prevOut = out;
      if (this.mute & bit) continue;
      const l = (out * s8(d[base])) >> 7, rr = (out * s8(d[base + 1])) >> 7;
      mainL += l; mainR += rr;
      if (eon & bit) { echoL += l; echoR += rr; }
    }

    // Echo: read the delayed sample, filter it, mix it in, and write the new input back.
    const esa = d[0x6d] << 8, edl = d[0x7d] & 15, len = edl ? edl << 11 : 4;
    const ea = (esa + this.echoPos) & 0xffff;
    const rd = o => { const a = (ea + o) & 0xffff; return ((ram[a] | ram[(a + 1) & 0xffff] << 8) << 16) >> 17; };
    this.histPos = (this.histPos + 1) & 7;
    this.echoHist[0][this.histPos] = rd(0);
    this.echoHist[1][this.histPos] = rd(2);
    let fl = 0, fr = 0;
    for (let t = 0; t < 8; t++) {
      const c = s8(d[(t << 4) | 0x0f]), h = (this.histPos + t + 1) & 7;
      fl += (this.echoHist[0][h] * c) >> 6;
      fr += (this.echoHist[1][h] * c) >> 6;
    }
    fl = clamp16(fl) & ~1; fr = clamp16(fr) & ~1;
    let outL = clamp16(((clamp16(mainL) * s8(d[0x0c])) >> 7) + ((fl * s8(d[0x2c])) >> 7));
    let outR = clamp16(((clamp16(mainR) * s8(d[0x1c])) >> 7) + ((fr * s8(d[0x3c])) >> 7));
    if (!(flg & 0x20)) {
      const efb = s8(d[0x0d]);
      const wl = clamp16(clamp16(echoL) + ((fl * efb) >> 7)) & ~1, wr = clamp16(clamp16(echoR) + ((fr * efb) >> 7)) & ~1;
      const wa = o => (ea + o) & 0xffff;
      ram[wa(0)] = wl & 0xff; ram[wa(1)] = (wl >> 8) & 0xff;
      ram[wa(2)] = wr & 0xff; ram[wa(3)] = (wr >> 8) & 0xff;
    }
    this.echoPos += 4;
    if (this.echoPos >= len) this.echoPos = 0;
    if (flg & 0x40) { outL = 0; outR = 0; }
    return [outL, outR];
  }

  // Decodes the next four samples of a voice's BRR block (a block is a header and 8 bytes: 16 samples).
  decodeBrr(v, i, dir) {
    const ram = this.ram;
    if (v.brrNib === undefined || v.brrNib >= 16) {
      if (v.brrNib !== undefined && v.brrHeader & 1) { // end of the sample: loop, or stop
        this.dsp[0x7c] |= 1 << i;
        if (v.brrHeader & 2) {
          const e = (dir + this.dsp[(i << 4) + 4] * 4 + 2) & 0xffff;
          v.addr = ram[e] | ram[(e + 1) & 0xffff] << 8;
        } else { v.mode = 3; v.env = 0; }
      }
      v.brrHeader = ram[v.addr];
      v.blockAddr = v.addr;
      v.addr = (v.addr + 9) & 0xffff;
      v.brrNib = 0;
    }
    const shift = v.brrHeader >> 4, filter = (v.brrHeader >> 2) & 3;
    for (let k = 0; k < 4; k++, v.brrNib++) {
      const byte = ram[(v.blockAddr + 1 + (v.brrNib >> 1)) & 0xffff];
      let s = (v.brrNib & 1 ? byte << 28 : byte << 24) >> 28;
      s = shift <= 12 ? (s << shift) >> 1 : s < 0 ? -2048 : 0;
      // The previous samples are kept doubled, so the filters' coefficients are halved: filter 1 is 15/16 of the
      // last sample, 2 is 61/32 and -15/16 of the last two, 3 is 115/64 and -13/16.
      const p1 = v.p1, p2 = v.p2 >> 1;
      if (filter === 1) s += (p1 >> 1) + ((-p1) >> 5);
      else if (filter === 2) s += p1 - p2 + (p2 >> 4) + ((p1 * -3) >> 6);
      else if (filter === 3) s += p1 - p2 + ((p1 * -13) >> 7) + ((p2 * 3) >> 4);
      s = clamp16(s);
      s = (s << 17) >> 16; // keep 15 bits, doubled
      v.p2 = v.p1; v.p1 = s;
      v.ring[(v.rpos + v.have) & 15] = s;
      v.have++;
    }
  }

  envelope(v, base) {
    const d = this.dsp;
    if (v.mode === 3) { v.env = Math.max(0, v.env - 8); return; }
    const adsr1 = d[base + 5], adsr2 = d[base + 6];
    let rate, env = v.env;
    if (adsr1 & 0x80) {
      if (v.mode === 0) { rate = (adsr1 & 15) * 2 + 1; if (!this.due(rate)) return; env += rate === 31 ? 1024 : 32; if (env > 0x7ff) { env = 0x7ff; v.mode = 1; } }
      else if (v.mode === 1) { rate = ((adsr1 >> 4) & 7) * 2 + 16; if (!this.due(rate)) return; env -= ((env - 1) >> 8) + 1; if (env >> 8 === adsr2 >> 5) v.mode = 2; }
      else { rate = adsr2 & 0x1f; if (!this.due(rate)) return; env -= ((env - 1) >> 8) + 1; }
    } else {
      const g = d[base + 7];
      if (!(g & 0x80)) { v.env = (g & 0x7f) << 4; return; }
      rate = g & 0x1f;
      if (!this.due(rate)) return;
      const m = (g >> 5) & 3;
      if (m === 0) env -= 32;
      else if (m === 1) env -= ((env - 1) >> 8) + 1;
      else if (m === 2) env += 32;
      else env += env < 0x600 ? 32 : 8;
    }
    v.env = env < 0 ? 0 : env > 0x7ff ? 0x7ff : env;
  }
  due(rate) { return rate !== 0 && (this.counter + OFFSETS[rate]) % RATES[rate] === 0; }

  // The machine's state as an .spc file (the standard snapshot other players load). Voices' internal state isn't
  // part of the format, so take it between notes.
  snapshot() {
    const f = new Uint8Array(0x10200);
    const sig = "SNES-SPC700 Sound File Data v0.30";
    for (let i = 0; i < sig.length; i++) f[i] = sig.charCodeAt(i);
    f[0x21] = 26; f[0x22] = 26; f[0x23] = 27; f[0x24] = 30;
    f[0x25] = this.pc & 0xff; f[0x26] = this.pc >> 8;
    f[0x27] = this.a; f[0x28] = this.x; f[0x29] = this.y; f[0x2a] = this.psw; f[0x2b] = this.sp;
    f.set(this.ram, 0x100);
    const io = 0x100;
    f[io + 0xf1] = this.timers.reduce((v, t, i) => v | (t.on ? 1 << i : 0), 0);
    f[io + 0xf2] = this.dspAddr;
    for (let i = 0; i < 4; i++) f[io + 0xf4 + i] = this.portIn[i];
    for (let i = 0; i < 3; i++) { f[io + 0xfa + i] = this.timers[i].target; f[io + 0xfd + i] = this.timers[i].out; }
    f.set(this.dsp, 0x10100);
    for (let i = 0; i < 8; i++) f[0x10100 + (i << 4) + 8] = this.voices[i].env >> 4;
    return f;
  }

  // Runs until `n` stereo samples at 32 kHz are made, into `out` (interleaved Int16-range floats) if given.
  generate(n, outL, outR, off = 0) {
    for (let k = 0; k < n; k++) {
      const want = 32 - this.cycles;
      this.cycles = this.run(want) - want; // the last instruction's overrun counts against the next sample

      const [l, r] = this.sample();
      if (outL) { outL[off + k] = l; outR[off + k] = r; }
    }
  }
}
