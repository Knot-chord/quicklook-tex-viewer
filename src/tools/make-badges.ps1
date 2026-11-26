# 生成自托管静态 badge（shields 风格 SVG），避免依赖 shields.io
# 用法：pwsh -File src\tools\make-badges.ps1   → 输出到 docs\badges\
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$outDir = Join-Path $root 'docs\badges'
New-Item -ItemType Directory -Force $outDir | Out-Null

$badges = @(
    @{ file = 'quicklook.svg'; label = 'QuickLook'; message = '4.5';       color = '#007ec6' },
    @{ file = 'dotnet.svg';    label = 'dotnet';    message = '4.7.2';     color = '#007ec6' },
    @{ file = 'webview2.svg';  label = 'WebView2';  message = 'runtime';   color = '#9f9f9f' },
    @{ file = 'version.svg';   label = 'version';   message = '0.1.0';     color = '#007ec6' },
    @{ file = 'tests.svg';     label = 'tests';     message = 'passing';   color = '#97ca00' },
    @{ file = 'deps.svg';      label = 'dependencies'; message = '0';      color = '#4c1' },
    @{ file = 'license.svg';   label = 'license';   message = 'MIT';       color = '#9f9f9f' }
)

function Esc([string]$s) { return ($s -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' -replace '"', '&quot;') }
function SegWidth([string]$s) {
    $w = [Math]::Max(22, [int](6.6 * $s.Length + 10))
    return $w
}

foreach ($b in $badges) {
    $lw = SegWidth $b.label
    $mw = SegWidth $b.message
    $w = $lw + $mw
    $lt = [Math]::Max(4, $lw - 10)
    $mt = [Math]::Max(4, $mw - 10)
    $label = Esc $b.label
    $msg = Esc $b.message
    $svg = @"
<svg xmlns="http://www.w3.org/2000/svg" width="$w" height="20" role="img" aria-label="$label`: $msg">
  <title>$label`: $msg</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="$w" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="$lw" height="20" fill="#555"/>
    <rect x="$lw" width="$mw" height="20" fill="$($b.color)"/>
    <rect width="$w" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="$([int]($lw/2))" y="15" fill="#010101" fill-opacity=".3" textLength="$lt" lengthAdjust="spacingAndGlyphs">$label</text>
    <text x="$([int]($lw/2))" y="14" textLength="$lt" lengthAdjust="spacingAndGlyphs">$label</text>
    <text x="$([int]($lw + $mw/2))" y="15" fill="#010101" fill-opacity=".3" textLength="$mt" lengthAdjust="spacingAndGlyphs">$msg</text>
    <text x="$([int]($lw + $mw/2))" y="14" textLength="$mt" lengthAdjust="spacingAndGlyphs">$msg</text>
  </g>
</svg>
"@
    [IO.File]::WriteAllText((Join-Path $outDir $b.file), $svg, (New-Object Text.UTF8Encoding($false)))
    Write-Output ('  ' + $b.file + '  ' + $w + 'x20')
}
Write-Output ('输出目录: ' + $outDir)
