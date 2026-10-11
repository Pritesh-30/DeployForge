<#
DeployForge on a laptop, without remembering anything.

    .\scripts\dev.ps1 up         start (or create) every platform container
    .\scripts\dev.ps1 status     what is running, and whether it is healthy
    .\scripts\dev.ps1 backend    free port 8000 if a stale server holds it, then run the API
    .\scripts\dev.ps1 frontend   run the console on port 3000
    .\scripts\dev.ps1 down       stop the platform containers (apps are left alone)
    .\scripts\dev.ps1 tunnel     publish the console + API on NGROK_DOMAIN (one ngrok tunnel to
                                 port 3000) so GitHub webhooks and Actions can reach this laptop.
                                 Add "actions" or "local" to choose where builds run.
    .\scripts\dev.ps1 local      switch back to building on this laptop

Every command is safe to run again. `up` starts a container that exists,
creates one that does not, and recreates the router only when its token no
longer matches TRAEFIK_PROVIDER_TOKEN in backend/.env — the mismatch that
makes the router poll get 403 and app URLs stop updating.

If PowerShell refuses to run scripts:
    powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1 up
#>

param(
    [Parameter(Position = 0)][string]$Command = "status",
    [Parameter(Position = 1)][string]$Option = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"
$Network = "deployforge_edge"

function Read-EnvValue([string]$Name, [string]$Default) {
    $file = Join-Path $Backend ".env"
    if (Test-Path $file) {
        foreach ($line in Get-Content $file) {
            if ($line -match "^\s*$Name\s*=\s*(.*)\s*$") { return $Matches[1].Trim('"').Trim("'") }
        }
    }
    return $Default
}

function Set-EnvValue([string]$Name, [string]$Value) {
    # Written without a byte-order mark: Windows PowerShell's "utf8" adds one,
    # and the backend would then read the first variable's name with it.
    $file = Join-Path $Backend ".env"
    $lines = if (Test-Path $file) { @(Get-Content $file) } else { @() }
    $found = $false
    $lines = foreach ($line in $lines) {
        if ($line -match "^\s*$Name\s*=") { $found = $true; "$Name=$Value" } else { $line }
    }
    if (-not $found) { $lines = @($lines) + "$Name=$Value" }
    [IO.File]::WriteAllLines($file, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))
}

function Find-Ngrok {
    $cmd = Get-Command ngrok -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $local = Join-Path $env:USERPROFILE "ngrok\ngrok.exe"
    if (Test-Path $local) { return $local }
    throw "ngrok is not installed. Install it from https://ngrok.com/download and run 'ngrok config add-authtoken <token>' once."
}

function Tunnel([string]$Backend_) {
    # One public address serves everything. ngrok forwards your domain to the
    # console on port 3000, and the console forwards /backend/* to the API
    # (frontend/next.config.ts). So, through the one domain:
    #   https://<domain>/                         the console, for the demo
    #   https://<domain>/backend/webhooks/github  GitHub's push webhooks
    #   https://<domain>/backend/ci/runs          GitHub Actions asking what to build
    $ngrok = Find-Ngrok
    $domain = Read-EnvValue "NGROK_DOMAIN" ""
    if (-not $domain) {
        throw "Set NGROK_DOMAIN=<your static domain> in backend/.env (https://dashboard.ngrok.com/domains)."
    }
    $url = "https://$domain"

    $secret = Read-EnvValue "GITHUB_WEBHOOK_SECRET" ""
    if (-not $secret) {
        $bytes = New-Object byte[] 24
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $secret = -join ($bytes | ForEach-Object { $_.ToString("x2") })
        Set-EnvValue "GITHUB_WEBHOOK_SECRET" $secret
    }
    Set-EnvValue "PUBLIC_API_URL" "$url/backend"
    if ($Backend_ -in @("actions", "local")) { Set-EnvValue "BUILD_BACKEND" $Backend_ }
    $mode = Read-EnvValue "BUILD_BACKEND" "local"

    Write-Host ""
    Write-Host "  Console:      $url"
    Write-Host "  API:          $url/backend   (PUBLIC_API_URL in backend/.env)"
    Write-Host "  Webhooks:     $url/backend/webhooks/github?app=<app id>"
    Write-Host "  Builds run:   $(if ($mode -eq 'actions') { 'in GitHub Actions' } else { 'on this laptop' })   (.\scripts\dev.ps1 tunnel actions|local)"
    Write-Host ""
    Write-Host "  Restart the API now (.\scripts\dev.ps1 backend). On start it points every"
    Write-Host "  app's GitHub webhook at this address; from then on a push deploys."
    Write-Host "  Keep this window open - closing it closes the tunnel."
    Write-Host ""
    & $ngrok http 3000 "--url=$domain"
}

function Container-State([string]$Name) {
    # Windows PowerShell turns a native command's stderr into an error under
    # "Stop"; a missing container is an answer here, not a failure.
    $ErrorActionPreference = "Continue"
    $state = docker inspect --format "{{.State.Status}}" $Name 2>$null
    if ($LASTEXITCODE -ne 0) { return "missing" }
    return $state
}

