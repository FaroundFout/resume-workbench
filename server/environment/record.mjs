import { mkdir, open, readFile, rename, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const pathFor = root => join(root, '.runtime', 'environment-validation.json');
const validFingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export async function saveEnvironmentRecord(projectRoot, report) {
  if (report.state !== 'ready' || report.pdfReady !== true || !validFingerprint(report.fingerprint) ||
      typeof report.verifiedAt !== 'string' || !Number.isFinite(Date.parse(report.verifiedAt))) throw Error('Invalid environment verification record');
  await mkdir(join(projectRoot, '.runtime'), { recursive: true });
  const path = pathFor(projectRoot); const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(JSON.stringify({ schema: 1, fingerprint: report.fingerprint, verifiedAt: report.verifiedAt, pdfReady: true }) + '\n');
    await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, path);
  } finally { if (handle) await handle.close(); await rm(temporary, { force: true }); }
}
export async function clearEnvironmentRecord(projectRoot) { await rm(pathFor(projectRoot), { force: true }); }
export async function applyEnvironmentRecord(projectRoot, report) {
  if (report.state !== 'verification-required' || !validFingerprint(report.fingerprint)) return report;
  try {
    const path = pathFor(projectRoot); const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return report;
    const stored = JSON.parse(await readFile(path, 'utf8'));
    if (stored.schema !== 1 || stored.pdfReady !== true || stored.fingerprint !== report.fingerprint ||
        typeof stored.verifiedAt !== 'string' || !Number.isFinite(Date.parse(stored.verifiedAt))) return report;
    return { ...report, pdfReady: true, state: 'ready', verifiedAt: stored.verifiedAt,
      checks: [...report.checks, { id: 'bilingual-pdf', status: 'passed', code: 'PDF_VERIFIED', message: '当前环境的中文、英文样例已编译通过。' }] };
  } catch (error) {
    if (error instanceof SyntaxError || ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return report;
    throw error;
  }
}
