# SF Desk calendar helper for Windows: reads classic Outlook's calendars through its COM API and
# prints JSON in the same shape as the Mac's EventKit helper (mac/calendar.swift).
#   outlook-calendar.ps1 calendars
#   outlook-calendar.ps1 events <fromISO> <toISO> <calendarId>[,<calendarId>...]
# Needs classic Outlook (new Outlook has no COM API). Outlook starts if it isn't running.
# Written for Windows PowerShell 5.1, which every Windows 10 and 11 has.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$inv = [Globalization.CultureInfo]::InvariantCulture

function Out-Json($value) {
  [Console]::Out.Write((ConvertTo-Json -InputObject $value -Depth 5 -Compress))
}
function Fail($code, $message) {
  Out-Json @{ error = $code; message = $message }
  exit 1
}

try {
  $outlook = New-Object -ComObject Outlook.Application
  $ns = $outlook.GetNamespace('MAPI')
} catch {
  $hr = $_.Exception.HResult
  if ($hr -eq -2147221164) { # REGDB_E_CLASSNOTREG
    Fail 'nooutlook' ('SF Desk reads your calendar from classic Outlook, which isn''t installed here. ' +
      'If you use the new Outlook, switch back to classic Outlook (the "New Outlook" toggle at the top right), or pick Salesforce events.')
  }
  if ($hr -eq -2146959355) { # CO_E_SERVER_EXEC_FAILURE: Outlook runs as administrator and SF Desk doesn't, or the reverse
    Fail 'elevation' 'Outlook and SF Desk are running with different permissions (one as administrator). Start both normally, then reload.'
  }
  Fail 'outlook' ("Couldn't open Outlook: " + $_.Exception.Message)
}

# olExchangeStoreType: 0 primary mailbox, 1 delegate mailbox, 2 public folders, 3 not Exchange, 4 additional mailbox.
function Store-Type($store) {
  try { $t = $store.ExchangeStoreType } catch { return 'other' }
  if ($t -eq 0 -or $t -eq 1 -or $t -eq 4) { return 'exchange' }
  if ($t -eq 2) { return 'subscribed' }
  return 'local'
}

# Each mailbox's or data file's main calendar, and calendars filed under it.
function Calendar-Folders {
  $seen = @{}
  foreach ($store in $ns.Stores) {
    try { $root = $store.GetDefaultFolder(9) } catch { continue } # olFolderCalendar
    $type = Store-Type $store
    $folders = New-Object System.Collections.ArrayList
    [void]$folders.Add($root)
    try {
      foreach ($sub in $root.Folders) { if ($sub.DefaultItemType -eq 1) { [void]$folders.Add($sub) } } # olAppointmentItem
    } catch {}
    foreach ($f in $folders) {
      if ($seen.ContainsKey($f.EntryID)) { continue }
      $seen[$f.EntryID] = $true
      [pscustomobject]@{ folder = $f; id = $f.EntryID; title = [string]$f.Name; account = [string]$store.DisplayName; type = $type }
    }
  }
}

if ($args.Count -lt 1) { Fail 'usage' 'usage: outlook-calendar.ps1 calendars | events <from> <to> <ids>' }

if ($args[0] -eq 'calendars') {
  $list = @(Calendar-Folders | ForEach-Object { @{ id = $_.id; title = $_.title; account = $_.account; type = $_.type; writable = $true } })
  Out-Json $list
  exit 0
}

if ($args[0] -ne 'events' -or $args.Count -lt 4) { Fail 'usage' 'usage: outlook-calendar.ps1 events <fromISO> <toISO> <calendarIds>' }
try {
  $fromUtc = [DateTimeOffset]::Parse($args[1], $inv).UtcDateTime
  $toUtc = [DateTimeOffset]::Parse($args[2], $inv).UtcDateTime
} catch { Fail 'usage' 'from and to must be ISO dates' }
$ids = @($args[3] -split ',' | Where-Object { $_ })

