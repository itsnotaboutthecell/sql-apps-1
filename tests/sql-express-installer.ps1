param(
    [Parameter(Mandatory = $true)] [string] $Helper,
    [Parameter(Mandatory = $true)] [string] $Scenario,
    [Parameter(Mandatory = $true)] [string] $Cache
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$env:LOCALAPPDATA = $Cache
$calls = [System.Collections.Generic.List[string]]::new()
$installerArguments = @()

# Load only the installer function; never execute registry, SQL or service setup.
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Helper, [ref] $tokens, [ref] $parseErrors)
if ($parseErrors.Count -ne 0) { throw 'The Express helper has syntax errors.' }
$install = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-ExpressInstall'
}, $true))
if ($install.Count -ne 1) { throw 'Expected the real Invoke-ExpressInstall function.' }
. ([scriptblock]::Create($install[0].Extent.Text))

function Get-Instances {
    if ($Scenario -eq 'inventory-error') { throw 'inventory unavailable' }
    if ($Scenario -eq 'existing-instance') { return [pscustomobject]@{ instance = 'SQLEXPRESS' } }
}
function Assert-Administrator([string] $Message) {
    $calls.Add('administrator')
    if ($Scenario -eq 'not-administrator') { throw 'administrator required' }
}
function Invoke-WebRequest([switch] $UseBasicParsing, [string] $Uri, [string] $OutFile) {
    $calls.Add('download')
    if ($Uri -ne 'https://download.microsoft.com/download/7ab8f535-7eb8-4b16-82eb-eca0fa2d38f3/SQL2025-SSEI-Expr.exe') {
        throw 'Unexpected installer source.'
    }
    [System.IO.File]::WriteAllText($OutFile, 'fixture, not an executable')
}
function Get-FileHash([string] $LiteralPath, [string] $Algorithm) {
    $calls.Add('hash')
    if ($Algorithm -ne 'SHA256') { throw 'Unexpected hash algorithm.' }
    return @{ Hash = if ($Scenario -in @('bad-hash', 'cached-bad-hash')) { 'BAD' } else {
        '1C677A33B318481C3217128835F8405CF0026621DCD04B13EB6CB0982E823F27'
    } }
}
function Get-AuthenticodeSignature([string] $LiteralPath) {
    $calls.Add('signature')
    return @{
        Status = if ($Scenario -eq 'bad-signature') { 'NotTrusted' } else { 'Valid' }
        SignerCertificate = if ($Scenario -eq 'missing-certificate') { $null } else { @{
            Subject = if ($Scenario -eq 'wrong-signer') { 'CN=Not Microsoft Corporation, O=Fixture' } else { 'CN=Microsoft Corporation, O=Microsoft Corporation' }
        } }
    }
}
function Start-Process([string] $FilePath, [string[]] $ArgumentList, [switch] $Wait, [switch] $PassThru) {
    $calls.Add('launch')
    $script:installerArguments = $ArgumentList
    if (-not $Wait -or -not $PassThru) { throw 'The installer must be awaited.' }
    return @{ ExitCode = if ($Scenario -eq 'restart') { 3010 } elseif ($Scenario -eq 'installer-error') { 1603 } else { 0 } }
}
function Invoke-LocalQuery([string] $Name, [string] $Catalog, [string] $Sql) {
    $calls.Add('verify')
    if ($Name -ne 'SQLEXPRESS' -or $Catalog -ne 'master') { throw 'Unexpected identity verification target.' }
    return ,@(@{ engineEdition = if ($Scenario -eq 'wrong-engine') { 3 } else { 4 }; majorVersion = 17 })
}
if ($Scenario -eq 'cached-bad-hash') {
    $directory = Join-Path $Cache 'SqlApps\Installers\SQL2025-17.0.1000.7'
    [void](New-Item -ItemType Directory -Path $directory -Force)
    [System.IO.File]::WriteAllText((Join-Path $directory 'SQL2025-SSEI-Expr.exe'), 'invalid cached fixture')
}
$failure = $null
$exitCode = $null
try { $exitCode = Invoke-ExpressInstall }
catch { $failure = $_.Exception.Message }
@{ failure = $failure; exitCode = $exitCode; calls = $calls.ToArray(); arguments = $installerArguments } |
    ConvertTo-Json -Depth 4 -Compress
