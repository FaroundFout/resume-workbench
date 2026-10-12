import { lstat, realpath, readdir, readFile, mkdir, open, link, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative, extname, basename, parse, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { encodeReleaseZip, sha256, safeArchivePath, releaseError, validateTrueType, validatePng, essentialReleaseResources, validateReleaseSamples } from './release-format.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const publicTrees = new Set(['samples', 'web', 'server', 'scripts', 'templates', 'licenses']);
const publicRootFiles = new Set(['LICENSE', 'README.md', 'README_zh.md', 'config.example.json', 'setup.cmd', 'start.cmd', 'start.sh', 'doctor.cmd', 'repair.cmd']);
const publicDocs = new Set(['docs/local-editor.md', 'docs/verification/installation-matrix.md']);
const extensions = new Set(['.mjs', '.cjs', '.js', '.json', '.ps1', '.cmd', '.sh', '.html', '.css', '.svg', '.png', '.jpg', '.jpeg', '.tex', '.txt', '.md']);
const excluded = /^(?:\..*|resume|resume_zh|examples|private|artifacts|node_modules|__pycache__|cache|caches|config\.local\.json)$/iu;
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const inside = (root, path) => { const part = relative(root, path); return !part || (part !== '..' && !part.startsWith(`..${sep}`) && !parse(part).root); };
export function isPublicReleasePath(name, required = []) {
  if (!safeArchivePath(name) || name.split('/').some(part => excluded.test(part))) return false;
  if (publicRootFiles.has(name) || publicDocs.has(name)) return true;
  if (name.startsWith('font/')) return required.includes(name) && /\.(?:ttf|txt)$/iu.test(name);
  return publicTrees.has(name.split('/')[0]) && extensions.has(extname(name).toLowerCase());
}

async function noLinks(path, code) {
  const root = parse(path).root; let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw releaseError(code, 'Symbolic links and junctions are not allowed.'); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
}
async function readOrdinary(root, name, required) {
  const path = join(root, name); await noLinks(path, 'UNSAFE_SOURCE_LINK');
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT' && required) throw releaseError('RESOURCE_MISSING', `Required release file missing: ${name}`); throw error; }
  if (!info.isFile() || !inside(root, await realpath(path))) throw releaseError('UNSAFE_SOURCE_LINK', `Not a contained regular file: ${name}`);
  if (info.size > 128 * 1024 * 1024) throw releaseError('RELEASE_TOO_LARGE', `File exceeds release limit: ${name}`);
  return readFile(path);
}

function validateDependencies(entries, manifest) {
  const files = manifest.requiredTexFiles;
  if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length || files.some(file => !/^[A-Za-z0-9-]+\.(?:sty|cls)$/u.test(file))) throw releaseError('DEPENDENCY_MANIFEST_MISMATCH', 'Invalid TeX dependency manifest.');
  for (const flavour of ['miktex', 'texlive']) for (const file of files) {
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(manifest.packageIdsByFlavour?.[flavour]?.[file] ?? '')) throw releaseError('DEPENDENCY_MANIFEST_MISMATCH', `No safe ${flavour} package mapping for ${file}.`);
  }
  for (const [name, bytes] of entries) if (name.startsWith('templates/') && name.endsWith('.tex')) {
    const text = bytes.toString('utf8').replace(/(?<!\\)%[^\r\n]*/gu, '');
    for (const match of text.matchAll(/\\(documentclass|usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/gu)) {
      for (const dependency of match[2].split(',').map(value => value.trim())) {
        const file = dependency + (match[1] === 'documentclass' ? '.cls' : '.sty');
        if (!files.includes(file)) throw releaseError('DEPENDENCY_MANIFEST_MISMATCH', `Undeclared direct template dependency: ${name} -> ${file}`);
      }
    }
  }
}