function Ensure-Container([string]$Name, [string[]]$RunArgs) {
    switch (Container-State $Name) {
        "running" { Write-Host "  ok       $Name" }
        "missing" {
            docker run -d --name $Name --restart unless-stopped @RunArgs | Out-Null
            Write-Host "  created  $Name"
        }
        default {
            docker start $Name | Out-Null
            Write-Host "  started  $Name"
        }
    }
}

function Up {
    $ErrorActionPreference = "Continue"
    docker info *> $null
    if ($LASTEXITCODE -ne 0) { throw "Docker is not running. Start Docker Desktop first." }

    docker network inspect $Network *> $null
    if ($LASTEXITCODE -ne 0) { docker network create $Network | Out-Null; Write-Host "  created  network $Network" }

    Ensure-Container "deployforge-db" @(
        "-e", "POSTGRES_USER=deployforge", "-e", "POSTGRES_PASSWORD=deployforge", "-e", "POSTGRES_DB=deployforge",
        "-p", "5433:5432", "-v", "deployforge_pgdata:/var/lib/postgresql/data", "postgres:17")
    Ensure-Container "deployforge-redis" @(
        "-p", "127.0.0.1:6379:6379", "-v", "deployforge_redis:/data",
        "redis:7-alpine", "redis-server", "--appendonly", "yes", "--save", "")
    Ensure-Container "deployforge-registry" @(
        "-p", "127.0.0.1:5000:5000", "-v", "deployforge_registry:/var/lib/registry",
        "--network", $Network, "registry:2")

    # The router polls the API with a shared token. If the container was made
    # with a different token than backend/.env holds, every poll is refused
    # and the routing table silently stops changing — so it is recreated.
    $token = Read-EnvValue "TRAEFIK_PROVIDER_TOKEN" "deployforge-internal"
    $endpoint = "http://host.docker.internal:8000/internal/traefik/config?token=$token"
    if ((Container-State "deployforge-traefik") -ne "missing") {
        $args_ = (docker inspect --format "{{json .Args}}" deployforge-traefik) -join ""
        if ($args_ -notmatch [regex]::Escape("token=$token")) {
            Write-Host "  router token differs from backend/.env - recreating deployforge-traefik"
            docker rm -f deployforge-traefik | Out-Null
        }
    }
    Ensure-Container "deployforge-traefik" @(
        "-p", "80:80", "-p", "127.0.0.1:8090:8080", "--network", $Network,
        "--add-host=host.docker.internal:host-gateway",
        "traefik:v3.3", "--api.dashboard=true", "--api.insecure=true",
        "--providers.http.endpoint=$endpoint", "--providers.http.pollInterval=5s",
        "--entrypoints.web.address=:80")

    Push-Location $Backend
    try {
        & .\.venv\Scripts\alembic.exe upgrade head | Out-Null
        Write-Host "  ok       database schema is current"
    } finally { Pop-Location }
}

function Status {
    foreach ($name in "deployforge-db", "deployforge-redis", "deployforge-registry", "deployforge-traefik") {
        "{0,-22} {1}" -f $name, (Container-State $name) | Write-Host
    }
    try {
        $health = Invoke-RestMethod http://127.0.0.1:8000/health -TimeoutSec 3
        Write-Host ("API                    {0} (database {1}, redis {2}, builds: {3})" -f $health.status, $health.database, $health.redis, $health.build_backend)
    } catch { Write-Host "API                    not started yet - run: .\scripts\dev.ps1 backend  (and .\scripts\dev.ps1 frontend in another terminal)" }
}

function Free-Port([int]$Port) {
    $owners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $owners) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $procId"
        # Only ever stop an old DeployForge API — never something else that
        # happens to use the port.
        if ($proc.CommandLine -match "uvicorn" -and $proc.CommandLine -match "app\.main") {
            Write-Host "Stopping a stale DeployForge API on port $Port (pid $procId)"
            # Its reload workers inherit the socket; stop the whole tree.
            Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $procId } |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        } else {
            throw "Port $Port is used by another program: $($proc.CommandLine)"
        }
    }
    Start-Sleep -Milliseconds 500
}

switch ($Command) {
    "up" { Up; Status }
    "status" { Status }
    "down" {
        foreach ($name in "deployforge-traefik", "deployforge-registry", "deployforge-redis", "deployforge-db") {
            if ((Container-State $name) -eq "running") { docker stop $name | Out-Null; Write-Host "  stopped  $name" }
        }
    }
    "backend" {
        Free-Port 8000
        Set-Location $Backend
        # Live and log streams stay open as long as a page is; without a limit
        # a reload waits on them for ever and the API stops answering.
        & .\.venv\Scripts\uvicorn.exe app.main:app --reload --port 8000 --timeout-graceful-shutdown 3
    }
    "frontend" {
        Set-Location $Frontend
        npm run dev
    }
    "tunnel" { Tunnel $Option }
    "local" {
        Set-EnvValue "BUILD_BACKEND" "local"
        Write-Host "  backend/.env: BUILD_BACKEND=local. Restart the API: .\scripts\dev.ps1 backend"
    }
    default { throw "Unknown command '$Command'. Use: up, status, backend, frontend, down, tunnel, local." }
}
