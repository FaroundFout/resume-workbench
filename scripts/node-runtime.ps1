# Windows PowerShell 5.1-compatible portable runtime preparation.
# A Node/CMD child of PowerShell 7 can inherit its module search path. Load the
# native utility module explicitly so Get-FileHash remains the PS5.1 function.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
function Resolve-NodeArchitecture {
    $native = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrWhiteSpace($native)) { $native = $env:PROCESSOR_ARCHITECTURE }
    switch ($native.ToUpperInvariant()) {
        'AMD64' { return 'x64' }
        'ARM64' { return 'arm64' }
        default { throw "Unsupported Windows architecture '$native'. Only x64 and ARM64 are supported." }
    }
}

function Test-NodeRuntime {
    param([string]$Executable, [string]$Version, [string]$Architecture)
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $false }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo.FileName = $Executable
    $process.StartInfo.Arguments = '-p "process.version + ''|'' + process.arch"'
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    try {
        [void]$process.Start()
        if (-not $process.WaitForExit(10000)) { $process.Kill(); $process.WaitForExit(); return $false }
        return ($process.ExitCode -eq 0 -and $process.StandardOutput.ReadToEnd().Trim() -eq "v$Version|$Architecture")
    } catch { return $false } finally { $process.Dispose() }
}

function Download-NodeArchive {
    param([string]$Uri, [string]$Destination)
    # TLS 1.2 is supported by the official host; this affects only this process.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing -TimeoutSec 120 -ErrorAction Stop
}

function Assert-RuntimeDirectory {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Runtime directory must be a regular project-local directory: $Path"
        }
    }
}

function Remove-RuntimeWorkDirectory {
    param([string]$RuntimeRoot, [string]$Path)
    $boundary = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\') + '\'
    $target = [IO.Path]::GetFullPath($Path)
    if (-not $target.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside project .runtime.' }
    Assert-RuntimeDirectory -Path $RuntimeRoot
    if (Test-Path -LiteralPath $target) {
        Assert-RuntimeDirectory -Path $target
        # Do not recursively follow junctions, including ones in extracted content.
        $links = @(Get-ChildItem -LiteralPath $target -Force -Recurse -ErrorAction Stop | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
        if ($links.Count) { throw 'Refusing runtime cleanup through a reparse point.' }
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    }
}

function Invoke-NodeSetup {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    $ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
    $architecture = Resolve-NodeArchitecture
    $manifest = Get-Content -LiteralPath (Join-Path $ProjectRoot 'scripts\node-runtime.json') -Raw -ErrorAction Stop | ConvertFrom-Json
    $version = $manifest.version
    $expectedHash = $manifest.sha256.$architecture
    if ($version -notmatch '^\d+\.\d+\.\d+$' -or $expectedHash -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid pinned Node runtime manifest.' }
    $runtime = Join-Path $ProjectRoot '.runtime'
    Assert-RuntimeDirectory -Path $runtime
    [void](New-Item -ItemType Directory -Path $runtime -Force -ErrorAction Stop)
    $nodeDirectory = Join-Path $runtime 'node'
    $node = Join-Path $nodeDirectory 'node.exe'
    $lock = $null
    $work = $null
    try {
        # An OS-owned handle survives neither process exit nor crashes; a leftover file is safe.
        $deadline = [DateTime]::UtcNow.AddSeconds(150)
        while ($null -eq $lock) {
            try { $lock = [IO.File]::Open((Join-Path $runtime 'setup.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
            catch [IO.IOException] {
                if ([DateTime]::UtcNow -ge $deadline) { throw 'Another setup is still running. Wait for it to finish, then retry setup.cmd.' }
                Start-Sleep -Milliseconds 200
            }
        }
        Assert-RuntimeDirectory -Path $nodeDirectory
        if (Test-NodeRuntime -Executable $node -Version $version -Architecture $architecture) {
            Write-Host "Reusing portable Node v$version ($architecture); no download needed."
            return $node
        }
        $work = Join-Path $runtime ('setup-' + [Guid]::NewGuid().ToString('N'))
        [void](New-Item -ItemType Directory -Path $work -ErrorAction Stop)
        $archiveName = "node-v$version-win-$architecture"
        $archive = Join-Path $work 'node.zip'
        $uri = "https://nodejs.org/dist/v$version/$archiveName.zip"
        Write-Host "Downloading pinned Node v$version ($architecture) from nodejs.org..."
        Download-NodeArchive -Uri $uri -Destination $archive
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256 -ErrorAction Stop).Hash -ne $expectedHash) {
            throw 'Node download SHA256 mismatch. Existing runtime preserved; retry setup.cmd with a working network.'
        }
        $extracted = Join-Path $work 'extracted'
        try { Expand-Archive -LiteralPath $archive -DestinationPath $extracted -ErrorAction Stop }
        catch { throw ('Node archive extraction failed. Existing runtime preserved: ' + $_.Exception.Message) }
        $candidate = Join-Path $extracted $archiveName
        if (-not (Test-NodeRuntime -Executable (Join-Path $candidate 'node.exe') -Version $version -Architecture $architecture)) {
            throw 'Downloaded Node version or architecture did not match the pin. Existing runtime preserved.'
        }
        # Only a verified staging directory can replace the current runtime. Roll back failed publication.
        $previous = Join-Path $work 'previous'
        $hadPrevious = Test-Path -LiteralPath $nodeDirectory
        if ($hadPrevious) { [IO.Directory]::Move($nodeDirectory, $previous) }
        try { [IO.Directory]::Move($candidate, $nodeDirectory) }
        catch {
            if ($hadPrevious) { [IO.Directory]::Move($previous, $nodeDirectory) }
            throw
        }
        Write-Host "Prepared portable Node v$version ($architecture) in .runtime/node."
        return $node
    } finally {
        try { if ($null -ne $work) { Remove-RuntimeWorkDirectory -RuntimeRoot $runtime -Path $work } }
        finally { if ($null -ne $lock) { $lock.Dispose() } }
    }
}
