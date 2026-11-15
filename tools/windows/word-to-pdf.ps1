<# Wordを保存したら、同じ場所に同じ名前のPDFを自動で作る（Windows用・裏で動き続ける）

   - 10秒ごとに、Wordの「最近使ったファイル」を見て、Googleドライブの中にあるWord（.docx / .doc）が
     PDFより新しければ、PDFを作り直す
     （ドライブ全体をたどると、ファイルが多いときに終わらなかったため。2026-11-15）
   - PDFは、Wordそのもので作る（UDデジタル教科書体などのフォントも、見た目もそのまま）
   - Wordのファイルには何もしない（コピーを開いてPDFにする。開いて編集中のWordにも触らない）
   - 初めて動かしたときより前からあるWordは、PDFがまだなければ作らない
     （ドライブ中の古いWordが全部PDFになるのを防ぐ）。一度保存し直せば、PDFが作られる

   見る場所: ふだんは自動で探す（G: などの「マイドライブ」、Parallelsで見えるMacのGoogleドライブ）
   場所を決めたいときは C:\ProgramData\word-to-pdf\folders.txt に、1行に1つずつフォルダを書く（UTF-8）
   記録: C:\ProgramData\word-to-pdf\log.txt #>

$ErrorActionPreference = 'Stop'
$Home2 = Join-Path $env:ProgramData 'word-to-pdf'
New-Item -ItemType Directory -Force -Path $Home2 | Out-Null
$LogFile = Join-Path $Home2 'log.txt'
$SinceFile = Join-Path $Home2 'since.txt'
$ListFile = Join-Path $Home2 'folders.txt'

function Log($msg) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg
  try {
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) { Move-Item -Force $LogFile ($LogFile + '.old') }
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
  } catch {}
}

# 同時に2つ動かない
$mutex = New-Object System.Threading.Mutex($false, 'Global\pdf-tegaki-word-to-pdf')
if (-not $mutex.WaitOne(0)) { exit }

# 初めて動かした時刻（これより前からあるWordは、PDFがなければ作らない）
if (-not (Test-Path $SinceFile)) { (Get-Date).ToString('o') | Set-Content -Path $SinceFile -Encoding ASCII }
$Since = [datetime]::Parse((Get-Content $SinceFile -Raw).Trim())

function Find-Folders {
  if (Test-Path $ListFile) {
    $list = Get-Content $ListFile -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') }
    if ($list) { return @($list | Where-Object { Test-Path -LiteralPath $_ }) }
  }
  $found = @()
  foreach ($d in Get-PSDrive -PSProvider FileSystem) {
    foreach ($name in @('マイドライブ', 'My Drive')) {
      $p = Join-Path $d.Root $name
      if (Test-Path -LiteralPath $p) { $found += $p }
    }
  }
  if (-not $found) {
    # Parallels: MacのGoogleドライブ（\\Mac\Home\Library\CloudStorage\GoogleDrive-○○\マイドライブ）
    $cs = '\\Mac\Home\Library\CloudStorage'
    if (Test-Path -LiteralPath $cs) {
      foreach ($g in Get-ChildItem -LiteralPath $cs -Directory -Filter 'GoogleDrive-*') {
        foreach ($name in @('マイドライブ', 'My Drive')) {
          $p = Join-Path $g.FullName $name
          if (Test-Path -LiteralPath $p) { $found += $p }
        }
      }
    }
  }
  return $found
}

$Word = $null
function Get-Word {
  if ($script:Word) { return $script:Word }
  # 自動で作ったWordは見えない。使っているWordにつながったときは、表示や設定を変えない
  $script:Word = New-Object -ComObject Word.Application
  if (-not $script:Word.Visible) { $script:Word.DisplayAlerts = 0 }
  return $script:Word
}
function Close-Word {
  if (-not $script:Word) { return }
  try {
    # 自分で開いた見えないWordだけ閉じる（使っているWordは閉じない）
    if (-not $script:Word.Visible -and $script:Word.Documents.Count -eq 0) { $script:Word.Quit() }
  } catch {}
  try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($script:Word) } catch {}
  $script:Word = $null
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}

