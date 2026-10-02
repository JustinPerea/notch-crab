// For the tests: read a band PNG back to its pixels. A mod's tests can import only their own files, so no node:zlib: this is a small
// inflate (RFC 1950/1951: stored, fixed and dynamic Huffman blocks, after puff.c), and a PNG reader for what engine/png.js writes
// (8-bit RGBA, every row filtered None).

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// canonical Huffman code from code lengths: how many codes of each length, and the symbols in code order
function huff(lens) {
  const count = new Uint16Array(16), offs = new Uint16Array(16), sym = new Uint16Array(lens.length);
  for (const l of lens) count[l]++;
  count[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  for (let s = 0; s < lens.length; s++) if (lens[s]) sym[offs[lens[s]]++] = s;
  return { count, sym };
}

// zlib data (2-byte header, then DEFLATE) to bytes
export function inflate(src) {
  let pos = 2, bit = 0;
  const out = [];
  const bits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (pos >= src.length) throw new Error('inflate: ran out of input');
      v |= ((src[pos] >> bit) & 1) << i;
      if (++bit === 8) { bit = 0; pos++; }
    }
    return v;
  };
  const decode = (h) => {   // a Huffman code is read first bit first, most significant first
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.sym[index + (code - first)];
      index += c; first = (first + c) << 1; code <<= 1;
    }
    throw new Error('inflate: bad code');
  };
  let final;
  do {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      if (bit) { bit = 0; pos++; }
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      for (let i = 0; i < len; i++) out.push(src[pos++]);
      continue;
    }
    let lit, dist;
    if (type === 1) {
      lit = huff(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)));
      dist = huff(new Array(30).fill(5));
    } else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4, cl = new Array(19).fill(0), lens = [];
      for (let i = 0; i < ncode; i++) cl[ORDER[i]] = bits(3);
      const ch = huff(cl);
      while (lens.length < nlen + ndist) {
        const s = decode(ch);
        if (s < 16) lens.push(s);
        else if (s === 16) { const p = lens[lens.length - 1]; for (let r = 3 + bits(2); r--; ) lens.push(p); }
        else if (s === 17) { for (let r = 3 + bits(3); r--; ) lens.push(0); }
        else { for (let r = 11 + bits(7); r--; ) lens.push(0); }
      }
      lit = huff(lens.slice(0, nlen)); dist = huff(lens.slice(nlen));
    } else throw new Error('inflate: bad block type');
    for (;;) {
      const s = decode(lit);
      if (s < 256) out.push(s);
      else if (s === 256) break;
      else {
        const i = s - 257, len = LBASE[i] + bits(LEXT[i]), d = decode(dist), back = DBASE[d] + bits(DEXT[d]);
        if (back > out.length) throw new Error('inflate: distance too far back');
        for (let k = 0; k < len; k++) out.push(out[out.length - back]);
      }
    }
  } while (!final);
  return Uint8Array.from(out);
}

// a base64 PNG to { w, h, at(x, y) -> [r, g, b, a] }; throws on anything but 8-bit RGBA with None-filtered rows
export function readPng(b64) {
  const bin = atob(b64), buf = Uint8Array.from(bin, (c) => c.charCodeAt(0)), dv = new DataView(buf.buffer);
  const w = dv.getUint32(16), h = dv.getUint32(20), idat = [];
  if (buf[24] !== 8 || buf[25] !== 6) throw new Error(`readPng: depth ${buf[24]}, colour type ${buf[25]}, not 8-bit RGBA`);
  for (let o = 8; o < buf.length; ) {
    const n = dv.getUint32(o), type = String.fromCharCode(...buf.subarray(o + 4, o + 8));
    if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + n));
    o += 12 + n;
  }
  const z = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  idat.reduce((o, c) => (z.set(c, o), o + c.length), 0);
  const raw = inflate(z), stride = w * 4 + 1;
  if (raw.length !== stride * h) throw new Error(`readPng: ${raw.length} bytes, want ${stride * h}`);
  for (let y = 0; y < h; y++) if (raw[y * stride] !== 0) throw new Error(`readPng: row ${y} filter ${raw[y * stride]}, not None`);
  return { w, h, at: (x, y) => Array.from(raw.subarray(y * stride + 1 + x * 4, y * stride + 5 + x * 4)) };
}
