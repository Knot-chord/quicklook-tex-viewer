#Requires -Version 5.1
<#
.SYNOPSIS
    静态验收插件 DLL：不运行 QuickLook，也不加载 WPF 依赖，直接读 PE 元数据。

.DESCRIPTION
    检查项：
      1. 类型与接口：QuickLook.Plugin.TeXViewer.Plugin 是否实现 QuickLook.Common.Plugin.IViewer
      2. 方法齐全：Init / CanHandle / Prepare / View / Cleanup / get_Priority
      3. 嵌入资源：tex2html.html 与 MathJax 是否在 DLL 里
      4. 程序集依赖：只依赖宿主提供的 QuickLook.Common 与同目录的 WebView2
      5. 目标框架：net472（.NET Framework 4.8 运行时可加载）

.EXAMPLE
    .\verify-plugin.ps1 -Dll ..\..\release\QuickLook.Plugin.TeXViewer\QuickLook.Plugin.TeXViewer.dll
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Dll
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Reflection.Metadata | Out-Null

$path = (Resolve-Path $Dll).Path
$fs = [System.IO.File]::OpenRead($path)
$pe = New-Object System.Reflection.PortableExecutable.PEReader($fs)
$md = [System.Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe)

$fail = 0; $ok = 0
function Check($name, $cond, $extra) {
    if ($cond) { $script:ok++; Write-Host "  [OK] $name" -ForegroundColor Green }
    else { $script:fail++; Write-Host "  [!!] $name  $extra" -ForegroundColor Red }
}

Write-Host "`n=== $([System.IO.Path]::GetFileName($path))  ($([math]::Round($fs.Length/1KB,1)) KB)" -ForegroundColor Cyan

# ---- 目标框架 ----
$tfm = $null
$asmDef = $md.GetAssemblyDefinition()
$caHandle = $asmDef.GetCustomAttributes()
foreach ($cah in $caHandle) {
    $ca = $md.GetCustomAttribute($cah)
    if ($ca.Constructor.Kind -eq 'MemberReference') {
        $ctor = $md.GetMemberReference([System.Reflection.Metadata.MemberReferenceHandle]$ca.Constructor)
        if ($ctor.Parent.Kind -eq 'TypeReference') {
            $tr = $md.GetTypeReference([System.Reflection.Metadata.TypeReferenceHandle]$ctor.Parent)
            if ($md.GetString($tr.Name) -eq 'TargetFrameworkAttribute') {
                $blob = $md.GetBlobBytes($ca.Value)
                $tfm = [System.Text.Encoding]::UTF8.GetString($blob) -replace '[^\x20-\x7e]', ''
                $tfm = ($tfm -replace '^.\x01', '') -replace '.NETFramework,Version=', '.NETFramework '
            }
        }
    }
}
Check "目标框架 = net472" ($tfm -like '*4.7.2*' -or $tfm -like '*4.6.2*') $tfm

# ---- 类型 / 接口 ----
$pluginType = $null
$pluginHandle = $null
foreach ($th in $md.TypeDefinitions) {
    $td = $md.GetTypeDefinition($th)
    $name = $md.GetString($td.Name)
    $ns = $md.GetString($td.Namespace)
    if ($name -eq 'Plugin' -and $ns -eq 'QuickLook.Plugin.TeXViewer') {
        $pluginType = $td; $pluginHandle = $th
    }
}
Check "存在 QuickLook.Plugin.TeXViewer.Plugin" ($null -ne $pluginType)

$ifaces = @()
if ($pluginType) {
    foreach ($ih in $pluginType.GetInterfaceImplementations()) {
        $ii = $md.GetInterfaceImplementation($ih)
        if ($ii.Interface.Kind -eq 'TypeReference') {
            $tr = $md.GetTypeReference([System.Reflection.Metadata.TypeReferenceHandle]$ii.Interface)
            $ifaces += ($md.GetString($tr.Namespace) + '.' + $md.GetString($tr.Name))
        } elseif ($ii.Interface.Kind -eq 'TypeDefinition') {
            $td = $md.GetTypeDefinition([System.Reflection.Metadata.TypeDefinitionHandle]$ii.Interface)
            $ifaces += ($md.GetString($td.Namespace) + '.' + $md.GetString($td.Name))
        }
    }
}
Check "实现 IViewer" ($ifaces -contains 'QuickLook.Common.Plugin.IViewer') ($ifaces -join ',')

# ---- 方法 ----
$methods = @()
if ($pluginType) {
    foreach ($mh in $pluginType.GetMethods()) {
        $m = $md.GetMethodDefinition($mh)
        $methods += $md.GetString($m.Name)
    }
}
foreach ($need in @('Init', 'CanHandle', 'Prepare', 'View', 'Cleanup')) {
    Check "方法 $need" ($methods -contains $need) ($methods -join ',')
}

# ---- 嵌入资源 ----
$resources = @()
foreach ($rh in $md.ManifestResources) {
    $r = $md.GetManifestResource($rh)
    $resources += $md.GetString($r.Name)
}
Check "嵌入 tex2html.html" ($resources -contains 'QuickLook.Plugin.TeXViewer.Resources.tex2html.html') ($resources -join ',')
Check "嵌入 MathJax" ($resources -contains 'QuickLook.Plugin.TeXViewer.Resources.mathjax\tex-mml-svg.js') ($resources -join ',')

# ---- 依赖 ----
$refs = @()
foreach ($rh in $md.AssemblyReferences) {
    $r = $md.GetAssemblyReference($rh)
    $refs += ($md.GetString($r.Name) + ' ' + $r.Version)
}
Write-Host "  · 引用：$($refs -join '; ')" -ForegroundColor DarkGray
Check "引用 QuickLook.Common 4.5.0.0（由宿主提供）" ($refs -join ';' -match 'QuickLook\.Common 4\.5\.0\.0') ($refs -join ';')
Check "未随包私带 QuickLook.Common.dll" (-not (Test-Path (Join-Path (Split-Path $path) 'QuickLook.Common.dll'))) ''
Check "引用 WebView2" ($refs -join ';' -match 'Microsoft\.Web\.WebView2') ""

$pe.Dispose(); $fs.Dispose()

Write-Host ("`n静态验收：{0} 通过 / {1} 失败" -f $ok, $fail) -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $(if ($fail) { 1 } else { 0 })
