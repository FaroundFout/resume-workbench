# Shared validation for evidence captured before setup, without changing PATH.
function Assert-CleanReleaseProfile {
    param([hashtable]$Profile)
    if ($Profile.build -lt 22000 -or -not $Profile.workstation -or $Profile.architecture -ne 'x64' -or $Profile.elevated -or $Profile.administratorGroupMember -or
        @($Profile.presentTools).Count -or @($Profile.cachedTex).Count -or $Profile.snapshot -notmatch '^[A-Za-z0-9_.-]{1,128}$') {
        throw 'CLEAN_ENVIRONMENT_REQUIRED: use a reset Windows 11 x64 VM snapshot, a non-elevated ordinary user, no preinstalled product/QA tools and no cached TeX.'
    }
}
