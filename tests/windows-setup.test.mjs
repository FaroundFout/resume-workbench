import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const powershell = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const systemPath = join(process.env.SystemRoot || 'C:/Windows', 'System32');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const windows = { skip: process.platform !== 'win32' };
async function ps(root, code) {
  const file = join(root, `test-${crypto.randomUUID()}.ps1`);
  // Native Windows PowerShell needs a BOM for non-ASCII source paths.
  await writeFile(file, '\ufeff$ErrorActionPreference = "Stop"\r\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\r\n' + code);
  return exec(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { cwd: root, windowsHide: true, timeout: 90000 });
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'Workbench 中文 空格 !-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['scripts', 'server', 'start.cmd']) await cp(join(project, path), join(root, path), { recursive: true });
  try { await cp(join(project, 'setup.cmd'), join(root, 'setup.cmd')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return root;
}
async function localNode(root) {
  await mkdir(join(root, '.runtime/node'), { recursive: true });
  await cp(process.execPath, join(root, '.runtime/node/node.exe'));
}
async function manifest(root, sha256 = '0'.repeat(64), version = process.versions.node) {
  await writeFile(join(root, 'scripts/node-runtime.json'), JSON.stringify({ version, sha256: { x64: sha256, arm64: sha256 } }));
}
async function cmd(root, name, args = '', path = systemPath, cwd = root, env = {}) {
  return exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${join(root, name)}" ${args}"`],
    { cwd, env: { ...process.env, PATH: path, ...env }, windowsHide: true, windowsVerbatimArguments: true, timeout: 90000 });
}
const loadModule = root => `. ${quote(join(root, 'scripts/node-runtime.ps1'))}\r\n`;
async function oldNodeFixture(root, cwd) {
  const directory = join(root, 'shadow old Node !'); await mkdir(directory);
  const executable = join(directory, 'node.exe'); await cp(process.execPath, executable);
  const targets = [executable];
  if (cwd) { const executable = join(cwd, 'node.exe'); await cp(process.execPath, executable); targets.push(executable); }
  const marker = join(directory, 'invoked.txt');
  const preload = join(directory, 'old-version.cjs');
  // Real native Node executables exercise CMD resolution. Only these shadow
  // executables report a controlled legacy version; the local runtime is untouched.
  await writeFile(preload, `
    if (${JSON.stringify(targets.map(path => path.toLowerCase()))}.includes(process.execPath.toLowerCase())) {
      require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'legacy Node invoked\\n');
      Object.defineProperty(process.versions, 'node', { value: '20.0.0' });
    }
  `);
  return { directory, marker, env: { NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"` } };
}

test('Windows launcher prefers local Node over old cwd/PATH Node and passes arguments and exit status', windows, async t => {
  const root = await fixture(t); await localNode(root);
  await writeFile(join(root, 'server/index.mjs'), 'console.log(JSON.stringify({exe:process.execPath,args:process.argv.slice(2),path:process.env.PATH}));process.exit(23);');
  const cwd = join(root, 'outside !'); await mkdir(cwd);
  const old = await oldNodeFixture(root, cwd);
  await assert.rejects(cmd(root, 'start.cmd', '--no-open "two words ! 中文"', old.directory + ';' + systemPath, cwd, old.env), error => {
    assert.equal(error.code, 23, error.stdout + error.stderr); const result = JSON.parse(error.stdout.trim());
    assert.equal(result.exe, join(root, '.runtime/node/node.exe'));
    assert.deepEqual(result.args, ['--no-open', 'two words ! 中文']);
    assert.equal(result.path.split(';')[0], join(root, '.runtime/node'));
    return true;
  });
  await assert.rejects(access(old.marker), { code: 'ENOENT' });
});

test('Windows launcher explains setup for missing or old Node without starting the server', windows, async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'server/index.mjs'), 'console.log("SERVER_STARTED");');
  const old = await oldNodeFixture(root);
  for (const path of [systemPath, old.directory + ';' + systemPath]) {
    await assert.rejects(cmd(root, 'start.cmd', '', path, root, old.env), error => {
      assert.equal(error.code, 1); assert.match(error.stdout, /setup\.cmd/); assert.doesNotMatch(error.stdout, /SERVER_STARTED/); return true;
    });
  }
  assert.match(await readFile(old.marker, 'utf8'), /legacy Node invoked/);
});

test('PowerShell 5.1 maps native architecture and rejects unsupported machines', windows, async t => {
  const root = await fixture(t);
  const result = await ps(root, loadModule(root) + `
    $env:PROCESSOR_ARCHITEW6432 = 'AMD64'; $env:PROCESSOR_ARCHITECTURE = 'x86'
    Resolve-NodeArchitecture
    $env:PROCESSOR_ARCHITEW6432 = 'ARM64'; Resolve-NodeArchitecture
    $env:PROCESSOR_ARCHITEW6432 = ''; $env:PROCESSOR_ARCHITECTURE = 'AMD64'; Resolve-NodeArchitecture
    $env:PROCESSOR_ARCHITECTURE = 'x86'
    try { Resolve-NodeArchitecture; throw 'accepted unsupported architecture' } catch { if ($_.Exception.Message -notmatch 'Unsupported Windows architecture') { throw }; 'unsupported rejected' }
  `);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), ['x64', 'arm64', 'x64', 'unsupported rejected']);
});

