param([switch]$RebuildImages)
# Windows PowerShell treats native progress on stderr as ErrorRecords when redirected.
# Check native exit codes explicitly; valid pnpm/Docker progress must not abort startup.
$ErrorActionPreference = 'Continue'
$taskRoot = Split-Path $PSScriptRoot -Parent
Push-Location $taskRoot -ErrorAction Stop
try {
  if (!(Test-Path -LiteralPath '.env')) { throw 'Create .env from .env.example and configure its credentials first.' }
  docker info --format '{{.ServerVersion}}' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop before launching Support CRM.' }
  pnpm build
  if ($LASTEXITCODE -ne 0) { throw 'The application build failed.' }
  $composeArgs = @('-f','docker-compose.yml','-f','docker-compose.override.yml','-f','docker-compose.preview.yml')
  # Compose resolves image names and .env; do not parse or print environment secrets here.
  $config = docker compose @composeArgs config --format json | ConvertFrom-Json -ErrorAction Stop
  if ($LASTEXITCODE -ne 0) { throw 'The local Compose configuration is invalid.' }
  if (!$config.name) { throw 'The Compose project identity is required before cutover.' }
  foreach ($service in @('api','web')) {
    $imageName = $config.services.$service.image
    if (!$imageName) { $imageName = "$($config.name)-${service}:latest" }
    $imageId = docker images --quiet $imageName
    if ($RebuildImages -or !$imageId) {
      docker compose @composeArgs build $service
      if ($LASTEXITCODE -ne 0) { throw "The $service image could not be built." }
    }
  }
  docker compose @composeArgs pull gowa
  if ($LASTEXITCODE -ne 0) { throw 'The pinned Go WhatsApp image could not be pulled.' }
  # Stop writers before the migration service changes the transport binding.
  docker compose @composeArgs stop api worker
  if ($LASTEXITCODE -ne 0) { throw 'Application writers could not stop before migration.' }
  # The retired gateway is no longer a Compose service. Stop only its project-owned container;
  # retain its named volume and leave unrelated services/projects alone.
  $legacyGatewayIds = @(docker ps --filter "label=com.docker.compose.project=$($config.name)" --filter 'label=com.docker.compose.service=openwa' --format '{{.ID}}')
  if ($LASTEXITCODE -ne 0) { throw 'Legacy gateway ownership could not be inspected.' }
  foreach ($legacyGatewayId in $legacyGatewayIds) {
    if ($legacyGatewayId -notmatch '^[a-f0-9]{12,64}$') { throw 'Unexpected container identifier.' }
    docker stop $legacyGatewayId | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The legacy gateway could not stop before cutover.' }
  }
  docker compose @composeArgs up -d --no-build --force-recreate migrate
  if ($LASTEXITCODE -ne 0) { throw 'The migration service could not be recreated.' }
  docker compose @composeArgs up -d --no-build
  if ($LASTEXITCODE -ne 0) { throw 'Support CRM could not start. Inspect docker compose logs.' }
  # A changed bind-mounted build is not a Compose configuration change. Reload Node explicitly.
  docker compose @composeArgs restart api worker web
  if ($LASTEXITCODE -ne 0) { throw 'The application processes could not restart with the latest build.' }
  $url = "http://localhost:$($config.services.web.ports[0].published)"
  $ready = $false
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $response = Invoke-WebRequest "$url/api/v1/health/live" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Seconds 1 }
  }
  if (!$ready) { throw 'The API did not become healthy. Inspect docker compose logs api.' }
  Write-Host "Support CRM: $url"
  Write-Host 'Use the administrator account configured in .env. Add WhatsApp accounts from the WhatsApp workspace.'
} finally { Pop-Location }
