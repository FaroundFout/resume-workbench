import { AppError } from './errors.mjs';
import { inspectImage } from './assets.mjs';
import { validateResumeData } from '../web/shared/model.mjs';

const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
const invalid = () => { throw new AppError('INVALID_BACKUP', '备份格式、简历数据或校徽图片无效'); };
function exactKeys(input, keys) {
  return input !== null && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key));
}

export async function exportBackup(store, resumeId) {
  // Retry a concurrent save so data and owned image always come from one revision.
  let doc;
  let snapshot;
  for (let attempt = 0; attempt < 3; attempt++) {
    doc = await store.read(resumeId);
    try { snapshot = await store.capture(resumeId, doc.revision); break; }
    catch (error) { if (error.code !== 'REVISION_CONFLICT' || attempt === 2) throw error; }
  }
  const result = Buffer.from(JSON.stringify({ format: 'purecv-backup', version: 1, name: doc.name, data: snapshot.data,
    logoImage: snapshot.logoImage ? { mime: snapshot.logoImage.mime, base64: snapshot.logoImage.bytes.toString('base64') } : null }));
  if (result.length > MAX_BACKUP_BYTES) throw new AppError('BACKUP_TOO_LARGE', '备份不得超过 10MiB', 413);
  return result;
}

export async function importBackup(store, bytes) {
  if (!Buffer.isBuffer(bytes)) invalid();
  if (bytes.length > MAX_BACKUP_BYTES) throw new AppError('BACKUP_TOO_LARGE', '备份不得超过 10MiB', 413);
  let backup;
  try { backup = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { invalid(); }
  if (!exactKeys(backup, ['format', 'version', 'name', 'data', 'logoImage']) || backup.format !== 'purecv-backup' || backup.version !== 1 ||
      typeof backup.name !== 'string' || !backup.name.trim() || backup.name.length > 2000) invalid();
  const validated = validateResumeData(backup.data);
  if (!validated.ok) throw new AppError('INVALID_BACKUP', '备份中的简历字段无效', 400,
    Object.fromEntries(validated.issues.map(issue => [issue.path, issue.message])));
  const hasAsset = backup.data.logo.assetId !== null;
  if (hasAsset !== (backup.logoImage !== null)) invalid();
  let logoImage = null;
  if (hasAsset) {
    const image = backup.logoImage;
    if (!exactKeys(image, ['mime', 'base64']) || !['image/png', 'image/jpeg'].includes(image.mime) || typeof image.base64 !== 'string' ||
        image.base64.length === 0 || image.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(image.base64)) invalid();
    const decoded = Buffer.from(image.base64, 'base64');
    if (decoded.toString('base64') !== image.base64) invalid();
    try { if (inspectImage(decoded).mime !== image.mime) invalid(); }
    catch { invalid(); }
    logoImage = { mime: image.mime, bytes: decoded };
  }
  // The reference in portable data is never dereferenced. A new ID is assigned.
  return store.createWithAsset({ name: backup.name, data: backup.data, logoImage });
}
