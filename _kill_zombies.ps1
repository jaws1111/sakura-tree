# Kill listeners on sakura project ports + orphan vite/playwright node under this repo.
param(
  [int[]]$Ports = @(5173, 4173, 5188),
  [switch]$Quiet,
  [switch]$StatusOnly
)

$ErrorActionPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$killed = New-Object System.Collections.ArrayList
$seen = @{}

function Kill-Pid([int]$ProcessId, [string]$Why) {
  if ($ProcessId -le 0) { return }
  if ($seen.ContainsKey($ProcessId)) { return }
  $seen[$ProcessId] = $true
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  $name = if ($proc) { $proc.ProcessName } else { '?' }

  # taskkill is more reliable than Stop-Process for foreign node/vite holders
  $out = & taskkill.exe /F /PID $ProcessId 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0 -or ($out -match 'SUCCESS')) {
    [void]$killed.Add([pscustomobject]@{ Pid = $ProcessId; Name = $name; Why = $Why })
    if (-not $Quiet) {
      Write-Host ("  x zombie {0}  pid {1}  {2}" -f $Why, $ProcessId, $name)
    }
  }
}

if ($StatusOnly) {
  foreach ($port in $Ports) {
    $conns = @(Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Where-Object {
      $_.RemotePort -eq 0 -or $_.State -eq 'Listen' -or $_.State -eq 'Bound'
    })
    if ($conns.Count -gt 0) { Write-Output $port }
  }
  exit 0
}

foreach ($port in $Ports) {
  $conns = @(Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue)
  foreach ($c in $conns) {
    # Some Windows builds leave State blank on listen sockets; RemotePort 0 marks them.
    if ($c.RemotePort -eq 0 -or $c.State -eq 'Listen' -or $c.State -eq 'Bound') {
      Kill-Pid -ProcessId ([int]$c.OwningProcess) -Why (":{0}" -f $port)
    }
  }

  # netstat fallback
  netstat -ano | ForEach-Object {
    if ($_ -match (":{0}\s+\S+\s+LISTENING\s+(\d+)" -f $port)) {
      Kill-Pid -ProcessId ([int]$Matches[1]) -Why (":{0}" -f $port)
    }
  }
}

Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -and
  $_.CommandLine.Contains($here) -and
  ($_.CommandLine -match 'vite|playwright|sakura_tree|sakura|_zombie_probe')
} | ForEach-Object {
  Kill-Pid -ProcessId ([int]$_.ProcessId) -Why 'orphan-node'
}

$count = $killed.Count
if ($Quiet) {
  if ($count -gt 0) {
    Write-Host ("  cleared {0} zombie process(es)" -f $count)
  }
} else {
  if ($count -eq 0) {
    Write-Host ("  no zombies on ports {0}" -f ($Ports -join ' '))
  } else {
    Write-Host ("  cleared {0} zombie process(es)" -f $count)
  }
}

exit 0
