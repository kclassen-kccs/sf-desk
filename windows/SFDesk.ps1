# SF Desk for Windows, the counterpart of the Mac app (mac/app/SFDesk.swift). It starts the SF Desk
# server with the bundled Node.js, opens it in its own window (Microsoft Edge in app mode) and keeps an
# SF Desk icon in the notification area to reopen the window, reach settings and the log, or quit.
# Closing the window keeps the server running, so the Outlook add-in keeps working; Quit stops it.
# The installer's shortcuts run this with Windows PowerShell (windows/install.ps1).
#
# The app lives in %LOCALAPPDATA%\Programs\SF Desk (app\ and runtime\); settings and data in
# %LOCALAPPDATA%\SF Desk: .env, data\, certs\, logs\server.log, sf-cli\ if this downloaded the CLI, and
# edge\ for the window's browser profile.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is very slow when it draws progress

$appDir = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $env:LOCALAPPDATA 'SF Desk'
$envFile = Join-Path $dataDir '.env'
$logDir = Join-Path $dataDir 'logs'
$logFile = Join-Path $logDir 'server.log'
$icon = Join-Path $PSScriptRoot 'SFDesk.ico'
$sfInstance = 'https://sailpoint.my.salesforce.com'
$sfAlias = 'sailpoint'
$sfTarball = 'https://developer.salesforce.com/media/salesforce-cli/sf/channels/stable/sf-win32-x64.tar.gz'
$env:SF_AUTOUPDATE_DISABLE = 'true'

# The build (from VERSION.txt, written by scripts/build-windows-package.sh), shown on errors.
$build = ''
try { $build = ([IO.File]::ReadAllText((Join-Path $appDir 'VERSION.txt'))).Trim() } catch {}
function Show-Error($message) {
  if ($build) { $message += "`n`n($build)" }
  [void][Windows.Forms.MessageBox]::Show($message, 'SF Desk', 'OK', 'Error')
}
function Ask($title, $message) {
  return [Windows.Forms.MessageBox]::Show($message, $title, 'YesNo', 'Question') -eq 'Yes'
}

# ---------- settings ----------

# .env is yours to edit (Edit Settings...); the launcher never writes it, since some PCs refuse writes to
# it (security tools guarding ".env" files, or attributes it picked up). What the launcher works out
# itself (where sf is, which org alias) goes in launcher.json, and reaches the server as environment
# variables unless .env sets them.
$stateFile = Join-Path $dataDir 'launcher.json'

function Read-Env {
  $vars = @{}
  try {
    if (Test-Path -LiteralPath $envFile) {
      foreach ($line in [IO.File]::ReadAllLines($envFile)) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { $vars[$Matches[1]] = $Matches[2].Trim().Trim('"') }
      }
    }
  } catch {}
  return $vars
}
function Read-State {
  $state = @{}
  try {
    if (Test-Path -LiteralPath $stateFile) {
      $json = [IO.File]::ReadAllText($stateFile) | ConvertFrom-Json
      foreach ($p in $json.PSObject.Properties) { $state[$p.Name] = [string]$p.Value }
    }
  } catch {}
  return $state
}
# A setting from .env if it has a value there, else from launcher.json.
function Get-Setting($key) {
  $v = (Read-Env)[$key]
  if ($v) { return $v }
  return (Read-State)[$key]
}
function Save-Setting($key, $value) {
  $state = Read-State
  $state[$key] = $value
  try {
    [IO.File]::WriteAllText($stateFile, (ConvertTo-Json -InputObject $state), (New-Object System.Text.UTF8Encoding $false))
  } catch {
    Write-Warning "Couldn't save $key to ${stateFile}: $($_.Exception.Message)"
  }
}

# ---------- the server ----------

function Get-Url {
  $port = (Read-Env)['PORT']
  if (-not ($port -match '^\d+$')) { $port = '3000' }
  return "http://localhost:$port"
}

function Test-Answers($url) {
  try {
    $req = [Net.HttpWebRequest]::Create($url)
    $req.Proxy = $null
    $req.Timeout = 2000
    $req.GetResponse().Close()
    return $true
  } catch [Net.WebException] {
    return $null -ne $_.Exception.Response # any HTTP answer means it's up
  } catch {
    return $false
  }
}

