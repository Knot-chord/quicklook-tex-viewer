# 从 GitHub 代码搜索自动抓取“有代表性的 .tex”样例（按类别），存到 samples/web2/<类别>/
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$outRoot = Join-Path $root 'samples\web2'
New-Item -ItemType Directory -Force $outRoot | Out-Null
$gh = 'C:\Users\Z1234\AppData\Local\Programs\gh\bin\gh.exe'

# 每类查询：filename 语法搜代码，挑 2 个不同仓库
$queries = @(
  @{ cat = '01-article';      q = 'filename:sample2e.tex' },
  @{ cat = '02-acm';          q = 'filename:sigconf.tex' },
  @{ cat = '03-ieee';         q = 'filename:bare_conf.tex' },
  @{ cat = '04-elsevier';     q = 'filename:elsarticle-template-num.tex' },
  @{ cat = '05-springer';     q = 'filename:llncs.tex' },
  @{ cat = '06-beamer';       q = 'filename:beamer.tex' },
  @{ cat = '07-slides';       q = 'filename:slides.tex' },
  @{ cat = '08-thesis';       q = 'filename:thesis.tex' },
  @{ cat = '09-cv';           q = 'filename:resume.tex' },
  @{ cat = '10-cover-letter'; q = 'filename:cover-letter.tex' },
  @{ cat = '11-poster';       q = 'filename:poster.tex' },
  @{ cat = '12-tikz';         q = 'filename:tikz.tex' },
  @{ cat = '13-book';         q = 'filename:book.tex' },
  @{ cat = '14-exam';         q = 'filename:exam.tex' },
  @{ cat = '15-letter';       q = 'filename:letter.tex' },
  @{ cat = '16-math';         q = 'filename:math.tex' },
  @{ cat = '17-table';        q = 'filename:table.tex' },
  @{ cat = '18-cjk';          q = 'filename:ctex.tex' },
  @{ cat = '19-report';       q = 'filename:report.tex' },
  @{ cat = '20-paper';        q = 'filename:paper.tex' }
)

$report = @()
foreach ($item in $queries) {
  $cat = $item.cat; $q = $item.q
  $dir = Join-Path $outRoot $cat
  New-Item -ItemType Directory -Force $dir | Out-Null
  try {
    $json = & $gh api ("search/code?per_page=8&q=" + [uri]::EscapeDataString($q)) 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $json) { $report += [pscustomobject]@{ cat = $cat; file = ''; status = 'search-failed' }; continue }
    $items = ($json | ConvertFrom-Json).items
    $taken = 0
    foreach ($it in $items) {
      if ($taken -ge 2) { break }
      if ($it.path -notmatch '\.tex$') { continue }
      $repo = $it.repository.full_name; $p = $it.path
      try {
        $content = & $gh api ("repos/$repo/contents/" + $p) --jq '.content' 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $content) { continue }
        $b64 = ($content -join '') -replace '\s', ''
        $bytes = [Convert]::FromBase64String($b64)
        $safe = ($repo -replace '/', '_') + '__' + ([IO.Path]::GetFileName($p))
        $dest = Join-Path $dir $safe
        [IO.File]::WriteAllBytes($dest, $bytes)
        $report += [pscustomobject]@{ cat = $cat; file = $safe; status = 'ok' }
        $taken++
      } catch { }
    }
    if ($taken -eq 0) { $report += [pscustomobject]@{ cat = $cat; file = ''; status = 'no-usable' } }
  } catch {
    $report += [pscustomobject]@{ cat = $cat; file = ''; status = 'error: ' + $_.Exception.Message }
  }
}
$report | Format-Table -AutoSize
