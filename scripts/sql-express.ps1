param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Inspect', 'Install', 'Query', 'Database', 'Configure', 'ConfigureSqlAuthentication')]
    [string] $Action,
    [ValidatePattern('^[A-Za-z][A-Za-z0-9_]{0,127}$')]
    [string] $Instance = 'SQLEXPRESS',
    [ValidatePattern('^[A-Za-z][A-Za-z0-9_]{0,127}$')]
    [string] $Database = 'master',
    [ValidateRange(1, 65535)]
    [int] $Port = 1433,
    [switch] $AllowRestart
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
foreach ($module in @('Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Security')) {
    Import-Module (Join-Path $PSHOME "Modules\$module\$module.psd1") -ErrorAction Stop
}

function Invoke-LocalQuery([string] $Name, [string] $Catalog, [string] $Sql) {
    $builder = [System.Data.SqlClient.SqlConnectionStringBuilder]::new()
    $builder['Data Source'] = if ($Name -eq 'MSSQLSERVER') { 'lpc:.' } else { "lpc:.\$Name" }
    $builder['Initial Catalog'] = $Catalog
    $builder['Integrated Security'] = $true
    $builder['Connect Timeout'] = 5
    $connection = [System.Data.SqlClient.SqlConnection]::new($builder.ConnectionString)
    try {
        $connection.Open()
        $command = $connection.CreateCommand()
        $command.CommandTimeout = 30
        $command.CommandText = $Sql
        $reader = $command.ExecuteReader()
        try {
            $rows = [System.Collections.Generic.List[object]]::new()
            do {
                while ($reader.Read()) {
                    $row = [ordered]@{}
                    for ($index = 0; $index -lt $reader.FieldCount; $index++) {
                        $row[$reader.GetName($index)] = if ($reader.IsDBNull($index)) { $null } else { $reader.GetValue($index) }
                    }
                    $rows.Add($row)
                }
            } while ($reader.NextResult())
            return ,$rows.ToArray()
        } finally { $reader.Dispose(); $command.Dispose() }
    } catch [System.Data.SqlClient.SqlException] {
        throw "Express SQL operation failed (SQL error $($_.Exception.Number)). Review the selected instance, permissions and containment; no credential reset was attempted."
    } finally { $connection.Dispose() }
}

function Get-Instances {
    $instances = [System.Collections.Generic.List[object]]::new()
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
        $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
        try {
            $names = $registry.OpenSubKey('SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL')
            if ($null -eq $names) { continue }
            try {
                foreach ($name in $names.GetValueNames()) {
                    if ($name -notmatch '^[A-Za-z][A-Za-z0-9_]{0,127}$') { throw 'An invalid registered SQL instance requires administrator inspection.' }
                    if (@($instances | Where-Object { $_.instance -eq $name }).Count -gt 0) { continue }
                    $instanceId = [string]$names.GetValue($name)
                    $setup = $registry.OpenSubKey("SOFTWARE\Microsoft\Microsoft SQL Server\$instanceId\Setup")
                    if ($null -eq $setup) { throw "SQL instance $name has incomplete registration; do not install over it." }
                    try {
                        $version = [string]$setup.GetValue('Version')
                        $edition = [string]$setup.GetValue('Edition')
                    } finally { $setup.Dispose() }
                    $verified = $false
                    $probeCode = 'SQL_IDENTITY_UNVERIFIED'
                    $containedAuthentication = $null
                    $integratedSecurityOnly = $null
                    $loopbackPorts = @()
                    try {
                        $identity = Invoke-LocalQuery $name 'master' "SELECT CONVERT(int,SERVERPROPERTY('EngineEdition')) AS engineEdition, CONVERT(int,SERVERPROPERTY('ProductMajorVersion')) AS majorVersion, CONVERT(int,SERVERPROPERTY('IsIntegratedSecurityOnly')) AS integratedSecurityOnly, CONVERT(int,value_in_use) AS containedAuthentication FROM sys.configurations WHERE name = 'contained database authentication';"
                        $verified = $identity.Count -eq 1 -and $identity[0].engineEdition -eq 4 -and $identity[0].majorVersion -eq 17
                        if ($verified) { $probeCode = 'EXPRESS_IDENTITY_VERIFIED'; $containedAuthentication = $identity[0].containedAuthentication; $integratedSecurityOnly = $identity[0].integratedSecurityOnly }
                    } catch {
                        $probeCode = 'SQL_QUERY_FAILED_REVIEW_INSTANCE'
                    }
                    $tcp = $registry.OpenSubKey("SOFTWARE\Microsoft\Microsoft SQL Server\$instanceId\MSSQLServer\SuperSocketNetLib\Tcp")
                    if ($null -ne $tcp) {
                        try {
                            if ($tcp.GetValue('Enabled') -eq 1 -and $tcp.GetValue('ListenOnAllIPs') -eq 0) {
                                $otherEnabled = $false
                                foreach ($addressName in $tcp.GetSubKeyNames()) {
                                    if ($addressName -notmatch '^IP\d+$') { continue }
                                    $address = $tcp.OpenSubKey($addressName)
                                    try {
                                        if ($address.GetValue('Enabled') -ne 1) { continue }
                                        if ($address.GetValue('IpAddress') -ne '127.0.0.1') { $otherEnabled = $true; continue }
                                        $configuredPort = [string]$address.GetValue('TcpPort')
                                        if ([string]$address.GetValue('TcpDynamicPorts') -eq '' -and $configuredPort -match '^\d{1,5}$' -and
                                            [int]$configuredPort -gt 0 -and [int]$configuredPort -le 65535) { $loopbackPorts += [int]$configuredPort }
                                    } finally { $address.Dispose() }
                                }
                                if ($otherEnabled) { $loopbackPorts = @() }
                            }
                        } finally { $tcp.Dispose() }
                    }
                    $instances.Add([pscustomobject]@{
                        instance = $name
                        majorVersion = if ($version -match '^(\d+)\.') { [int]$Matches[1] } else { 0 }
                        edition = $edition
                        registered = $true
                        verified = $verified
                        probeCode = $probeCode
                        containedAuthentication = $containedAuthentication
                        integratedSecurityOnly = $integratedSecurityOnly
                        loopbackPorts = @($loopbackPorts)
                    })
                }
            } finally { $names.Dispose() }
        } finally { $registry.Dispose() }
    }
    return $instances.ToArray()
}

