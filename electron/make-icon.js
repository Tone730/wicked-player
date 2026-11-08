// generates a 256x256 app icon: purple gradient rounded square + play triangle
const fs = require('fs'), zlib = require('zlib');
const W = 256, H = 256, R = 52;
const px = Buffer.alloc(W * H * 4);
function inRounded(x, y) {
  const cx = Math.min(Math.max(x, R), W - R), cy = Math.min(Math.max(y, R), H - R);
  return (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
}
function inTri(x, y) {
  const ax = 92, ay = 70, bx = 92, by = 186, cx2 = 194, cy2 = 128;
  const v0x = bx - ax, v0y = by - ay, v1x = cx2 - ax, v1y = cy2 - ay;
  const v2x = x - ax, v2y = y - ay;
  const d00 = v0x * v0x + v0y * v0y, d01 = v0x * v1x + v0y * v1y, d11 = v1x * v1x + v1y * v1y;
  const d20 = v2x * v0x + v2y * v0y, d21 = v2x * v1x + v2y * v1y;
  const den = d00 * d11 - d01 * d01;
  const u = (d11 * d20 - d01 * d21) / den, v = (d00 * d21 - d01 * d20) / den;
  return u >= 0 && v >= 0 && u + v <= 1;
}
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4;
  if (!inRounded(x, y)) { px[i + 3] = 0; continue; }
  const t = y / H;
  px[i] = Math.round(168 - t * 55);      // R: a855f7 -> 6d28d9
  px[i + 1] = Math.round(85 - t * 45);   // G
  px[i + 2] = Math.round(247 - t * 30);  // B
  px[i + 3] = 255;
  if (inTri(x, y)) { px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; }
}
// PNG encode
const tbl = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (const b of buf) c = tbl[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(__dirname + '/icon.png', png);
console.log('icon.png written:', png.length, 'bytes');
