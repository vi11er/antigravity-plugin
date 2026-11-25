param(
    [string]$VaultPath = "D:\Obsidian Job\Artchi"
)

$ErrorActionPreference = "Stop"
$SourceDir = Join-Path $PSScriptRoot ".."
$TargetDir = Join-Path $VaultPath ".obsidian\plugins\obsidian-antigravity"

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
Copy-Item -Force (Join-Path $SourceDir "manifest.json") $TargetDir
Copy-Item -Force (Join-Path $SourceDir "styles.css") $TargetDir
Copy-Item -Force (Join-Path $SourceDir "main.js") $TargetDir

$CommunityPluginsPath = Join-Path $VaultPath ".obsidian\community-plugins.json"
if (Test-Path $CommunityPluginsPath) {
    $plugins = Get-Content -Raw -Encoding UTF8 $CommunityPluginsPath | ConvertFrom-Json
    if ($plugins -notcontains "obsidian-antigravity") {
        $plugins += "obsidian-antigravity"
        $json = ConvertTo-Json $plugins
        [System.IO.File]::WriteAllText($CommunityPluginsPath, $json, (New-Object System.Text.UTF8Encoding($false)))
        Write-Output "Enabled 'obsidian-antigravity' in community-plugins.json"
    } else {
        Write-Output "'obsidian-antigravity' already enabled in community-plugins.json"
    }
}

Write-Output "Deployed plugin files to: $TargetDir"
