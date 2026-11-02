# Builds a PRODUCTION package: test controls are switched off.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (Test-Path dist) { Remove-Item dist -Recurse -Force }
New-Item dist -ItemType Directory | Out-Null
Copy-Item manifest.json, config.js, core.js, background.js, content.js, pip-guard.js, popup.html, popup.css, popup.js -Destination dist
Copy-Item icons -Destination dist -Recurse

$cfg = Get-Content dist\config.js | ForEach-Object {
  if ($_ -match '@DEBUG_FLAG') { $_ -replace 'enabled:\s*true', 'enabled: false' } else { $_ }
}
Set-Content dist\config.js $cfg -Encoding UTF8
if (-not (Select-String -Path dist\config.js -Pattern '@DEBUG_FLAG' | Where-Object { $_.Line -match 'enabled: false' })) {
  throw 'Debug flag is still on'
}
$version = (Get-Content manifest.json -Raw | ConvertFrom-Json).version
$zip = "spotify-limiter-$version.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path dist\* -DestinationPath $zip
Write-Host "Built dist\ and $zip (debug OFF)"
