# Optional Windows login launcher. Scheduling itself remains platform-neutral Node.js.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$daemon = Join-Path $root 'src\daemon.mjs'
Start-Process -FilePath $node -ArgumentList @('--use-env-proxy', ('"{0}"' -f $daemon)) -WorkingDirectory $root -WindowStyle Hidden
