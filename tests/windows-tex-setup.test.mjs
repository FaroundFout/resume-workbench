import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveToolchain } from '../server/environment/toolchain.mjs';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const psExe = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const windows = { skip: process.platform !== 'win32' };
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const relativeExecutable = '.runtime/tex/g-11111111111111111111111111111111/texmfs/install/miktex/bin/x64/xelatex.exe';
const fingerprint = 'a'.repeat(64);
const record = { schema: 1, relativeExecutable, fingerprint, verifiedAt: '2026-10-12T00:00:00.000Z' };
async function rootFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'PureCV 私有 TeX 空格 !-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  return root;
}
async function put(path, value = 'fixture') { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); }
async function selectionApi() {
  const module = await import('../server/environment/selection.mjs').catch(error => error.code === 'ERR_MODULE_NOT_FOUND' ? {} : Promise.reject(error));
  assert.equal(typeof module.readManagedSelection, 'function', 'managed selection reader must exist');
  return module;
}
async function ps(root, code) {
  const script = join(root, `test-${crypto.randomUUID()}.ps1`);
  await writeFile(script, '\ufeff$ErrorActionPreference="Stop"\r\n[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)\r\n' + code);
  return exec(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { cwd: root, windowsHide: true, timeout: 90000 });
}
async function moduleFixture(t) {
  const root = await rootFixture(t);
  await mkdir(join(root,'server/environment'),{recursive:true});
  await cp(join(project,'server/environment/record.mjs'),join(root,'server/environment/record.mjs'));
  for (const file of ['tex-runtime.ps1', 'tex-bootstrap.json']) {
    try { await cp(join(project, 'scripts', file), join(root, 'scripts', file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return root;
}
const load = root => `. ${quote(join(root, 'scripts/tex-runtime.ps1'))}\r\n`;
const profile = `function Get-TexPlatform { @{ architecture='x64'; version='10.0'; build=22631; workstation=$true } }\r\n`;
const absent = `function Get-TexDiscovery { param($ProjectRoot,$NodeExecutable,$CancellationToken,$TimeoutMs) @{ executable=$null; explicit=$false; timedOut=$false } }\r\n`;

test('missing bundled resources fail real discovery before any bootstrap download', windows, async t => {
  const root=await moduleFixture(t);
  await cp(join(project,'server'),join(root,'server'),{recursive:true});
  const result=await ps(root,load(root)+profile+`
    function Download-TexArchive { throw 'download forbidden' }
    try { Invoke-TexSetup -ProjectRoot ${quote(root)} -NodeExecutable ${quote(process.execPath)}; throw 'unexpected success' }
    catch { if ($_.Exception.Message -notmatch 'PROJECT_RESOURCE_MISSING') { throw }; 'resources rejected' }
  `);
  assert.match(result.stdout,/resources rejected/);
  await assert.rejects(readdir(join(root,'.runtime/tex')),{code:'ENOENT'});
});

test('managed selection only accepts published bounded project-local regular executable paths', async t => {
  const root = await rootFixture(t); const { readManagedSelection } = await selectionApi();
  assert.equal(await readManagedSelection(root), null);
  await put(join(root, relativeExecutable)); await put(join(root, '.runtime/tex-selection.json'), JSON.stringify(record));
  assert.deepEqual(await readManagedSelection(root), { relativeExecutable, fingerprint });
  for (const invalid of [
    { ...record, schema: 2 }, { ...record, fingerprint: 'bad' }, { ...record, verifiedAt: 'invalid' },
    { ...record, relativeExecutable: '../outside/xelatex.exe' }, { ...record, relativeExecutable: 'C:/outside/xelatex.exe' },
    { ...record, relativeExecutable: relativeExecutable.replace('/texmfs/', '/../texmfs/') },
    { ...record, relativeExecutable: relativeExecutable.replace('xelatex.exe', 'miktex.exe') },
  ]) {
    await writeFile(join(root, '.runtime/tex-selection.json'), JSON.stringify(invalid));
    assert.equal(await readManagedSelection(root), null);
  }
  await writeFile(join(root, '.runtime/tex-selection.json'), '{' + 'x'.repeat(16384));
  assert.equal(await readManagedSelection(root), null);
});

test('managed selection rejects junction ancestors and linked records before selecting an executable', windows, async t => {
  const root = await rootFixture(t); const { readManagedSelection } = await selectionApi();
  const outside = join(root, 'outside'); await put(join(outside, 'g-11111111111111111111111111111111/texmfs/install/miktex/bin/x64/xelatex.exe'));
  await mkdir(join(root, '.runtime')); await symlink(outside, join(root, '.runtime/tex'), 'junction');
  await put(join(root, '.runtime/tex-selection.json'), JSON.stringify(record));
  assert.equal(await readManagedSelection(root), null);
  await rm(join(root, '.runtime/tex')); await mkdir(join(root, '.runtime/tex'));
  await put(join(root, relativeExecutable)); await rm(join(root, '.runtime/tex-selection.json'));
  await symlink(outside, join(root, '.runtime/tex-selection.json'), 'junction');
  assert.equal(await readManagedSelection(root), null);
});

test('managed compiler precedes system discovery while explicit compiler always wins without fallback', async t => {
  const root = await rootFixture(t); await put(join(root, relativeExecutable));
  await put(join(root, '.runtime/tex-selection.json'), JSON.stringify(record));
  const bin = dirname(join(root, relativeExecutable));
  for (const name of ['miktex', 'findtexmf']) await put(join(bin, name + (process.platform === 'win32' ? '.exe' : '')));
  const probes = [];
  const probe = async executable => { probes.push(executable); return { flavour:'miktex', exitCode:0, log:'MiKTeX-XeTeX fixture' }; };
  const selected = await resolveToolchain({ projectRoot:root, xelatexPath:null }, { env:{ PATH:'' }, commonPaths:[], probe });
  assert.equal(selected?.executable, join(root, relativeExecutable)); assert.deepEqual(probes, [join(root, relativeExecutable)]);
  probes.length = 0;
  const explicit = join(root, 'explicit missing.exe');
  assert.equal(await resolveToolchain({ projectRoot:root, xelatexPath:explicit }, { env:{ PATH:bin }, commonPaths:[],
    probe:async executable => { probes.push(executable); return { flavour:null, log:'' }; } }), null);
  assert.deepEqual(probes, [explicit]);
});

test('managed repository is restored only for its selected private compiler and cannot override explicit environment', async t => {
  const root = await rootFixture(t); await put(join(root,relativeExecutable));
  await put(join(root,'.runtime/tex-selection.json'),JSON.stringify({...record,repository:{url:'https://example.test/miktex/'}}));
  const probe=async () => ({flavour:'miktex',exitCode:0,log:'MiKTeX fixture'});
  const managed=await resolveToolchain({projectRoot:root,xelatexPath:null},{env:{PATH:''},commonPaths:[],probe});
  assert.equal(managed?.env.MIKTEX_REPOSITORY,'https://example.test/miktex/');
  const configured=await resolveToolchain({projectRoot:root,xelatexPath:join(root,relativeExecutable)}, {env:{PATH:'',MIKTEX_REPOSITORY:'user repository'},commonPaths:[],probe});
  assert.equal(configured.env.MIKTEX_REPOSITORY,'user repository');
});

test('existing compiler reuse and invalid explicit config start no bootstrap download', windows, async t => {
  const root = await moduleFixture(t);
  const result = await ps(root, load(root) + `
    function Download-TexArchive { throw 'download forbidden' }
    function Get-TexDiscovery { @{ executable='C:\\fixture\\xelatex.exe'; explicit=$false; timedOut=$false } }
    Invoke-TexSetup -ProjectRoot ${quote(root)} -NodeExecutable ${quote(process.execPath)}
    function Get-TexDiscovery { @{ executable=$null; explicit=$true; timedOut=$false } }
    try { Invoke-TexSetup -ProjectRoot ${quote(root)} -NodeExecutable ${quote(process.execPath)}; throw 'unexpected success' }
    catch { if ($_.Exception.Message -notmatch 'COMPILER_CONFIG_INVALID') { throw }; 'explicit rejected' }
  `);
  assert.match(result.stdout, /C:\\fixture\\xelatex.exe/); assert.match(result.stdout, /explicit rejected/);
});

test('ARM64, Windows 10 and server profiles refuse automatic x64 deployment before downloading', windows, async t => {
  const root = await moduleFixture(t);
  const result = await ps(root, load(root) + absent + `
    function Download-TexArchive { throw 'download forbidden' }
    foreach ($profile in @(
      @{architecture='arm64';version='10.0';build=22631;workstation=$true},
      @{architecture='x64';version='10.0';build=19045;workstation=$true},
      @{architecture='x64';version='10.0';build=26100;workstation=$false}
    )) {
      function Get-TexPlatform { $profile }
      try { Invoke-TexSetup -ProjectRoot ${quote(root)} -NodeExecutable ${quote(process.execPath)}; throw 'unexpected success' }
      catch { if ($_.Exception.Message -notmatch 'TEX_PLATFORM_UNSUPPORTED') { throw }; 'unsupported rejected' }
    }
  `);
  assert.equal((result.stdout.match(/unsupported rejected/g) || []).length, 3);
});

async function bootstrapArchive(root) {
  await put(join(root, 'payload/miktexsetup_standalone.exe'), 'fixture installer boundary only');
  const archive = join(root, 'fixture.zip');
  await ps(root, `Compress-Archive -Path ${quote(join(root, 'payload/*'))} -DestinationPath ${quote(archive)}`);
  return archive;
}
const fakeBootstrap = (root, archive, failure = '') => `
  $fixtureArchive=${quote(archive)}
  $manifest=Get-Content -LiteralPath ${quote(join(root, 'scripts/tex-bootstrap.json'))} -Raw | ConvertFrom-Json
  $manifest.sha256=${failure === 'checksum' ? "'0' * 64" : '(Get-FileHash -LiteralPath $fixtureArchive -Algorithm SHA256).Hash'}
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath ${quote(join(root, 'scripts/tex-bootstrap.json'))}
  function Download-TexArchive { param($Uri,$Destination,$CancellationToken,$TimeoutMs)
    ${failure === 'download' ? "throw 'fixture network failure'" : 'Copy-Item -LiteralPath $fixtureArchive -Destination $Destination'}
  }
  function Invoke-TexInstaller { param($Executable,$Generation,$Repository,$CancellationToken,$TimeoutMs)
    ${failure === 'install' ? "throw 'fixture install failure'" : `[IO.Directory]::CreateDirectory((Join-Path $Generation 'texmfs/install/miktex/bin/x64')) | Out-Null
    [IO.File]::WriteAllText((Join-Path $Generation 'texmfs/install/miktex/bin/x64/xelatex.exe'), $Generation)`}
  }
  function Test-TexCandidate { param($ProjectRoot,$NodeExecutable,$Executable,$Generation,$CancellationToken,$TimeoutMs)
    ${failure === 'verify' ? "throw 'fixture bilingual failure'" : "@{ fingerprint=('b' * 64); version='MiKTeX fixture'; verifiedAt='2026-10-12T00:00:00.000Z' }"}
  }
`;

test('checksum, install and bilingual failures preserve previous selection and remove only own generation', windows, async t => {
  const root = await moduleFixture(t); const archive = await bootstrapArchive(root);
  await put(join(root, relativeExecutable), 'old healthy tree'); await put(join(root, '.runtime/tex-selection.json'), JSON.stringify(record));
  const before = await readFile(join(root, '.runtime/tex-selection.json'));
  for (const failure of ['download', 'checksum', 'install', 'verify']) {
    const result = await ps(root, load(root) + profile + absent + fakeBootstrap(root, archive, failure) + `
      try { Invoke-TexSetup -ProjectRoot ${quote(root)} -NodeExecutable ${quote(process.execPath)}; throw 'unexpected success' }
      catch { if ($_.Exception.Message -eq 'unexpected success') { throw }; $_.Exception.Message }
    `);
    assert.match(result.stdout, {download:/network failure/,checksum:/SHA256/,install:/install failure/,verify:/bilingual failure/}[failure]);
    assert.deepEqual(await readFile(join(root, '.runtime/tex-selection.json')), before);
    assert.equal(await readFile(join(root, relativeExecutable), 'utf8'), 'old healthy tree');
    assert.deepEqual(await readdir(join(root, '.runtime/tex')), ['g-11111111111111111111111111111111']);
  }
});

test('successful candidate stays in stable generation and published record is reused on second run', windows, async t => {
  const root = await moduleFixture(t); const archive = await bootstrapArchive(root);
  await ps(root, load(root) + profile + absent + fakeBootstrap(root, archive) + `Invoke-TexSetup -ProjectRoot ${quote(root)} -NodeExecutable ${quote(process.execPath)}`);
  const selection = JSON.parse(await readFile(join(root, '.runtime/tex-selection.json'), 'utf8'));
  assert.match(selection.relativeExecutable, /^\.runtime\/tex\/g-[a-f0-9]{32}\/texmfs\/install\/miktex\/bin\/x64\/xelatex\.exe$/);
  const executable = join(root, selection.relativeExecutable);
  assert.equal(await readFile(executable, 'utf8'), join(root, selection.relativeExecutable.split('/texmfs/')[0]));
  assert.equal(selection.fingerprint, 'b'.repeat(64));
  const result = await ps(root, load(root) + `
    function Get-TexDiscovery { @{ executable=${quote(executable)}; explicit=$false; timedOut=$false } }
    function Download-TexArchive { throw 'download forbidden' }
    Invoke-TexSetup -ProjectRoot ${quote(root)} -NodeExecutable ${quote(process.execPath)}
  `);
  assert.match(result.stdout, /Reusing/); assert.equal((await readdir(join(root, '.runtime/tex'))).length, 1);
});

test('setup lock rejects concurrent generation mutation and cancellation starts no download', windows, async t => {
  const root = await moduleFixture(t); await mkdir(join(root, '.runtime'));
  const result = await ps(root, load(root) + profile + absent + `
    function Download-TexArchive { throw 'download forbidden' }
    $lock=[IO.File]::Open(${quote(join(root, '.runtime/tex-setup.lock'))},'OpenOrCreate','ReadWrite','None')
    try {
      try { Invoke-TexSetup -ProjectRoot ${quote(root)} -NodeExecutable ${quote(process.execPath)}; throw 'unexpected success' }
      catch { if ($_.Exception.Message -notmatch 'ENVIRONMENT_BUSY') { throw }; 'busy rejected' }
    } finally { $lock.Dispose() }
    $cancel=New-Object Threading.CancellationTokenSource; $cancel.Cancel()
    try { Invoke-TexSetup -ProjectRoot ${quote(root)} -NodeExecutable ${quote(process.execPath)} -CancellationToken $cancel.Token; throw 'unexpected success' }
    catch { if ($_.Exception.Message -notmatch 'cancel') { throw }; 'cancelled' }
  `);
  assert.match(result.stdout, /busy rejected/); assert.match(result.stdout, /cancelled/);
});

test('setup refuses runtime junction before writing outside the project runtime', windows, async t => {
  const root = await moduleFixture(t); const outside = join(root, 'outside'); await mkdir(outside);
  await symlink(outside, join(root, '.runtime'), 'junction');
  const result = await ps(root, load(root) + profile + absent + `
    function Download-TexArchive { throw 'download forbidden' }
    try { Invoke-TexSetup -ProjectRoot ${quote(root)} -NodeExecutable ${quote(process.execPath)}; throw 'unexpected success' }
    catch { if ($_.Exception.Message -notmatch 'reparse|regular') { throw }; 'junction rejected' }
  `);
  assert.match(result.stdout, /junction rejected/); assert.deepEqual(await readdir(outside), []);
});

test('bootstrap traversal archive is rejected before extraction or installer execution', windows, async t => {
  const root = await moduleFixture(t); const archive = join(root, 'traversal.zip');
  await ps(root, `Add-Type -AssemblyName System.IO.Compression.FileSystem; Add-Type -AssemblyName System.IO.Compression
    $file=[IO.File]::Open(${quote(archive)},'Create')
    $zip=New-Object IO.Compression.ZipArchive($file,[IO.Compression.ZipArchiveMode]::Create)
    try { $entry=$zip.CreateEntry('../outside.exe'); $stream=$entry.Open(); $stream.WriteByte(1); $stream.Dispose() } finally { $zip.Dispose(); $file.Dispose() }`);
  const result = await ps(root, load(root) + profile + absent + fakeBootstrap(root, archive) + `
    function Invoke-TexInstaller { throw 'installer forbidden' }
    try { Invoke-TexSetup -ProjectRoot ${quote(root)} -NodeExecutable ${quote(process.execPath)}; throw 'unexpected success' }
    catch { if ($_.Exception.Message -notmatch 'archive layout') { throw }; 'traversal rejected' }
  `);
  assert.match(result.stdout, /traversal rejected/); assert.deepEqual(await readdir(join(root, '.runtime/tex')), []);
  await assert.rejects(readFile(join(root, 'outside.exe')), { code:'ENOENT' });
});

test('installer only uses private portable basic flags and retries download twice without repeating installation', windows, async t => {
  const root = await moduleFixture(t);
  const result = await ps(root, load(root) + `
    $script:attempts=0; $script:installCalls=0
    function Invoke-TexProcess { param($Executable,$Arguments,$WorkingDirectory,$CancellationToken,$TimeoutMs)
      foreach ($flag in @('--shared=no','--use-registry=no','--modify-path=no','--program-folder=','--package-set=basic',('--portable=' + ${quote(root)}),('--local-package-repository=' + ${quote(join(root,'repository'))}))) {
        if ($Arguments -notcontains $flag) { throw ('missing protection ' + $flag) }
      }
      if ($Arguments -contains '--admin') { throw 'admin forbidden' }
      if ($Arguments[-1] -eq 'download') { $script:attempts++; if ($script:attempts -le 2) { throw 'network unavailable' } }
      elseif ($Arguments[-1] -eq 'install') { $script:installCalls++ }
      else { throw 'unrecognized installer task' }
      return ''
    }
    Invoke-TexInstaller -Executable 'fixture-boundary.exe' -Generation ${quote(root)} -Repository ${quote(join(root,'repository'))} -CancellationToken ([Threading.CancellationToken]::None) -TimeoutMs 5000
    "$script:attempts|$script:installCalls"
  `);
  assert.match(result.stdout, /3\|1/);
});

test('bounded subprocess runner preserves quoted arguments and kills children on timeout or cancellation', windows, async t => {
  const root = await moduleFixture(t);
  const pidFile = join(root, 'child.pid'); const child = join(root, 'child.mjs');
  await writeFile(child, `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    writeFileSync(process.argv[2],String(child.pid));setInterval(()=>{},1000);`);
  const result = await ps(root, load(root) + `
    $args=@('two words ! 中文','quote"value','trailing\\')
    Invoke-TexProcess -Executable ${quote(process.execPath)} -Arguments (@('-e','console.log(JSON.stringify(process.argv.slice(1)))') + $args) -WorkingDirectory ${quote(root)} -TimeoutMs 5000
    foreach ($mode in @('timeout','cancel')) {
      $cancel=New-Object Threading.CancellationTokenSource
      if ($mode -eq 'cancel') { $cancel.CancelAfter(800) }
      try { Invoke-TexProcess -Executable ${quote(process.execPath)} -Arguments @(${quote(child)},${quote(pidFile)}) -WorkingDirectory ${quote(root)} -CancellationToken $cancel.Token -TimeoutMs 800; throw 'unexpected success' }
      catch { if ($_.Exception.Message -notmatch 'TIMEOUT|cancel') { throw }; $mode + ' stopped' }
      if (Test-Path -LiteralPath ${quote(pidFile)}) {
        $childPid=[int](Get-Content -LiteralPath ${quote(pidFile)})
        if (Get-Process -Id $childPid -ErrorAction SilentlyContinue) { throw 'child leaked' }
        Remove-Item -LiteralPath ${quote(pidFile)}
      } else { throw 'fixture did not launch its child' }
      $cancel.Dispose()
    }
  `);
  const line = result.stdout.split(/\r?\n/).find(line => line.startsWith('['));
  assert.deepEqual(JSON.parse(line), ['two words ! 中文','quote"value','trailing\\']);
  assert.match(result.stdout,/timeout stopped/); assert.match(result.stdout,/cancel stopped/);
});

test('full setup deploys only after missing compiler and final success uses the published selection', windows, async t => {
  const root = await moduleFixture(t); const archive = await bootstrapArchive(root);
  await cp(join(project,'scripts/setup-windows.ps1'),join(root,'scripts/setup-windows.ps1'));
  await put(join(root,'scripts/node-runtime.ps1'), `function Invoke-NodeSetup { param($ProjectRoot) ${quote(process.execPath)} }`);
  const doctor = `import {readFileSync,writeFileSync,existsSync} from 'node:fs'; import {join} from 'node:path';
    const root=${JSON.stringify(root)}; const selected=join(root,'.runtime/tex-selection.json');
    if(!existsSync(selected)){ console.log('MISSING_COMPILER'); process.exit(1); }
    const record=JSON.parse(readFileSync(selected,'utf8')); console.log('PDF_READY:'+record.relativeExecutable);`;
  await writeFile(join(root,'scripts/doctor.mjs'),doctor);
  const module = join(root,'scripts/tex-runtime.ps1');
  await writeFile(module, '\ufeff' + await readFile(module,'utf8') + '\n' + profile + absent + fakeBootstrap(root,archive));
  const result = await exec(psExe,['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'scripts/setup-windows.ps1')],{cwd:root,windowsHide:true,timeout:90000});
  assert.match(result.stdout,/MISSING_COMPILER/); assert.match(result.stdout,/PDF_READY:\.runtime\/tex\/g-/);
  await assert.rejects(readFile(join(root,'config.local.json')),{code:'ENOENT'});
});

test('candidate verification requires same-source MiKTeX, remote repository and update mode before publication', windows, async t => {
  const root=await moduleFixture(t); await cp(join(project,'server'),join(root,'server'),{recursive:true});
  const executable=join(root,relativeExecutable), generation=join(root,relativeExecutable.split('/texmfs/')[0]);
  await put(executable); await put(join(dirname(executable),'mpm.exe'));
  await writeFile(join(root,'server/compiler/process.mjs'), `export async function runProcess(options){
    if(options.executable!==${JSON.stringify(join(dirname(executable),'mpm.exe'))}||JSON.stringify(options.args)!=='["--pick-repository-url"]') throw Error('wrong repository source');
    return {exitCode:0,stdout:'https://example.test/miktex/\\n'};
  }`);
  await writeFile(join(root,'server/environment/prepare.mjs'), `export async function preparePdfEnvironment(config,options){
    if(config.xelatexPath!==${JSON.stringify(executable)}||options.update!==true||process.env.MIKTEX_REPOSITORY!=='https://example.test/miktex/') throw Error('candidate was not isolated or synchronized');
    return {state:'ready',pdfReady:true,fingerprint:'${'b'.repeat(64)}',verifiedAt:'2026-10-12T00:00:00.000Z',toolchain:{flavour:'miktex',executable:config.xelatexPath,version:'MiKTeX fixture'}};
  }`);
  const result=await ps(root,load(root)+`
    $verified=Test-TexCandidate -ProjectRoot ${quote(root)} -NodeExecutable ${quote(process.execPath)} -Executable ${quote(executable)} -Generation ${quote(generation)} -CancellationToken ([Threading.CancellationToken]::None) -TimeoutMs 10000
    $verified | ConvertTo-Json
  `);
  const verified=JSON.parse(result.stdout); assert.equal(verified.repository,'https://example.test/miktex/');
  await assert.rejects(readFile(join(root,'.runtime/environment-validation.json')),{code:'ENOENT'});
  await writeFile(join(root,'server/environment/prepare.mjs'), `export async function preparePdfEnvironment(){return {state:'ready',pdfReady:true,checks:[],toolchain:{flavour:'texlive',executable:'foreign'}};}`);
  await assert.rejects(ps(root,load(root)+`Test-TexCandidate -ProjectRoot ${quote(root)} -NodeExecutable ${quote(process.execPath)} -Executable ${quote(executable)} -Generation ${quote(generation)} -CancellationToken ([Threading.CancellationToken]::None) -TimeoutMs 10000`), error=>/Candidate toolchain identity changed/.test(error.stdout+error.stderr));
});

test('two independent setup processes cannot publish competing private generations', windows, async t => {
  const root=await moduleFixture(t); const archive=await bootstrapArchive(root), marker=join(root,'entered-installer');
  const code=load(root)+profile+absent+fakeBootstrap(root,archive)+`
    function Invoke-TexInstaller { param($Executable,$Generation,$Repository,$CancellationToken,$TimeoutMs)
      [IO.File]::WriteAllText(${quote(marker)},'locked'); Start-Sleep -Seconds 5
      [IO.Directory]::CreateDirectory((Join-Path $Generation 'texmfs/install/miktex/bin/x64')) | Out-Null
      [IO.File]::WriteAllText((Join-Path $Generation 'texmfs/install/miktex/bin/x64/xelatex.exe'),$Generation)
    }
    Invoke-TexSetup -ProjectRoot ${quote(root)} -NodeExecutable ${quote(process.execPath)}
  `;
  const first=ps(root,code);
  const deadline=Date.now()+10000;
  for (;;) {
    try { await readFile(marker); break; } catch(error) { if(error.code!=='ENOENT') throw error; }
    assert.ok(Date.now()<deadline,'first fixture must acquire the production lock');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  await assert.rejects(ps(root,code),error=>/ENVIRONMENT_BUSY/.test(error.stdout+error.stderr));
  await first;
  assert.equal((await readdir(join(root,'.runtime/tex'))).length,1);
  const selected=JSON.parse(await readFile(join(root,'.runtime/tex-selection.json'),'utf8'));
  assert.equal(selected.fingerprint,'b'.repeat(64));
});

test('selection publication failure preserves existing executable and previous record', windows, async t => {
  const root=await moduleFixture(t); const archive=await bootstrapArchive(root);
  await put(join(root,relativeExecutable),'previous healthy'); await put(join(root,'.runtime/tex-selection.json'),JSON.stringify(record));
  const previousValidation=Buffer.from(JSON.stringify({schema:1,fingerprint:'a'.repeat(64),pdfReady:true,verifiedAt:record.verifiedAt})+'\n');
  await put(join(root,'.runtime/environment-validation.json'),previousValidation);
  const before=await readFile(join(root,'.runtime/tex-selection.json'));
  const result=await ps(root,load(root)+profile+absent+fakeBootstrap(root,archive)+`
    $held=[IO.File]::Open(${quote(join(root,'.runtime/tex-selection.json'))},'Open','Read','Read')
    try {
      try { Invoke-TexSetup -ProjectRoot ${quote(root)} -NodeExecutable ${quote(process.execPath)}; throw 'unexpected success' }
      catch { if($_.Exception.Message -eq 'unexpected success'){throw}; 'publication rejected' }
    } finally { $held.Dispose() }
  `);
  assert.match(result.stdout,/publication rejected/);
  assert.deepEqual(await readFile(join(root,'.runtime/tex-selection.json')),before);
  assert.deepEqual(await readFile(join(root,'.runtime/environment-validation.json')),previousValidation);
  assert.equal(await readFile(join(root,relativeExecutable),'utf8'),'previous healthy');
  assert.deepEqual(await readdir(join(root,'.runtime/tex')),['g-11111111111111111111111111111111']);
});
