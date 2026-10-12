param([Parameter(Mandatory=$true)][string]$EvidenceDirectory, [Parameter(Mandatory=$true)][string]$Snapshot)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-clean-profile.ps1')
$os = Get-CimInstance Win32_OperatingSystem
$native = $env:PROCESSOR_ARCHITEW6432
if (-not $native) { $native = $env:PROCESSOR_ARCHITECTURE }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$tools = @('node','xelatex','miktex','miktexsetup','kpsewhich','findtexmf','tlmgr','python','python3','pdftoppm','make')
$present = @()
foreach ($tool in $tools) {
    $previousPreference = $ErrorActionPreference
    try {
        # where.exe's absent-command stderr is an expected negative probe in
        # Windows PowerShell 5.1, not an installation failure.
        $ErrorActionPreference = 'Continue'
        $found = & (Join-Path $env:SystemRoot 'System32\where.exe') $tool 2>$null
        $whereExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($whereExit -eq 0 -and $found) { $present += $tool }
}
$candidateCaches = @(
    (Join-Path $env:APPDATA 'MiKTeX'), (Join-Path $env:LOCALAPPDATA 'MiKTeX'),
    (Join-Path $env:LOCALAPPDATA 'Programs\MiKTeX'),
    (Join-Path $env:ProgramData 'MiKTeX'), (Join-Path $env:ProgramFiles 'MiKTeX'),
    (Join-Path $env:ProgramFiles 'MiKTeX 2.9'), (Join-Path $env:ProgramFiles 'TeX Live'),
    (Join-Path $env:SystemDrive 'texlive')
)
$cached = @($candidateCaches | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { Split-Path $_ -Leaf })
$registryRoots = @('HKCU:\Software\MiKTeX.org', 'HKLM:\Software\MiKTeX.org', 'HKLM:\Software\WOW6432Node\MiKTeX.org')
foreach ($path in $registryRoots) { if (Test-Path -LiteralPath $path) { $cached += 'MiKTeX registry' } }
$profile = @{
    build=[int]$os.BuildNumber; version=$os.Version; workstation=($os.ProductType -eq 1)
    architecture=$native.ToUpperInvariant().Replace('AMD64','x64').Replace('ARM64','arm64')
    elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    administratorGroupMember=(@($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' }).Count -gt 0)
    presentTools=$present; cachedTex=$cached; snapshot=$Snapshot; checkedAt=[DateTime]::UtcNow.ToString('o')
}
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$path = Join-Path $EvidenceDirectory 'clean-preflight.json'
try {
    Assert-CleanReleaseProfile -Profile $profile
    $profile.status = 'passed'
} catch {
    $profile.status = 'failed'
    [IO.File]::WriteAllText($path, ($profile | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
    throw
}
[IO.File]::WriteAllText($path, ($profile | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
Write-Host 'Clean Windows 11 x64 ordinary-user preflight passed. PATH was inspected without filtering.'
