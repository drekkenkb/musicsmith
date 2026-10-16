// ZIP reading/writing, WAV writing and IPS patches, without libraries.

const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(data, crc = 0) {
  crc = ~crc;
  for (let i = 0; i < data.length; i++) crc = CRC[(crc ^ data[i]) & 255] ^ (crc >>> 8);
  return ~crc >>> 0;
}

export function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), n = f.data.length;
    const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint16(12, 0x5821, true); // a fixed date, 2024-01-01
    lv.setUint32(14, crc, true); lv.setUint32(18, n, true); lv.setUint32(22, n, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const c = new Uint8Array(46 + name.length), cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(14, 0x5821, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, n, true); cv.setUint32(24, n, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    c.set(name, 46);
    parts.push(local, f.data);
    central.push(c);
    offset += local.length + n;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, size, true); ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

// Reads stored and deflated entries, which covers what Finder, Windows, Android and the iOS Files app produce.
export async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let e = bytes.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("That isn't a ZIP file.");
  const count = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const dec = new TextDecoder(), files = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("The ZIP file is damaged.");
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) {
      data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    } else throw new Error(`${name} uses a ZIP compression method this app can't read.`);
    files.push({ name, data });
  }
  return files;
}

// Builds an IPS patch turning `a` into `b` (same length). Returns null if they're identical.
export function makeIPS(a, b) {
  const out = [0x50, 0x41, 0x54, 0x43, 0x48]; // "PATCH"
  const n = b.length;
  let i = 0, records = 0;
  while (i < n) {
    if (a[i] === b[i]) { i++; continue; }
    // An offset of 0x454F46 would read as the "EOF" marker, so such a record starts one byte earlier.
    const start = i === 0x454f46 ? i - 1 : i;
    if (start > 0xffffff) throw new Error("This ROM is bigger than 16 MB, which IPS patches can't describe.");
    let end = i;
    while (end < n && end - start < 0xffff) {
      if (a[end] !== b[end]) { end++; continue; }
      // Bridge short runs of unchanged bytes: a new record costs 5 bytes of header.
      let g = end;
      while (g < n && a[g] === b[g] && g - end < 6) g++;
      if (g < n && g - end < 6) end = g; else break;
    }
    end = Math.min(end, start + 0xffff);
    out.push(start >> 16, (start >> 8) & 0xff, start & 0xff, (end - start) >> 8, (end - start) & 0xff);
    for (let k = start; k < end; k++) out.push(b[k]);
    records++;
    i = end;
  }
  if (!records) return null;
  out.push(0x45, 0x4f, 0x46); // "EOF"
  return new Uint8Array(out);
}

// 16-bit mono PCM.
export function wav(samples, rate) {
  const b = new ArrayBuffer(44 + samples.length * 2), dv = new DataView(b);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); dv.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, "data"); dv.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Blob([b], { type: "audio/wav" });
}
