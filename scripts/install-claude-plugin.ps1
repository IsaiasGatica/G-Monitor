$ErrorActionPreference = 'Stop'
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host 'Claude CLI no está en PATH. Instalar desde Claude Desktop > Code > + > Plugins > Add plugin: g-monitor de g-monitor-local. Ver INSTALAR-DESKTOP.txt.'
    exit 20
}
$versionText = (& claude --version | Out-String)
if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '(\d+\.\d+\.\d+)') { throw 'Claude Code no está disponible.' }
if ([version]$Matches[1] -lt [version]'2.1.287') { throw 'Actualizar Claude Code a 2.1.287 o posterior.' }
$catalog = (& claude plugin marketplace list --json | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'No se pudo consultar el registro de marketplaces.' }
$existing = @($catalog | ConvertFrom-Json) | Where-Object { $_.name -eq 'g-monitor-local' }
if ($existing) {
    if ($existing.source -ne 'directory' -or [IO.Path]::GetFullPath($existing.path) -ne [IO.Path]::GetFullPath($PSScriptRoot)) {
        throw 'g-monitor-local apunta a otra ubicación. Retirar ese marketplace con claude plugin marketplace remove g-monitor-local y ejecutar nuevamente este instalador.'
    }
    & claude plugin marketplace update g-monitor-local
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo actualizar el marketplace local.' }
} else {
    & claude plugin marketplace add $PSScriptRoot
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo registrar el marketplace local.' }
}
& claude plugin validate (Join-Path $PSScriptRoot 'plugins/g-monitor')
if ($LASTEXITCODE -ne 0) { throw 'Claude rechazó la validación del plugin. Revisar el diagnóstico anterior.' }
& claude plugin install g-monitor@g-monitor-local --scope user
if ($LASTEXITCODE -ne 0) { throw 'No se pudo instalar el plugin.' }
& claude plugin update g-monitor@g-monitor-local --scope user
if ($LASTEXITCODE -ne 0) { throw 'No se pudo actualizar el plugin.' }
$enableText = (& claude plugin enable g-monitor@g-monitor-local --scope user --json | Out-String)
$enableExit = $LASTEXITCODE
$enableResult = ($enableText.Trim() -split "`n" | Select-Object -Last 1) | ConvertFrom-Json
if ($enableExit -ne 0 -and -not $enableResult.alreadyInGoalState) { throw "No se pudo habilitar el plugin: $enableText" }
Write-Host 'Plugin instalado. Usar /reload-plugins en el chat existente.'
