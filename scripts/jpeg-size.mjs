// JPEG 尺寸解析：仅扫描 SOF（Start Of Frame，0xC0–0xC3）标记读取宽高，零依赖。
// 供 validate-catalog.mjs 与 server.js（图片上传校验）复用。
export function jpegSize(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

// JPEG 文件魔数：FF D8 FF
export function isJpegMagic(buffer) {
  return !!buffer && buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}
