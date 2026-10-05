# Focus Guard installer for Windows. Run in PowerShell as Administrator:
#
#   irm https://raw.githubusercontent.com/ReidoBoss/focus-guard/main/install.ps1 | iex
#
# With options (-Yes: no questions, -Uninstall: remove):
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ReidoBoss/focus-guard/main/install.ps1))) -Uninstall
param([switch]$Uninstall, [switch]$Yes)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = "ReidoBoss/focus-guard"
$Dest = Join-Path $env:ProgramFiles "FocusGuard"
$Task = "FocusGuard"
$NotifierTask = "FocusGuardNotifier"
$StatsHost = "home"
$OldStatsHost = "dota-limiter-stats" # the address before 2026-10, removed on install
$Hosts = Join-Path $env:windir "System32\drivers\etc\hosts"

$AllBrowsers = @("brave", "chrome", "edge", "firefox")
$BrowserNames = @{ brave = "Brave"; chrome = "Google Chrome"; edge = "Microsoft Edge"; firefox = "Firefox" }
$PolicyKeys = @{
    brave   = "HKLM:\SOFTWARE\Policies\BraveSoftware\Brave"
    chrome  = "HKLM:\SOFTWARE\Policies\Google\Chrome"
    edge    = "HKLM:\SOFTWARE\Policies\Microsoft\Edge"
    firefox = "HKLM:\SOFTWARE\Policies\Mozilla\Firefox"
}
# Every policy browsers\policies.js can write, so a reinstall or uninstall clears them all.
$OurPolicies = @("URLBlocklist", "URLAllowlist", "DnsOverHttpsMode", "ForceGoogleSafeSearch", "ForceYouTubeRestrict", "ForceBingSafeSearch", "WebsiteFilter", "DNSOverHTTPS")
$BrowserExes = @{
    brave   = @("$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe", "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe", "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe")
    chrome  = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
    edge    = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
    firefox = @("$env:ProgramFiles\Mozilla Firefox\firefox.exe", "${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe")
}

function Say($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Bold($msg) { Write-Host $msg -ForegroundColor White }

# ---------------------------------------------------------------- prompts
# No questions with -Yes or in CI: every question takes its default.
$Interactive = (-not $Yes) -and ($env:FG_INTERACTIVE -or ((-not $env:CI) -and [Environment]::UserInteractive))

function Ask($question, $default) {
    if (-not $Interactive) { return $default }
    $prompt = $question
    if ("$default" -ne "") { $prompt = "$question [$default]" }
    if ([Console]::IsInputRedirected) {
        Write-Host -NoNewline "${prompt}: "
        $answer = [Console]::In.ReadLine()
        Write-Host $answer
    } else {
        $answer = Read-Host $prompt
    }
    if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
    return $answer.Trim()
}

function YesNo($question, $default) {
    while ($true) {
        $a = Ask "$question (y/n)" $default
        if ($a -match "^[Yy]") { return $true }
        if ($a -match "^[Nn]") { return $false }
        Write-Host "Please answer y or n."
    }
}

function Choose($question, $default, [string[]]$options) {
    if ($Interactive) {
        Write-Host ""
        Write-Host $question
        for ($i = 0; $i -lt $options.Count; $i++) { Write-Host "  $($i + 1)) $($options[$i])" }
    } else {
        return [int]$default
    }
    while ($true) {
        $a = Ask "Choose 1-$($options.Count)" $default
        $n = 0
        if ([int]::TryParse("$a", [ref]$n) -and $n -ge 1 -and $n -le $options.Count) { return $n }
        Write-Host "Please type a number from 1 to $($options.Count)."
    }
}

function Number($question, $default, $min, $max) {
    if (-not $Interactive) { return [int]$default }
    while ($true) {
        $a = Ask $question $default
        $n = 0
        if ([int]::TryParse("$a", [ref]$n) -and $n -ge $min -and $n -le $max) { return $n }
        Write-Host "Please type a whole number from $min to $max."
    }
}

# ---------------------------------------------------------------- basics
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run PowerShell as Administrator (right-click > Run as administrator), then paste the command again."
}

function Test-BrowserInstalled($b) {
    foreach ($p in $BrowserExes[$b]) { if ($p -and (Test-Path $p)) { return $true } }
    return $false
}

function Stop-FocusGuard {
    foreach ($t in @($Task, $NotifierTask)) {
        Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    }
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like "*FocusGuard*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Remove-HostsEntry {
    $lines = Get-Content $Hosts | Where-Object { $_ -notmatch " $StatsHost$" -and $_ -notmatch " $OldStatsHost$" }
    Set-Content -Path $Hosts -Value $lines -Encoding ASCII
}