export async function collectRelease(sourceRoot = projectRoot) {
  const source = resolve(sourceRoot); await noLinks(source, 'UNSAFE_SOURCE_LINK');
  if (!(await lstat(source)).isDirectory()) throw releaseError('UNSAFE_SOURCE_LINK', 'Source must be a regular directory.');
  const sourceReal = await realpath(source);
  // Resolve the actual source manifest only after verifying its path, never the
  // developer checkout's cached manifest when --source points to a candidate.
  const manifestPath = 'server/environment/manifest.mjs'; const sourceManifest = await readOrdinary(sourceReal, manifestPath, true);
  const dependencies = await import(`${pathToFileURL(join(sourceReal, manifestPath)).href}?sha256=${sha256(sourceManifest)}`);
  const required = dependencies.requiredProjectFiles;
  if (!Array.isArray(required) || !required.length || new Set(required).size !== required.length || !Array.isArray(dependencies.requiredFonts) || dependencies.requiredFonts.length !== 6) throw releaseError('DEPENDENCY_MANIFEST_MISMATCH', 'Invalid product resource manifest.');
  for (const name of essentialReleaseResources) if (!required.includes(name)) throw releaseError('DEPENDENCY_MANIFEST_MISMATCH', `Required product resource missing from manifest: ${name}`);
  for (const name of required) if (!isPublicReleasePath(name, required)) throw releaseError('DEPENDENCY_MANIFEST_MISMATCH', `Product resource is outside the public release allowlist: ${name}`);
  for (const font of dependencies.requiredFonts) if (!required.includes(`font/${font}`) || !font.endsWith('.ttf')) throw releaseError('DEPENDENCY_MANIFEST_MISMATCH', 'Font and resource manifests disagree.');
  const entries = new Map();
  for (const name of required) {
    const bytes = await readOrdinary(sourceReal, name, true);
    if (!bytes.length) throw releaseError('RESOURCE_INVALID', `Empty resource: ${name}`);
    if (name.endsWith('.ttf')) validateTrueType(bytes, name);
    if (name.endsWith('.png')) validatePng(bytes, name);
    entries.set(name, bytes);
  }
  async function walk(name) {
    const path = join(sourceReal, name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !inside(sourceReal, await realpath(path))) throw releaseError('UNSAFE_SOURCE_LINK', `Unsafe link in public source: ${name}`);
    if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort(order)) if (!excluded.test(child)) await walk(`${name}/${child}`);
    } else if (info.isFile() && isPublicReleasePath(name, required)) entries.set(name, await readOrdinary(sourceReal, name, false));
    else if (!info.isFile()) throw releaseError('UNSAFE_SOURCE_LINK', `Non-regular public source: ${name}`);
  }
  for (const name of publicTrees) {
    try { await walk(name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const name of [...publicRootFiles, ...publicDocs]) {
    try { entries.set(name, await readOrdinary(sourceReal, name, ['LICENSE', 'config.example.json', 'setup.cmd', 'start.cmd', 'doctor.cmd', 'repair.cmd', 'README.md', 'README_zh.md', 'docs/local-editor.md'].includes(name))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Runtime bootstrap files are part of the complete install contract.
  for (const name of ['server/index.mjs', 'web/index.html', 'scripts/setup-windows.ps1', 'scripts/node-runtime.ps1', 'scripts/node-runtime.json', 'scripts/tex-runtime.ps1', 'scripts/tex-bootstrap.json', 'scripts/doctor.mjs']) {
    if (!entries.has(name)) throw releaseError('RESOURCE_MISSING', `Required release file missing: ${name}`);
  }
  validateDependencies(entries, dependencies);
  const modelPath = join(sourceReal, 'web/shared/model.mjs');
  const model = await import(`${pathToFileURL(modelPath).href}?sha256=${sha256(entries.get('web/shared/model.mjs'))}`);
  validateReleaseSamples(entries, model.validateResumeData);
  const manifest = { schema: 1, product: 'PureCV local editor', archiveFormat: 'ZIP32-deflate-utf8-dos-epoch',
    requiredFonts: [...dependencies.requiredFonts], requiredProjectFiles: [...required].sort(order), requiredTexFiles: [...dependencies.requiredTexFiles],
    packageIdsByFlavour: dependencies.packageIdsByFlavour,
    files: [...entries].sort(([a], [b]) => order(a, b)).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })) };
  entries.set('RELEASE-MANIFEST.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  return { entries, manifest, source: sourceReal };
}

async function validateOutput(source, output) {
  if (extname(output).toLowerCase() !== '.zip') throw releaseError('UNSAFE_OUTPUT', 'Output must be a new .zip artifact.');
  if (inside(source, output)) {
    const parts = relative(source, output).split(sep);
    if (publicTrees.has(parts[0]) || ['font', 'docs', 'resume', 'resume_zh', 'examples', '.git', '.purecv'].includes(parts[0]) || /config\./iu.test(basename(output))) throw releaseError('UNSAFE_OUTPUT', 'Output cannot replace project source or private data.');
  }
  await noLinks(output, 'UNSAFE_OUTPUT');
  for (const target of [output, `${output}.sha256`, `${output}.manifest.json`]) {
    try { await lstat(target); throw releaseError('UNSAFE_OUTPUT', 'Output artifacts already exist; select a new path.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function publishNew(path, bytes) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`); let handle;
  try {
    handle = await open(temporary, 'wx'); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    // Linking a complete temporary file publishes atomically and cannot replace
    // a destination created by another process. Temporary stays in this parent.
    await link(temporary, path);
  } finally { if (handle) await handle.close(); await rm(temporary, { force: true }); }
}
export async function packageRelease({ sourceRoot = projectRoot, output } = {}) {
  if (!output) throw releaseError('UNSAFE_OUTPUT', 'Specify --output <new-file.zip>.');
  const destination = resolve(output), source = resolve(sourceRoot);
  await validateOutput(source, destination);
  const collected = await collectRelease(source);
  const bytes = encodeReleaseZip(collected.entries), digest = sha256(bytes);
  await mkdir(dirname(destination), { recursive: true }); await validateOutput(collected.source, destination);
  await publishNew(destination, bytes);
  const published = [destination];
  try {
    await publishNew(`${destination}.manifest.json`, Buffer.from(JSON.stringify(collected.manifest, null, 2) + '\n'));
    published.push(`${destination}.manifest.json`);
    await publishNew(`${destination}.sha256`, Buffer.from(`${digest}  ${basename(destination)}\n`));
    published.push(`${destination}.sha256`);
  } catch (error) {
    for (const path of published) await rm(path, { force: true });
    throw error;
  }
  return { output: destination, sha256: digest, files: collected.manifest.files.length, bytes: bytes.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    while (args.length) {
      const key = args.shift(); if (!['--output', '--source'].includes(key) || !args.length || options[key]) throw releaseError('USAGE', 'Usage: node scripts/package-release.mjs --output <new-file.zip> [--source <public-source>]');
      options[key] = args.shift();
    }
    console.log(JSON.stringify(await packageRelease({ output: options['--output'], sourceRoot: options['--source'] || projectRoot })));
  } catch (error) { console.error(`[${error.code || 'RELEASE_FAILED'}] ${error.message}`); process.exitCode = 1; }
}
