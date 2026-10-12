import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requiredProjectFiles } from '../server/environment/manifest.mjs';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const powershell = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const systemPath = join(process.env.SystemRoot || 'C:/Windows', 'System32');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const windows = { skip: process.platform !== 'win32' };
const fixtureArchitecture = process.arch;
const fixtureProcessor = { x64: 'AMD64', arm64: 'ARM64' }[fixtureArchitecture];
const runtimeFixtures = { skip: windows.skip || (!fixtureProcessor &&
  `Portable runtime fixtures need an x64 or arm64 Node runner; ${fixtureArchitecture} cannot satisfy the product's version/architecture check.`) };
function runtimeArchitectureProfile() {
  assert.ok(fixtureProcessor, `Unsupported portable runtime fixture runner: ${fixtureArchitecture}`);
  // These archives contain the runner, which can differ from the native OS ISA.
  // Set only the test subprocess profile; native mapping has its own unmodified test.
  return `$env:PROCESSOR_ARCHITEW6432 = '${fixtureProcessor}'\r\n$env:PROCESSOR_ARCHITECTURE = '${fixtureProcessor}'\r\n`;
}
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
  for (const file of ['setup.cmd', 'doctor.cmd', 'repair.cmd']) {
    try { await cp(join(project, file), join(root, file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return root;
}
async function runtimeFixture(t) {
  const root = await fixture(t);
  const entry = join(root, 'scripts/setup-windows.ps1');
  // Apply the fixture profile inside PS5.1, after Windows has created the process.
  // Only this disposable copied entry changes; the production script stays intact.
  const source = await readFile(entry, 'utf8');
  const firstLineEnd = source.indexOf('\n') + 1;
  await writeFile(entry, '\ufeff' + source.slice(0, firstLineEnd) + runtimeArchitectureProfile() + source.slice(firstLineEnd));
  return root;
}
async function runtimePs(root, code) { return ps(root, runtimeArchitectureProfile() + code); }
async function localNode(root) {
  await mkdir(join(root, '.runtime/node'), { recursive: true });
  await cp(process.execPath, join(root, '.runtime/node/node.exe'));
}
async function manifest(root, sha256 = '0'.repeat(64), version = process.versions.node) {
  await writeFile(join(root, 'scripts/node-runtime.json'), JSON.stringify({ version, sha256: { [fixtureArchitecture]: sha256 } }));
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

test('setup defaults to strict PDF preparation and supports explicit editor-only success with existing Node', runtimeFixtures, async t => {
  const root = await runtimeFixture(t); await localNode(root); await manifest(root);
  for (const resource of requiredProjectFiles) {
    await mkdir(join(root, resource, '..'), { recursive: true });
    await writeFile(join(root, resource), 'temporary public resource fixture');
  }
  await writeFile(join(root, 'config.local.json'), JSON.stringify({ xelatexPath: 'missing-xelatex.exe' }));
  const before = await readFile(join(root, '.runtime/node/node.exe'));
  await assert.rejects(cmd(root, 'setup.cmd', '--no-pause'), error => {
    assert.equal(error.code, 1); assert.match(error.stdout, /COMPILER_CONFIG_INVALID|missing-compiler/);
    assert.match(error.stdout, /https:\/\/miktex.org\/download/); assert.match(error.stdout, /docs\/local-editor.md/);
    assert.doesNotMatch(error.stdout, /Setup complete/); return true;
  });
  const result = await cmd(root, 'setup.cmd', '--no-pause --editor-only');
  assert.match(result.stdout, /reus/i); assert.match(result.stdout, /start\.cmd/);
  assert.match(result.stdout, /Node.*editor.*ready/i); assert.match(result.stdout, /PDF.*未准备|PDF.*not prepared/i);
  assert.doesNotMatch(result.stdout, /PDF are ready|Resume Workbench:/);
  assert.deepEqual(await readFile(join(root, '.runtime/node/node.exe')), before);
  await writeFile(join(root, 'config.local.json'), '{invalid');
  await assert.rejects(cmd(root, 'setup.cmd', '--editor-only --no-pause'), error => error.code !== 0 && /CONFIG_INVALID|配置/.test(error.stdout + error.stderr));
});

test('fixed Windows setup and diagnostic modes pass flags and preserve child exit status without pausing', runtimeFixtures, async t => {
  const root = await runtimeFixture(t); await localNode(root); await manifest(root);
  await writeFile(join(root, 'scripts/doctor.mjs'), 'console.log(JSON.stringify({args:process.argv.slice(2),exe:process.execPath}));process.exit(23);');
  const cases = [['setup.cmd', '--no-pause', '--prepare'], ['setup.cmd', '--editor-only --no-pause', '--editor-only'],
    ['setup.cmd', '--no-pause --editor-only', '--editor-only'], ['doctor.cmd', '--no-pause', '--verify'], ['repair.cmd', '--no-pause', '--prepare']];
  for (const [entry, args, expectedMode] of cases) {
    await assert.rejects(cmd(root, entry, args), error => {
      assert.equal(error.code, 23, error.stdout + error.stderr);
      const result = JSON.parse(error.stdout.trim().split(/\r?\n/u).find(line => line.startsWith('{')));
      assert.deepEqual(result.args, [expectedMode]);
      assert.equal(result.exe, join(root, '.runtime/node/node.exe'));
      assert.doesNotMatch(error.stdout, /Press any key|按任意键|Setup complete/i);
      return true;
    });
  }
});

test('unknown Windows entry flags are rejected before any setup or doctor work', runtimeFixtures, async t => {
  const root = await runtimeFixture(t); await localNode(root); await manifest(root);
  await writeFile(join(root, 'scripts/doctor.mjs'), 'console.log("DOCTOR_STARTED");');
  for (const [entry, args] of [['setup.cmd', '--no-pause --unknown'], ['setup.cmd', '--editor-only --unknown --no-pause'],
    ['doctor.cmd', '--prepare --no-pause'], ['repair.cmd', '--editor-only --no-pause']]) {
    await assert.rejects(cmd(root, entry, args), error => {
      assert.equal(error.code, 2, error.stdout + error.stderr);
      assert.match(error.stdout, /Usage/i);
      assert.doesNotMatch(error.stdout, /DOCTOR_STARTED|Reusing|Downloading|Press any key/i);
      return true;
    });
  }
});

test('diagnostic entries explain missing or old Node and never install it', windows, async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'scripts/doctor.mjs'), 'console.log("DOCTOR_STARTED");');
  const old = await oldNodeFixture(root);
  for (const entry of ['doctor.cmd', 'repair.cmd']) {
    for (const path of [systemPath, old.directory + ';' + systemPath]) {
      await assert.rejects(cmd(root, entry, '--no-pause', path, root, old.env), error => {
        assert.equal(error.code, 1, error.stdout + error.stderr); assert.match(error.stdout, /setup\.cmd/);
        assert.doesNotMatch(error.stdout, /DOCTOR_STARTED|Downloading/i); return true;
      });
    }
  }
  await assert.rejects(access(join(root, '.runtime/node/node.exe')), error => error.code === 'ENOENT');
});

test('download, checksum, extraction and version failures preserve existing runtime in PowerShell 5.1', runtimeFixtures, async t => {
  const fixtureVersion = `${Number(process.versions.node.split('.')[0]) + 1}.0.0`;
  const root = await runtimeFixture(t); await localNode(root); await manifest(root, '0'.repeat(64), fixtureVersion);
  const nodePath = join(root, '.runtime/node/node.exe'); const before = await readFile(nodePath);
  // The only replaced boundary downloads bytes. Hashing, extraction, validation and publication stay real.
  for (const failure of ['download', 'checksum', 'extraction', 'version']) {
    const archive = join(root, 'fixture.zip');
    if (failure === 'version') {
      const payload = join(root, `node-v${fixtureVersion}-win-${fixtureArchitecture}`); await mkdir(payload, { recursive: true });
      await cp(process.execPath, join(payload, 'node.exe'));
      await runtimePs(root, `Compress-Archive -LiteralPath ${quote(payload)} -DestinationPath ${quote(archive)} -Force`);
    } else await writeFile(archive, 'invalid ZIP');
    const result = await runtimePs(root, loadModule(root) + `
      $root = ${quote(root)}; $fixtureArchive = ${quote(archive)}
      ${['extraction', 'version'].includes(failure) ? `$m = Get-Content -LiteralPath (Join-Path $root 'scripts/node-runtime.json') -Raw | ConvertFrom-Json; $m.sha256.${fixtureArchitecture} = (Get-FileHash -LiteralPath $fixtureArchive -Algorithm SHA256).Hash; $m | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'scripts/node-runtime.json')` : ''}
      function Download-NodeArchive { param($Uri, $Destination) ${failure === 'download' ? "throw 'fixture download failure'" : 'Copy-Item -LiteralPath $fixtureArchive -Destination $Destination'} }
      try { Invoke-NodeSetup -ProjectRoot $root; throw 'unexpected success' } catch { if ($_.Exception.Message -eq 'unexpected success') { throw }; Write-Output $_.Exception.Message }
    `);
    assert.match(result.stdout, { download: /download failure/, checksum: /SHA256/, extraction: /archive|ZIP|zip|目录|文件/, version: /version|architecture/i }[failure]);
    assert.deepEqual(await readFile(nodePath), before, failure + ' must preserve old runtime');
    const leftovers = await runtimePs(root, `@(Get-ChildItem -LiteralPath ${quote(join(root, '.runtime'))} -Directory | Where-Object Name -Like 'setup-*').Count`);
    assert.equal(leftovers.stdout.trim(), '0');
  }
});