function Convert-One($src, $pdf) {
  $tmpDir = Join-Path $env:TEMP ('word-to-pdf-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmpDir | Out-Null
  try {
    $copy = Join-Path $tmpDir ('src' + [IO.Path]::GetExtension($src))
    $out = Join-Path $tmpDir 'out.pdf'
    Copy-Item -LiteralPath $src -Destination $copy
    $w = Get-Word
    # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles)
    $doc = $w.Documents.Open($copy, $false, $true, $false)
    try { $doc.ExportAsFixedFormat($out, 17) }   # 17 = PDF
    finally { $doc.Close(0); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($doc) }
    Move-Item -Force -LiteralPath $out -Destination $pdf
    (Get-Item -LiteralPath $pdf).LastWriteTime = Get-Date
    Log ('PDFを作りました: ' + $pdf)
  } finally {
    Remove-Item -Recurse -Force -LiteralPath $tmpDir -ErrorAction SilentlyContinue
  }
}

# Wordの「最近使ったファイル」（Wordの記録と、Windowsの「最近使った項目」）
function Get-RecentDocs {
  $paths = @{}
  $keys = @(Get-Item -Path 'HKCU:\Software\Microsoft\Office\*\Word\User MRU\*\File MRU', 'HKCU:\Software\Microsoft\Office\*\Word\File MRU' -ErrorAction SilentlyContinue)
  foreach ($k in $keys) {
      foreach ($v in $k.GetValueNames()) {
        if ($v -notmatch '^Item \d+$') { continue }
        $p = [string]$k.GetValue($v)
        $i = $p.LastIndexOf('*'); if ($i -ge 0) { $p = $p.Substring($i + 1) }
        if ($p) { $paths[$p] = $true }
      }
  }
  $recent = Join-Path $env:APPDATA 'Microsoft\Windows\Recent'
  if (Test-Path -LiteralPath $recent) {
    $sh = New-Object -ComObject WScript.Shell
    foreach ($l in Get-ChildItem -LiteralPath $recent -Filter '*.doc*.lnk' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 40) {
      try { $t = $sh.CreateShortcut($l.FullName).TargetPath; if ($t) { $paths[$t] = $true } } catch {}
    }
  }
  return @($paths.Keys)
}

$failed = @{}   # 失敗したファイル → そのときのWordの更新時刻（直して保存し直すまで、やり直さない）
Log '起動しました'
$lastFolders = ''
$lastSig = $null
$told = @{}
while ($true) {
  try {
    $folders = @(Find-Folders)
    $key = $folders -join ' | '
    if ($key -ne $lastFolders) { Log ('見ている場所: ' + $(if ($key) { $key } else { '（見つかりません）' })); $lastFolders = $key }
    $all = @(Get-RecentDocs)
    $mine = @($all | Where-Object { $p = $_; $_ -match '\.docx?$' -and ($folders | Where-Object { $p.StartsWith($_.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) }) })
    $sig = $mine -join '|'
    if ($sig -ne $lastSig) {
      Log ('最近使ったWord: ' + $all.Count + '件（うちマイドライブ内 ' + $mine.Count + '件）')
      $mine | Select-Object -First 5 | ForEach-Object { Log ('  ' + $_) }
      if (-not $mine.Count) { $all | Select-Object -First 5 | ForEach-Object { Log ('  （対象外）' + $_) } }
      $lastSig = $sig
    }
    foreach ($src in $mine) {
      if ($src -notmatch '\.docx?$' -or [IO.Path]::GetFileName($src).StartsWith('~$')) { continue }
      $inside = $false
      foreach ($f in $folders) { if ($src.StartsWith($f.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { $inside = $true; break } }
      if (-not $inside) { continue }
      if (-not (Test-Path -LiteralPath $src)) { continue }
      $d = Get-Item -LiteralPath $src
      $pdf = [IO.Path]::ChangeExtension($d.FullName, '.pdf')
      $t = $d.LastWriteTime
      if (((Get-Date) - $t).TotalSeconds -lt 5) { continue }       # 保存の途中かもしれない
      $hasPdf = Test-Path -LiteralPath $pdf
      if ($hasPdf) { if ((Get-Item -LiteralPath $pdf).LastWriteTime -ge $t) { continue } }
      elseif ($t -lt $Since) {
        if (-not $told.ContainsKey($d.FullName)) { Log ('入れる前に保存されたWordなので、まだ作りません（保存し直すと作ります）: ' + $d.FullName); $told[$d.FullName] = $true }
        continue
      }
      if ($failed.ContainsKey($d.FullName) -and $failed[$d.FullName] -eq $t) { continue }
      try { Convert-One $d.FullName $pdf; $failed.Remove($d.FullName) }
      catch { $failed[$d.FullName] = $t; Log ('PDFにできませんでした: ' + $d.FullName + '  ' + $_.Exception.Message) }
    }
  } catch { Log ('エラー: ' + $_.Exception.Message) }
  Close-Word
  Start-Sleep -Seconds 10
}
