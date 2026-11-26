# 真实 QuickLook 空格自动化（可无人值守）：
#   选中文件 → 资源管理器前台 → 空格 → 等待预览窗口 → UIA 读全文/统计 → 关闭
# 判定：窗口打开、标题匹配、能读到正文、无错误提示、渲染耗时
param(
    [string[]]$Files,
    [string]$Dir,
    [string]$ListFile,
    [int]$WaitSeconds = 8,
    [string]$OutCsv
)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class QlWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public const uint WM_CLOSE = 0x0010;
}
"@
$UIA=[System.Windows.Automation.AutomationElement]
$TP=[System.Windows.Automation.TextPattern]
$sh=New-Object -ComObject WScript.Shell
$SW=[System.Windows.Forms.SendKeys]

function Get-WindowsByPid([int]$targetPid) {
    $script:winList = New-Object System.Collections.ArrayList
    $cb=[QlWin+EnumProc]{ param($h,$l)
        $p=0; [void][QlWin]::GetWindowThreadProcessId($h,[ref]$p)
        if ($p -eq $targetPid -and [QlWin]::IsWindowVisible($h)) {
            $sb=New-Object Text.StringBuilder 512; [void][QlWin]::GetWindowText($h,$sb,512)
            [void]$script:winList.Add([pscustomobject]@{Hwnd=$h; Title=$sb.ToString()})
        }
        return $true
    }
    [void][QlWin]::EnumWindows($cb,[IntPtr]::Zero)
    return @($script:winList)
}
function Get-ExplorerWindows {
    # explorer.exe 可能被多次启动成多个进程：逐个收集，避免只看到其中一个
    $all = @()
    foreach ($p in (Get-Process -Name explorer -ErrorAction SilentlyContinue)) {
        $all += Get-WindowsByPid $p.Id
    }
    return @($all)
}
function Get-QuickLookWindows {
    $p=Get-Process -Name QuickLook -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $p) { return @() }
    return (Get-WindowsByPid $p.Id | Where-Object { $_.Title -like 'QuickLook*' })
}
function Close-Window($hwnd) { [void][QlWin]::PostMessage($hwnd, [QlWin]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) }

function Read-PreviewText($hwnd) {
    try {
        $el=$UIA::FromHandle($hwnd)
        $all=$el.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
        for($i=0;$i -lt $all.Count;$i++){
            $e=$all[$i]
            try { $p=$e.GetCurrentPattern($TP::Pattern) } catch { $p=$null }
            if($p){
                $t=$p.DocumentRange.GetText(40000)
                if($t -and $t.Length -gt 10){ return $t }
            }
        }
    } catch { }
    return ''
}
function Get-TracePath {
    $p1=Join-Path $env:APPDATA 'pooi.moe\QuickLook\TeXViewer.trace.log'
    if(Test-Path $p1){ return $p1 }
    return (Join-Path $env:LOCALAPPDATA 'Packages\21090PaddyXu.QuickLook_egxr34yet59cg\LocalCache\Roaming\pooi.moe\QuickLook\TeXViewer.trace.log')
}

# 确保 QuickLook 在运行
if (-not (Get-Process -Name QuickLook -ErrorAction SilentlyContinue)) {
    Start-Process 'explorer.exe' -ArgumentList 'shell:AppsFolder\21090PaddyXu.QuickLook_egxr34yet59cg!Main'
    Start-Sleep -Seconds 5
}
# 清掉已打开的预览
foreach($w in Get-QuickLookWindows){ Close-Window $w.Hwnd; Start-Sleep -Milliseconds 300 }

$targets=@()
if ($ListFile) { $targets += Get-Content $ListFile | Where-Object { $_ -and (Test-Path $_.Trim()) } | ForEach-Object { $_.Trim() } }
if ($Dir) { $targets += Get-ChildItem $Dir -Recurse -Filter '*.tex' | ForEach-Object { $_.FullName } }
if ($Files) { $targets += $Files | Where-Object { Test-Path $_ } | ForEach-Object { (Resolve-Path $_).Path } }
$targets = $targets | Select-Object -Unique
if(-not $targets){ throw '没有可测的 .tex' }

