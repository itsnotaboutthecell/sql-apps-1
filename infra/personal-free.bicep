targetScope = 'resourceGroup'

@minLength(3)
@maxLength(20)
param name string

@allowed(['dev', 'test', 'prod'])
param environment string = 'dev'

param location string = resourceGroup().location
param tenantId string
param sqlAdministratorObjectId string
param sqlAdministratorName string

@minLength(1)
param sqlAdministratorLogin string = 'sqlappsadmin'

@secure()
@minLength(32)
param sqlAdministratorPassword string

@secure()
@minLength(32)
param runtimePassword string

var prefix = '${name}-${environment}'
var suffix = uniqueString(resourceGroup().id, prefix)
var sqlName = '${prefix}-${suffix}'
var tags = {
  project: 'sql-apps'
  environment: environment
  deployment: 'personal-free'
}

resource site 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${prefix}-${suffix}'
  location: location
  tags: tags
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {
    allowConfigFileUpdates: true
  }
}

resource sql 'Microsoft.Sql/servers@2023-08-01' = {
  name: sqlName
  location: location
  tags: tags
  properties: {
    version: '12.0'
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    administratorLogin: sqlAdministratorLogin
    administratorLoginPassword: sqlAdministratorPassword
    administrators: {
      administratorType: 'ActiveDirectory'
      login: sqlAdministratorName
      sid: sqlAdministratorObjectId
      tenantId: tenantId
      azureADOnlyAuthentication: false
    }
  }
}

resource allowAzure 'Microsoft.Sql/servers/firewallRules@2023-08-01' = {
  parent: sql
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource database 'Microsoft.Sql/servers/databases@2023-08-01' = {
  parent: sql
  name: 'app'
  location: location
  tags: tags
  sku: {
    name: 'GP_S_Gen5_2'
    tier: 'GeneralPurpose'
    family: 'Gen5'
    capacity: 2
  }
  properties: {
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    zoneRedundant: false
    requestedBackupStorageRedundancy: 'Local'
    maxSizeBytes: 34359738368
    useFreeLimit: true
    freeLimitExhaustionBehavior: 'AutoPause'
    autoPauseDelay: 60
    minCapacity: json('0.5')
  }
}

resource appSettings 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: site
  name: 'appsettings'
  properties: {
    AZURE_SQL_SERVER: '${sql.name}${az.environment().suffixes.sqlServerHostname}'
    AZURE_SQL_DATABASE: 'app'
    AZURE_SQL_USER: 'sql_apps_runtime'
    AZURE_SQL_PASSWORD: runtimePassword
  }
}

output staticWebAppName string = site.name
output staticWebAppHostname string = site.properties.defaultHostname
output sqlServer string = '${sql.name}${az.environment().suffixes.sqlServerHostname}'
output databaseName string = database.name
