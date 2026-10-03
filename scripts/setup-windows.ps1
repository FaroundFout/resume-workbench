$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
try {
    . (Join-Path $PSScriptRoot 'node-runtime.ps1')
    $project = Split-Path -Parent $PSScriptRoot
    $node = Invoke-NodeSetup -ProjectRoot $project
    & $node (Join-Path $PSScriptRoot 'check-environment.mjs')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host 'Setup complete. Run start.cmd to open the editor.'
    exit 0
} catch {
    Write-Host ('Setup failed: ' + $_.Exception.Message)
    Write-Host 'Check network access and local permissions, then retry setup.cmd. See docs/local-editor.md.'
    exit 1
}
