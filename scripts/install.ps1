# Crocodile installer for Windows.
#
#   irm https://raw.githubusercontent.com/pwalda/crocodile/main/scripts/install.ps1 | iex
#
# Downloads the latest installer from GitHub and runs it silently (per-user,
# no administrator rights). Files downloaded by PowerShell are not marked as
# coming from the internet, so SmartScreen does not block builds that are not
# code-signed yet.
#
# The command line tool instead (to %LOCALAPPDATA%\Programs\crocodile-cli,
# added to your PATH):
#
#   $env:CROC_INSTALL='cli'; irm https://raw.githubusercontent.com/pwalda/crocodile/main/scripts/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$repo = if ($env:CROC_REPO) { $env:CROC_REPO } else { 'pwalda/crocodile' }

# Everything is downloaded over https: an address that is not, or a download that a
# redirect took to one, is refused (and the file is not kept).
function Save-Https($url, $path) {
  $uri = $url -as [uri]
  if (-not $uri -or -not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'https') {
    throw "Refusing to download from an address that is not https: $url"
  }
  $response = Invoke-WebRequest $url -OutFile $path -UseBasicParsing -PassThru
  # Windows PowerShell gives the address it ended at as ResponseUri, PowerShell 7 in the request.
  $final = $response.BaseResponse.ResponseUri
  if (-not $final) { $final = $response.BaseResponse.RequestMessage.RequestUri }
  if ($final -and $final.Scheme -ne 'https') {
    Remove-Item $path -ErrorAction SilentlyContinue
    throw "Refusing a download that ended at an address that is not https: $final"
  }
}

Write-Host '==> Looking up the latest Crocodile release' -ForegroundColor Green
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
# There is an installer per architecture, and a bigger one with both. 32-bit
# PowerShell on 64-bit Windows reports the real architecture in ARCHITEW6432.
$arch = if (@($env:PROCESSOR_ARCHITEW6432, $env:PROCESSOR_ARCHITECTURE) -contains 'ARM64') { 'arm64' } else { 'x64' }

if ($env:CROC_INSTALL -eq 'cli') {
  $cli = $release.assets | Where-Object { $_.name -eq "crocodile-cli-windows-$arch.zip" } | Select-Object -First 1
  if (-not $cli) {
    $cli = $release.assets | Where-Object { $_.name -eq 'crocodile-cli-windows-x64.zip' } | Select-Object -First 1
  }
  if (-not $cli) { throw 'No command line build found; with Node.js 22 or newer: npm install -g crocodile-cli' }
  $zip = Join-Path $env:TEMP $cli.name
  Write-Host "==> Downloading $($cli.name)" -ForegroundColor Green
  Save-Https $cli.browser_download_url $zip
  $dir = Join-Path $env:LOCALAPPDATA 'Programs\crocodile-cli'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Expand-Archive -Path $zip -DestinationPath $dir -Force
  Move-Item -Force (Join-Path $dir "$([IO.Path]::GetFileNameWithoutExtension($cli.name)).exe") (Join-Path $dir 'crocodile.exe')
  Remove-Item $zip -ErrorAction SilentlyContinue
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($userPath -split ';') -contains $dir)) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$dir", 'User')
    Write-Host '==> Added it to your PATH (open a new terminal to use it)' -ForegroundColor Green
  }
  Write-Host "==> Done. Start with: crocodile help" -ForegroundColor Green
  return
}
$installers = @($release.assets | Where-Object { $_.name -match '\.exe$' })
$asset = $installers | Where-Object { $_.name -match "-win-$arch\.exe$" } | Select-Object -First 1
if (-not $asset) {
  $asset = $installers | Where-Object { $_.name -match '-win\.exe$' } | Select-Object -First 1
}
if (-not $asset) { throw 'No Windows installer found in the latest release.' }

$file = Join-Path $env:TEMP $asset.name
Write-Host "==> Downloading $($asset.name)" -ForegroundColor Green
Save-Https $asset.browser_download_url $file

Write-Host '==> Installing' -ForegroundColor Green
# --force-run starts Crocodile when the silent install finishes.
Start-Process -FilePath $file -ArgumentList '/S', '--force-run' -Wait
Remove-Item $file -ErrorAction SilentlyContinue
Write-Host '==> Done. Crocodile is in your Start menu.' -ForegroundColor Green
