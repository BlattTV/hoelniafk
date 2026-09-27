<#
  Registers the Hoelni Client Suite as a scheduled task that starts at logon of
  the CURRENT user. DPAPI protects the vault key per Windows user, so the suite
  must run as the same user that created the vault (no SYSTEM service).

  Usage (PowerShell, in the repository root):
    powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1
  Remove:
    Unregister-ScheduledTask -TaskName "HoelniClientSuite" -Confirm:$false
#>
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$node = (Get-Command node).Source
if (-not (Test-Path "$root\dist\supervisor.js")) { throw "Build first: npm ci; npm run build" }
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$root\dist\supervisor.js`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'HoelniClientSuite' -Action $action -Trigger $trigger -Settings $settings -Description 'Hoelni Client Suite (supervised)' -Force | Out-Null
Write-Host "Scheduled task 'HoelniClientSuite' registered for $env:USERNAME. Start now with: Start-ScheduledTask -TaskName HoelniClientSuite"
