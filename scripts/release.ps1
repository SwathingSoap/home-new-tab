# Releases a new version: bumps the patch version, signs on AMO (unlisted), publishes the .xpi as a
# GitHub release and lists it in updates.json, which Firefox polls (manifest update_url) to update itself.
#
# AMO keys come from the user environment variables WEB_EXT_API_KEY / WEB_EXT_API_SECRET
# (https://addons.mozilla.org/developers/addon/api/key/), set once with:
#   [Environment]::SetEnvironmentVariable('WEB_EXT_API_KEY', 'user:...', 'User')
#   [Environment]::SetEnvironmentVariable('WEB_EXT_API_SECRET', '...', 'User')
# GitHub: gh CLI logged in (gh auth login).

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$repo = 'SwathingSoap/home-new-tab'
$addonId = 'home-new-tab@swathingsoap'
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) { $gh = 'C:\Program Files\GitHub CLI\gh.exe' }

foreach ($name in 'WEB_EXT_API_KEY', 'WEB_EXT_API_SECRET') {
    $value = [Environment]::GetEnvironmentVariable($name, 'User')
    if (-not $value) { throw "$name is not set, see the top of scripts/release.ps1" }
    Set-Item "env:$name" $value
}

function Write-Utf8($path, $text) {
    [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false))
}

# 0.3.1 -> 0.3.2 (text replace keeps the manifest formatting).
$manifestPath = Join-Path $root 'manifest.json'
$manifest = [IO.File]::ReadAllText($manifestPath)
$old = ([regex]::Match($manifest, '"version":\s*"([\d.]+)"')).Groups[1].Value
$parts = $old.Split('.')
$parts[-1] = [string]([int]$parts[-1] + 1)
$new = $parts -join '.'
Write-Utf8 $manifestPath ($manifest -replace ('"version":\s*"' + [regex]::Escape($old) + '"'), ('"version": "' + $new + '"'))
Write-Host "version $old -> $new"

Remove-Item (Join-Path $root '.amo-upload-uuid') -ErrorAction SilentlyContinue
npx web-ext sign --source-dir . --channel unlisted --approval-timeout 1800000 `
    --ignore-files package.json package-lock.json README.md scripts updates.json
if ($LASTEXITCODE -ne 0) { throw "web-ext sign failed ($LASTEXITCODE)" }

$signed = Get-ChildItem (Join-Path $root 'web-ext-artifacts') -Filter "*-$new.xpi" | Select-Object -First 1
if (-not $signed) { throw "Signed .xpi for $new not found in web-ext-artifacts" }
$xpi = Join-Path $signed.DirectoryName "home-new-tab-$new.xpi"
Copy-Item $signed.FullName $xpi -Force
Write-Host "signed: $xpi"

# updates.json: newest first, the last few versions kept.
$link = "https://github.com/$repo/releases/download/v$new/home-new-tab-$new.xpi"
$hash = 'sha256:' + (Get-FileHash $xpi -Algorithm SHA256).Hash.ToLower()
$updatesPath = Join-Path $root 'updates.json'
$updates = Get-Content $updatesPath -Raw | ConvertFrom-Json
$list = @([pscustomobject]@{ version = $new; update_link = $link; update_hash = $hash }) +
    @($updates.addons.$addonId.updates | Where-Object { $_ -and $_.version -ne $new } | Select-Object -First 4)
$updates.addons.$addonId.updates = $list
Write-Utf8 $updatesPath (($updates | ConvertTo-Json -Depth 6) + "`n")

git add -A
git commit -m "Release $new"
if ($LASTEXITCODE -ne 0) { throw "git commit failed" }
git tag "v$new"
git push origin main --tags
if ($LASTEXITCODE -ne 0) { throw "git push failed" }
# updates.json is live from the push; Firefox finds the asset a few seconds later at worst.
& $gh release create "v$new" $xpi --repo $repo --title $new --notes "Signed build $new" --verify-tag
if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }

Write-Host "released $new; Firefox picks it up on its next update check"
$firefox = 'C:\Program Files\Mozilla Firefox\firefox.exe'
if ($env:RELEASE_OPEN_XPI -and (Test-Path $firefox)) { Start-Process $firefox $xpi }