# The SMTP address of a recipient. Exchange colleagues come back as X.500 addresses, so ask Exchange.
$PR_SMTP = 'http://schemas.microsoft.com/mapi/proptag/0x39FE001E'
function Smtp($r) {
  try { $a = [string]$r.Address } catch { $a = '' }
  if ($a -like '*@*') { return $a }
  try { $s = [string]$r.PropertyAccessor.GetProperty($PR_SMTP); if ($s) { return $s } } catch {}
  try { $u = $r.AddressEntry.GetExchangeUser(); if ($u) { return [string]$u.PrimarySmtpAddress } } catch {}
  return ''
}

$me = ''
try { $me = [string]$ns.CurrentUser.AddressEntry.GetExchangeUser().PrimarySmtpAddress } catch {}
if (-not $me) { try { $me = Smtp $ns.CurrentUser } catch {} }

$iso = 'yyyy-MM-dd''T''HH:mm:ss''Z'''
$errors = New-Object System.Collections.ArrayList
function Note-Error($err) { if ($errors.Count -lt 3) { [void]$errors.Add($err.Exception.Message.Trim()) } }
$inRange = { param($i) $i.Class -eq 26 -and $i.StartUTC -lt $toUtc -and $i.EndUTC -gt $fromUtc } # olAppointment

# The folder's appointments (one per occurrence of a repeating one) in the range.
# Outlook's Restrict takes dates as text and parses them by the PC's regional format, which goes wrong on
# some PCs, so try this PC's short format, then an ISO-like one. Pad a day on each side, since these drop
# seconds and all-day events sit at local midnight, then filter exactly. If neither finds anything, walk
# the whole calendar instead, expanding repeating meetings ourselves: slower, but needs no date text.
function Find-Items($folder) {
  $found = New-Object System.Collections.ArrayList
  $from = $fromUtc.AddDays(-1).ToLocalTime(); $to = $toUtc.AddDays(1).ToLocalTime()
  foreach ($f in @($from.ToString('g', [Globalization.CultureInfo]::CurrentCulture), $to.ToString('g', [Globalization.CultureInfo]::CurrentCulture)),
                 @($from.ToString('yyyy-MM-dd HH:mm', $inv), $to.ToString('yyyy-MM-dd HH:mm', $inv))) {
    try {
      $items = $folder.Items
      $items.Sort('[Start]')
      $items.IncludeRecurrences = $true # one item per occurrence; Count is meaningless after this, so walk with GetNext
      $hits = $items.Restrict("[Start] < '" + $f[1] + "' AND [End] > '" + $f[0] + "'")
      $item = $hits.GetFirst()
      while ($null -ne $item) {
        if (& $inRange $item) { [void]$found.Add($item) }
        $item = $hits.GetNext()
      }
    } catch { Note-Error $_ }
    if ($found.Count) { return $found }
  }

  $days = [Math]::Ceiling(($toUtc - $fromUtc).TotalDays) + 1
  foreach ($item in $folder.Items) {
    try {
      if ($item.Class -ne 26) { continue }
      if (-not $item.IsRecurring) { if (& $inRange $item) { [void]$found.Add($item) }; continue }
      $pattern = $item.GetRecurrencePattern()
      if ($pattern.PatternStartDate -gt $to -or ($pattern.PatternEndDate -lt $from.Date)) { continue }
      $time = $item.Start.TimeOfDay
      for ($d = 0; $d -le $days; $d++) {
        try {
          $occurrence = $pattern.GetOccurrence($from.Date.AddDays($d) + $time)
          if (& $inRange $occurrence) { [void]$found.Add($occurrence) }
        } catch {} # no occurrence that day
      }
      # Occurrences moved to another time aren't found by their usual start; the exceptions list them.
      foreach ($x in $pattern.Exceptions) {
        try { if (-not $x.Deleted -and (& $inRange $x.AppointmentItem)) { [void]$found.Add($x.AppointmentItem) } } catch {}
      }
    } catch { Note-Error $_ }
  }
  # A moved occurrence can be found both ways; keep one per start.
  $seen = @{}
  return @($found | Where-Object { $k = [string]$_.GlobalAppointmentID + '|' + $_.StartUTC.Ticks; if ($seen[$k]) { $false } else { $seen[$k] = $true; $true } })
}

