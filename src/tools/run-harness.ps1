#Requires -Version 5.1
<#
.SYNOPSIS
    构建并启动“本地宿主测试程序”，在 QuickLook 之外用真实 WebView2 复现插件渲染。

.DESCRIPTION
    为什么需要它：QuickLook 的安装目录在 WindowsApps（ACL 拒绝直接启动），
    而黑屏一类的问题又必须用真实 WebView2 才能定位。这个 harness 用与
    QuickLook 完全相同的调用顺序（Preview → 交给窗口显示）驱动 TeXPanel。

    产出：
      .build\harness\TeXViewerHarness.exe   宿主程序
      %TEMP%\QuickLook.TeXViewer.log        插件诊断日志

.EXAMPLE
    .\run-harness.ps1 -Tex .\samples\article-math.tex
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Tex,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

$texPath = (Resolve-Path $Tex).Path

Write-Host "== 1/4 构建插件" -ForegroundColor Cyan
& pwsh -NoProfile -File (Join-Path $Root 'build.ps1') | Out-Null
$hostOut = Join-Path $Root '.build\host'
$pluginDll = Join-Path $hostOut 'QuickLook.Plugin.TeXViewer.dll'
if (-not (Test-Path $pluginDll)) { throw "插件 DLL 不存在：$pluginDll" }

Write-Host "== 2/4 编译 harness" -ForegroundColor Cyan
$harnessOut = Join-Path $Root '.build\harness'
& dotnet build (Join-Path $Root 'src\host-test\Harness.csproj') `
    -c Release -p:PluginDll="$pluginDll" -o "$harnessOut" -v minimal --nologo
if ($LASTEXITCODE -ne 0) { throw "harness 编译失败" }

Write-Host "== 3/4 准备运行期依赖" -ForegroundColor Cyan
# 插件本体 + WebView2 托管/原生依赖
Get-ChildItem $hostOut -Filter '*.dll' -File | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $harnessOut $_.Name) -Force
}
$wvRuntimes = Join-Path $hostOut 'runtimes'
if (Test-Path $wvRuntimes) {
    Copy-Item $wvRuntimes (Join-Path $harnessOut 'runtimes') -Recurse -Force
}
# 宿主提供的 QuickLook.Common（SettingHelper / OSThemeHelper 需要）
$pkg = Get-AppxPackage -Name '21090PaddyXu.QuickLook' -ErrorAction SilentlyContinue
$qlCommon = if ($pkg) { Join-Path $pkg.InstallLocation 'Package\QuickLook.Common.dll' } else { $null }
if ($qlCommon -and (Test-Path $qlCommon)) {
    Copy-Item $qlCommon (Join-Path $harnessOut 'QuickLook.Common.dll') -Force
} else {
    throw '找不到 QuickLook.Common.dll'
}

Write-Host "== 4/4 启动" -ForegroundColor Cyan
$trace = Join-Path $env:TEMP 'QuickLook.TeXViewer.log'
if (Test-Path $trace) { Remove-Item $trace -Force }
Write-Host "  样本：$texPath"
Write-Host "  日志：$trace"
Write-Host "  程序：$harnessOut\TeXViewerHarness.exe"

if ($NoLaunch) { return }

$p = Start-Process -FilePath (Join-Path $harnessOut 'TeXViewerHarness.exe') `
    -ArgumentList "`"$texPath`"" -PassThru
Write-Host "  已启动 PID=$($p.Id)" -ForegroundColor Green
Start-Sleep -Seconds 6

Write-Host "`n== 日志内容" -ForegroundColor Cyan
if (Test-Path $trace) { Get-Content $trace } else { Write-Host '  （日志还没生成，可能程序未起来）' -ForegroundColor Yellow }