function Assert-Administrator([string] $Message) {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw $Message }
}

$os = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$major = if ($os.PSObject.Properties.Name -contains 'CurrentMajorVersionNumber') { [int]$os.CurrentMajorVersionNumber } else { 0 }
$supported = [Environment]::Is64BitOperatingSystem -and $env:PROCESSOR_ARCHITECTURE -eq 'AMD64' -and
    $major -ge 10 -and ($os.ProductName -notmatch 'Windows Server' -or [int]$os.CurrentBuildNumber -ge 17763)
if ($Action -eq 'Inspect') {
    @{ supported = $supported; instances = @(Get-Instances) } | ConvertTo-Json -Depth 5 -Compress
    exit 0
}
if (-not $supported) { throw 'SQL Server 2025 Express installation/bootstrap requires supported Windows x64.' }

function Invoke-ExpressInstall {
    if (@(Get-Instances | Where-Object { $_.instance -eq 'SQLEXPRESS' }).Count -gt 0) {
        throw 'SQLEXPRESS is already registered; inspect it instead of installing over it.'
    }
    Assert-Administrator 'Administrator approval is required. Run the exact reviewed command in an approved administrator terminal; this helper will not elevate itself.'
    if (-not $env:LOCALAPPDATA) { throw 'A current-user installer cache is unavailable.' }
    $directory = Join-Path $env:LOCALAPPDATA 'SqlApps\Installers\SQL2025-17.0.1000.7'
    [void](New-Item -ItemType Directory -Path $directory -Force)
    $installer = Join-Path $directory 'SQL2025-SSEI-Expr.exe'
    if (-not (Test-Path -LiteralPath $installer)) {
        Invoke-WebRequest -UseBasicParsing -Uri 'https://download.microsoft.com/download/7ab8f535-7eb8-4b16-82eb-eca0fa2d38f3/SQL2025-SSEI-Expr.exe' -OutFile $installer
    }
    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne '1C677A33B318481C3217128835F8405CF0026621DCD04B13EB6CB0982E823F27') {
        throw 'SQL Express installer hash does not match the reviewed release. No installer was executed.'
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)CN=Microsoft Corporation(?:,|$)') {
        throw 'SQL Express installer does not have a valid Microsoft signature. No installer was executed.'
    }
    $process = Start-Process -FilePath $installer -ArgumentList @('/IACCEPTSQLSERVERLICENSETERMS', '/ENU', '/ACTION=Install', '/quiet', '/InstallPath="C:\Program Files\Microsoft SQL Server"') -Wait -PassThru
    if ($process.ExitCode -eq 3010) { [Console]::Error.WriteLine('SQL Express requires a human-approved restart before readiness can be checked.'); return 3010 }
    if ($process.ExitCode -ne 0) { throw "SQL Express installer failed ($($process.ExitCode)); inspect its logs and active installer before reviewing a retry." }
    $verified = Invoke-LocalQuery 'SQLEXPRESS' 'master' "SELECT CONVERT(int,SERVERPROPERTY('EngineEdition')) AS engineEdition, CONVERT(int,SERVERPROPERTY('ProductMajorVersion')) AS majorVersion;"
    if ($verified.Count -ne 1 -or $verified[0].engineEdition -ne 4 -or $verified[0].majorVersion -ne 17) {
        throw 'Installer completed but SQL Server 2025 Express identity did not verify.'
    }
    return 0
}

