param([switch]$EditorOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
try {
    . (Join-Path $PSScriptRoot 'node-runtime.ps1')
    $project = Split-Path -Parent $PSScriptRoot
    $node = Invoke-NodeSetup -ProjectRoot $project
    $env:PATH = (Split-Path -Parent $node) + ';' + $env:PATH
    $mode = '--prepare'
    if ($EditorOnly) { $mode = '--editor-only' }
    & $node (Join-Path $PSScriptRoot 'doctor.mjs') $mode
    exit $LASTEXITCODE
} catch {
    Write-Host ('Setup failed: ' + $_.Exception.Message)
    Write-Host 'Check network access and local permissions, then retry setup.cmd. See docs/local-editor.md.'
    exit 1
}