function Set-UrlList($key, $values) {
    Remove-Item $key -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -Path $key -Force | Out-Null
    $i = 1
    foreach ($v in $values) {
        New-ItemProperty -Path $key -Name "$i" -Value $v -PropertyType String -Force | Out-Null
        $i++
    }
}

# Writes policies.js output: lists and nested objects become subkeys, the rest values.
function Set-Policy($key, $policy) {
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    foreach ($p in $policy.PSObject.Properties) {
        $v = $p.Value
        if ($v -is [array]) {
            Set-UrlList "$key\$($p.Name)" $v
        } elseif ($v.GetType().Name -eq "PSCustomObject") {
            Set-Policy "$key\$($p.Name)" $v
        } elseif ($v -is [bool] -or $v -is [int]) {
            New-ItemProperty -Path $key -Name $p.Name -Value ([int]$v) -PropertyType DWord -Force | Out-Null
        } else {
            New-ItemProperty -Path $key -Name $p.Name -Value "$v" -PropertyType String -Force | Out-Null
        }
    }
}

function Remove-BrowserPolicy($b) {
    $key = $PolicyKeys[$b]
    foreach ($name in $OurPolicies) {
        Remove-Item "$key\$name" -Recurse -Force -ErrorAction SilentlyContinue
        Remove-ItemProperty -Path $key -Name $name -Force -ErrorAction SilentlyContinue
    }
}

function Find-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

# ---------------------------------------------------------------- uninstall
if ($Uninstall) {
    if ($Interactive -and -not (YesNo "Remove the Dota limit and the website blocker from this computer?" "n")) {
        Write-Host "Nothing removed."
        return
    }
    Say "Removing Focus Guard"
    Stop-FocusGuard
    foreach ($t in @($Task, $NotifierTask)) {
        Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
    }
    foreach ($b in $AllBrowsers) { Remove-BrowserPolicy $b }
    $n = Find-Node
    $dnsScript = Join-Path $Dest "browsers\dns.js"
    if ($n -and (Test-Path $dnsScript)) {
        & $n $dnsScript off | Out-Null
        if ($LASTEXITCODE -ne 0) { Warn "Couldn't put your DNS settings back. Set them to automatic in your network settings." }
    }
    Remove-HostsEntry
    Remove-Item $Dest -Recurse -Force -ErrorAction SilentlyContinue
    Say "Done. Remove the Focus Guard extension from your browsers' extension pages yourself."
    return
}

# ---------------------------------------------------------------- source files
$Src = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "dota-limit\daemon.js"))) {
    $Src = $PSScriptRoot
} else {
    $tmp = Join-Path $env:TEMP ("focus-guard-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $zip = Join-Path $tmp "src.zip"
    Write-Host "Downloading Focus Guard..."
    try {
        Invoke-WebRequest "https://codeload.github.com/$Repo/zip/refs/heads/main" -OutFile $zip -UseBasicParsing -TimeoutSec 300
    } catch {
        throw "Couldn't download Focus Guard from GitHub. Check your internet connection and try again."
    }
    Expand-Archive $zip -DestinationPath $tmp
    $Src = Join-Path $tmp "focus-guard-main"
}

# ---------------------------------------------------------------- node.js
$Node = Find-Node
if (-not $Node) {
    Say "Installing Node.js (needed to run Focus Guard)"
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "Node.js is required. Install the LTS version from https://nodejs.org, then run this again."
    }
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements | Out-Null
    $Node = Find-Node
    if (-not $Node) { throw "Node.js install failed. Install it from https://nodejs.org, then run this again." }
}

# ---------------------------------------------------------------- questions
# Last install's answers become this run's defaults.
$Prev = $null
$choicesFile = Join-Path $Dest "choices.json"
if (Test-Path $choicesFile) { $Prev = Get-Content $choicesFile -Raw | ConvertFrom-Json }
function Prev($key, $default) {
    if ($Prev -and ($Prev.PSObject.Properties.Name -contains $key)) { return $Prev.$key }
    return $default
}

