<#
  Adds additional source IPv4 addresses to a network adapter so that every
  identity can use its own local bind IP (see NETWORKING.md).

  Run as Administrator:
    powershell -ExecutionPolicy Bypass -File scripts\windows\add-bind-ips.ps1 -Adapter "Ethernet" -Prefix "10.20.0" -From 101 -To 115 -PrefixLength 24

  "SkipAsSource" keeps Windows from using these addresses for its own traffic –
  only the suite uses them explicitly.
#>
param(
  [Parameter(Mandatory = $true)][string]$Adapter,
  [Parameter(Mandatory = $true)][string]$Prefix,
  [int]$From = 101,
  [int]$To = 115,
  [int]$PrefixLength = 24
)
$ErrorActionPreference = 'Stop'
for ($i = $From; $i -le $To; $i++) {
  $ip = "$Prefix.$i"
  if (Get-NetIPAddress -IPAddress $ip -ErrorAction SilentlyContinue) { Write-Host "$ip already present"; continue }
  New-NetIPAddress -InterfaceAlias $Adapter -IPAddress $ip -PrefixLength $PrefixLength -SkipAsSource $true | Out-Null
  Write-Host "added $ip (SkipAsSource)"
}
Get-NetIPAddress -InterfaceAlias $Adapter -AddressFamily IPv4 | Format-Table IPAddress, PrefixLength, SkipAsSource
