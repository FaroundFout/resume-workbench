import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { AppError } from '../errors.mjs';

/** Compiler and package manager from one real bin directory share ownership.
 * A namespaced kernel reservation needs no PID files or crash recovery.
 * Hash/OS-port collisions fail closed, never choose a fallback port.
 */
export async function acquireEnvironmentLease(toolchain, { mode = 'build', signal } = {}) {
  signal?.throwIfAborted();
  const executable = await realpath(toolchain.executable);
  const bin = await realpath(dirname(executable));
  signal?.throwIfAborted();
  const identity = process.platform === 'win32' ? bin.toLowerCase() : bin;
  const digest = createHash('sha256').update(`purecv:tex-environment:v1\0${identity}`).digest();
  const port = 20000 + digest.readUInt32BE(0) % 20000;
  const reservation = createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
    });
  } catch (cause) {
    signal?.throwIfAborted();
    const error = new AppError('ENVIRONMENT_BUSY', '所选 LaTeX 环境正在编译或修复，或保留端口不可用。请稍后重试。', 409);
    Object.defineProperty(error, 'cause', { value: cause });
    throw error;
  }
  let closing;
  const release = () => closing ??= new Promise((resolve, reject) => {
    reservation.close(error => error ? reject(error) : resolve());
  });
  // Binding is awaited even when cancelled, so late ownership cannot leak.
  if (signal?.aborted) { await release(); signal.throwIfAborted(); }
  return { identity, mode, release };
}
