# Registers the agent-mesh worker as a Windows scheduled task that starts at logon
# and is restarted every 5 minutes if it is not running.
#   powershell -ExecutionPolicy Bypass -File worker\install-windows.ps1 -Config C:\path\worker.json
#   ... -Uninstall   removes it again.
param(
  [Parameter(Mandatory = $true)][string]$Config,
  [string]$Name = "agent-mesh worker",
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName "$Name keepalive" -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "Removed '$Name'."
  return
}
$cfg = (Resolve-Path $Config).Path
$worker = (Resolve-Path (Join-Path $PSScriptRoot "mesh-worker.mjs")).Path
$node = (Get-Command node -ErrorAction Stop).Source
$logDir = Join-Path $env:USERPROFILE (".agent-mesh\keepalive\" + ($Name -replace '[^A-Za-z0-9_-]', '_'))
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# The keepalive starts the worker hidden when no node process runs it with this config.
$keep = Join-Path $logDir "keepalive.ps1"
@"
`$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { `$_.CommandLine -like '*mesh-worker.mjs*' -and `$_.CommandLine -like '*$cfg*' }
if (-not `$running) {
  Start-Process -WindowStyle Hidden -FilePath '$node' -ArgumentList @('"$worker"', '--config', '"$cfg"') -RedirectStandardOutput '$logDir\worker.out.log' -RedirectStandardError '$logDir\worker.err.log'
  Add-Content '$logDir\keepalive.log' "`$(Get-Date -Format o) worker was not running; started it"
}
"@ | Set-Content -Encoding UTF8 $keep

# Every 5 minutes, as the current user, only while logged on: needs no admin rights
# (a logon trigger would). After a reboot it starts within 5 minutes of logging on.
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$keep`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "$Name keepalive" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "$Name keepalive"
Write-Output "Installed '$Name keepalive' (every 5 min while you are logged on). Logs: $logDir"
