import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, symlink, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const packer = join(root, 'scripts/package-release.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fonts = [
  'font/Lato/Lato-Regular.ttf', 'font/Lato/Lato-Bold.ttf', 'font/Lato/Lato-Italic.ttf', 'font/Lato/Lato-BoldItalic.ttf',
  'font/Simsun/SourceHanSerifCN-Regular.ttf', 'font/Simsun/SourceHanSerifCN-Bold.ttf',
];

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'PureCV 发布 中文 空格-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'public source'); await mkdir(source);
  for (const name of ['server', 'web', 'scripts', 'templates', 'samples']) await cp(join(root, name), join(source, name), { recursive: true });
  for (const name of [...fonts, 'font/Lato/OFL.txt', 'font/Simsun/LICENSE.txt', 'setup.cmd', 'start.cmd', 'start.sh', 'doctor.cmd', 'repair.cmd', 'config.example.json', 'LICENSE', 'README.md', 'README_zh.md', 'docs/local-editor.md']) {
    await mkdir(dirname(join(source, name)), { recursive: true }); await cp(join(root, name), join(source, name));
  }
  return { directory, source, output: join(directory, 'candidate.zip') };
}
const packageCli = f => exec(process.execPath, [packer, '--source', f.source, '--output', f.output], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });

// Independently read standard ZIP central/local headers. This does not use the
// production verifier, so a ZIP-writing bug cannot validate its own output.
function zipEntries(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10); let offset = bytes.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const method = bytes.readUInt16LE(offset + 10), size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const local = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + size);
    entries.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
    offset += 46 + nameLength + extra + comment;
  }
  return entries;
}

test('release ZIP is reproducible, independently readable and contains public sources plus complete digests', async t => {
  const f = await fixture(t);
  await mkdir(join(f.source, 'samples'), { recursive: true }); await writeFile(join(f.source, 'samples/public-example.json'), '{"name":"Public Example"}\n');
  await writeFile(join(f.source, 'server/environment/new-feature.mjs'), 'export const enabled = true;\n');
  await packageCli(f);
  const first = await readFile(f.output); const entries = zipEntries(first);
  for (const name of [...fonts, 'templates/default-logo.png', 'templates/purecv-en/main.tex', 'templates/purecv-zh/main.tex', 'templates/shared/macros.tex', 'server/environment/new-feature.mjs', 'samples/public-example.json', 'scripts/node-runtime.ps1', 'scripts/tex-runtime.ps1', 'scripts/tex-bootstrap.json', 'web/app.mjs', 'setup.cmd', 'doctor.cmd', 'repair.cmd', 'LICENSE', 'docs/local-editor.md']) assert.ok(entries.has(name), `Missing ${name}`);
  const manifest = JSON.parse(entries.get('RELEASE-MANIFEST.json'));
  assert.equal(manifest.schema, 1);
  assert.deepEqual(manifest.files.map(file => file.path), [...entries.keys()].filter(name => name !== 'RELEASE-MANIFEST.json').sort());
  assert.equal(manifest.requiredFonts.length, 6);
  for (const file of manifest.files) {
    assert.equal(file.bytes, entries.get(file.path).length);
    assert.equal(file.sha256, sha(entries.get(file.path)));
  }
  assert.equal((await readFile(`${f.output}.sha256`, 'utf8')).split(/\s/u)[0], sha(first));
  assert.deepEqual(JSON.parse(await readFile(`${f.output}.manifest.json`, 'utf8')), manifest);
  // Filesystem dates and absolute source/output paths must not affect the ZIP.
  const second = join(f.directory, 'other.zip'); await packageCli({ ...f, output: second });
  assert.deepEqual(await readFile(second), first);
});

test('allowlist excludes personal data, private docs, caches and nested local configuration', async t => {
  const f = await fixture(t);
  for (const name of ['resume/resume.tex', 'resume_zh/resume_zh.pdf', 'examples/private.json', '.git/config', '.purecv/resumes/person.json', '.runtime/node/node.exe', 'config.local.json', 'docs/verification/artifacts/private.pdf', 'docs/superpowers/specs/private.md', 'web/.runtime/cache.json', 'samples/private/secret.json', 'server/config.local.json']) {
    await mkdir(dirname(join(f.source, name)), { recursive: true }); await writeFile(join(f.source, name), 'PRIVATE_CANARY_01');
  }
  await packageCli(f); const entries = zipEntries(await readFile(f.output));
  assert.ok(![...entries.values()].some(bytes => bytes.includes('PRIVATE_CANARY_01')));
  assert.ok(![...entries.keys()].some(name => /(?:^|\/)(?:resume|resume_zh|examples|\.git|\.runtime|\.purecv|private|artifacts)(?:\/|$)|config\.local\.json/iu.test(name)));
});

