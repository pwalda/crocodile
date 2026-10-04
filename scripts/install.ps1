# Crocodile installer for Windows.
#
#   irm https://raw.githubusercontent.com/pwalda/crocodile/main/scripts/install.ps1 | iex
#
# Downloads the latest installer from GitHub and runs it silently (per-user,
# no administrator rights). Files downloaded by PowerShell are not marked as
# coming from the internet, so SmartScreen does not block builds that are not
# code-signed yet.
$ErrorActionPreference = 'Stop'
$repo = if ($env:CROC_REPO) { $env:CROC_REPO } else { 'pwalda/crocodile' }

Write-Host '==> Looking up the latest Crocodile release' -ForegroundColor Green
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
# There is an installer per architecture, and a bigger one with both. 32-bit
# PowerShell on 64-bit Windows reports the real architecture in ARCHITEW6432.
$arch = if (@($env:PROCESSOR_ARCHITEW6432, $env:PROCESSOR_ARCHITECTURE) -contains 'ARM64') { 'arm64' } else { 'x64' }
$installers = @($release.assets | Where-Object { $_.name -match '\.exe$' })
$asset = $installers | Where-Object { $_.name -match "-win-$arch\.exe$" } | Select-Object -First 1
if (-not $asset) {
  $asset = $installers | Where-Object { $_.name -match '-win\.exe$' } | Select-Object -First 1
}
if (-not $asset) { throw 'No Windows installer found in the latest release.' }

$file = Join-Path $env:TEMP $asset.name
Write-Host "==> Downloading $($asset.name)" -ForegroundColor Green
Invoke-WebRequest $asset.browser_download_url -OutFile $file -UseBasicParsing

Write-Host '==> Installing' -ForegroundColor Green
# --force-run starts Crocodile when the silent install finishes.
Start-Process -FilePath $file -ArgumentList '/S', '--force-run' -Wait
Remove-Item $file -ErrorAction SilentlyContinue
Write-Host '==> Done. Crocodile is in your Start menu.' -ForegroundColor Green
