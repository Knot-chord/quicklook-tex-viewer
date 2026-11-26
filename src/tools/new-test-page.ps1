#Requires -Version 5.1
<#
.SYNOPSIS
    为某个 .tex 样例生成“测试引导页”，在浏览器里验证前端渲染。

.DESCRIPTION
    引导页只做一件事：把自己重定向到
        .build/web/tex2html.html?texBase64=<文件内容>&name=<文件名>
    这样既不需要本地 HTTP 服务器，也不会触发 file:// 的跨文件读取限制。

.EXAMPLE
    .\new-test-page.ps1 -Tex ..\..\samples\article-math.tex
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Tex,
    [string]$Out
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$WebDir = Join-Path $Root '.build\web'
$AppHtml = Join-Path $WebDir 'tex2html.html'

if (-not (Test-Path $AppHtml)) {
    throw "找不到 $AppHtml，先运行 build.ps1 -WebOnly"
}

$texPath = (Resolve-Path $Tex).Path
$bytes = [System.IO.File]::ReadAllBytes($texPath)
$b64 = [Convert]::ToBase64String($bytes)
$name = [System.IO.Path]::GetFileName($texPath)

$testDir = Join-Path $Root '.build\test'
New-Item -ItemType Directory -Force $testDir | Out-Null

if (-not $Out) {
    $Out = Join-Path $testDir ([System.IO.Path]::GetFileNameWithoutExtension($texPath) + '.html')
}

# 引导页与 tex2html.html 同目录，用相对路径重定向
$rel = [System.IO.Path]::GetRelativePath((Split-Path -Parent $Out), $AppHtml).Replace('\', '/')
$url = "$rel" + '?texBase64=' + [uri]::EscapeDataString($b64) + '&name=' + [uri]::EscapeDataString($name) + '&theme=light'

$html = @"
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>$name</title></head>
<body style="font:13px sans-serif;padding:24px;color:#555">
正在载入 $name …
<script>location.replace("$url");</script>
</body></html>
"@

[System.IO.File]::WriteAllText($Out, $html, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "测试页：$Out"
Write-Host "目标：$AppHtml"