if ($Interactive) {
    Write-Host ""
    Bold "Focus Guard setup"
    Write-Host "Press Enter to take the answer in [brackets]."
    Write-Host ""
    Bold "1. Dota 2 daily limit"
    Write-Host "Counts your matches and closes Steam for the rest of the day once you're done."
}
$DotaEnabled = $false
$Mode = Prev "mode" "bo3"
$MaxGames = [int](Prev "maxGames" 3)
$WeekendMode = Prev "weekendMode" "same"
$WeekendMax = [int](Prev "weekendMaxGames" 7)
$ResetHour = [int](Prev "resetHour" 4)
$OpenDota = [bool](Prev "opendota" $true)
$Tilt = [bool](Prev "tiltCheck" $true)
$dotaDefault = "n"
if (Prev "dotaEnabled" $true) { $dotaDefault = "y" }
if (YesNo "Set up the Dota 2 limit?" $dotaDefault) {
    $DotaEnabled = $true
    $modeDefault = 1
    if ($Mode -eq "games") { $modeDefault = 2 }
    $pick = Choose "When should the day end?" $modeDefault @("Best of 3: stop at 2 wins or 2 losses", "After a fixed number of games")
    if ($pick -eq 2) {
        $Mode = "games"
        $MaxGames = Number "How many games per day?" $MaxGames 1 20
    } else {
        $Mode = "bo3"
    }
    $weekendDefault = "y"
    if ($WeekendMode -eq "same") { $weekendDefault = "n" }
    if (YesNo "Use a different limit on Saturday and Sunday?" $weekendDefault) {
        $weekendPick = 2
        if ($WeekendMode -eq "bo3") { $weekendPick = 1 }
        $pick = Choose "On Saturday and Sunday, when should the day end?" $weekendPick @("Best of 3: stop at 2 wins or 2 losses", "After a fixed number of games")
        if ($pick -eq 2) {
            $WeekendMode = "games"
            $WeekendMax = Number "How many games on Saturday and Sunday?" $WeekendMax 1 20
        } else {
            $WeekendMode = "bo3"
        }
    } else {
        $WeekendMode = "same"
    }
    $ResetHour = Number "What hour does a new day start? (0-23, so a 2 AM game counts toward the night before)" $ResetHour 0 23
    if ($Interactive) {
        Write-Host ""
        Write-Host "The stats page can show your teammates and enemies after each match: rank, most-played"
        Write-Host "heroes, smurfs, parties, streaks, and your record with and against them. This sends the"
        Write-Host "match ID to OpenDota (opendota.com, a free public Dota stats site)."
    }
    $odDefault = "n"
    if ($OpenDota) { $odDefault = "y" }
    $OpenDota = YesNo "Look up the other 9 players on OpenDota after each match?" $odDefault
    $tiltDefault = "n"
    if ($Tilt) { $tiltDefault = "y" }
    $Tilt = YesNo "After a loss, get a tilt check notification (what went wrong, and a nudge to take a break)?" $tiltDefault
}

if ($Interactive) {
    Write-Host ""
    Bold "2. Website blocker"
    Write-Host "Blocks Facebook, YouTube and Reddit, but keeps facebook.com/messages working."
    $status = ($AllBrowsers | ForEach-Object {
        if (Test-BrowserInstalled $_) { "$($BrowserNames[$_]) (installed)" } else { $BrowserNames[$_] }
    }) -join ", "
    Write-Host "Supported here: $status"
}
$prevBrowsers = Prev "browsers" $null
$browserDefault = 1
if ($null -ne $prevBrowsers -and $prevBrowsers -eq "") { $browserDefault = 3 } elseif ($prevBrowsers -and $prevBrowsers -ne ($AllBrowsers -join ",")) { $browserDefault = 2 }
$pick = Choose "Block these sites in:" $browserDefault @(
    "Every supported browser, including ones you install later (recommended)",
    "Only the browsers I pick",
    "None, skip the website blocker")
$Browsers = @()
if ($pick -eq 1) { $Browsers = $AllBrowsers }
if ($pick -eq 2) {
    foreach ($b in $AllBrowsers) {
        $def = "n"
        if ($prevBrowsers) {
            if (($prevBrowsers -split ",") -contains $b) { $def = "y" }
        } elseif (Test-BrowserInstalled $b) { $def = "y" }
        if (YesNo "  $($BrowserNames[$b])?" $def) { $Browsers += $b }
    }
}
$names = ($Browsers | ForEach-Object { $BrowserNames[$_] }) -join ", "
if (-not $names) { $names = "off" }

