# Downloads the wiretrick-helper binary from GitHub releases, verifies its
# SHA-256, and runs `wiretrick-helper install` (which copies itself to
# %APPDATA%\wiretrick-helper and registers the native host).
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/nimatrueway/wiretrick/master/helper/install.ps1))) -ExtensionId <id> -TrustCa
#
# $env:WIRETRICK_HELPER_VERSION = "v1.2.3" pins a release (default: latest).
param(
    [string[]]$ExtensionId,
    [switch]$TrustCa,
    [string[]]$Browser
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repo = "nimatrueway/wiretrick"
$version = if ($env:WIRETRICK_HELPER_VERSION) { $env:WIRETRICK_HELPER_VERSION } else { "latest" }
$base = if ($env:WIRETRICK_HELPER_BASE_URL) { $env:WIRETRICK_HELPER_BASE_URL } elseif ($version -eq "latest") { "https://github.com/$repo/releases/latest/download" } else { "https://github.com/$repo/releases/download/$version" }
# x64 build; Windows on Arm runs it under emulation
$asset = "wiretrick-helper-x86_64-pc-windows-msvc.exe"

if (-not $ExtensionId) {
    throw "pass -ExtensionId <id> (shown in the extension's Settings > Local helper)"
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("wiretrick-helper-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $exe = Join-Path $tmp "wiretrick-helper.exe"
    Write-Host "downloading $asset ($version)..." -ForegroundColor DarkGray
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $exe

    $sums = Join-Path $tmp "SHA256SUMS"
    $haveSums = $true
    try { Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums } catch { $haveSums = $false }
    if ($haveSums) {
        $line = Get-Content $sums | Where-Object { ($_ -split '\s+')[1] -in @($asset, "*$asset") } | Select-Object -First 1
        if (-not $line) { throw "$asset is missing from SHA256SUMS" }
        $want = ($line -split '\s+')[0].ToLower()
        $got = (Get-FileHash -Algorithm SHA256 $exe).Hash.ToLower()
        if ($want -ne $got) { throw "checksum mismatch for $asset (expected $want, got $got)" }
        Write-Host "checksum ok" -ForegroundColor DarkGray
    } else {
        Write-Host "no SHA256SUMS in this release - skipping checksum" -ForegroundColor DarkGray
    }

    $helperArgs = @("install")
    foreach ($id in $ExtensionId) { $helperArgs += @("--extension-id", $id) }
    foreach ($b in $Browser) { $helperArgs += @("--browser", $b) }
    if ($TrustCa) { $helperArgs += "--trust-ca" }
    & $exe @helperArgs
    if ($LASTEXITCODE -ne 0) { throw "wiretrick-helper install failed (exit $LASTEXITCODE)" }
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
