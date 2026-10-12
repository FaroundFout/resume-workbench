param([switch]$EditorOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
try {
    $setupClock = [Diagnostics.Stopwatch]::StartNew()
    $cancel = New-Object Threading.CancellationTokenSource
    $cancel.CancelAfter(2400000)
    . (Join-Path $PSScriptRoot 'node-runtime.ps1')
    . (Join-Path $PSScriptRoot 'tex-runtime.ps1')
    $project = Split-Path -Parent $PSScriptRoot
    $node = Invoke-NodeSetup -ProjectRoot $project
    $env:PATH = (Split-Path -Parent $node) + ';' + $env:PATH
    $mode = '--prepare'
    if ($EditorOnly) { $mode = '--editor-only' }
    $result = Invoke-TexProcess -Executable $node -Arguments @((Join-Path $PSScriptRoot 'doctor.mjs'),$mode) -WorkingDirectory $project -CancellationToken $cancel.Token -TimeoutMs ([Math]::Max(1,2400000-$setupClock.ElapsedMilliseconds)) -PassResult
    if ($result.stdout) { Write-Host $result.stdout.TrimEnd() }; if ($result.stderr) { Write-Host $result.stderr.TrimEnd() }
    if ($result.exitCode -eq 1 -and -not $EditorOnly) {
        $discovery = Get-TexDiscovery -ProjectRoot $project -NodeExecutable $node -CancellationToken $cancel.Token -TimeoutMs 15000
        if (-not $discovery.executable -and -not $discovery.explicit -and -not $discovery.timedOut) {
            [void](Invoke-TexSetup -ProjectRoot $project -NodeExecutable $node -CancellationToken $cancel.Token -TimeoutMs ([Math]::Min(2000000,[Math]::Max(1,2400000-$setupClock.ElapsedMilliseconds))))
            $result = Invoke-TexProcess -Executable $node -Arguments @((Join-Path $PSScriptRoot 'doctor.mjs'),'--check') -WorkingDirectory $project -CancellationToken $cancel.Token -TimeoutMs ([Math]::Max(1,2400000-$setupClock.ElapsedMilliseconds)) -PassResult
            if ($result.stdout) { Write-Host $result.stdout.TrimEnd() }; if ($result.stderr) { Write-Host $result.stderr.TrimEnd() }
        }
    }
    exit $result.exitCode
} catch {
    Write-Host ('Setup failed: ' + $_.Exception.Message)
    Write-Host 'Check network access and local permissions, then retry setup.cmd. See docs/local-editor.md.'
    exit 1
} finally { if ($cancel) { $cancel.Dispose() } }