$PrevAdult = [bool](Prev "blockAdult" $false)
if ($Interactive) {
    Write-Host ""
    Bold "3. Adult websites"
    Write-Host "Blocks porn and other adult sites in every browser and app, by switching this computer's"
    Write-Host "DNS to Cloudflare's free family filter. Also turns on SafeSearch in Google, Bing and YouTube."
}
$adultDefault = "n"
if ($PrevAdult) { $adultDefault = "y" }
$BlockAdult = YesNo "Block adult websites?" $adultDefault
$Adult01 = "0"
if ($BlockAdult) { $Adult01 = "1" }

if ($Interactive) {
    Write-Host ""
    Bold "Summary"
    if ($DotaEnabled) {
        if ($Mode -eq "bo3") { Write-Host "  Dota 2 limit:     best of 3, new day at ${ResetHour}:00" } else { Write-Host "  Dota 2 limit:     $MaxGames games, new day at ${ResetHour}:00" }
        if ($WeekendMode -eq "bo3") { Write-Host "  Weekends:         best of 3" } elseif ($WeekendMode -eq "games") { Write-Host "  Weekends:         $WeekendMax games" } else { Write-Host "  Weekends:         same as weekdays" }
        if ($OpenDota) { Write-Host "  Player lookups:   on (OpenDota)" } else { Write-Host "  Player lookups:   off" }
        if ($Tilt) { Write-Host "  Tilt check:       on" } else { Write-Host "  Tilt check:       off" }
    } else {
        Write-Host "  Dota 2 limit:     off"
    }
    Write-Host "  Website blocker:  $names"
    if ($BlockAdult) { Write-Host "  Adult websites:   blocked" } else { Write-Host "  Adult websites:   not blocked" }
    Write-Host ""
    if (-not (YesNo "Install with these settings?" "y")) {
        Write-Host "Nothing changed."
        return
    }
}

$Choices = [ordered]@{
    dotaEnabled = $DotaEnabled
    mode        = $Mode
    maxGames    = $MaxGames
    weekendMode = $WeekendMode
    weekendMaxGames = $WeekendMax
    resetHour   = $ResetHour
    browsers    = ($Browsers -join ",")
    blockSafari = $false
    blockAdult  = $BlockAdult
    opendota    = $OpenDota
    tiltCheck   = $Tilt
}
$ChoicesJson = $Choices | ConvertTo-Json -Compress

# ---------------------------------------------------------------- files
Say "Installing to $Dest"
Stop-FocusGuard
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
foreach ($old in @("brave", "browsers\extension", "dota-limit\stats-url.txt")) {
    Remove-Item (Join-Path $Dest $old) -Recurse -Force -ErrorAction SilentlyContinue
}
Copy-Item (Join-Path $Src "dota-limit"), (Join-Path $Src "browsers") -Destination $Dest -Recurse -Force
Set-Content -Path $choicesFile -Value $ChoicesJson -Encoding ASCII
# Only administrators can change the limiter's files and settings.
icacls $Dest /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-545:(OI)(CI)RX" | Out-Null

# ---------------------------------------------------------------- dota 2
$Detected = "{}"
if ($DotaEnabled) {
    Say "Setting up Dota 2 match tracking"
    # Steam rewrites its settings when it quits, so it has to be closed before launch options change.
    $patch = $true
    if ((Get-Process -Name steam -ErrorAction SilentlyContinue) -and $Interactive) {
        $patch = YesNo "Steam is open and has to close so its launch options can be changed. Close it now?" "y"
    }
    if ($patch) {
        Stop-Process -Name steam, steamwebhelper, dota2 -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
        $env:FG_NO_LAUNCH_OPTIONS = ""
    } else {
        $env:FG_NO_LAUNCH_OPTIONS = "1"
    }
    $Detected = & $Node (Join-Path $Dest "dota-limit\setup.js") detect
    if ($LASTEXITCODE -ne 0) { throw "Dota setup failed." }
    $info = $Detected | ConvertFrom-Json
    if ($info.dotaDir) {
        Write-Host "Found Dota 2 at: $($info.dotaDir)"
        if ($info.launchOptionsPatched.Count -gt 0) { Write-Host "Added -gamestateintegration to Dota 2 launch options." }
        if (-not $patch) { Warn "Add -gamestateintegration to Dota 2 launch options in Steam yourself (Dota 2 > Properties)." }
    } else {
        Warn "Dota 2 wasn't found. Install it through Steam, then run this installer again."
    }
}
# Passed through the environment: PowerShell 5 mangles quotes in native arguments.
$env:FG_DETECTED = "$Detected"
$env:FG_CHOICES = $ChoicesJson
& $Node (Join-Path $Dest "dota-limit\setup.js") write-config (Join-Path $Dest "dota-limit\config.json") $env:USERNAME | Out-Null

