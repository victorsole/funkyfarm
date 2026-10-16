param([ValidateSet('setup','api','test')][string]$Action='api')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Environment.ps1')
$farmInterpreter=Join-Path $farmProject '.venv/Scripts/python.exe'
Push-Location $farmProject
try {
    if ($Action -eq 'setup') {
        if (-not (Test-Path -LiteralPath $farmInterpreter)) {
            & python -m venv .venv
            if ($LASTEXITCODE) { throw 'Python environment could not be created' }
        }
        & $farmInterpreter -m pip install -e '.[test]'
        if ($LASTEXITCODE) { throw 'Dependency installation failed' }
        & docker compose -f compose.dev.yaml up -d --wait database
        if ($LASTEXITCODE) { throw 'Local database could not start' }
        & $farmInterpreter scripts/provision.py
        if ($LASTEXITCODE) { throw 'Database preparation failed' }
        & $farmInterpreter -m funkyfarm.migrate
        if ($LASTEXITCODE) { throw 'Development migration failed' }
        $farmDevelopmentAdmin=$env:FUNKYFARM_ADMIN_DATABASE_URL
        try {
            $env:FUNKYFARM_ADMIN_DATABASE_URL=$env:FUNKYFARM_TEST_ADMIN_DATABASE_URL
            & $farmInterpreter -m funkyfarm.migrate
            if ($LASTEXITCODE) { throw 'Test migration failed' }
        } finally { $env:FUNKYFARM_ADMIN_DATABASE_URL=$farmDevelopmentAdmin }
    } elseif ($Action -eq 'test') {
        & $farmInterpreter -m pytest tests -q --tb=short
        if ($LASTEXITCODE) { throw 'Integration verification failed' }
    } else {
        & $farmInterpreter -m uvicorn funkyfarm.app:create_app --factory --host 127.0.0.1 --port 8139 --no-access-log
        if ($LASTEXITCODE) { throw 'API exited with an error' }
    }
} finally { Pop-Location }