test('setup.cmd works offline without system Node, reuses healthy runtime and checks existing config', windows, async t => {
  const root = await fixture(t); await localNode(root); await manifest(root);
  await writeFile(join(root, 'config.local.json'), JSON.stringify({ xelatexPath: 'missing-xelatex.exe' }));
  const before = await readFile(join(root, '.runtime/node/node.exe'));
  const result = await cmd(root, 'setup.cmd', '--no-pause');
  assert.match(result.stdout, /reus/i); assert.match(result.stdout, /start\.cmd/);
  assert.match(result.stdout, /https:\/\/miktex.org\/download/); assert.match(result.stdout, /docs\/local-editor.md/);
  assert.match(result.stdout, /Node.*editor.*ready/i); assert.doesNotMatch(result.stdout, /PDF ready|Resume Workbench:/);
  assert.deepEqual(await readFile(join(root, '.runtime/node/node.exe')), before);
  await writeFile(join(root, 'config.local.json'), '{invalid');
  await assert.rejects(cmd(root, 'setup.cmd', '--no-pause'), error => error.code !== 0 && /CONFIG_INVALID|配置/.test(error.stdout + error.stderr));
});

test('download, checksum, extraction and version failures preserve existing runtime in PowerShell 5.1', windows, async t => {
  const fixtureVersion = `${Number(process.versions.node.split('.')[0]) + 1}.0.0`;
  const root = await fixture(t); await localNode(root); await manifest(root, '0'.repeat(64), fixtureVersion);
  const nodePath = join(root, '.runtime/node/node.exe'); const before = await readFile(nodePath);
  // The only replaced boundary downloads bytes. Hashing, extraction, validation and publication stay real.
  for (const failure of ['download', 'checksum', 'extraction', 'version']) {
    const archive = join(root, 'fixture.zip');
    if (failure === 'version') {
      const payload = join(root, `node-v${fixtureVersion}-win-${process.arch}`); await mkdir(payload, { recursive: true });
      await cp(process.execPath, join(payload, 'node.exe'));
      await ps(root, `Compress-Archive -LiteralPath ${quote(payload)} -DestinationPath ${quote(archive)} -Force`);
    } else await writeFile(archive, 'invalid ZIP');
    const result = await ps(root, loadModule(root) + `
      $root = ${quote(root)}; $fixtureArchive = ${quote(archive)}
      ${['extraction', 'version'].includes(failure) ? `$m = Get-Content -LiteralPath (Join-Path $root 'scripts/node-runtime.json') -Raw | ConvertFrom-Json; $m.sha256.x64 = (Get-FileHash -LiteralPath $fixtureArchive -Algorithm SHA256).Hash; $m | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'scripts/node-runtime.json')` : ''}
      function Download-NodeArchive { param($Uri, $Destination) ${failure === 'download' ? "throw 'fixture download failure'" : 'Copy-Item -LiteralPath $fixtureArchive -Destination $Destination'} }
      try { Invoke-NodeSetup -ProjectRoot $root; throw 'unexpected success' } catch { if ($_.Exception.Message -eq 'unexpected success') { throw }; Write-Output $_.Exception.Message }
    `);
    assert.match(result.stdout, { download: /download failure/, checksum: /SHA256/, extraction: /archive|ZIP|zip|目录|文件/, version: /version|architecture/i }[failure]);
    assert.deepEqual(await readFile(nodePath), before, failure + ' must preserve old runtime');
    const leftovers = await ps(root, `@(Get-ChildItem -LiteralPath ${quote(join(root, '.runtime'))} -Directory | Where-Object Name -Like 'setup-*').Count`);
    assert.equal(leftovers.stdout.trim(), '0');
  }
});

test('repair validates a fixture archive then concurrent setups publish exactly one healthy runtime', windows, async t => {
  const root = await fixture(t); await manifest(root);
  const payload = join(root, `node-v${process.versions.node}-win-${process.arch}`); await mkdir(payload);
  await cp(process.execPath, join(payload, 'node.exe'));
  const archive = join(root, 'fixture.zip');
  await ps(root, `Compress-Archive -LiteralPath ${quote(payload)} -DestinationPath ${quote(archive)} -Force`);
  // Initialize the fixture before racing production setup, whose manifest is read-only.
  await ps(root, loadModule(root) + `
    $m = Get-Content -LiteralPath ${quote(join(root, 'scripts/node-runtime.json'))} -Raw | ConvertFrom-Json
    $m.sha256.x64 = (Get-FileHash -LiteralPath ${quote(archive)} -Algorithm SHA256).Hash
    $m | ConvertTo-Json | Set-Content -LiteralPath ${quote(join(root, 'scripts/node-runtime.json'))}
  `);
  await mkdir(join(root, '.runtime/node'), { recursive: true });
  await writeFile(join(root, '.runtime/node/node.exe'), 'broken runtime');
  const code = loadModule(root) + `
    $root = ${quote(root)}; $fixtureArchive = ${quote(archive)}
    function Download-NodeArchive { param($Uri, $Destination)
      if ($Uri -ne 'https://nodejs.org/dist/v${process.versions.node}/node-v${process.versions.node}-win-x64.zip') { throw 'wrong official URL' }
      Start-Sleep -Milliseconds 300
      Copy-Item -LiteralPath $fixtureArchive -Destination $Destination
    }
    Invoke-NodeSetup -ProjectRoot $root
  `;
  const results = await Promise.all([ps(root, code), ps(root, code)]);
  assert.equal(results.filter(result => /Prepared portable Node/.test(result.stdout)).length, 1);
  assert.equal(results.filter(result => /Reusing/.test(result.stdout)).length, 1);
  const probe = await exec(join(root, '.runtime/node/node.exe'), ['-v']); assert.equal(probe.stdout.trim(), process.version);
  await access(join(root, '.runtime/node/node.exe'));
});
