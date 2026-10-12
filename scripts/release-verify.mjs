import { readFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeReleaseZip, sha256, releaseError, validateTrueType, validatePng, essentialReleaseResources, validateReleaseSamples } from './release-format.mjs';
import { validateResumeData } from '../web/shared/model.mjs';
import { isPublicReleasePath } from './package-release.mjs';

export function verifyReleaseBuffer(bytes) {
  const entries = decodeReleaseZip(bytes);
  let manifest;
  try { manifest = JSON.parse(entries.get('RELEASE-MANIFEST.json')?.toString('utf8')); }
  catch { throw releaseError('RELEASE_INVALID', 'Release manifest missing or invalid.'); }
  if (manifest?.schema !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.requiredProjectFiles) || !Array.isArray(manifest.requiredFonts) || manifest.requiredFonts.length !== 6 || manifest.files.length !== entries.size - 1) throw releaseError('RELEASE_INVALID', 'Release manifest shape does not match ZIP.');
  for (const name of essentialReleaseResources) if (!manifest.requiredProjectFiles.includes(name)) throw releaseError('RELEASE_INVALID', 'Essential resource missing from release manifest.');
  const seen = new Set();
  for (const file of manifest.files) {
    if (!file || seen.has(file.path) || !isPublicReleasePath(file.path, manifest.requiredProjectFiles) || !entries.has(file.path) ||
        file.bytes !== entries.get(file.path).length || file.sha256 !== sha256(entries.get(file.path))) throw releaseError('RELEASE_INVALID', 'Release paths or SHA256 digests do not match manifest.');
    seen.add(file.path);
  }
  for (const name of manifest.requiredProjectFiles) {
    const data = entries.get(name); if (!data?.length || !seen.has(name)) throw releaseError('RELEASE_INVALID', `Required resource absent: ${name}`);
    try { if (name.endsWith('.ttf')) validateTrueType(data, name); if (name.endsWith('.png')) validatePng(data, name); }
    catch { throw releaseError('RELEASE_INVALID', `Required resource invalid: ${name}`); }
  }
  for (const font of manifest.requiredFonts) if (!manifest.requiredProjectFiles.includes(`font/${font}`)) throw releaseError('RELEASE_INVALID', 'Release font manifests disagree.');
  try { validateReleaseSamples(entries, validateResumeData); }
  catch { throw releaseError('RELEASE_INVALID', 'Public seed models in release are invalid.'); }
  return { sha256: sha256(bytes), bytes: bytes.length, files: manifest.files.length, manifest, entries };
}
export async function verifyReleaseZip(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024 * 1024) throw releaseError('RELEASE_INVALID', 'Release ZIP must be an ordinary file within size limits.');
  return verifyReleaseBuffer(await readFile(path));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); if (args.length !== 2 || args[0] !== '--zip') throw releaseError('USAGE', 'Usage: node scripts/release-verify.mjs --zip <candidate.zip>');
    const result = await verifyReleaseZip(resolve(args[1]));
    console.log(JSON.stringify({ sha256: result.sha256, bytes: result.bytes, files: result.files, requiredProjectFiles: result.manifest.requiredProjectFiles }));
  } catch (error) { console.error(`[${error.code || 'RELEASE_INVALID'}] ${error.message}`); process.exitCode = 1; }
}
