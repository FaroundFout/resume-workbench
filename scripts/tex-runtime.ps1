# Windows PowerShell 5.1. Only private, stable portable generations are created.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-TexPlatform {
    $native = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrWhiteSpace($native)) { $native = $env:PROCESSOR_ARCHITECTURE }
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    return @{ architecture = $native.ToUpperInvariant().Replace('AMD64','x64').Replace('ARM64','arm64'); version = $os.Version; build = [int]$os.BuildNumber; workstation = ($os.ProductType -eq 1) }
}

function Assert-TexPath {
    param([string]$ProjectRoot, [string]$Path, [switch]$Directory)
    $root = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
    $target = [IO.Path]::GetFullPath($Path)
    if ($target -ne $root -and -not $target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing TeX path outside project.' }
    $current = $root
    $parts = @('') + @($target.Substring($root.Length).TrimStart('\').Split('\') | Where-Object { $_ })
    foreach ($part in $parts) {
        if ($part) { $current = Join-Path $current $part }
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing TeX path through a reparse point.' }
            if (($current -ne $target -or $Directory) -and -not $item.PSIsContainer) { throw 'TeX directory must be regular.' }
        }
    }
}

function Remove-TexOwnedDirectory {
    param([string]$ProjectRoot, [string]$Path)
    $texRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot '.runtime\tex')).TrimEnd('\') + '\'
    $target = [IO.Path]::GetFullPath($Path)
    if (-not $target.StartsWith($texRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($target) -notmatch '^(g|work)-[a-f0-9]{32}$') { throw 'Refusing cleanup outside owned TeX generation.' }
    Assert-TexPath -ProjectRoot $ProjectRoot -Path $target -Directory
    if (Test-Path -LiteralPath $target) {
        # Inspect one level at a time so enumeration never traverses a junction.
        $queue = New-Object 'Collections.Generic.Queue[string]'; $queue.Enqueue($target)
        while ($queue.Count) {
            foreach ($item in Get-ChildItem -LiteralPath $queue.Dequeue() -Force -ErrorAction Stop) {
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing TeX cleanup through a reparse point.' }
                if ($item.PSIsContainer) { $queue.Enqueue($item.FullName) }
            }
        }
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    }
}

function ConvertTo-TexArgument {
    param([string]$Value)
    # Windows CommandLineToArgvW quoting; no shell is involved.
    return '"' + ([regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
}

function Stop-TexProcessTree {
    param([Diagnostics.Process]$Process)
    if (-not $Process.HasExited) {
        $killer = New-Object Diagnostics.Process
        try {
            $killer.StartInfo.FileName = Join-Path $env:SystemRoot 'System32\taskkill.exe'
            $killer.StartInfo.Arguments = '/PID ' + $Process.Id + ' /T /F'
            $killer.StartInfo.UseShellExecute = $false; $killer.StartInfo.CreateNoWindow = $true
            $killer.StartInfo.RedirectStandardOutput = $true; $killer.StartInfo.RedirectStandardError = $true
            [void]$killer.Start(); if (-not $killer.WaitForExit(5000)) { $killer.Kill() }
        } finally { $killer.Dispose() }
        if (-not $Process.HasExited) { $Process.Kill() }
        [void]$Process.WaitForExit(5000)
    }
}

function Invoke-TexProcess {
    param([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory, [Threading.CancellationToken]$CancellationToken = [Threading.CancellationToken]::None, [int]$TimeoutMs = 15000, [switch]$PassResult)
    $CancellationToken.ThrowIfCancellationRequested()
    $process = New-Object Diagnostics.Process; $started=$false
    try {
        $process.StartInfo.FileName = $Executable
        $process.StartInfo.Arguments = (($Arguments | ForEach-Object { ConvertTo-TexArgument $_ }) -join ' ')
        $process.StartInfo.WorkingDirectory = $WorkingDirectory
        $process.StartInfo.UseShellExecute = $false; $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.RedirectStandardOutput = $true; $process.StartInfo.RedirectStandardError = $true
        $process.StartInfo.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
        $process.StartInfo.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
        [void]$process.Start(); $started=$true
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        $watch = [Diagnostics.Stopwatch]::StartNew()
        while (-not $process.WaitForExit(100)) {
            if ($CancellationToken.IsCancellationRequested) { Stop-TexProcessTree $process; $CancellationToken.ThrowIfCancellationRequested() }
            if ($watch.ElapsedMilliseconds -ge $TimeoutMs) { Stop-TexProcessTree $process; throw 'TEX_SETUP_TIMEOUT: process exceeded its time limit.' }
        }
        if (-not $stdout.Wait(5000) -or -not $stderr.Wait(5000)) { throw 'TEX_SETUP_TIMEOUT: child output did not close.' }
        if ($PassResult) { return @{ exitCode=$process.ExitCode; stdout=$stdout.Result; stderr=$stderr.Result } }
        if ($process.ExitCode -ne 0) { throw ('TEX_SETUP_PROCESS_FAILED: ' + $stderr.Result + $stdout.Result) }
        if ($stderr.Result) { Write-Host $stderr.Result.TrimEnd() }
        return $stdout.Result
    } finally { if ($null -ne $process) { if ($started -and -not $process.HasExited) { Stop-TexProcessTree $process }; $process.Dispose() } }
}

function Get-TexDiscovery {
    param($ProjectRoot,$NodeExecutable,$CancellationToken,$TimeoutMs)
    $code = @'
import {pathToFileURL} from 'node:url'; import {join} from 'node:path';
const root=process.argv[1];
const {loadConfig}=await import(pathToFileURL(join(root,'server/config.mjs')));
const {resolveToolchain}=await import(pathToFileURL(join(root,'server/environment/toolchain.mjs')));
const config=await loadConfig(root); let discovery;
const {inspectEnvironment}=await import(pathToFileURL(join(root,'server/environment/check.mjs')));
const resources=await inspectEnvironment(config,{toolchain:null,signal:AbortSignal.timeout(15000)});
if(resources.state==='missing-resources') throw Error(resources.checks.filter(x=>x.status==='failed').map(x=>`[${x.code}] ${x.message}`).join('\n'));
const selected=await resolveToolchain(config,{signal:AbortSignal.timeout(15000),onDiscovery:value=>discovery=value});
console.log(JSON.stringify({executable:selected?.executable??null,explicit:!!config.xelatexPath,timedOut:!!discovery?.timedOut}));
'@
    $output = Invoke-TexProcess -Executable $NodeExecutable -Arguments @('--input-type=module','-e',$code,$ProjectRoot) -WorkingDirectory $ProjectRoot -CancellationToken $CancellationToken -TimeoutMs $TimeoutMs
    return $output | ConvertFrom-Json
}

function Download-TexArchive {
    param([string]$Uri,[string]$Destination,[Threading.CancellationToken]$CancellationToken,[int]$TimeoutMs)
    # WebClient's asynchronous request allows cooperative cancellation in PS5.1.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $client = New-Object Net.WebClient
    try {
        $task = $client.DownloadFileTaskAsync([Uri]$Uri, $Destination)
        $watch = [Diagnostics.Stopwatch]::StartNew()
        while (-not $task.IsCompleted) {
            if ($CancellationToken.IsCancellationRequested) { $client.CancelAsync(); $CancellationToken.ThrowIfCancellationRequested() }
            if ($watch.ElapsedMilliseconds -ge $TimeoutMs) { $client.CancelAsync(); throw 'TEX_SETUP_TIMEOUT: bootstrap download exceeded its time limit.' }
            Start-Sleep -Milliseconds 100
        }
        $task.GetAwaiter().GetResult()
    } finally { $client.Dispose() }
}

function Expand-TexBootstrap {
    param([string]$Archive,[string]$Destination)
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        # The pinned official ZIP contains only one regular executable. Validate
        # every entry before extraction, so malicious traversal is never written.
        if ($zip.Entries.Count -ne 1 -or $zip.Entries[0].FullName -ne 'miktexsetup_standalone.exe' -or $zip.Entries[0].Length -gt 20000000) { throw 'Invalid MiKTeX bootstrap archive layout.' }
        if (($zip.Entries[0].ExternalAttributes -shr 16 -band 0xF000) -eq 0xA000) { throw 'Linked bootstrap archive entry rejected.' }
    } finally { $zip.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($Archive,$Destination)
}

function Invoke-TexInstaller {
    param($Executable,$Generation,$Repository,$CancellationToken,$TimeoutMs)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $common = @('--quiet','--shared=no','--use-registry=no','--modify-path=no','--program-folder=','--package-set=basic',('--local-package-repository=' + $Repository),('--portable=' + $Generation))
    for ($attempt = 0; ; $attempt++) {
        try {
            [void](Invoke-TexProcess -Executable $Executable -Arguments ($common + @('download')) -WorkingDirectory $Generation -CancellationToken $CancellationToken -TimeoutMs ([Math]::Max(1,$TimeoutMs - $watch.ElapsedMilliseconds)))
            break
        } catch { if ($attempt -ge 2 -or $CancellationToken.IsCancellationRequested -or $watch.ElapsedMilliseconds -ge $TimeoutMs) { throw }; Write-Host 'Retrying MiKTeX package download...' }
    }
    [void](Invoke-TexProcess -Executable $Executable -Arguments ($common + @('install')) -WorkingDirectory $Generation -CancellationToken $CancellationToken -TimeoutMs ([Math]::Max(1,$TimeoutMs - $watch.ElapsedMilliseconds)))
}

function Test-TexCandidate {
    param($ProjectRoot,$NodeExecutable,$Executable,$Generation,$CancellationToken,$TimeoutMs)
    $code = @'
import {pathToFileURL} from 'node:url'; import {join,dirname} from 'node:path'; import {stat,realpath} from 'node:fs/promises';
const [root,executable]=process.argv.slice(1);
const {loadConfig}=await import(pathToFileURL(join(root,'server/config.mjs')));
const {preparePdfEnvironment}=await import(pathToFileURL(join(root,'server/environment/prepare.mjs')));
const {redactEnvironmentLog}=await import(pathToFileURL(join(root,'server/environment/diagnostics.mjs')));
const {runProcess}=await import(pathToFileURL(join(root,'server/compiler/process.mjs')));
const config=await loadConfig(root);
if(config.xelatexPath) throw Error('COMPILER_CONFIG_CHANGED: explicit compiler configuration appeared during private installation');
const bin=dirname(executable), mpm=join(bin,'mpm.exe');
if(!(await stat(mpm)).isFile()||(await realpath(mpm)).toLowerCase()!==mpm.toLowerCase()) throw Error('Candidate package manager is not a regular sibling');
const picked=await runProcess({executable:mpm,args:['--pick-repository-url'],cwd:root,timeoutMs:15000,signal:AbortSignal.timeout(15000)});
if(picked.exitCode!==0||picked.timedOut||picked.aborted) throw Error('Cannot select remote MiKTeX repository');
const urls=(picked.stdout||'').trim().split(/\r?\n/).filter(x=>x.startsWith('https://'));
if(urls.length!==1) throw Error('Remote MiKTeX repository was not an unambiguous HTTPS URL');
const repository=new URL(urls[0]); if(repository.username||repository.password||repository.hash) throw Error('Invalid remote MiKTeX repository URL');
process.env.MIKTEX_REPOSITORY=repository.href;
const report=await preparePdfEnvironment({...config,xelatexPath:executable},{signal:AbortSignal.timeout(790000),update:true,log:line=>console.error(redactEnvironmentLog(String(line)))});
if(report.pdfReady!==true||report.state!=='ready') { console.error(report.checks.filter(x=>x.status==='failed').map(x=>`[${x.code}] ${x.message}`).join('\n')); process.exit(1); }
if(report.toolchain?.flavour!=='miktex'||report.toolchain.executable.toLowerCase()!==executable.toLowerCase()) throw Error('Candidate toolchain identity changed');
console.log(JSON.stringify({fingerprint:report.fingerprint,verifiedAt:report.verifiedAt,version:report.toolchain.version,repository:repository.href}));
'@
    $output = Invoke-TexProcess -Executable $NodeExecutable -Arguments @('--input-type=module','-e',$code,$ProjectRoot,$Executable) -WorkingDirectory $ProjectRoot -CancellationToken $CancellationToken -TimeoutMs $TimeoutMs
    return $output | ConvertFrom-Json
}

function Publish-TexSelection {
    param($ProjectRoot,$Selection)
    $path = Join-Path $ProjectRoot '.runtime\tex-selection.json'
    Assert-TexPath -ProjectRoot $ProjectRoot -Path $path
    $temporary = $path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($Selection | ConvertTo-Json -Depth 8) + "`n")
        $file = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $file.Write($bytes,0,$bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
        if (Test-Path -LiteralPath $path) { [IO.File]::Replace($temporary,$path,$null) }
        else { [IO.File]::Move($temporary,$path) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Publish-TexValidation {
    param($ProjectRoot,$NodeExecutable,$Selection,$CancellationToken,$TimeoutMs)
    Assert-TexPath -ProjectRoot $ProjectRoot -Path (Join-Path $ProjectRoot '.runtime\environment-validation.json')
    $code = @'
import {pathToFileURL} from 'node:url'; import {join} from 'node:path';
const [root,fingerprint,verifiedAt]=process.argv.slice(1);
const {saveEnvironmentRecord}=await import(pathToFileURL(join(root,'server/environment/record.mjs')));
await saveEnvironmentRecord(root,{state:'ready',pdfReady:true,fingerprint,verifiedAt});
'@
    [void](Invoke-TexProcess -Executable $NodeExecutable -Arguments @('--input-type=module','-e',$code,$ProjectRoot,$Selection.fingerprint,$Selection.verifiedAt) -WorkingDirectory $ProjectRoot -CancellationToken $CancellationToken -TimeoutMs $TimeoutMs)
}

function Invoke-TexSetup {
    param([Parameter(Mandatory=$true)][string]$ProjectRoot,[string]$NodeExecutable,[Threading.CancellationToken]$CancellationToken=[Threading.CancellationToken]::None,[int]$TimeoutMs=2000000)
    $CancellationToken.ThrowIfCancellationRequested()
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
    if (-not $NodeExecutable) { $NodeExecutable = Join-Path $ProjectRoot '.runtime\node\node.exe' }
    $discovery = Get-TexDiscovery -ProjectRoot $ProjectRoot -NodeExecutable $NodeExecutable -CancellationToken $CancellationToken -TimeoutMs 15000
    if ($discovery.executable) { Write-Host 'Reusing selected XeLaTeX; no private bootstrap download needed.'; return $discovery.executable }
    if ($discovery.explicit) { throw 'COMPILER_CONFIG_INVALID: explicitly configured XeLaTeX is invalid; it will not be replaced.' }
    if ($discovery.timedOut) { throw 'TEX_DISCOVERY_TIMEOUT: compiler discovery was incomplete; retry diagnostics.' }
    $platform = Get-TexPlatform
    if ($platform.architecture -ne 'x64' -or $platform.version -notmatch '^10\.0' -or $platform.build -lt 22000 -or -not $platform.workstation) { throw 'TEX_PLATFORM_UNSUPPORTED: automatic private MiKTeX deployment requires Windows 11 x64. Use setup.cmd --editor-only or an existing supported compiler.' }
    $manifest = Get-Content -LiteralPath (Join-Path $ProjectRoot 'scripts\tex-bootstrap.json') -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 1 -or $manifest.version -notmatch '^\d+\.\d+\.\d+\+[a-f0-9]+$' -or $manifest.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $manifest.fileName -ne ('miktexsetup-' + $manifest.version + '-x64.zip') -or $manifest.url -ne ('https://miktex.org/download/ctan/systems/win32/miktex/setup/windows-x64/' + $manifest.fileName.Replace('+','%2B')) -or $manifest.packageSet -ne 'basic' -or $manifest.executable -ne 'miktexsetup_standalone.exe') { throw 'Invalid pinned MiKTeX bootstrap manifest.' }
    $runtime = Join-Path $ProjectRoot '.runtime'; $tex = Join-Path $runtime 'tex'
    Assert-TexPath -ProjectRoot $ProjectRoot -Path $tex -Directory
    [void][IO.Directory]::CreateDirectory($tex)
    $lockPath = Join-Path $runtime 'tex-setup.lock'; Assert-TexPath -ProjectRoot $ProjectRoot -Path $lockPath
    $lock = $null; $generation = $null; $work = $null; $published = $false
    try {
        try { $lock = [IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
        catch [IO.IOException] { throw 'ENVIRONMENT_BUSY: another private TeX setup is running; retry after it finishes.' }
        # Recheck after acquiring the OS handle; another setup may have published.
        $discovery = Get-TexDiscovery -ProjectRoot $ProjectRoot -NodeExecutable $NodeExecutable -CancellationToken $CancellationToken -TimeoutMs 15000
        if ($discovery.executable) { Write-Host 'Reusing selected XeLaTeX; no download needed.'; return $discovery.executable }
        if ($discovery.explicit -or $discovery.timedOut) { throw 'Compiler selection changed or discovery was incomplete.' }
        $generation = Join-Path $tex ('g-' + [Guid]::NewGuid().ToString('N')); $work = Join-Path $tex ('work-' + [Guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($generation); [void][IO.Directory]::CreateDirectory($work)
        $archive = Join-Path $work 'bootstrap.zip'
        Write-Host 'Downloading pinned MiKTeX setup utility from miktex.org...'
        for ($attempt=0; ; $attempt++) {
            $CancellationToken.ThrowIfCancellationRequested()
            try { Download-TexArchive -Uri $manifest.url -Destination $archive -CancellationToken $CancellationToken -TimeoutMs ([Math]::Min(120000,[Math]::Max(1,$TimeoutMs-$watch.ElapsedMilliseconds))); break }
            catch { if ($attempt -ge 2 -or $CancellationToken.IsCancellationRequested -or $watch.ElapsedMilliseconds -ge $TimeoutMs) { throw }; Write-Host 'Retrying bootstrap download...' }
        }
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $manifest.sha256) { throw 'MiKTeX download SHA256 mismatch. Previous selection preserved.' }
        $extracted = Join-Path $work 'bootstrap'; Expand-TexBootstrap -Archive $archive -Destination $extracted
        $installer = Join-Path $extracted $manifest.executable; Assert-TexPath -ProjectRoot $ProjectRoot -Path $installer
        Write-Host 'Installing the basic package set into a stable private portable generation...'
        Invoke-TexInstaller -Executable $installer -Generation $generation -Repository (Join-Path $generation 'repository') -CancellationToken $CancellationToken -TimeoutMs ([Math]::Min(1200000,[Math]::Max(1,$TimeoutMs-$watch.ElapsedMilliseconds)))
        $executable = Join-Path $generation 'texmfs\install\miktex\bin\x64\xelatex.exe'
        Assert-TexPath -ProjectRoot $ProjectRoot -Path $executable
        if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Private installation did not produce the expected same-source XeLaTeX.' }
        Write-Host 'Preparing packages and verifying the actual Chinese and English templates...'
        $verified = Test-TexCandidate -ProjectRoot $ProjectRoot -NodeExecutable $NodeExecutable -Executable $executable -Generation $generation -CancellationToken $CancellationToken -TimeoutMs ([Math]::Min(800000,[Math]::Max(1,$TimeoutMs-$watch.ElapsedMilliseconds)))
        $CancellationToken.ThrowIfCancellationRequested()
        if ($watch.ElapsedMilliseconds -ge $TimeoutMs) { throw 'TEX_SETUP_TIMEOUT: private preparation exceeded its total time limit.' }
        if ($verified.fingerprint -notmatch '^[a-f0-9]{64}$' -or -not $verified.verifiedAt -or -not $verified.version) { throw 'Invalid bilingual verification result; selection preserved.' }
        $relative = '.runtime/tex/' + [IO.Path]::GetFileName($generation) + '/texmfs/install/miktex/bin/x64/xelatex.exe'
        $selection = @{ schema=1; relativeExecutable=$relative; fingerprint=$verified.fingerprint; verifiedAt=$verified.verifiedAt; version=$verified.version; bootstrap=@{version=$manifest.version;sha256=$manifest.sha256;url=$manifest.url}; repository=@{url=$verified.repository;packageSet='basic'} }
        # Never rename the installed tree: its configuration contains stable paths.
        Assert-TexPath -ProjectRoot $ProjectRoot -Path $executable
        Publish-TexSelection -ProjectRoot $ProjectRoot -Selection $selection
        $published=$true
        # Cache publication follows selection. A failed selection must preserve
        # the previous validation bytes; a cache failure keeps the verified tree.
        Publish-TexValidation -ProjectRoot $ProjectRoot -NodeExecutable $NodeExecutable -Selection $selection -CancellationToken $CancellationToken -TimeoutMs ([Math]::Min(15000,[Math]::Max(1,$TimeoutMs-$watch.ElapsedMilliseconds)))
        Write-Host 'Private MiKTeX selected after Chinese and English PDF verification.'
        return $executable
    } finally {
        try { if ($work) { Remove-TexOwnedDirectory -ProjectRoot $ProjectRoot -Path $work }; if ($generation -and -not $published) { Remove-TexOwnedDirectory -ProjectRoot $ProjectRoot -Path $generation } }
        finally { if ($lock) { $lock.Dispose() } }
    }
}
