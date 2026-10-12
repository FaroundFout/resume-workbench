import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Only the portable layout emitted by the bootstrapper can be published.
const managedExecutable = /^\.runtime\/tex\/g-[a-f0-9]{32}\/texmfs\/install\/miktex\/bin\/x64\/xelatex\.exe$/u;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
async function regularPath(root, segments, file) {
  let path = root;
  for (const [index, segment] of ['', ...segments].entries()) {
    if (segment) path = join(path, segment);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (index === segments.length && file ? !info.isFile() : !info.isDirectory())) return null;
    if (!samePath(await realpath(path), resolve(path))) return null;
  }
  return path;
}

/** Read only an atomically published selection; never accept staging trees or aliases. */
async function readManagedRecord(projectRoot) {
  try {
    const root = resolve(projectRoot);
    const record = await regularPath(root, ['.runtime', 'tex-selection.json'], true);
    if (!record || (await lstat(record)).size > 16384) return null;
    const stored = JSON.parse(await readFile(record, 'utf8'));
    if (stored?.schema !== 1 || typeof stored.relativeExecutable !== 'string' || !managedExecutable.test(stored.relativeExecutable) ||
        !/^[a-f0-9]{64}$/u.test(stored.fingerprint || '') || typeof stored.verifiedAt !== 'string' || !Number.isFinite(Date.parse(stored.verifiedAt))) return null;
    if (!await regularPath(root, stored.relativeExecutable.split('/'), true)) return null;
    return stored;
  } catch (error) {
    if (error instanceof SyntaxError || ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return null;
    throw error;
  }
}

export async function readManagedSelection(projectRoot) {
  const stored = await readManagedRecord(projectRoot);
  return stored ? { relativeExecutable: stored.relativeExecutable, fingerprint: stored.fingerprint } : null;
}

/** Remote repository is process-local metadata; never apply it to another compiler. */
export async function readManagedRepository(projectRoot) {
  const stored = await readManagedRecord(projectRoot);
  try {
    const url = new URL(stored?.repository?.url);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url.href : null;
  } catch { return null; }
}
