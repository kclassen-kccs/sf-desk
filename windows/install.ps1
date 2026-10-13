# Installs (or updates) SF Desk on Windows for the current user, from the unzipped SF-Desk-windows.zip.
# Run by "Install SF Desk.cmd" next to the app and runtime folders. No admin rights needed.
# The app goes to %LOCALAPPDATA%\Programs\SF Desk, with SF Desk shortcuts in the Start menu and on the
# Desktop. Settings and data stay in %LOCALAPPDATA%\SF Desk, so updating keeps them.

param([Parameter(Mandatory = $true)][string]$From)
$ErrorActionPreference = 'Stop'

$dest = Join-Path $env:LOCALAPPDATA 'Programs\SF Desk'
function Say($text) { Write-Host "  $text" }
function Die($text) { Write-Host "`n$text`n" -ForegroundColor Red; exit 1 }

if (-not (Test-Path (Join-Path $From 'app\server.js'))) {
  Die 'Can''t find the app folder next to the installer. Unzip the whole download first, then run "Install SF Desk" from the unzipped folder.'
}
# SF-Desk-windows.zip is for Intel/AMD PCs and SF-Desk-windows-arm64.zip for ARM ones (e.g. Snapdragon).
# ARM PCs can run either; an Intel/AMD PC can't run the ARM one.
$version = ''
try { $version = & (Join-Path $From 'runtime\node.exe') -v 2>$null } catch {}
if (-not $version) {
  Die 'This download''s Node.js doesn''t run on this PC. Use SF-Desk-windows.zip on Intel or AMD PCs and SF-Desk-windows-arm64.zip on ARM PCs.'
}
Write-Host "`nInstalling SF Desk into $dest" -ForegroundColor Cyan

# 1. Stop a running SF Desk, whose files would otherwise be in use. Its launcher's end of the server's
#    input closes when it stops, and the server then exits too.
$running = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*SFDesk.ps1*' })
foreach ($p in $running) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dest, 'OrdinalIgnoreCase') } |
  Stop-Process -Force -ErrorAction SilentlyContinue
if ($running.Count) { Say 'Stopped the running SF Desk.'; Start-Sleep -Seconds 2 }

# 2. Copy the app and Node.js, replacing an earlier version.
New-Item -ItemType Directory -Force $dest | Out-Null
foreach ($name in 'app', 'runtime') {
  $target = Join-Path $dest $name
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Copy-Item -Recurse (Join-Path $From $name) $target
}
# Files from a browser download carry a "from the internet" mark that makes Windows warn about each one.
Get-ChildItem -Recurse -File $dest | Unblock-File
Say "Copied $((Get-Content (Join-Path $dest 'app\VERSION.txt') -ErrorAction SilentlyContinue) -join ' ')."

# 3. Shortcuts that start SF Desk (windows/SFDesk.ps1) without a console window.
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$launcher = Join-Path $dest 'app\windows\SFDesk.ps1'
$shell = New-Object -ComObject WScript.Shell
$links = @((Join-Path ([Environment]::GetFolderPath('Programs')) 'SF Desk.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'SF Desk.lnk'))
foreach ($path in $links) {
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = $powershell
  $link.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""
  $link.WorkingDirectory = $dest
  $link.IconLocation = (Join-Path $dest 'app\windows\SFDesk.ico') + ',0'
  $link.WindowStyle = 7 # minimized, so no console flashes up
  $link.Description = 'SF Desk: your Salesforce accounts, opportunities and time entry'
  $link.Save()
}
Say 'Added SF Desk to the Start menu and the Desktop.'

# 4. Time Entry reads meetings from classic Outlook. New Outlook has no COM API.
if (Test-Path 'Registry::HKEY_CLASSES_ROOT\Outlook.Application') {
  Say 'Found classic Outlook: Time Entry will read your calendar from it.'
} else {
  Write-Host '  Classic Outlook isn''t installed, so Time Entry can only show Salesforce events.' -ForegroundColor Yellow
  Say 'If you use the new Outlook, switch back to classic Outlook to see your Outlook calendar.'
}

Write-Host "`nDone. Starting SF Desk..." -ForegroundColor Cyan
Say 'The first time, it offers to download the Salesforce CLI and opens your browser to sign in.'
Say 'Look for the SF Desk icon in the notification area (by the clock) to reopen or quit it.'
Start-Process $links[0]