test('repair validates a fixture archive then concurrent setups publish exactly one healthy runtime', runtimeFixtures, async t => {
  const root = await runtimeFixture(t); await manifest(root);
  const payload = join(root, `node-v${process.versions.node}-win-${fixtureArchitecture}`); await mkdir(payload);
  await cp(process.execPath, join(payload, 'node.exe'));
  const archive = join(root, 'fixture.zip');
  await runtimePs(root, `Compress-Archive -LiteralPath ${quote(payload)} -DestinationPath ${quote(archive)} -Force`);
  // Initialize the fixture before racing production setup, whose manifest is read-only.
  await runtimePs(root, loadModule(root) + `
    $m = Get-Content -LiteralPath ${quote(join(root, 'scripts/node-runtime.json'))} -Raw | ConvertFrom-Json
    $m.sha256.${fixtureArchitecture} = (Get-FileHash -LiteralPath ${quote(archive)} -Algorithm SHA256).Hash
    $m | ConvertTo-Json | Set-Content -LiteralPath ${quote(join(root, 'scripts/node-runtime.json'))}
  `);
  await mkdir(join(root, '.runtime/node'), { recursive: true });
  await writeFile(join(root, '.runtime/node/node.exe'), 'broken runtime');
  const code = loadModule(root) + `
    $root = ${quote(root)}; $fixtureArchive = ${quote(archive)}
    function Download-NodeArchive { param($Uri, $Destination)
      if ($Uri -ne 'https://nodejs.org/dist/v${process.versions.node}/node-v${process.versions.node}-win-${fixtureArchitecture}.zip') { throw 'wrong official URL' }
      Start-Sleep -Milliseconds 300
      Copy-Item -LiteralPath $fixtureArchive -Destination $Destination
    }
    Invoke-NodeSetup -ProjectRoot $root
  `;
  const results = await Promise.all([runtimePs(root, code), runtimePs(root, code)]);
  assert.equal(results.filter(result => /Prepared portable Node/.test(result.stdout)).length, 1);
  assert.equal(results.filter(result => /Reusing/.test(result.stdout)).length, 1);
  const probe = await exec(join(root, '.runtime/node/node.exe'), ['-v']); assert.equal(probe.stdout.trim(), process.version);
  await access(join(root, '.runtime/node/node.exe'));
});
