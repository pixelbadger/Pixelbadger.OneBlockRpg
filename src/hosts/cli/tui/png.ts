/**
 * A small PNG codec for sprite art and scene frames: 8-bit images in, RGBA out. Enough for the assets this repo
 * ships and the images generators produce (greyscale, RGB, palette, with or without alpha; not interlaced).
 */

import { unzlibSync, zlibSync } from "fflate";

/** An RGBA image, row-major, 4 bytes a pixel. */
export interface Image {
  w: number;
  h: number;
  data: Uint8Array;
}

export const image = (w: number, h: number): Image => ({ w, h, data: new Uint8Array(w * h * 4) });

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** CRC-32 (as PNG and zlib use it), unsigned. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const v = view(out);
  v.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  v.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Encodes RGBA as a PNG (filter 0 on every row; `level` is the deflate level, 1 for speed). */
export function encodePng(img: Image, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6): Uint8Array {
  const ihdr = new Uint8Array(13);
  view(ihdr).setUint32(0, img.w);
  view(ihdr).setUint32(4, img.h);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = img.w * 4;
  const raw = new Uint8Array((stride + 1) * img.h);
  for (let y = 0; y < img.h; y++) {
    raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibSync(raw, { level })),
    chunk("IEND", new Uint8Array()),
  ]);
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decodes an 8-bit, non-interlaced PNG to RGBA. */
export function decodePng(b: Uint8Array): Image {
  if (b.length < 8 || SIGNATURE.some((x, i) => b[i] !== x)) throw new Error("not a PNG");
  const v = view(b);
  let at = 8;
  let w = 0;
  let h = 0;
  let type = 0;
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (at < b.length) {
    const len = v.getUint32(at);
    const kind = String.fromCharCode(...b.subarray(at + 4, at + 8));
    const body = b.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (kind === "IHDR") {
      w = view(body).getUint32(0);
      h = view(body).getUint32(4);
      type = body[9]!;
      if (body[8] !== 8) throw new Error(`PNG bit depth ${body[8]} is not supported (8 only)`);
      if (body[12] !== 0) throw new Error("interlaced PNGs are not supported");
      if (!(type in CHANNELS)) throw new Error(`PNG colour type ${type} is not supported`);
    } else if (kind === "PLTE") palette = body;
    else if (kind === "tRNS") trns = body;
    else if (kind === "IDAT") idat.push(body);
    else if (kind === "IEND") break;
  }
  const ch = CHANNELS[type]!;
  const stride = w * ch;
  const raw = unzlibSync(concat(idat));
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[row + x - ch]! : 0;
      const up = y ? px[row - stride + x]! : 0;
      const c = x >= ch && y ? px[row - stride + x - ch]! : 0;
      let v = raw[src + x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (a + up) >> 1;
      else if (filter === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      px[row + x] = v & 255;
    }
  }
  const out = image(w, h);
  const d = out.data;
  for (let i = 0, j = 0; i < w * h; i++, j += ch) {
    const o = i * 4;
    if (type === 6) {
      d[o] = px[j]!;
      d[o + 1] = px[j + 1]!;
      d[o + 2] = px[j + 2]!;
      d[o + 3] = px[j + 3]!;
    } else if (type === 2) {
      d[o] = px[j]!;
      d[o + 1] = px[j + 1]!;
      d[o + 2] = px[j + 2]!;
      d[o + 3] = 255;
    } else if (type === 3) {
      const p = px[j]!;
      d[o] = palette?.[p * 3] ?? 0;
      d[o + 1] = palette?.[p * 3 + 1] ?? 0;
      d[o + 2] = palette?.[p * 3 + 2] ?? 0;
      d[o + 3] = trns && p < trns.length ? trns[p]! : 255;
    } else {
      const g = px[j]!;
      d[o] = d[o + 1] = d[o + 2] = g;
      d[o + 3] = type === 4 ? px[j + 1]! : 255;
    }
  }
  return out;
}
