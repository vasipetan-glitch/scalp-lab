# Scalp Lab - local server (demo / paper trading only)
# - Serves the dashboard from .\public
# - Proxies Yahoo Finance chart data for the 3 allowed symbols (browsers can't call Yahoo directly)
# - Saves the demo account to .\data\state.json and reports to .\data\reports
# Listens on localhost only. No real money, no broker connection.

param(
  [int]$Port = 4870,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Public  = [System.IO.Path]::GetFullPath((Join-Path $Root 'public'))
$Data    = Join-Path $Root 'data'
$Cache   = Join-Path $Data 'cache'
$Reports = Join-Path $Data 'reports'
foreach ($d in @($Data, $Cache, $Reports)) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null } }

$UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
$AllowedSymbols   = @('EURUSD=X', 'GC=F', 'NQ=F')
$AllowedIntervals = @('1m', '5m')
$AllowedRanges    = @('1d', '2d', '5d', '60d')
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

$Mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'application/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon'
  '.md' = 'text/markdown; charset=utf-8'; '.csv' = 'text/csv; charset=utf-8'
}

function Send-Response($ctx, [int]$code, [string]$type, $body) {
  $resp = $ctx.Response
  $resp.StatusCode = $code
  $resp.ContentType = $type
  $resp.Headers.Add('Cache-Control', 'no-store')
  if ($body -is [byte[]]) { $bytes = $body } else { $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$body) }
  $resp.ContentLength64 = $bytes.Length
  if ($ctx.Request.HttpMethod -ne 'HEAD') { $resp.OutputStream.Write($bytes, 0, $bytes.Length) }
  $resp.OutputStream.Close()
}

function Send-Json($ctx, [int]$code, $obj) {
  Send-Response $ctx $code 'application/json; charset=utf-8' ($obj | ConvertTo-Json -Compress -Depth 5)
}

function Read-Body($req) {
  $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
  try { return $reader.ReadToEnd() } finally { $reader.Close() }
}

function Write-Atomic([string]$path, [string]$text) {
  $tmp = "$path.tmp"
  [System.IO.File]::WriteAllText($tmp, $text, $Utf8NoBom)
  # [NullString]::Value = a real null (PowerShell would turn $null into "" and Replace would fail)
  if (Test-Path $path) { [System.IO.File]::Replace($tmp, $path, [NullString]::Value) } else { [System.IO.File]::Move($tmp, $path) }
}

function Get-Url([string]$url) {
  $wc = New-Object System.Net.WebClient
  try {
    $wc.Headers.Add('User-Agent', $UA)
    $wc.Headers.Add('Accept', 'application/json')
    $wc.Encoding = [System.Text.Encoding]::UTF8
    return $wc.DownloadString($url)
  } finally { $wc.Dispose() }
}

function Get-Chart($q) {
  $symbol = $q['symbol']; $interval = $q['interval']; $range = $q['range']
  $p1 = $q['period1']; $p2 = $q['period2']
  if ($AllowedSymbols -notcontains $symbol) { throw "symbol not allowed" }
  if ($AllowedIntervals -notcontains $interval) { throw "interval not allowed" }
  $params = "interval=$interval"
  if ($p1 -and $p2) {
    if ($p1 -notmatch '^\d{9,11}$' -or $p2 -notmatch '^\d{9,11}$') { throw "bad period" }
    $params += "&period1=$p1&period2=$p2"
  } else {
    if ($AllowedRanges -notcontains $range) { throw "range not allowed" }
    $params += "&range=$range"
  }
  # Long history is cached for 20 minutes so page reloads stay fast and polite to Yahoo
  $cacheFile = $null
  if ($range -eq '60d') {
    $cacheFile = Join-Path $Cache (($symbol -replace '[^A-Za-z0-9]', '_') + "_$interval`_$range.json")
    if ((Test-Path $cacheFile) -and ((Get-Date) - (Get-Item $cacheFile).LastWriteTime).TotalMinutes -lt 20) {
      return [System.IO.File]::ReadAllText($cacheFile)
    }
  }
  $enc = [uri]::EscapeDataString($symbol)
  $text = $null; $lastErr = $null
  foreach ($h in @('query1', 'query2')) {
    try { $text = Get-Url "https://$h.finance.yahoo.com/v8/finance/chart/$enc`?$params"; break } catch { $lastErr = $_.Exception.Message }
  }
  if (-not $text) { throw "Yahoo request failed: $lastErr" }
  if ($cacheFile) { Write-Atomic $cacheFile $text }
  return $text
}