$baselineExplorer = @(Get-ExplorerWindows | ForEach-Object { $_.Hwnd })
$rows=@()
foreach($f in $targets){
    $name=[IO.Path]::GetFileName($f)
    $dirName=Split-Path (Split-Path $f -Parent) -Leaf
    $trace=Get-TracePath
    $before=if(Test-Path $trace){(Get-Item $trace).Length}else{0}

    Start-Process explorer.exe -ArgumentList "/select,`"$f`"" | Out-Null
    Start-Sleep -Milliseconds 1100

    $exp = Get-ExplorerWindows | Where-Object { $_.Title -eq $dirName -and $baselineExplorer -notcontains $_.Hwnd } | Select-Object -Last 1
    if (-not $exp) { $exp = Get-ExplorerWindows | Where-Object { $_.Title -eq $dirName } | Select-Object -Last 1 }
    if ($exp) { [void][QlWin]::SetForegroundWindow($exp.Hwnd) }
    Start-Sleep -Milliseconds 450
    $SW::SendWait(' ')

    # 等预览窗口按文件名出现
    $ql=$null; $deadline=(Get-Date).AddSeconds($WaitSeconds)
    while((Get-Date) -lt $deadline){
        $ql = Get-QuickLookWindows | Where-Object { $_.Title -like ('*' + $name) } | Select-Object -First 1
        if($ql){ break }
        Start-Sleep -Milliseconds 350
    }
    if(-not $ql){
        # 第一次没出现：重新聚焦再按一次空格（资源管理器焦点竞争时用）
        if($exp){ [void][QlWin]::SetForegroundWindow($exp.Hwnd) }
        Start-Sleep -Milliseconds 500
        $SW::SendWait(' ')
        $deadline=(Get-Date).AddSeconds($WaitSeconds)
        while((Get-Date) -lt $deadline){
            $ql = Get-QuickLookWindows | Where-Object { $_.Title -like ('*' + $name) } | Select-Object -First 1
            if($ql){ break }
            Start-Sleep -Milliseconds 350
        }
    }
    # 等到统计行出现（重文档 MathJax 渲染完才有“N 块 · M 公式”），最多 12 秒
    $text = ''
    $poll=(Get-Date).AddSeconds(12)
    while((Get-Date) -lt $poll){
        $text = if($ql){ Read-PreviewText $ql.Hwnd } else { '' }
        $flat0 = ($text -replace '\s+',' ')
        if($flat0 -match '\d+ 块 ·' -or $flat0 -match '加载失败|无法读取|插件资源缺失|初始化超时'){ break }
        Start-Sleep -Milliseconds 600
    }
    $flat = ($text -replace '\s+',' ').Trim()

    $after=if(Test-Path $trace){(Get-Item $trace).Length}else{0}
    $lines=@()
    if($after -gt $before){
        try{
            $fs=[IO.File]::Open($trace,'Open','Read','ReadWrite'); $fs.Seek($before,'Begin')|Out-Null
            $sr=New-Object IO.StreamReader($fs); $lines=($sr.ReadToEnd() -split "`r?`n")|Where-Object{$_}; $sr.Close(); $fs.Close()
        }catch{}
    }
    $ms=$null; $m=($lines|Select-String 'page rendered'|Select-Object -Last 1)
    if($m -and $m.Line -match '\+(\d+) ms'){ $ms=[int]$matches[1] }
    $errs=($lines|Select-String 'Parse异常|Preview 失败|加载失败|WebView2 初始化超时'|ForEach-Object{$_.Line.Trim()}) -join ' | '
    $stats=''; $sm=[regex]::Match($flat,'(\d+) 块 · (\d+) 个?(?:公式|公式) · ([\d\.]+ (?:KB|B)) · (\d+) ms')
    if($sm.Success){ $stats=$sm.Value }

    $badText = $flat -match '加载失败|无法读取|插件资源缺失|初始化超时|WebView2 初始化|渲染器异常'
    $hasContent = $flat -match '\S' -and -not ($flat -match '^\s*目录?\s*' -and $flat.Length -lt 40)
    $ok = ($ql -ne $null) -and $hasContent -and -not $badText -and -not $errs

    $rows += [pscustomobject]@{
        文件=$name; 目录=$dirName; 打开=($ql -ne $null); 有正文=$hasContent;
        统计=$stats; 渲染ms=$ms; 异常=$badText; 控制台=$errs;
        预览开头= if($flat.Length -gt 70){$flat.Substring(0,70)}else{$flat}
    }

    if($ql){ Close-Window $ql.Hwnd; Start-Sleep -Milliseconds 500 }
    foreach($w in (Get-ExplorerWindows | Where-Object { $baselineExplorer -notcontains $_.Hwnd -and $_.Title -eq $dirName })){
        Close-Window $w.Hwnd
    }
    Start-Sleep -Milliseconds 300
}

$rows | Format-Table -AutoSize @{n='文件';e={$_.文件}}, @{n='打开';e={$_.打开}}, @{n='正文';e={$_.有正文}}, @{n='渲染ms';e={$_.渲染ms}}, @{n='统计';e={$_.统计}}, @{n='异常';e={$_.异常}}
if($OutCsv){ $rows | Export-Csv -Path $OutCsv -NoTypeInformation -Encoding UTF8; Write-Output ('CSV: ' + $OutCsv) }
$pass=($rows|Where-Object{$_.打开 -and $_.有正文 -and -not $_.异常 -and -not $_.控制台}).Count
Write-Output ("=== 共 {0} 份：通过 {1}，问题 {2} ===" -f $rows.Count,$pass,($rows.Count-$pass))
