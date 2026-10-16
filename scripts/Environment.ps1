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
$env:FUNKYFARM_ADMIN_PASSWORD = $farmAdmin
$env:FUNKYFARM_RUNTIME_PASSWORD = $farmRuntime
$env:FUNKYFARM_ADMIN_DATABASE_URL = "postgresql://funkyfarm_admin:${farmAdmin}@127.0.0.1:55440/funkyfarm"
$env:FUNKYFARM_DATABASE_URL = "postgresql://funkyfarm_app:${farmRuntime}@127.0.0.1:55440/funkyfarm"
$env:FUNKYFARM_TEST_ADMIN_DATABASE_URL = "postgresql://funkyfarm_admin:${farmAdmin}@127.0.0.1:55440/funkyfarm_test"
$env:FUNKYFARM_TEST_DATABASE_URL = "postgresql://funkyfarm_app:${farmRuntime}@127.0.0.1:55440/funkyfarm_test"
$env:FUNKYFARM_STORAGE_ROOT = Join-Path $farmPrivate 'documents'
$env:FUNKYFARM_CONNECTIONS_KEY = [Net.NetworkCredential]::new('', $farmCredential.Connections).Password
$env:FUNKYFARM_COOKIE_SECURE = 'false'
$env:FUNKYFARM_ALLOWED_ORIGINS = 'http://localhost:5189,http://127.0.0.1:5189'
$env:FUNKYFARM_PUBLIC_URL = 'http://127.0.0.1:5189'
$env:FUNKYFARM_OAUTH_ALLOW_LOCAL_HTTP = 'true'
Remove-Variable farmCredential,farmAdmin,farmRuntime