function Find-Node {
  $bundled = Join-Path (Split-Path -Parent $appDir) 'runtime\node.exe'
  if (Test-Path $bundled) { return $bundled }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$script:server = $null
$script:quitting = $false

function Start-Server {
  $node = Find-Node
  if (-not $node) { throw 'SF Desk can''t find Node.js. Run the SF Desk installer again.' }
  New-Item -ItemType Directory -Force $logDir | Out-Null
  [IO.File]::WriteAllText($logFile, '')
  $psi = New-Object Diagnostics.ProcessStartInfo
  # cmd.exe only to send the server's output to the log. Our end of its input pipe closes when this
  # launcher quits or dies, and the server then exits (SF_DESK_APP).
  $psi.FileName = $env:ComSpec
  $psi.Arguments = '/d /s /c ""' + $node + '" "' + (Join-Path $appDir 'server.js') + '" >> "' + $logFile + '" 2>&1"'
  $psi.WorkingDirectory = $dataDir # the server reads .env from its working folder
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.EnvironmentVariables['SF_DESK_APP'] = '1'
  $psi.EnvironmentVariables['SF_DESK_DB'] = Join-Path $dataDir 'data\sf-desk.db'
  $psi.EnvironmentVariables['SF_DESK_CERTS'] = Join-Path $dataDir 'certs'
  foreach ($key in 'SF_CLI_PATH', 'SF_TARGET_ORG') {
    $value = Get-Setting $key
    if ($value) { $psi.EnvironmentVariables[$key] = $value }
  }
  $script:server = [Diagnostics.Process]::Start($psi)

  $url = Get-Url
  for ($i = 0; $i -lt 120; $i++) {
    if ($script:server.HasExited) { throw "The SF Desk server stopped while starting.`n`n$(Get-LogTail)" }
    if (Test-Answers $url) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "The SF Desk server didn't answer at $url.`n`n$(Get-LogTail)"
}

function Stop-Server {
  $p = $script:server
  $script:server = $null
  if (-not $p -or $p.HasExited) { return }
  try { $p.StandardInput.Close() } catch {}
  if (-not $p.WaitForExit(5000)) {
    # The server didn't take the hint: stop it and its cmd.exe.
    try { & taskkill.exe /pid $p.Id /t /f 2>&1 | Out-Null } catch {}
  }
}

function Get-LogTail {
  if (-not (Test-Path $logFile)) { return '' }
  return ((Get-Content $logFile -Tail 15) -join "`n")
}

# ---------- Salesforce CLI ----------

function Find-Sf {
  $configured = Get-Setting 'SF_CLI_PATH'
  if ($configured -and (Test-Path $configured)) { return $configured }
  $cmd = Get-Command sf.cmd -ErrorAction SilentlyContinue
  $candidates = @(
    $(if ($cmd) { $cmd.Source }),
    (Join-Path $env:ProgramFiles 'sf\bin\sf.cmd'),
    (Join-Path $env:LOCALAPPDATA 'sf\bin\sf.cmd'),
    (Join-Path $dataDir 'sf-cli\bin\sf.cmd'))
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

# Salesforce's own build of the CLI, into the data folder: no admin rights, no npm.
function Get-Sf {
  Show-Status 'Downloading the Salesforce CLI from Salesforce...'
  $tmp = Join-Path $env:TEMP ('sfdesk-sf-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Force (Join-Path $tmp 'sf') | Out-Null
  try {
    $tarball = Join-Path $tmp 'sf.tar.gz'
    Invoke-WebRequest -UseBasicParsing -Uri $sfTarball -OutFile $tarball -ErrorAction Stop
    Show-Status 'Unpacking the Salesforce CLI...'
    & (Join-Path $env:SystemRoot 'System32\tar.exe') -xzf $tarball -C (Join-Path $tmp 'sf') --strip-components 1
    if ($LASTEXITCODE -ne 0) { throw "tar exited with code $LASTEXITCODE" }
    $dest = Join-Path $dataDir 'sf-cli'
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Move-Item (Join-Path $tmp 'sf') $dest -ErrorAction Stop
    return (Join-Path $dest 'bin\sf.cmd')
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

function Connect-Salesforce($target) {
  # sf writes notices to stderr, which Windows PowerShell turns into errors that 'Stop' would throw on.
  $ErrorActionPreference = 'Continue'
  $sf = Find-Sf
  if (-not $sf) {
    if (-not (Ask 'SF Desk needs the Salesforce CLI' 'SF Desk signs in to Salesforce with it. Download Salesforce''s own copy now? No admin rights are needed.')) {
      throw 'SF Desk needs the Salesforce CLI. Install it from https://developer.salesforce.com/tools/salesforcecli, then open SF Desk again.'
    }
    try { $sf = Get-Sf } catch {
      Start-Process 'https://developer.salesforce.com/tools/salesforcecli'
      throw "Couldn't download the Salesforce CLI ($($_.Exception.Message)). Install it with the Windows installer on the page that just opened, then open SF Desk again."
    }
  }
  if ((Get-Setting 'SF_CLI_PATH') -ne $sf) { Save-Setting 'SF_CLI_PATH' $sf }

  Show-Status 'Checking your Salesforce login...'
  $targetArgs = @(); if ($target) { $targetArgs = @('--target-org', $target) }
  $shown = (& $sf org display --json @targetArgs 2>$null) -join "`n"
  if ($shown -match '"status":\s*0') { return }

  if (-not (Ask 'Sign in to Salesforce' 'Your browser will open the Salesforce login. Sign in with SSO as usual, then come back to SF Desk.')) { return }
  Show-Status 'Waiting for you to sign in to Salesforce in your browser...'
  $alias = $target; if (-not $alias) { $alias = $sfAlias }
  $login = (& $sf org login web --instance-url $sfInstance --alias $alias 2>&1) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw "Salesforce sign-in didn't finish. Quit SF Desk and open it again to retry.`n`n$login" }
  if (-not $target) { Save-Setting 'SF_TARGET_ORG' $alias }
}

# ---------- the window and the tray icon ----------

function Find-Edge {
  foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
    if (-not $base) { continue }
    $exe = Join-Path $base 'Microsoft\Edge\Application\msedge.exe'
    if (Test-Path $exe) { return $exe }
  }
  return $null
}

# SF Desk in its own window: Edge in app mode with its own profile, so it has no tabs or address bar
# and keeps its own sign-in cookies. Without Edge, the default browser.
function Open-Window {
  $url = Get-Url
  $edge = Find-Edge
  if ($edge) {
    Start-Process $edge -ArgumentList @("--app=$url", ('--user-data-dir="' + (Join-Path $dataDir 'edge') + '"'), '--no-first-run', '--no-default-browser-check')
  } else {
    Start-Process $url
  }
}

$script:tray = $null
function Show-Status($text) {
  if (-not $script:tray) { return }
  $script:tray.Text = ('SF Desk: ' + $text).Substring(0, [Math]::Min(63, ('SF Desk: ' + $text).Length))
  $script:tray.ShowBalloonTip(3000, 'SF Desk', $text, 'Info')
}

function Quit-App {
  $script:quitting = $true
  Stop-Server
  if ($script:tray) { $script:tray.Visible = $false; $script:tray.Dispose() }
  [Windows.Forms.Application]::Exit()
}

function Restart-Server {
  $script:quitting = $true
  Stop-Server
  $script:quitting = $false
  try {
    Show-Status 'Restarting the server...'
    Start-Server
    Show-Status 'SF Desk is running.'
  } catch {
    Show-Error $_.Exception.Message
  }
}

# ---------- start ----------

# One launcher at a time. A second one (e.g. the shortcut clicked again) just opens another window.
$created = $false
$mutex = New-Object Threading.Mutex($true, 'Local\SFDeskLauncher', [ref]$created)
if (-not $created) {
  if (Test-Answers (Get-Url)) { Open-Window }
  exit 0
}

try {
  New-Item -ItemType Directory -Force (Join-Path $dataDir 'data') | Out-Null
  # A commented .env to edit, if there isn't one yet. Optional: the server runs without it.
  if (-not (Test-Path -LiteralPath $envFile)) {
    try { [IO.File]::WriteAllText($envFile, [IO.File]::ReadAllText((Join-Path $appDir '.env.example'))) } catch {}
  }
  if (-not (Get-Setting 'SF_TARGET_ORG')) { Save-Setting 'SF_TARGET_ORG' $sfAlias }

  $script:tray = New-Object Windows.Forms.NotifyIcon
  $script:tray.Icon = New-Object Drawing.Icon $icon
  $script:tray.Text = 'SF Desk'
  $script:tray.Visible = $true

  $url = Get-Url
  $ownServer = -not (Test-Answers $url) # else already running (a checkout's "npm start", say): just show it
  if ($ownServer) {
    $vars = Read-Env
    if (-not $vars['SF_CLIENT_ID']) { Connect-Salesforce (Get-Setting 'SF_TARGET_ORG') }
    Show-Status 'Starting SF Desk...'
    Start-Server
  }
  $script:tray.Text = 'SF Desk'
} catch {
  if ($script:tray) { $script:tray.Visible = $false }
  Stop-Server
  Show-Error $_.Exception.Message
  exit 1
}

$menu = New-Object Windows.Forms.ContextMenuStrip
function Add-MenuItem($text, [scriptblock]$action) {
  $item = New-Object Windows.Forms.ToolStripMenuItem $text
  $item.add_Click($action)
  [void]$menu.Items.Add($item)
}
Add-MenuItem 'Open SF Desk' { Open-Window }
[void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
Add-MenuItem 'Edit Settings...' { Start-Process notepad.exe -ArgumentList ('"' + $envFile + '"') }
Add-MenuItem 'Restart Server' { Restart-Server }
Add-MenuItem 'Show Server Log' { Start-Process notepad.exe -ArgumentList ('"' + $logFile + '"') }
Add-MenuItem 'Show Data Folder' { Start-Process explorer.exe -ArgumentList ('"' + $dataDir + '"') }
[void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
Add-MenuItem 'Quit SF Desk' { Quit-App }
$script:tray.ContextMenuStrip = $menu
$script:tray.add_MouseClick({ param($s, $e) if ($e.Button -eq 'Left') { Open-Window } })

# Say so if the server stops by itself, and offer to start it again.
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  $p = $script:server
  if ($script:quitting -or -not $p -or -not $p.HasExited) { return }
  $script:server = $null
  if (Ask 'SF Desk' "The SF Desk server stopped (exit code $($p.ExitCode)). Start it again?`n`n$(Get-LogTail)") { Restart-Server }
})
if ($ownServer) { $timer.Start() }

Open-Window
[Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