$out = New-Object System.Collections.ArrayList
foreach ($c in @(Calendar-Folders | Where-Object { $ids -contains $_.id })) {
  foreach ($item in @(Find-Items $c.folder)) {
    $startUtc = $item.StartUTC; $endUtc = $item.EndUTC
    $attendees = New-Object System.Collections.ArrayList
    $n = 0
    foreach ($r in $item.Recipients) {
      if ($r.Type -eq 3) { continue } # olResource: rooms and equipment
      if (++$n -gt 60) { break }      # enough to find the customer's domain; big invites get slow
      $email = Smtp $r
      [void]$attendees.Add(@{ name = [string]$r.Name; email = $email; me = [bool]($me -and $email -eq $me) })
    }
    $notes = [string]$item.Body
    if ($notes.Length -gt 20000) { $notes = $notes.Substring(0, 20000) }
    $uid = [string]$item.GlobalAppointmentID
    if (-not $uid) { $uid = [string]$item.EntryID }
    [void]$out.Add(@{
      # Occurrences of a repeating meeting share an ID; the server adds the start to tell them apart.
      uid = $uid
      title = [string]$item.Subject
      start = $startUtc.ToString($iso, $inv)
      end = $endUtc.ToString($iso, $inv)
      date = $item.Start.ToString('yyyy-MM-dd', $inv)
      allDay = [bool]$item.AllDayEvent
      location = [string]$item.Location
      notes = $notes
      calendar = $c.title
      calendarId = $c.id
      organizer = [string]$item.Organizer
      attendees = $attendees.ToArray()
      canceled = ($item.MeetingStatus -eq 5 -or $item.MeetingStatus -eq 7) # olMeetingCanceled, olMeetingReceivedAndCanceled
      free = ($item.BusyStatus -eq 0) # olFree
    })
  }
}
if ($out.Count) { Out-Json $out.ToArray(); exit 0 }

# Nothing found: say what Outlook shows, so an empty week can be told apart from the wrong calendar,
# an empty Outlook profile or the new Outlook. The server shows this under the calendar.
$facts = New-Object System.Collections.ArrayList
try { [void]$facts.Add("Outlook $($outlook.Version), profile '$($ns.CurrentProfileName)'") } catch {}
try {
  $new = Get-ItemProperty 'HKCU:\Software\Microsoft\Office\16.0\Outlook\Preferences' -Name UseNewOutlook -ErrorAction Stop
  if ($new.UseNewOutlook -eq 1) { [void]$facts.Add('the new Outlook is switched on, so classic Outlook may not be syncing your mailbox: pick "Sign in to read your Microsoft 365 calendar" in the calendar list instead') }
} catch {}
$picked = @(Calendar-Folders | Where-Object { $ids -contains $_.id })
if (-not $picked.Count) { [void]$facts.Add('that calendar is no longer in Outlook') }
foreach ($c in $picked) {
  try {
    $items = $c.folder.Items
    $text = "$($c.title) in $($c.account) has $($items.Count) items"
    if ($items.Count) {
      $items.Sort('[Start]', $true)
      $last = $items.GetFirst()
      if ($last) { $text += ", the latest starting $($last.Start.ToString('yyyy-MM-dd', $inv))" }
    }
    [void]$facts.Add($text)
  } catch { Note-Error $_ }
}
if ($errors.Count) { [void]$facts.Add('errors: ' + ($errors -join '; ')) }
Out-Json @{ events = @(); diag = ($facts -join '; ').TrimEnd('.') + '.' }
