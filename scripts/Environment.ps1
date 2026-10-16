$ErrorActionPreference = 'Stop'
$farmProject = Split-Path -Parent $PSScriptRoot
$farmPrivate = Join-Path $farmProject 'runtime'
$farmSecretPath = Join-Path $farmPrivate 'credentials.clixml'
if (-not (Test-Path -LiteralPath $farmSecretPath)) {
    New-Item -ItemType Directory -Path $farmPrivate -Force | Out-Null
    $farmCredential = [pscustomobject]@{
        Admin = ConvertTo-SecureString ([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))) -AsPlainText -Force
        Runtime = ConvertTo-SecureString ([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))) -AsPlainText -Force
    }
    $farmCredential | Export-Clixml -LiteralPath $farmSecretPath
}
$farmCredential = Import-Clixml -LiteralPath $farmSecretPath
if (-not $farmCredential.PSObject.Properties['Connections']) {
    $farmConnectionKey = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).Replace('+','-').Replace('/','_')
    $farmCredential | Add-Member -NotePropertyName Connections -NotePropertyValue (ConvertTo-SecureString $farmConnectionKey -AsPlainText -Force)
    $farmCredential | Export-Clixml -LiteralPath $farmSecretPath
    Remove-Variable farmConnectionKey
}
$farmAdmin = [Net.NetworkCredential]::new('', $farmCredential.Admin).Password
$farmRuntime = [Net.NetworkCredential]::new('', $farmCredential.Runtime).Password
$env:FUNKYFARMERS_ADMIN_PASSWORD = $farmAdmin
$env:FUNKYFARMERS_RUNTIME_PASSWORD = $farmRuntime
$env:FUNKYFARMERS_ADMIN_DATABASE_URL = "postgresql://funkyfarmers_admin:${farmAdmin}@127.0.0.1:55439/funkyfarmers"
$env:FUNKYFARMERS_DATABASE_URL = "postgresql://funkyfarmers_app:${farmRuntime}@127.0.0.1:55439/funkyfarmers"
$env:FUNKYFARMERS_TEST_ADMIN_DATABASE_URL = "postgresql://funkyfarmers_admin:${farmAdmin}@127.0.0.1:55439/funkyfarmers_test"
$env:FUNKYFARMERS_TEST_DATABASE_URL = "postgresql://funkyfarmers_app:${farmRuntime}@127.0.0.1:55439/funkyfarmers_test"
$env:FUNKYFARMERS_STORAGE_ROOT = Join-Path $farmPrivate 'documents'
$env:FUNKYFARMERS_CONNECTIONS_KEY = [Net.NetworkCredential]::new('', $farmCredential.Connections).Password
$env:FUNKYFARMERS_COOKIE_SECURE = 'false'
$env:FUNKYFARMERS_ALLOWED_ORIGINS = 'http://localhost:5189,http://127.0.0.1:5189'
$env:FUNKYFARMERS_PUBLIC_URL = 'http://127.0.0.1:5189'
$env:FUNKYFARMERS_OAUTH_ALLOW_LOCAL_HTTP = 'true'
Remove-Variable farmCredential,farmAdmin,farmRuntime
