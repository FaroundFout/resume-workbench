import { mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { AppError } from './errors.mjs';

// Kernel-held reservation: no stale files, PID assumptions or unlink races.
// Collisions fail closed. Never select a fallback port for the same directory.
export async function acquireDataDirectory(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const canonical = await realpath(dataDir);
  const identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const digest = createHash('sha256').update(identity).digest();
  // Below the usual Windows ephemeral range; exclusions/other listeners fail closed.
  const port = 20000 + digest.readUInt32BE(0) % 20000;
  const reservation = createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
    });
  } catch (cause) {
    throw new AppError('DATA_DIRECTORY_IN_USE',
      '无法取得数据目录独占权：可能已有 PureCV 实例，或本机保留端口被其他程序/系统占用。请先关闭已有实例；若仍失败，可在 config.local.json 选择另一 dataDir（不会搬移已有简历）。', 503);
  }
  let closing;
  return { dataDir: canonical, release: () => closing ??= new Promise((resolve, reject) => {
    reservation.close(error => error ? reject(error) : resolve());
  }) };
}