function Handle($ctx) {
  $req = $ctx.Request
  $path = $req.Url.AbsolutePath
  $method = $req.HttpMethod

  if ($path -eq '/api/ping') { Send-Json $ctx 200 @{ ok = $true; time = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }; return }

  if ($path -eq '/api/chart' -and $method -eq 'GET') {
    try { Send-Response $ctx 200 'application/json; charset=utf-8' (Get-Chart $req.QueryString) }
    catch { Send-Json $ctx 502 @{ error = $_.Exception.Message } }
    return
  }

  # This week's economic calendar (free Forex Factory feed), cached for 60 minutes
  if ($path -eq '/api/news' -and $method -eq 'GET') {
    $newsFile = Join-Path $Cache 'news_thisweek.json'
    try {
      if (-not ((Test-Path $newsFile) -and ((Get-Date) - (Get-Item $newsFile).LastWriteTime).TotalMinutes -lt 60)) {
        Write-Atomic $newsFile (Get-Url 'https://nfs.faireconomy.media/ff_calendar_thisweek.json')
      }
      Send-Response $ctx 200 'application/json; charset=utf-8' ([System.IO.File]::ReadAllText($newsFile))
    } catch {
      if (Test-Path $newsFile) { Send-Response $ctx 200 'application/json; charset=utf-8' ([System.IO.File]::ReadAllText($newsFile)) }
      else { Send-Json $ctx 502 @{ error = $_.Exception.Message } }
    }
    return
  }

  if ($path -eq '/api/state') {
    $file = Join-Path $Data 'state.json'
    if ($method -eq 'GET') {
      if (Test-Path $file) { Send-Response $ctx 200 'application/json; charset=utf-8' ([System.IO.File]::ReadAllText($file)) }
      else { Send-Response $ctx 200 'application/json; charset=utf-8' 'null' }
      return
    }
    if ($method -eq 'POST') {
      $body = Read-Body $req
      if ($body.Length -lt 2 -or $body.Length -gt 30MB) { Send-Json $ctx 400 @{ error = 'bad body' }; return }
      Write-Atomic $file $body
      Send-Json $ctx 200 @{ ok = $true }
      return
    }
  }

  if ($path -eq '/api/report' -and $method -eq 'POST') {
    $name = $req.QueryString['name']
    if ($name -notmatch '^[A-Za-z0-9_\-]+\.(md|csv|json)$') { Send-Json $ctx 400 @{ error = 'bad name' }; return }
    Write-Atomic (Join-Path $Reports $name) (Read-Body $req)
    Send-Json $ctx 200 @{ ok = $true }
    return
  }

  if ($method -ne 'GET') { Send-Json $ctx 405 @{ error = 'method not allowed' }; return }

  # Static files from .\public (no path traversal)
  $rel = [uri]::UnescapeDataString($path.TrimStart('/'))
  if ($rel -eq '') { $rel = 'index.html' }
  $full = [System.IO.Path]::GetFullPath((Join-Path $Public $rel))
  if (-not $full.StartsWith($Public, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $full -PathType Leaf)) {
    Send-Response $ctx 404 'text/plain; charset=utf-8' 'Not found'; return
  }
  $ext = [System.IO.Path]::GetExtension($full).ToLower()
  $type = $Mime[$ext]; if (-not $type) { $type = 'application/octet-stream' }
  Send-Response $ctx 200 $type ([System.IO.File]::ReadAllBytes($full))
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch {
  Write-Host "Port $Port is busy - Scalp Lab is probably already running. Opening the dashboard." -ForegroundColor Yellow
  if (-not $NoBrowser) { Start-Process "http://localhost:$Port/" }
  exit 0
}

Write-Host ''
Write-Host "  Scalp Lab (DEMO - paper money only) is running at http://localhost:$Port/" -ForegroundColor Green
Write-Host '  Keep this window open while you want the demo to trade. Press Ctrl+C to stop.'
Write-Host ''
if (-not $NoBrowser) { Start-Process "http://localhost:$Port/" }

try {
  while ($listener.IsListening) {
    $async = $listener.BeginGetContext($null, $null)
    while (-not $async.AsyncWaitHandle.WaitOne(250)) { }
    $ctx = $listener.EndGetContext($async)
    try { Handle $ctx }
    catch {
      $msg = $_.Exception.Message
      Write-Host ("  error on {0} {1}: {2}" -f $ctx.Request.HttpMethod, $ctx.Request.Url.AbsolutePath, $msg) -ForegroundColor Red
      try { Send-Json $ctx 500 @{ error = $msg } } catch { }
    }
  }
} finally {
  $listener.Stop(); $listener.Close()
}
