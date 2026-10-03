import { AppError } from './errors.mjs';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
const invalid = () => { throw new AppError('INVALID_IMAGE', '图片结构损坏或格式不受支持'); };

function inspectPng(bytes) {
  let offset = 8;
  let width;
  let height;
  let color;
  let palette = false;
  let body = false;
  let bodyFinished = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid();
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > 0x7fffffff || end > bytes.length) invalid();
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    // Buffer's ASCII decoder masks high bits; validate raw bytes first.
    if (!typeBytes.every(byte => (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a))) invalid();
    const type = typeBytes.toString('ascii');
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) invalid();
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid();
    if (offset === 8 && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) invalid();
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      const depth = bytes[offset + 16];
      color = bytes[offset + 17];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !depths[color]?.includes(depth) ||
          bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) invalid();
    } else if (type === 'PLTE') {
      if (palette || body || length === 0 || length > 768 || length % 3 || [0, 4].includes(color)) invalid();
      palette = true;
    } else if (type === 'IDAT') {
      if (bodyFinished || (color === 3 && !palette)) invalid();
      if (length > 0) body = true;
    } else if (type === 'IEND') {
      if (length !== 0 || !body || end !== bytes.length) invalid();
      return { mime: 'image/png', width, height };
    } else {
      if (type[0] === type[0].toUpperCase()) invalid();
      if (body) bodyFinished = true;
    }
    offset = end;
  }
  invalid();
}

function inspectJpeg(bytes) {
  let offset = 2;
  let width;
  let height;
  let scan = false;
  let entropy = false;
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) invalid();
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!width || !height || !scan || !entropy || offset !== bytes.length) invalid();
      return { mime: 'image/jpeg', width, height };
    }
    if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) invalid();
    if (marker === 1) continue;
    if (marker < 0xc0 || offset + 2 > bytes.length) invalid();
    const length = bytes.readUInt16BE(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length) invalid();
    if (frameMarkers.has(marker)) {
      if (width !== undefined || length < 11) invalid();
      height = bytes.readUInt16BE(offset + 3);
      width = bytes.readUInt16BE(offset + 5);
      const components = bytes[offset + 7];
      if (!width || !height || !components || length !== 8 + 3 * components) invalid();
    }
    if (marker === 0xda) {
      if (!width || length < 8) invalid();
      const components = bytes[offset + 2];
      if (!components || length !== 6 + 2 * components) invalid();
      scan = true;
      offset = end;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { entropy = true; offset++; continue; }
        if (offset + 1 >= bytes.length) invalid();
        const next = bytes[offset + 1];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { entropy = true; offset += 2; continue; }
        break;
      }
    } else {
      offset = end;
    }
  }
  invalid();
}

/** Validate bounded image structure; this does not decode pixel data. */
export function inspectImage(bytes) {
  if (!Buffer.isBuffer(bytes)) invalid();
  if (bytes.length > MAX_IMAGE_BYTES) throw new AppError('IMAGE_TOO_LARGE', '图片不得超过 5MiB', 413);
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return inspectPng(bytes);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return inspectJpeg(bytes);
  invalid();
}

export async function putAsset(store, resumeId, bytes) {
  if (!Buffer.isBuffer(bytes)) invalid();
  const ownedBytes = Buffer.from(bytes);
  const image = inspectImage(ownedBytes);
  const id = await store.writeAsset(resumeId, ownedBytes);
  return { id, ...image };
}

export async function readAsset(store, resumeId, assetId) {
  return store.readOwnedAsset(resumeId, assetId);
}
