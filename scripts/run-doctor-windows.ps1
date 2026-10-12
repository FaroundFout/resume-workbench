param([Parameter(Mandatory = $true)][ValidateSet('verify', 'prepare')][string]$Mode, [switch]$Update)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
try {
    $project = Split-Path -Parent $PSScriptRoot
    $node = Join-Path $project '.runtime\node\node.exe'
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
        $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $command) { throw 'Node.js 22 or newer is required. Run setup.cmd to prepare the project-local Node runtime.' }
        $node = $command.Source
    }
    & $node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
    if ($LASTEXITCODE -ne 0) { throw 'Node.js 22 or newer is required. Run setup.cmd to prepare or repair the project-local Node runtime.' }
    $env:PATH = (Split-Path -Parent $node) + ';' + $env:PATH
    $doctorArgs = @(('--' + $Mode))
    if ($Update) { $doctorArgs += '--update' }
    & $node (Join-Path $PSScriptRoot 'doctor.mjs') @doctorArgs
    exit $LASTEXITCODE
} catch {
    Write-Host ('Environment entry failed: ' + $_.Exception.Message)
    Write-Host 'Run setup.cmd to prepare or repair Node, then retry this command. See docs/local-editor.md.'
    exit 1
}
