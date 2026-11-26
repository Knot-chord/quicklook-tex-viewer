# 第二波：补充类别（海报/TikZ/书籍/信件/考试/报告/算法/两栏等），与第一波去重
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$outRoot = Join-Path $root 'samples\web2b'
New-Item -ItemType Directory -Force $outRoot | Out-Null
$gh = 'C:\Users\Z1234\AppData\Local\Programs\gh\bin\gh.exe'
$existing = @()
foreach ($d in @('samples\web2', 'samples\web2b')) {
  $p = Join-Path $root $d
  if (Test-Path $p) { $existing += Get-ChildItem $p -Recurse -Filter '*.tex' | ForEach-Object { $_.Name } }
}

$queries = @(
  @{ cat = '21-poster';   q = 'filename:poster.tex' },
  @{ cat = '22-tikz';     q = 'filename:tikz.tex' },
  @{ cat = '23-book';     q = 'filename:book.tex' },
  @{ cat = '24-letter';   q = 'filename:letter.tex' },
  @{ cat = '25-exam';     q = 'filename:exam.tex' },
  @{ cat = '26-report';   q = 'filename:report.tex' },
  @{ cat = '27-algorithm';q = 'filename:algorithm.tex' },
  @{ cat = '28-plot';     q = 'filename:plot.tex' }
)

$report = @()
foreach ($item in $queries) {
  $cat = $item.cat; $q = $item.q
  $dir = Join-Path $outRoot $cat
  New-Item -ItemType Directory -Force $dir | Out-Null
  try {
    $json = & $gh api ("search/code?per_page=10&q=" + [uri]::EscapeDataString($q)) 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $json) { $report += [pscustomobject]@{ cat=$cat; file=''; status='search-failed' }; continue }
    $items = ($json | ConvertFrom-Json).items
    $taken = 0
    foreach ($it in $items) {
      if ($taken -ge 2) { break }
      if ($it.path -notmatch '\.tex$') { continue }
      $repo = $it.repository.full_name; $p = $it.path
      $safe = ($repo -replace '/', '_') + '__' + ([IO.Path]::GetFileName($p))
      if ($existing -contains $safe) { continue }
      try {
        $content = & $gh api ("repos/$repo/contents/" + $p) --jq '.content' 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $content) { continue }
        $b64 = ($content -join '') -replace '\s', ''
        [IO.File]::WriteAllBytes((Join-Path $dir $safe), [Convert]::FromBase64String($b64))
        $existing += $safe
        $report += [pscustomobject]@{ cat=$cat; file=$safe; status='ok' }
        $taken++
      } catch { }
    }
    if ($taken -eq 0) { $report += [pscustomobject]@{ cat=$cat; file=''; status='no-new' } }
  } catch { $report += [pscustomobject]@{ cat=$cat; file=''; status='error' } }
}
$report | Format-Table -AutoSize
