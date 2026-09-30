# Focus Guard installer for Windows. Run in PowerShell as Administrator:
#
#   irm https://raw.githubusercontent.com/ReidoBoss/focus-guard/main/install.ps1 | iex
#
# Uninstall:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ReidoBoss/focus-guard/main/install.ps1))) -Uninstall
param([switch]$Uninstall)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = "ReidoBoss/focus-guard"
$Dest = Join-Path $env:ProgramFiles "FocusGuard"
$Task = "FocusGuard"
$NotifierTask = "FocusGuardNotifier"
$StatsHost = "dota-limiter-stats"
$Hosts = Join-Path $env:windir "System32\drivers\etc\hosts"
$BravePolicy = "HKLM:\SOFTWARE\Policies\BraveSoftware\Brave"

function Say($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run PowerShell as Administrator (right-click > Run as administrator), then paste the command again."
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
    $lines = Get-Content $Hosts | Where-Object { $_ -notmatch " $StatsHost$" }
    Set-Content -Path $Hosts -Value $lines -Encoding ASCII
}

if ($Uninstall) {
    Say "Removing Focus Guard"
    Stop-FocusGuard
    foreach ($t in @($Task, $NotifierTask)) {
        Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
    }
    Remove-Item "$BravePolicy\URLBlocklist", "$BravePolicy\URLAllowlist" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-HostsEntry
    Remove-Item $Dest -Recurse -Force -ErrorAction SilentlyContinue
    Say "Done. Remove the Focus Guard extension from brave://extensions yourself."
    return
}

# ---------------------------------------------------------------- source files
$Src = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "dota-limit\daemon.js"))) {
    $Src = $PSScriptRoot
} else {
    Say "Downloading Focus Guard"
    $tmp = Join-Path $env:TEMP ("focus-guard-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $zip = Join-Path $tmp "src.zip"
    Invoke-WebRequest "https://codeload.github.com/$Repo/zip/refs/heads/main" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath $tmp
    $Src = Join-Path $tmp "focus-guard-main"
}

# ---------------------------------------------------------------- node.js
function Find-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) {
        if (Test-Path $p) { return $p }
    }
    return $null
}
$Node = Find-Node
if (-not $Node) {
    Say "Installing Node.js"
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "Node.js is required. Install the LTS version from https://nodejs.org, then run this again."
    }
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements | Out-Null
    $Node = Find-Node
    if (-not $Node) { throw "Node.js install failed. Install it from https://nodejs.org, then run this again." }
}
Write-Host "Using Node.js $(& $Node -v) at $Node"

# ---------------------------------------------------------------- files
Say "Installing to $Dest"
Stop-FocusGuard
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
Copy-Item (Join-Path $Src "dota-limit"), (Join-Path $Src "brave") -Destination $Dest -Recurse -Force
# Only administrators can change the limiter's files and settings.
icacls $Dest /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-545:(OI)(CI)RX" | Out-Null

# ---------------------------------------------------------------- dota 2
Say "Setting up Dota 2 match tracking"
# Steam rewrites its config on exit, so it has to be closed before launch options are changed.
Stop-Process -Name steam, steamwebhelper, dota2 -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
$Detected = & $Node (Join-Path $Dest "dota-limit\setup.js") detect
if ($LASTEXITCODE -ne 0) { throw "Dota setup failed." }
# Passed through the environment: PowerShell 5 mangles quotes in native arguments.
$env:FG_DETECTED = $Detected
& $Node (Join-Path $Dest "dota-limit\setup.js") write-config (Join-Path $Dest "dota-limit\config.json") $env:USERNAME | Out-Null
$info = $Detected | ConvertFrom-Json
if ($info.dotaDir) {
    Write-Host "Found Dota 2 at: $($info.dotaDir)"
    if ($info.launchOptionsPatched.Count -gt 0) { Write-Host "Added -gamestateintegration to Dota 2 launch options." }
} else {
    Warn "Dota 2 wasn't found. Install it through Steam, then run this installer again."
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

if (-not (Select-String -Path $Hosts -Pattern " $StatsHost$" -Quiet)) {
    Add-Content -Path $Hosts -Value "`r`n127.0.0.1 $StatsHost" -Encoding ASCII
}
ipconfig /flushdns | Out-Null

# ---------------------------------------------------------------- brave
Say "Blocking Facebook, YouTube and Reddit in Brave"
$policy = Get-Content (Join-Path $Dest "brave\policy.json") -Raw | ConvertFrom-Json
foreach ($name in @("URLBlocklist", "URLAllowlist")) {
    $key = "$BravePolicy\$name"
    Remove-Item $key -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -Path $key -Force | Out-Null
    $i = 1
    foreach ($url in $policy.$name) {
        New-ItemProperty -Path $key -Name "$i" -Value $url -PropertyType String -Force | Out-Null
        $i++
    }
}

# ---------------------------------------------------------------- check
$ok = $false
for ($i = 0; $i -lt 20 -and -not $ok; $i++) {
    try {
        Invoke-WebRequest "http://$StatsHost/api" -UseBasicParsing -TimeoutSec 2 | Out-Null
        $ok = $true
    } catch { Start-Sleep -Seconds 1 }
}
if ($ok) { Say "Focus Guard is running" } else { Warn "The service didn't answer yet. Check $Dest\dota-limit\log.txt" }

Write-Host @"

  Stats page:  http://$StatsHost
  Daily limit: best of 3 (resets at 4 AM). Change it in $Dest\dota-limit\config.json

  One last manual step: Brave doesn't let installers add extensions.
    1. Open brave://extensions and turn on Developer mode
    2. Click "Load unpacked" and choose: $Dest\brave\extension
    3. Fully quit Brave and open it again

"@
