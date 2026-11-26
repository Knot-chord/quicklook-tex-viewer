#Requires -Version 5.1
<#
.SYNOPSIS
    构建 QuickLook LaTeX 预览插件（前端单文件 + 宿主 DLL + 发布包）。

.DESCRIPTION
    流程：
      1. 定位已安装的 QuickLook（Store / 便携版），拿到 QuickLook.Common.dll 做引用
      2. 若 vendor 里没有 MathJax，就从已安装的 MarkdownViewer.dll 里提取（复用现成资源）
      3. 前端打包成单文件 tex2html.html（内联 CSS/JS），MathJax 作为独立嵌入资源
      4. dotnet 编译 net472 插件 DLL
      5. 组装 release\QuickLook.Plugin.TeXViewer\ 与 release\QuickLook.Plugin.TeXViewer.qlplugin

.PARAMETER Install
    构建后直接覆盖安装到当前用户的 QuickLook 插件目录（Store 版为
    %LOCALAPPDATA%\Packages\21090PaddyXu.QuickLook_egxr34yet59cg\LocalCache\Roaming\pooi.moe\QuickLook\QuickLook.Plugin）。

.PARAMETER WebOnly
    只构建前端（不编译 DLL），用于浏览器里调试渲染效果。

.EXAMPLE
    .\build.ps1
    .\build.ps1 -Install
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$WebOnly,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root      = Split-Path -Parent $PSScriptRoot
if (Test-Path (Join-Path $PSScriptRoot 'src')) { $Root = $PSScriptRoot }

$SrcWeb    = Join-Path $Root 'src\web'
$SrcHost   = Join-Path $Root 'src\host'
$BuildDir  = Join-Path $Root '.build'
$WebOut    = Join-Path $BuildDir 'web'
$ResOut    = Join-Path $BuildDir 'res'
$HostOut   = Join-Path $BuildDir 'host'
$Release   = Join-Path $Root 'release'
$PluginId  = 'QuickLook.Plugin.TeXViewer'
$Version   = '1.0.0'

