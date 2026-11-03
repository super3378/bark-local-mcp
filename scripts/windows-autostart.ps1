param([ValidateSet('Enable', 'Disable', 'Status')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$name = 'BarkLocalMcp'
$launcher = Join-Path $PSScriptRoot 'start-scheduler.ps1'
$command = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File "{0}"' -f $launcher
$current = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).$name
if ($Action -eq 'Enable') {
    if ($current -and $current -ne $command) { throw 'A different BarkLocalMcp startup entry already exists.' }
    New-ItemProperty -LiteralPath $key -Name $name -PropertyType String -Value $command -Force | Out-Null
} elseif ($Action -eq 'Disable') {
    if ($current -eq $command) { Remove-ItemProperty -LiteralPath $key -Name $name }
}
$enabled = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).$name -eq $command
@{ enabled = $enabled; scope = 'current_user'; uses_task_scheduler = $false } | ConvertTo-Json -Compress
