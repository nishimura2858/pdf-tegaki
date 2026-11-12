<# Wordを保存したら、同じ場所に同じ名前のPDFを自動で作る（Windows用・裏で動き続ける）

   - Googleドライブの中を15秒ごとに見て、PDFより新しいWord（.docx / .doc）があればPDFを作り直す
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

$failed = @{}   # 失敗したファイル → そのときのWordの更新時刻（直して保存し直すまで、やり直さない）
Log '起動しました'
$lastFolders = ''
while ($true) {
  try {
    $folders = @(Find-Folders)
    $key = $folders -join ' | '
    if ($key -ne $lastFolders) { Log ('見ている場所: ' + $(if ($key) { $key } else { '（見つかりません）' })); $lastFolders = $key }
    foreach ($f in $folders) {
      $docs = Get-ChildItem -LiteralPath $f -Recurse -File -Include *.docx, *.doc -ErrorAction SilentlyContinue |
        Where-Object { -not $_.Name.StartsWith('~$') }
      foreach ($d in $docs) {
        $pdf = [IO.Path]::ChangeExtension($d.FullName, '.pdf')
        $t = $d.LastWriteTime
        if (((Get-Date) - $t).TotalSeconds -lt 5) { continue }       # 保存の途中かもしれない
        $hasPdf = Test-Path -LiteralPath $pdf
        if ($hasPdf) { if ((Get-Item -LiteralPath $pdf).LastWriteTime -ge $t) { continue } }
        elseif ($t -lt $Since) { continue }
        if ($failed.ContainsKey($d.FullName) -and $failed[$d.FullName] -eq $t) { continue }
        try { Convert-One $d.FullName $pdf; $failed.Remove($d.FullName) }
        catch { $failed[$d.FullName] = $t; Log ('PDFにできませんでした: ' + $d.FullName + '  ' + $_.Exception.Message) }
      }
    }
  } catch { Log ('エラー: ' + $_.Exception.Message) }
  Close-Word
  Start-Sleep -Seconds 15
}