function Write-Step($msg) { Write-Host "`n=== $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Info($msg) { Write-Host "  · $msg" -ForegroundColor Gray }
function Write-Warn($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }

if ($Clean -and (Test-Path $BuildDir)) {
    Remove-Item $BuildDir -Recurse -Force
}

# ---------------------------------------------------------------------------
# 1. 定位 QuickLook
# ---------------------------------------------------------------------------
Write-Step '定位 QuickLook 安装'

$QuickLookDir = $null
$UserPluginDir = $null

$pkg = Get-AppxPackage -Name '21090PaddyXu.QuickLook' -ErrorAction SilentlyContinue
if ($pkg -and $pkg.InstallLocation) {
    $candidate = Join-Path $pkg.InstallLocation 'Package'
    if (Test-Path (Join-Path $candidate 'QuickLook.Common.dll')) {
        $QuickLookDir = $candidate
        $UserPluginDir = Join-Path $env:LOCALAPPDATA 'Packages\21090PaddyXu.QuickLook_egxr34yet59cg\LocalCache\Roaming\pooi.moe\QuickLook\QuickLook.Plugin'
        Write-Info "Store 版：$($pkg.Version) @ $candidate"
    }
}

if (-not $QuickLookDir) {
    foreach ($p in @('C:\Program Files\QuickLook', 'C:\Program Files (x86)\QuickLook')) {
        if (Test-Path (Join-Path $p 'QuickLook.Common.dll')) { $QuickLookDir = $p; break }
    }
    if ($QuickLookDir) {
        $UserPluginDir = Join-Path $env:APPDATA 'pooi.moe\QuickLook\QuickLook.Plugin'
        Write-Info "便携版：$QuickLookDir"
    }
}

if (-not $QuickLookDir) {
    throw '找不到 QuickLook 安装（缺 QuickLook.Common.dll）。请确认已安装 QuickLook 4.x。'
}
Write-Ok "引用程序集目录：$QuickLookDir"
Write-Ok "用户插件目录：$UserPluginDir"

# ---------------------------------------------------------------------------
# 2. vendor：从 MarkdownViewer.dll 提取 MathJax（复用现成资源）
# ---------------------------------------------------------------------------
Write-Step '检查前端依赖（MathJax）'

$VendorDir  = Join-Path $SrcWeb 'vendor'
$MathJaxJs  = Join-Path $VendorDir 'tex-mml-svg.js'
New-Item -ItemType Directory -Force $VendorDir | Out-Null

if (-not (Test-Path $MathJaxJs)) {
    $mdViewer = Join-Path $QuickLookDir 'QuickLook.Plugin\QuickLook.Plugin.MarkdownViewer\QuickLook.Plugin.MarkdownViewer.dll'
    if (-not (Test-Path $mdViewer)) {
        throw "需要 MarkdownViewer.dll 提供 MathJax：$mdViewer 不存在"
    }
    New-Item -ItemType Directory -Force $BuildDir | Out-Null
    $tmp = Join-Path $BuildDir 'MarkdownViewer.dll'
    Copy-Item $mdViewer $tmp -Force
    $asm = [System.Reflection.Assembly]::Load([System.IO.File]::ReadAllBytes($tmp))
    $name = 'QuickLook.Plugin.MarkdownViewer.Resources.mathjax\tex-mml-svg.js'
    $stream = $asm.GetManifestResourceStream($name)
    if (-not $stream) { throw "MarkdownViewer.dll 里没有 $name" }
    $fs = [System.IO.File]::Create($MathJaxJs)
    try { $stream.CopyTo($fs) } finally { $fs.Dispose(); $stream.Dispose() }
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Write-Ok "已从 MarkdownViewer.dll 提取 MathJax（$([math]::Round((Get-Item $MathJaxJs).Length/1MB,2)) MB）"
} else {
    Write-Ok "复用已有 vendor\tex-mml-svg.js（$([math]::Round((Get-Item $MathJaxJs).Length/1MB,2)) MB）"
}

# ---------------------------------------------------------------------------
# 3. 前端：内联为单文件
# ---------------------------------------------------------------------------
Write-Step '打包前端'

if (Test-Path $WebOut) { Remove-Item $WebOut -Recurse -Force }
New-Item -ItemType Directory -Force $WebOut | Out-Null

$html  = Get-Content (Join-Path $SrcWeb 'plugin.html') -Raw -Encoding UTF8
$css   = Get-Content (Join-Path $SrcWeb 'style.css')    -Raw -Encoding UTF8
$vocab = Get-Content (Join-Path $SrcWeb 'tex-vocab.js')    -Raw -Encoding UTF8
$render= Get-Content (Join-Path $SrcWeb 'tex-renderer.js') -Raw -Encoding UTF8
$app   = Get-Content (Join-Path $SrcWeb 'app.js')       -Raw -Encoding UTF8

$linkTag = '<link rel="stylesheet" href="style.css" />'
if ($html -notmatch [regex]::Escape($linkTag)) { throw 'plugin.html 里找不到 style.css 引用' }
$html = $html.Replace($linkTag, "<style>`r`n$css`r`n  </style>")

$scriptTags = @(
    '<script src="tex-vocab.js"></script>',
    '<script src="tex-renderer.js"></script>',
    '<script src="app.js"></script>'
)
foreach ($t in $scriptTags) {
    if ($html -notmatch [regex]::Escape($t)) { throw "plugin.html 里找不到引用：$t" }
}
$html = $html.Replace($scriptTags[0], "<script>`r`n$vocab`r`n  </script>")
$html = $html.Replace($scriptTags[1], "<script>`r`n$render`r`n  </script>")
$html = $html.Replace($scriptTags[2], "<script>`r`n$app`r`n  </script>")

$outHtml = Join-Path $WebOut 'tex2html.html'
[System.IO.File]::WriteAllText($outHtml, $html, (New-Object System.Text.UTF8Encoding($false)))
Write-Ok "tex2html.html（$([math]::Round((Get-Item $outHtml).Length/1KB,1)) KB，样式/脚本已内联）"

New-Item -ItemType Directory -Force (Join-Path $WebOut 'mathjax') | Out-Null
Copy-Item $MathJaxJs (Join-Path $WebOut 'mathjax\tex-mml-svg.js') -Force
Write-Ok 'mathjax\tex-mml-svg.js'

# 给宿主用的资源目录（内容与 WebOut 一致）
if (Test-Path $ResOut) { Remove-Item $ResOut -Recurse -Force }
Copy-Item $WebOut $ResOut -Recurse -Force

if ($WebOnly) {
    Write-Host "`n前端构建完成：$WebOut" -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------------------
# 4. 编译宿主 DLL
# ---------------------------------------------------------------------------
Write-Step '编译宿主插件（net472）'

$dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue).Source
if (-not $dotnet) { throw '找不到 dotnet SDK（需要 .NET SDK 6+，仅用于编译）。' }

if (Test-Path $HostOut) { Remove-Item $HostOut -Recurse -Force }

& $dotnet build (Join-Path $SrcHost "$PluginId.csproj") `
    -c Release `
    -p:QuickLookDir="$QuickLookDir" `
    -p:ResourcesDir="$ResOut" `
    -o "$HostOut" `
    -v minimal --nologo

if ($LASTEXITCODE -ne 0) { throw "dotnet build 失败（退出码 $LASTEXITCODE）" }

$dll = Join-Path $HostOut "$PluginId.dll"

  # ---------------------------------------------------------------------------
  # 4b. 编译测试宿主（harness）：复用插件 DLL，含 --pdf2png（PDF 核对）
  # ---------------------------------------------------------------------------
  Write-Step '编译测试宿主（harness）'
  $harnessProj = Join-Path $root 'src\host-test\Harness.csproj'
  $harnessOut = Join-Path $root '.build\harness-installed'
  if (Test-Path $harnessOut) { Remove-Item $harnessOut -Recurse -Force }
  & $dotnet build $harnessProj -c Release -p:PluginDll="$dll" -p:QuickLookCommonDll="$(Join-Path $QuickLookDir 'QuickLook.Common.dll')" -p:HtmlViewerDll="$(Join-Path $QuickLookDir 'QuickLook.Plugin\QuickLook.Plugin.HtmlViewer\QuickLook.Plugin.HtmlViewer.dll')" -p:PluginDir="$HostOut" -o $harnessOut -v minimal --nologo
  if ($LASTEXITCODE -ne 0) { throw "harness 构建失败（退出码 $LASTEXITCODE）" }
  Get-ChildItem $HostOut -File | ForEach-Object { Copy-Item $_.FullName $harnessOut -Force }   # 运行时依赖插件 DLL 与 WebView2
# harness 直接加载插件程序集：补齐 QuickLook 宿主程序集与 WebView2 原生加载器
foreach ($d in @((Join-Path $QuickLookDir 'QuickLook.Common.dll'),
                  (Join-Path $QuickLookDir 'QuickLook.Plugin\QuickLook.Plugin.HtmlViewer\QuickLook.Plugin.HtmlViewer.dll'))) {
  if (Test-Path $d) { Copy-Item $d $harnessOut -Force }
}
if (Test-Path (Join-Path $HostOut 'runtimes')) { Copy-Item (Join-Path $HostOut 'runtimes') $harnessOut -Recurse -Force }
  Write-Ok 'TeXViewerHarness.exe'
if (-not (Test-Path $dll)) { throw "编译产物缺失：$dll" }
Write-Ok "$PluginId.dll（$([math]::Round((Get-Item $dll).Length/1KB,1)) KB）"

# ---------------------------------------------------------------------------
# 5. 组装发布目录
# ---------------------------------------------------------------------------
Write-Step '组装发布产物'

$StageDir = Join-Path $Release $PluginId
if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force }
New-Item -ItemType Directory -Force $StageDir | Out-Null

# 主 DLL
Copy-Item $dll $StageDir -Force

# 依赖：除 QuickLook.Common（宿主提供）与调试文件外的全部输出
Get-ChildItem $HostOut -Force | Where-Object {
    $_.Name -notin @('QuickLook.Common.dll', "$PluginId.pdb", "$PluginId.xml", 'QuickLook.Plugin.TeXViewer.deps.json')
} | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $StageDir $_.Name) -Recurse -Force
}

# 插件元数据（QuickLook.PluginInstaller 用它决定安装目录名）
$metadata = @"
<?xml version="1.0" encoding="utf-8"?>
<Metadata>
  <Namespace>$PluginId</Namespace>
  <Version>$Version</Version>
  <Description>LaTeX (.tex) 预览：结构还原 + MathJax 公式渲染，支持 \input 展开与相对图片。</Description>
</Metadata>
"@
[System.IO.File]::WriteAllText((Join-Path $StageDir 'QuickLook.Plugin.Metadata.config'), $metadata,
    (New-Object System.Text.UTF8Encoding($true)))

$files = Get-ChildItem $StageDir -Recurse -File
Write-Ok ("$PluginId\ ：{0} 个文件，{1} MB" -f $files.Count, [math]::Round((($files | Measure-Object Length -Sum).Sum)/1MB, 2))

# .qlplugin（zip，元数据在根，可直接拖给 QuickLook 安装）
$qlplugin = Join-Path $Release "$PluginId.qlplugin"
if (Test-Path $qlplugin) { Remove-Item $qlplugin -Force }
Compress-Archive -Path (Join-Path $StageDir '*') -DestinationPath $qlplugin -CompressionLevel Optimal
Write-Ok "$PluginId.qlplugin（$([math]::Round((Get-Item $qlplugin).Length/1MB,2)) MB）"

# 校验和
$sums = Get-ChildItem $Release -File -Recurse | Where-Object { $_.Extension -in @('.qlplugin', '.dll') } |
    ForEach-Object { '{0}  {1}' -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash, $_.Name }
[System.IO.File]::WriteAllLines((Join-Path $Release 'SHA256SUMS.txt'), $sums, (New-Object System.Text.UTF8Encoding($false)))
Write-Ok 'SHA256SUMS.txt'

# ---------------------------------------------------------------------------
# 6. 可选：安装到用户插件目录
# ---------------------------------------------------------------------------
if ($Install) {
    Write-Step '安装到 QuickLook 用户插件目录'
    $target = Join-Path $UserPluginDir $PluginId
    if (Test-Path $target) {
        # 先改名再删，避免 QuickLook 正在占用旧 DLL
        $trash = "$target.old-$(Get-Date -Format 'yyyyMMddHHmmss')"
        try { Rename-Item $target $trash -ErrorAction Stop; Remove-Item $trash -Recurse -Force -ErrorAction SilentlyContinue }
        catch { Write-Warn "旧版本暂时无法删除（QuickLook 可能正在运行）：$_" }
    }
    New-Item -ItemType Directory -Force $UserPluginDir | Out-Null
    Copy-Item $StageDir $target -Recurse -Force
    Write-Ok "已安装：$target"
    Write-Warn '需要重启 QuickLook（托盘图标 → 退出，再启动）后生效。'
}

Write-Host "`n构建完成。" -ForegroundColor Green
Write-Host "  发布目录：$Release"
Write-Host "  插件目录：$StageDir"
