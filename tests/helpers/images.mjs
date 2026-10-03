export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function padImage(bytes, size) {
  if (bytes[0] === 137) {
    const chunk = Buffer.alloc(size - bytes.length);
    chunk.writeUInt32BE(chunk.length - 12, 0);
    // A legal private ancillary chunk may carry arbitrary bytes.
    chunk.write('paDd', 4);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return Buffer.concat([bytes.subarray(0, -12), chunk, bytes.subarray(-12)]);
  }
  const chunks = [];
  let remaining = size - bytes.length;
  while (remaining > 0) {
    let length = Math.min(remaining, 65537);
    if (remaining > length && remaining - length < 4) length -= 4;
    const segment = Buffer.alloc(length);
    segment[0] = 0xff;
    segment[1] = 0xfe;
    segment.writeUInt16BE(length - 2, 2);
    chunks.push(segment);
    remaining -= length;
  }
  return Buffer.concat([bytes.subarray(0, 2), ...chunks, bytes.subarray(2)]);
}