# ---------------------------------------------------------------- adult websites
# Before the service starts, since the service re-applies the filter when it's on.
$dnsScript = Join-Path $Dest "browsers\dns.js"
if ($BlockAdult) {
    Say "Blocking adult websites"
    & $Node $dnsScript on | Out-Null
    if ($LASTEXITCODE -ne 0) { Warn "Couldn't change this computer's DNS settings, so adult sites are only hidden from Google, Bing and YouTube searches." }
} elseif ($PrevAdult) {
    Say "Unblocking adult websites"
    & $Node $dnsScript off | Out-Null
    if ($LASTEXITCODE -ne 0) { Warn "Couldn't put your DNS settings back. Set them to automatic in your network settings." }
}

# ---------------------------------------------------------------- service
Say "Starting the background service"
$daemon = Join-Path $Dest "dota-limit\daemon.js"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $Task -Force `
    -Action (New-ScheduledTaskAction -Execute $Node -Argument "`"$daemon`"" -WorkingDirectory (Join-Path $Dest "dota-limit")) `
    -Trigger (New-ScheduledTaskTrigger -AtStartup) `
    -Principal (New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest) `
    -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $Task

# Notifications: SYSTEM can't reach your desktop, so a tiny helper runs in your session.
$vbs = Join-Path $Dest "dota-limit\notifier.vbs"
Set-Content -Path $vbs -Encoding ASCII -Value @"
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """$Node"" """ & dir & "\notifier.js""", 0, False
"@
$me = "$env:USERDOMAIN\$env:USERNAME"
Register-ScheduledTask -TaskName $NotifierTask -Force `
    -Action (New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`"") `
    -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $me) `
    -Principal (New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive) `
    -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)) | Out-Null
try { Start-ScheduledTask -TaskName $NotifierTask } catch { Warn "Notifications start after your next sign-in." }

Remove-HostsEntry
Add-Content -Path $Hosts -Value "127.0.0.1 $StatsHost" -Encoding ASCII
ipconfig /flushdns | Out-Null

# ---------------------------------------------------------------- browsers
Say "Website blocker: $names"
$policiesScript = Join-Path $Dest "browsers\policies.js"
foreach ($b in $AllBrowsers) {
    Remove-BrowserPolicy $b
    $sites01 = "0"
    if ($Browsers -contains $b) { $sites01 = "1" }
    # Adult settings go to every browser, picked for the site list or not.
    if ($b -eq "firefox") {
        $policy = (& $Node $policiesScript firefox $sites01 $Adult01 | Out-String) | ConvertFrom-Json
    } else {
        $policy = (& $Node $policiesScript chromium $b $sites01 $Adult01 | Out-String) | ConvertFrom-Json
    }
    if (@($policy.PSObject.Properties).Count) { Set-Policy $PolicyKeys[$b] $policy }
}

# ---------------------------------------------------------------- check
$ok = $false
$StatsUrl = "http://$StatsHost/"
$urlFile = Join-Path $Dest "dota-limit\stats-url.txt"
for ($i = 0; $i -lt 20 -and -not $ok; $i++) {
    try {
        $StatsUrl = (Get-Content $urlFile -Raw).Trim()
        Invoke-WebRequest "$($StatsUrl)api" -UseBasicParsing -TimeoutSec 2 | Out-Null
        $ok = $true
    } catch { Start-Sleep -Seconds 1 }
}
if ($ok) { Say "Focus Guard is running" } else { Warn "The service didn't answer yet. Check $Dest\dota-limit\log.txt" }

Write-Host ""
Write-Host "  News:        $StatsUrl"
if ($DotaEnabled) { Write-Host "  Dota stats:  $($StatsUrl)dota" }
if ($Browsers | Where-Object { $_ -ne "firefox" }) {
    Write-Host @"

  One manual step per browser: browsers don't let installers add extensions.
  The extension stops Facebook's Home button from getting around the block.
    1. Open the extensions page (brave://extensions, chrome://extensions or edge://extensions)
    2. Turn on Developer mode
    3. Click "Load unpacked" and choose: $Dest\browsers\extension
"@
}
if ($Browsers -contains "firefox") {
    Write-Host @"

  Firefox: direct visits are blocked, but Firefox only runs extensions signed by Mozilla,
  so clicking Home inside facebook.com/messages can still reach the feed there.
"@
}
Write-Host ""
Write-Host "  Restart your browsers so they pick up the block list. Run this installer again any time to change settings."
Write-Host ""