if ($Action -eq 'Install') { exit (Invoke-ExpressInstall) }

if ($Action -in @('Configure', 'ConfigureSqlAuthentication')) {
    if (-not $AllowRestart) { throw 'Express configuration requires specific approval for the selected instance changes and service restart.' }
    Assert-Administrator 'Run the exact reviewed Express configuration command in an approved administrator terminal; no automatic elevation.'
    $row = Invoke-LocalQuery $Instance 'master' "SELECT CONVERT(int,SERVERPROPERTY('EngineEdition')) AS engineEdition, CONVERT(int,SERVERPROPERTY('ProductMajorVersion')) AS majorVersion;"
    if ($row.Count -ne 1 -or $row[0].engineEdition -ne 4 -or $row[0].majorVersion -ne 17) { throw 'Only the selected SQL Server 2025 Express instance can be configured.' }
    $instanceId = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL').$Instance
    if ($instanceId -notmatch '^MSSQL17\.[A-Za-z0-9_]+$') { throw 'Unexpected SQL instance registration; no configuration was changed.' }
    $serviceName = if ($Instance -eq 'MSSQLSERVER') { 'MSSQLSERVER' } else { "MSSQL`$$Instance" }
    if ($Action -eq 'ConfigureSqlAuthentication') {
        Set-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\$instanceId\MSSQLServer" -Name LoginMode -Value 2
        Restart-Service -Name $serviceName -ErrorAction Stop
        exit 0
    }
    $tcp = "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\$instanceId\MSSQLServer\SuperSocketNetLib\Tcp"
    $addresses = @(Get-ChildItem -LiteralPath $tcp | Where-Object { $_.PSChildName -match '^IP\d+$' })
    if (@($addresses | Where-Object { $_.GetValue('IpAddress') -eq '127.0.0.1' }).Count -ne 1) { throw 'A unique registered loopback SQL TCP address was not found; review configuration manually.' }
    Set-ItemProperty -LiteralPath $tcp -Name Enabled -Value 1
    Set-ItemProperty -LiteralPath $tcp -Name ListenOnAllIPs -Value 0
    foreach ($address in $addresses) {
        $loopback = $address.GetValue('IpAddress') -eq '127.0.0.1'
        Set-ItemProperty -LiteralPath $address.PSPath -Name Enabled -Value ([int]$loopback)
        if ($loopback) {
            Set-ItemProperty -LiteralPath $address.PSPath -Name TcpDynamicPorts -Value ''
            Set-ItemProperty -LiteralPath $address.PSPath -Name TcpPort -Value ([string]$Port)
        }
    }
    [void](Invoke-LocalQuery $Instance 'master' "EXEC sp_configure 'contained database authentication', 1; RECONFIGURE;")
    Restart-Service -Name $serviceName -ErrorAction Stop
    exit 0
}

if ($Action -eq 'Database') {
    if ($Database -in @('master', 'model', 'msdb', 'tempdb')) { throw 'Choose a development user database.' }
    $configuration = Invoke-LocalQuery $Instance 'master' "SELECT CONVERT(int,SERVERPROPERTY('IsIntegratedSecurityOnly')) AS integratedSecurityOnly, CONVERT(int,value_in_use) AS enabled FROM sys.configurations WHERE name = 'contained database authentication';"
    if ($configuration.Count -ne 1 -or $configuration[0].enabled -ne 1) { throw 'Contained authentication is not enabled. Review and approve configure-express before database initialization.' }
    if ($configuration[0].integratedSecurityOnly -ne 0) { throw 'The contained runtime user requires SQL authentication. Review and separately approve configure-express-auth and its instance-wide mixed-mode/restart effects; no authentication mode was changed.' }
    [void](Invoke-LocalQuery $Instance 'master' "IF DB_ID(N'$Database') IS NULL EXEC(N'CREATE DATABASE [$Database] CONTAINMENT = PARTIAL;');")
    $containment = Invoke-LocalQuery $Instance $Database 'SELECT containment AS value FROM sys.databases WHERE name = DB_NAME();'
    if ($containment.Count -ne 1 -or $containment[0].value -ne 1) { throw 'The selected existing database is not partially contained; review its configuration instead of changing it automatically.' }
    exit 0
}

$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($null -eq $request -or $request.PSObject.Properties.Name -notcontains 'sql' -or $request.sql -isnot [string] -or $request.sql.Length -gt 1048576) {
    throw 'Provide a bounded SQL request through standard input.'
}
$rows = Invoke-LocalQuery $Instance $Database $request.sql
ConvertTo-Json -InputObject @($rows) -Depth 10 -Compress
