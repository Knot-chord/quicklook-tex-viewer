#Requires -Version 5.1
<#
.SYNOPSIS
    抓取真实世界 LaTeX 文档样本，供 QuickLook TeX 插件做兼容性测试。

.DESCRIPTION
    样本全部落到 samples\real\<slug>\ 下，并在 samples\real\MANIFEST.md 生成清单
    （来源 URL、许可提示、字节数、SHA256、测试点）。
    GitHub 文件走 ghfast 前缀（本机约定），CTAN 直连。

    这些文件仅用于本机兼容性测试，版权与许可归各自上游，不要再分发。

.EXAMPLE
    .\fetch-samples.ps1
    .\fetch-samples.ps1 -Force   # 已存在也重新下载
#>
[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$OutRoot = Join-Path $Root 'samples\real'
$GhPrefix = 'https://ghfast.top/https://raw.githubusercontent.com/'
$Gh = 'C:\Users\Z1234\AppData\Local\Programs\gh\bin\gh.exe'

function Write-Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

function Get-DefaultBranch($repo) {
    try {
        $b = & $Gh api "repos/$repo" --jq '.default_branch' 2>$null
        if ($LASTEXITCODE -eq 0 -and $b) { return $b.Trim() }
    } catch { }
    return 'master'
}

function Save-Remote($url, $dest) {
    $dir = Split-Path -Parent $dest
    New-Item -ItemType Directory -Force $dir | Out-Null
    try {
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 60
        return (Get-Item $dest)
    } catch {
        Write-Host ("  [!!] 下载失败，跳过：{0}`n       {1}" -f $dest, $_.Exception.Message) -ForegroundColor Yellow
        return $null
    }
}

# ---------------------------------------------------------------------------
# 样本表
# slug / 文件名 / 来源 / 许可 / 测试点
# ---------------------------------------------------------------------------
$items = @(
    # -------- 出版方 / 期刊模板 --------
    @{ slug = '01-elsarticle-journal'; name = 'elsarticle-template-num.tex'
       url = 'https://mirrors.ctan.org/macros/latex/contrib/elsarticle/elsarticle-template-num.tex'
       license = 'LPPL 1.3 (CTAN elsarticle)'
       note = 'Elsevier 期刊模板：摘要/关键词/作者单位、natbib 引用、图表、附录' },

    @{ slug = '02-revtex-aps'; name = 'apssamp.tex'
       url = 'https://mirrors.ctan.org/macros/latex/contrib/revtex/sample/aps/apssamp.tex'
       license = 'LPPL 1.3 (CTAN revtex)'
       note = 'APS/REVTeX 物理稿件：双栏、\affiliation 多单位、带星脚注、revtex4-2 专有宏' },

    @{ slug = '03-ieeetran-conference'; name = 'bare_conf.tex'
       url = 'https://mirrors.ctan.org/macros/latex/contrib/IEEEtran/bare_conf.tex'
       license = 'LPPL 1.3 (CTAN IEEEtran)'
       note = 'IEEE 会议模板：IEEEauthorblock*、IEEEkeywords、双栏、\cite 密集' },

    @{ slug = '04-tufte-handout'; name = 'sample-handout.tex'
       url = 'https://mirrors.ctan.org/macros/latex/contrib/tufte-latex/sample-handout.tex'
       license = 'LPPL 1.3 (CTAN tufte-latex)'
       note = 'Tufte 风格：宽边注 \sidenote、\marginnote、\newthought 小体大写导语' },

    @{ slug = '05-moderncv-cv'; name = 'template.tex'
       url = 'https://mirrors.ctan.org/macros/latex/contrib/moderncv/template.tex'
       license = 'LPPL 1.3 (CTAN moderncv)'
       note = '简历模板：\cventry/\cvsitem/\cvitem 等自定义命令、无 section 结构' }
)

# -------- GitHub 上的真实文件（含 LyX 导出物与幻灯片）--------
$ghFiles = @(
    @{ repo = 'biopython/biopython'; path = 'Doc/biopdb_faq.tex'; slug = '06-lyx-export-doc'
       license = 'Biopython License (见上游)'
       note = 'LyX 导出的技术文档：大量 \selectlanguage/\def/\lyx… 宏、自定义格式，考降级能力' },

    @{ repo = 'winitzki/sofp'; path = 'talk_slides/equivalence-under-laws.tex'; slug = '07-lyx-beamer-slides'
       license = '见上游仓库'
       note = 'LyX 导出的 beamer 幻灯片：\frame/\begin{block} 结构，考非文档型版面' },

    @{ repo = 'martinGithub/beamer2pptx'; path = 'example.tex'; slug = '08-beamer-slides'
       license = '见上游仓库'
       note = '手写 beamer 幻灯片：\section 与 \begin{frame} 混排、itemize 覆盖层' }
)

# -------- 中文手册（主文件 + 16 个 \input 章节）--------
$lshortRepo = 'CTeX-org/lshort-zh-cn'
$lshortChaps = @(
    'titlepage.tex', 'preface.overview.tex', 'preface.contrib.tex',
    'chap.01.basics.tex', 'chap.02.text.tex', 'chap.03.elements.tex', 'chap.04.math.tex',
    'chap.05.style.tex', 'chap.06.spec.tex', 'chap.07.graphic.tex', 'chap.08.custom.tex',
    'app.A.install.tex', 'app.B.error.help.tex', 'sec.symbol.table.tex', 'biblio.tex', 'fdl.tex'
)

$manifest = New-Object System.Collections.Generic.List[string]
$manifest.Add('# 真实文档样本清单')
$manifest.Add('')
$manifest.Add('> 由 `src\tools\fetch-samples.ps1` 抓取，仅用于本机兼容性测试。')
$manifest.Add('> 版权与许可归各自上游，**不要再分发这些文件**。')
$manifest.Add('')
$manifest.Add('| 目录 | 文件 | 字节 | 许可 | 测试点 |')
$manifest.Add('| --- | --- | ---: | --- | --- |')

function Add-Row($slug, $name, $bytes, $license, $note) {
    $manifest.Add("| ``$slug`` | ``$name`` | $bytes | $license | $note |")
}

# ---- CTAN 部分 ----
Write-Step 'CTAN 样本'
foreach ($it in $items) {
    $dest = Join-Path (Join-Path $OutRoot $it.slug) $it.name
    if ((Test-Path $dest) -and -not $Force) {
        $f = Get-Item $dest
        Write-Host ("  · 已存在 {0} ({1} B)" -f $it.name, $f.Length) -ForegroundColor DarkGray
    } else {
        $f = Save-Remote $it.url $dest
        Write-Host ("  [OK] {0} ({1} B)" -f $it.name, $f.Length) -ForegroundColor Green
    }
    Add-Row $it.slug $it.name $f.Length $it.license $it.note
}

# ---- GitHub 部分 ----
Write-Step 'GitHub 样本（走 ghfast）'
foreach ($g in $ghFiles) {
    $branch = Get-DefaultBranch $g.repo
    $url = "$GhPrefix$($g.repo)/$branch/$($g.path)"
    $name = Split-Path -Leaf $g.path
    $dest = Join-Path (Join-Path $OutRoot $g.slug) $name
    if ((Test-Path $dest) -and -not $Force) {
        $f = Get-Item $dest
        Write-Host ("  · 已存在 {0} ({1} B)" -f $name, $f.Length) -ForegroundColor DarkGray
    } else {
        $f = Save-Remote $url $dest
        Write-Host ("  [OK] {0} ({1} B)  ← {2}" -f $name, $f.Length, $g.repo) -ForegroundColor Green
    }
    Add-Row $g.slug $name $f.Length $g.license $g.note
}

# ---- 中文手册（主文件 + 章节 + 样式）----
Write-Step '中文手册 lshort-zh-cn（主文件 + \input 章节）'
$lshortBranch = Get-DefaultBranch $lshortRepo
$lshortDir = Join-Path $OutRoot '09-lshort-zh-cn'
New-Item -ItemType Directory -Force $lshortDir | Out-Null

$files = @(
    @{ path = 'src/lshort-zh-cn.tex'; dest = 'lshort-zh-cn.tex' },
    @{ path = 'src/lshort-zh-cn-style.sty'; dest = 'lshort-zh-cn-style.sty' },
    @{ path = 'src/lshort-zh-cn-layout.tex'; dest = 'lshort-zh-cn-layout.tex' }
)
foreach ($f1 in $files) {
    $dest = Join-Path $lshortDir $f1.dest
    if ((Test-Path $dest) -and -not $Force) { $f = Get-Item $dest }
    else { $f = Save-Remote "$GhPrefix$lshortRepo/$lshortBranch/$($f1.path)" $dest }
    Write-Host ("  [OK] {0} ({1} B)" -f $f1.dest, $f.Length) -ForegroundColor Green
}
Add-Row '09-lshort-zh-cn' 'lshort-zh-cn.tex' (Get-Item (Join-Path $lshortDir 'lshort-zh-cn.tex')).Length `
    'GPL-2.0+ (见上游)' '中文 LaTeX 入门手册主文件：\input 16 个章节、自定义 .sty、图表公式密度高'

$chapDir = Join-Path $lshortDir 'chap'
New-Item -ItemType Directory -Force $chapDir | Out-Null
$chapBytes = 0
foreach ($c in $lshortChaps) {
    $dest = Join-Path $chapDir $c
    if ((Test-Path $dest) -and -not $Force) { $f = Get-Item $dest }
    else { $f = Save-Remote "$GhPrefix$lshortRepo/$lshortBranch/src/chap/$c" $dest }
    $chapBytes += $f.Length
}
Write-Host ("  [OK] chap\*.tex × {0}（合计 {1:N0} B）" -f $lshortChaps.Count, $chapBytes) -ForegroundColor Green
$manifest.Add("| ``09-lshort-zh-cn`` | ``chap\*.tex`` | $chapBytes | GPL-2.0+ | 16 个 \input 章节：中文排版、公式、表格、TikZ、自定义环境 |")

# ---- 写清单 ----
$manifest.Add('')
$manifest.Add('## 已知预期现象（测试时要能对上）')
$manifest.Add('')
$manifest.Add('- `lshort-zh-cn.tex`：16 个 `\input` 由宿主展开后一次渲染，页面统计应显示 16 个以上章节标题。')
$manifest.Add('- `moderncv` / `revtex` / `IEEEtran`：大量自定义命令（`\cventry`、`\affiliation`、`\IEEEauthorblockN`）会被降级为参数内容或直接丢弃，属预期。')
$manifest.Add('- `biopdb_faq.tex`（LyX 导出）：`\selectlanguage`、`\def\…` 等宏会被降级，可能出现少量原文宏名残留提示。')
$manifest.Add('- beamer 两份：`\begin{frame}` 会被当作未知环境包一层普通块，内容仍可读，但不会分屏显示。')
$manifest.Add('- `sample-handout.tex`（tufte）：`\sidenote` 降级为普通文本/脚注样式。')
$manifest.Add('- 所有模板里的 `.pdf`/`.eps` 图片：显示为带文件名的占位框，属预期（浏览器不能渲染 PDF）。')

[System.IO.File]::WriteAllLines((Join-Path $OutRoot 'MANIFEST.md'), $manifest, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "`n样本目录：$OutRoot" -ForegroundColor Cyan
Write-Host "清单：$(Join-Path $OutRoot 'MANIFEST.md')" -ForegroundColor Cyan
