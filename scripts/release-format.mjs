import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
export const releaseError = (code, message) => Object.assign(new Error(message), { code });
export const essentialReleaseResources = Object.freeze([
  'font/Lato/OFL.txt', 'font/Simsun/LICENSE.txt', 'templates/default-logo.png',
  'templates/purecv-en/main.tex', 'templates/purecv-zh/main.tex', 'templates/shared/macros.tex',
  'samples/resume.zh.json', 'samples/resume.en.json',
]);
export function validateReleaseSamples(entries, validateResumeData) {
  for (const [path, language] of [['samples/resume.zh.json', 'zh-CN'], ['samples/resume.en.json', 'en']]) {
    try {
      const sample = JSON.parse(entries.get(path)?.toString('utf8'));
      if (sample.language !== language || !validateResumeData(sample).ok) throw Error('Invalid seed model.');
    } catch { throw releaseError('SAMPLE_INVALID', `Public seed JSON does not match the product model or language: ${path}`); }
  }
}
export function safeArchivePath(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('\\') && !name.includes(':') &&
    !/[\x00-\x1f\x7f]/u.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/u.test(part));
}

/** Standard ZIP32, UTF-8 names, fixed DOS epoch, no host paths or timestamps. */
export function encodeReleaseZip(entries) {
  if (entries.size > 65535) throw releaseError('RELEASE_TOO_LARGE', 'ZIP32 file count exceeded.');
  const local = [], central = []; let offset = 0;
  for (const [name, bytes] of [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!safeArchivePath(name)) throw releaseError('RELEASE_INVALID', 'Unsafe archive entry.');
    const path = Buffer.from(name, 'utf8'); const compressed = deflateRawSync(bytes, { level: 9 }); const crc = crc32(bytes);
    if (path.length > 65535 || bytes.length > 0xffffffff || offset + compressed.length > 0xffffffff) throw releaseError('RELEASE_TOO_LARGE', 'ZIP32 size exceeded.');
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0x0021, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(path.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8); directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(0x0021, 14); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(path.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, path, compressed); central.push(directory, path); offset += header.length + path.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

/** Strictly verifies this release ZIP format before allowing extraction. */
export function decodeReleaseZip(bytes) {
  const invalid = () => { throw releaseError('RELEASE_INVALID', 'ZIP headers, paths, sizes or CRC do not match.'); };
  try {
    if (bytes.length < 22 || bytes.length > 512 * 1024 * 1024) invalid();
    const end = bytes.length - 22;
    if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 20)) invalid();
    const count = bytes.readUInt16LE(end + 10); const start = bytes.readUInt32LE(end + 16);
    if (!count || bytes.readUInt16LE(end + 8) !== count || start + bytes.readUInt32LE(end + 12) !== end) invalid();
    const entries = new Map(), names = new Set(); let offset = start, localEnd = 0, expanded = 0;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) invalid();
      const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
      const crc = bytes.readUInt32LE(offset + 16), compressedSize = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
      const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
      const local = bytes.readUInt32LE(offset + 42);
      if (flags !== 0x0800 || method !== 8 || extra || comment || bytes.readUInt16LE(offset + 34) || bytes.readUInt32LE(offset + 38) || offset + 46 + nameLength > end) invalid();
      const path = bytes.subarray(offset + 46, offset + 46 + nameLength), name = new TextDecoder('utf-8', { fatal: true }).decode(path);
      if (!safeArchivePath(name) || names.has(name.toLowerCase()) || local !== localEnd || local + 30 + nameLength > start || bytes.readUInt32LE(local) !== 0x04034b50) invalid();
      if (bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt32LE(local + 14) !== crc ||
          bytes.readUInt32LE(local + 18) !== compressedSize || bytes.readUInt32LE(local + 22) !== size || bytes.readUInt16LE(local + 26) !== nameLength ||
          bytes.readUInt16LE(local + 28) || !bytes.subarray(local + 30, local + 30 + nameLength).equals(path)) invalid();
      const dataStart = local + 30 + nameLength; localEnd = dataStart + compressedSize;
      if (localEnd > start || size > 128 * 1024 * 1024 || (expanded += size) > 512 * 1024 * 1024) invalid();
      const data = inflateRawSync(bytes.subarray(dataStart, localEnd), { maxOutputLength: Math.max(1, size) });
      if (data.length !== size || crc32(data) !== crc) invalid();
      entries.set(name, data); names.add(name.toLowerCase()); offset += 46 + nameLength;
    }
    if (offset !== end || localEnd !== start) invalid();
    return entries;
  } catch (error) {
    if (error.code === 'RELEASE_INVALID') throw error;
    invalid();
  }
}

function wordSum(bytes, zeroStart = -1) {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    let word = 0;
    for (let part = 0; part < 4; part++) word = (word << 8) | (offset + part < bytes.length && !(zeroStart >= 0 && offset + part >= zeroStart && offset + part < zeroStart + 4) ? bytes[offset + part] : 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}
export function validateTrueType(bytes, name) {
  const bad = () => { throw releaseError('FONT_INVALID', `Invalid TrueType structure or checksum: ${name}`); };
  if (bytes.length < 12 || bytes.readUInt32BE(0) !== 0x00010000) bad();
  const count = bytes.readUInt16BE(4); if (!count || count > 4095 || 12 + count * 16 > bytes.length) bad();
  const tables = new Map(), ranges = [];
  for (let i = 0; i < count; i++) {
    const index = 12 + i * 16, tag = bytes.toString('ascii', index, index + 4), checksum = bytes.readUInt32BE(index + 4);
    const offset = bytes.readUInt32BE(index + 8), length = bytes.readUInt32BE(index + 12);
    if (tables.has(tag) || offset % 4 || offset < 12 + count * 16 || offset + length > bytes.length) bad();
    const table = bytes.subarray(offset, offset + length);
    if (wordSum(table, tag === 'head' ? 8 : -1) !== checksum) bad();
    tables.set(tag, table); if (length) ranges.push([offset, offset + length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, i) => i > 0 && range[0] < ranges[i - 1][1])) bad();
  for (const tag of ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'name', 'post', 'glyf', 'loca']) if (!tables.has(tag)) bad();
  const head = tables.get('head');
  if (head.length < 54 || head.readUInt32BE(12) !== 0x5f0f3cf5 || tables.get('maxp').length < 6 || !tables.get('maxp').readUInt16BE(4) || wordSum(bytes) !== 0xb1b0afba) bad();
}

export function validatePng(bytes, name) {
  const bad = () => { throw releaseError('RESOURCE_INVALID', `Invalid PNG resource: ${name}`); };
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) bad();
  let offset = 8, image = false, end = false, first = true;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset); if (offset + size + 12 > bytes.length) bad();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + size)) !== bytes.readUInt32BE(offset + 8 + size)) bad();
    if (first && (type !== 'IHDR' || size !== 13 || !bytes.readUInt32BE(offset + 8) || !bytes.readUInt32BE(offset + 12))) bad();
    first = false; if (type === 'IDAT') image = true;
    offset += size + 12;
    if (type === 'IEND') { if (size !== 0) bad(); end = true; break; }
  }
  if (!image || !end || offset !== bytes.length) bad();
}