for (const name of [...fonts, 'templates/purecv-en/main.tex', 'templates/purecv-zh/main.tex', 'templates/shared/macros.tex', 'templates/default-logo.png', 'font/Lato/OFL.txt', 'font/Simsun/LICENSE.txt', 'samples/resume.zh.json', 'samples/resume.en.json']) {
  test(`missing required release resource ${name} fails before publication`, async t => {
    const f = await fixture(t); await rm(join(f.source, name));
    await assert.rejects(packageCli(f), error => error.code !== 0 && /RESOURCE_MISSING/u.test(error.stderr));
    await assert.rejects(stat(f.output), { code: 'ENOENT' });
    assert.deepEqual((await readdir(f.directory)).sort(), ['public source']);
  });
}

test('corrupted TTF content with a valid sfnt header fails before publication', async t => {
  const f = await fixture(t); const file = join(f.source, 'font/Lato/Lato-Regular.ttf');
  const bytes = await readFile(file); bytes[bytes.length - 16] ^= 0x40; await writeFile(file, bytes);
  await assert.rejects(packageCli(f), error => /FONT_INVALID/u.test(error.stderr));
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('new template dependency absent from the product manifest prevents release', async t => {
  const f = await fixture(t); const file = join(f.source, 'templates/purecv-en/main.tex');
  await writeFile(file, (await readFile(file, 'utf8')).replace('\\begin{document}', '\\usepackage{undeclaredreleasepackage}\n\\begin{document}'));
  await assert.rejects(packageCli(f), error => /DEPENDENCY_MANIFEST_MISMATCH/u.test(error.stderr));
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('missing known package-manager mapping prevents release', async t => {
  const f = await fixture(t); const file = join(f.source, 'server/environment/manifest.mjs');
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll("'geometry.sty': 'geometry'", "'geometry.sty': ''"));
  await assert.rejects(packageCli(f), error => /DEPENDENCY_MANIFEST_MISMATCH/u.test(error.stderr));
});

test('a junction or symlink inside an allowed tree cannot include outside data', async t => {
  const f = await fixture(t); const outside = join(f.directory, 'outside private');
  await mkdir(outside); await writeFile(join(outside, 'secret.mjs'), 'PRIVATE_CANARY_02');
  await symlink(outside, join(f.source, 'server/external'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(packageCli(f), error => /UNSAFE_SOURCE_LINK/u.test(error.stderr));
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('output cannot replace source or configuration and must not follow a junction', async t => {
  const f = await fixture(t); const original = await readFile(join(f.source, 'config.example.json'));
  for (const output of [join(f.source, 'web/release.zip'), join(f.source, 'config.local.json'), join(f.source, 'config.example.json')]) {
    await assert.rejects(packageCli({ ...f, output }), error => /UNSAFE_OUTPUT/u.test(error.stderr));
  }
  const outside = join(f.directory, 'outside'); await mkdir(outside);
  await symlink(outside, join(f.source, 'release-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(packageCli({ ...f, output: join(f.source, 'release-link/candidate.zip') }), error => /UNSAFE_OUTPUT/u.test(error.stderr));
  assert.deepEqual(await readFile(join(f.source, 'config.example.json')), original);
});

test('final ZIP verification checks digests and rejects modified or truncated archives', async t => {
  const f = await fixture(t); await packageCli(f);
  const verifier = join(root, 'scripts/release-verify.mjs');
  const run = path => exec(process.execPath, [verifier, '--zip', path], { windowsHide: true });
  const checked = JSON.parse((await run(f.output)).stdout); assert.equal(checked.sha256, sha(await readFile(f.output)));
  const bytes = await readFile(f.output); bytes[45] ^= 1;
  const damaged = join(f.directory, 'damaged.zip'); await writeFile(damaged, bytes);
  await assert.rejects(run(damaged), error => /RELEASE_INVALID/u.test(error.stderr));
  const truncated = join(f.directory, 'truncated.zip'); await writeFile(truncated, bytes.subarray(0, bytes.length - 5));
  await assert.rejects(run(truncated), error => /RELEASE_INVALID/u.test(error.stderr));
});

test('resource manifest cannot silently drop the public logo or font licenses', async t => {
  const f = await fixture(t); const file = join(f.source, 'server/environment/manifest.mjs');
  await writeFile(file, (await readFile(file, 'utf8')).replace("'templates/default-logo.png',", '').replace("'font/Lato/OFL.txt',", ''));
  await assert.rejects(packageCli(f), error => /DEPENDENCY_MANIFEST_MISMATCH/u.test(error.stderr));
});

test('clean Windows profile rejects admin, old OS, preinstalled tools and cached TeX', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'PureCV clean gate-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'gate.ps1');
  const helper = join(root, 'scripts/release-clean-profile.ps1').replaceAll("'", "''");
  await writeFile(script, `\ufeff$ErrorActionPreference = 'Stop'\n. '${helper}'\n$valid = @{ build=26100; workstation=$true; architecture='x64'; elevated=$false; administratorGroupMember=$false; presentTools=@(); cachedTex=@(); snapshot='win11-empty-2026-10-12' }\nAssert-CleanReleaseProfile -Profile $valid\n$bad = @(@{build=19045},@{workstation=$false},@{architecture='arm64'},@{elevated=$true},@{administratorGroupMember=$true},@{presentTools=@('node')},@{cachedTex=@('MiKTeX')},@{snapshot=''})\nforeach ($change in $bad) {\n  $profile=$valid.Clone(); foreach($key in $change.Keys) { $profile[$key]=$change[$key] }\n  $rejected=$false; try { Assert-CleanReleaseProfile -Profile $profile } catch { if ($_.Exception.Message -notmatch 'CLEAN_ENVIRONMENT_REQUIRED') { throw }; $rejected=$true }\n  if (-not $rejected) { throw 'Accepted a non-clean profile' }\n}\nWrite-Output '8 rejected, valid ordinary-user Windows 11 accepted'\n`);
  const powershell = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = await exec(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
  assert.match(result.stdout, /8 rejected, valid ordinary-user Windows 11 accepted/u);
});

test('two real packager processes publish one complete archive without replacing each other', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([packageCli(f), packageCli(f)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const entries = zipEntries(await readFile(f.output));
  assert.deepEqual(JSON.parse(await readFile(`${f.output}.manifest.json`, 'utf8')), JSON.parse(entries.get('RELEASE-MANIFEST.json')));
  assert.equal((await readFile(`${f.output}.sha256`, 'utf8')).split(/\s/u)[0], sha(await readFile(f.output)));
});

test('a pre-existing peer sidecar is preserved on refused publication', async t => {
  const f = await fixture(t); const peer = Buffer.from('peer owns this sidecar\n');
  await writeFile(`${f.output}.manifest.json`, peer);
  await assert.rejects(packageCli(f), error => /UNSAFE_OUTPUT/u.test(error.stderr));
  assert.deepEqual(await readFile(`${f.output}.manifest.json`), peer);
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('a sidecar created while the ZIP is being written survives failure cleanup', async t => {
  const f = await fixture(t); const peer = Buffer.from('concurrent peer sidecar\n');
  let done = false, inserted = false;
  const competing = (async () => {
    while (!done) {
      if ((await readdir(f.directory)).some(name => /^\.candidate\.zip\..*\.tmp$/u.test(name))) {
        await writeFile(`${f.output}.manifest.json`, peer, { flag: 'wx' }); inserted = true; return;
      }
      await delay(1);
    }
  })();
  try { await assert.rejects(packageCli(f)); } finally { done = true; await competing; }
  assert.ok(inserted, 'Real filesystem competitor must overlap ZIP temporary-file publication.');
  assert.deepEqual(await readFile(`${f.output}.manifest.json`), peer);
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('invalid or wrong-language public seed JSON prevents publishing a broken first launch', async t => {
  const f = await fixture(t); const file = join(f.source, 'samples/resume.zh.json');
  const sample = JSON.parse(await readFile(file, 'utf8')); sample.language = 'en'; sample.profile.contacts = 'broken';
  await writeFile(file, JSON.stringify(sample));
  await assert.rejects(packageCli(f), error => /SAMPLE_INVALID/u.test(error.stderr));
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('first start of the final extracted ZIP seeds both fictional examples and reuses them', async t => {
  const f = await fixture(t); await packageCli(f);
  const installed = join(f.directory, '安装 中文 空格');
  for (const [name, bytes] of zipEntries(await readFile(f.output))) {
    await mkdir(dirname(join(installed, name)), { recursive: true }); await writeFile(join(installed, name), bytes);
  }
  const portServer = http.createServer(); await new Promise(done => portServer.listen(0, '127.0.0.1', done));
  const port = portServer.address().port; await new Promise(done => portServer.close(done));
  // This unit fixture explicitly disables compiler discovery. It proves first
  // launch from the archive and makes no fresh-install/PDF capability claim.
  await writeFile(join(installed, 'config.local.json'), JSON.stringify({ port, xelatexPath: 'missing-test-compiler.exe' }));
  const { startServer } = await import(pathToFileURL(join(installed, 'server/index.mjs')).href);
  let ids;
  for (let run = 0; run < 2; run++) {
    const { server, url } = await startServer(installed, { openBrowser: false });
    try {
      assert.equal((await fetch(url)).status, 200);
      const response = await fetch(url + '/api/resumes'); assert.equal(response.status, 200);
      const { resumes } = await response.json(); assert.equal(resumes.length, 2);
      assert.deepEqual(resumes.map(doc => doc.language).sort(), ['en', 'zh-CN']);
      assert.ok(resumes.some(doc => doc.name === '中文虚构示例'));
      assert.ok(resumes.some(doc => doc.name === 'English fictional example'));
      const current = resumes.map(doc => doc.id).sort();
      if (ids) assert.deepEqual(current, ids); else ids = current;
    } finally { await server.shutdown(); }
  }
});
