targetScope = 'resourceGroup'

@minLength(3)
@maxLength(16)
@description('Deployment prefix. The SQL Apps starter uses sqlapps; changing an existing prefix selects different resources.')
param name string = 'sqlapps'
param selectedApplication string
param deploymentId string
param location string
param tenantId string
param tags object
@minLength(5)
@maxLength(50)
param registryName string
param sqlAdminObjectId string
param sqlAdminName string
@description('Explicit policy for a new database. free-paused uses the free tier and never enables paid continuation; paid-reviewed requires separate cost approval. No existing-database conversion is authorized.')
@allowed(['free-paused', 'paid-reviewed'])
param sqlBillingMode string
@description('Required reviewed sizing contract. Used for paid-reviewed; free-paused uses its fixed General Purpose serverless free-tier SKU instead.')
param sqlSku object
@minValue(104857600)
param sqlMaxSizeBytes int
@allowed(['Local', 'Zone', 'Geo', 'GeoZone'])
param sqlBackupRedundancy string
@description('Registry credential posture. starter enables the registry admin user because the starter runtime pulls with it; hardened keeps the admin user disabled for identity-based pulls.')
@allowed([
  'starter'
  'hardened'
])
param securityPosture string
@description('Demo log retention in days for the environment workspace. The workspace stays inside the free daily ingestion allowance.')
@minValue(30)
@maxValue(90)
param logRetentionDays int = 30

var prefix = '${name}-${substring(deploymentId, 0, 8)}'
var suffix = uniqueString(resourceGroup().id, deploymentId)
var ownedTags = union(tags, {
  'sql-apps-deployment': deploymentId
  'sql-apps-application': selectedApplication
  'sql-apps-profile': 'public-demo'
})
var freeSql = sqlBillingMode == 'free-paused'
var freeSqlSku = { name: 'GP_S_Gen5_2', tier: 'GeneralPurpose', family: 'Gen5', capacity: 2 }
var starterRegistry = securityPosture == 'starter'

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-runtime'
  location: location
  tags: ownedTags
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' = {
  name: registryName
  location: location
  tags: ownedTags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: starterRegistry
    publicNetworkAccess: 'Enabled'
    policies: { azureADAuthenticationAsArmPolicy: { status: 'enabled' } }
  }
}

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${prefix}-network'
  location: location
  tags: ownedTags
  properties: {
    addressSpace: { addressPrefixes: ['10.43.0.0/16'] }
    subnets: [{
      name: 'containers'
      properties: {
        addressPrefix: '10.43.0.0/27'
        delegations: [{ name: 'containers', properties: { serviceName: 'Microsoft.App/environments' } }]
        serviceEndpoints: [{ service: 'Microsoft.Sql', locations: [location] }]
      }
    }]
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  tags: ownedTags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: logRetentionDays
    workspaceCapping: { dailyQuotaGb: json('0.1') }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
    features: { disableLocalAuth: true }
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-containers'
  location: location
  tags: ownedTags
  properties: {
    vnetConfiguration: { infrastructureSubnetId: '${network.id}/subnets/containers', internal: false }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    appLogsConfiguration: { destination: 'azure-monitor' }
  }
}

resource environmentDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: environment
  name: 'demo-console-logs'
  properties: {
    workspaceId: logs.id
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
  }
}

resource sql 'Microsoft.Sql/servers@2023-08-01' = {
  name: '${prefix}-sql-${suffix}'
  location: location
  tags: ownedTags
  properties: {
    version: '12.0'
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    administrators: {
      administratorType: 'ActiveDirectory'
      login: sqlAdminName
      sid: sqlAdminObjectId
      tenantId: tenantId
      azureADOnlyAuthentication: true
    }
  }
}

resource database 'Microsoft.Sql/servers/databases@2023-08-01' = {
  parent: sql
  name: 'app'
  location: location
  tags: ownedTags
  sku: freeSql ? freeSqlSku : sqlSku
  properties: union({
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    maxSizeBytes: freeSql ? 34359738368 : sqlMaxSizeBytes
    requestedBackupStorageRedundancy: freeSql ? 'Local' : sqlBackupRedundancy
    zoneRedundant: false
    useFreeLimit: freeSql
  }, freeSql ? {
    freeLimitExhaustionBehavior: 'AutoPause'
    autoPauseDelay: 60
    minCapacity: json('0.5')
  } : {})
}

resource subnetRule 'Microsoft.Sql/servers/virtualNetworkRules@2023-08-01' = {
  parent: sql
  name: 'selected-application-subnet'
  properties: {
    virtualNetworkSubnetId: '${network.id}/subnets/containers'
    ignoreMissingVnetServiceEndpoint: false
  }
}

output environmentId string = environment.id
output environmentName string = environment.name
output applicationName string = '${prefix}-web'
output runtimeIdentityResourceId string = runtimeIdentity.id
output runtimeIdentityName string = runtimeIdentity.name
output runtimeIdentityClientId string = runtimeIdentity.properties.clientId
output runtimeIdentityPrincipalId string = runtimeIdentity.properties.principalId
output runtimeIdentityTenantId string = runtimeIdentity.properties.tenantId
output registryId string = registry.id
output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output networkId string = network.id
output subnetId string = '${network.id}/subnets/containers'
output sqlServerId string = sql.id
output sqlServerName string = sql.name
output sqlHost string = sql.properties.fullyQualifiedDomainName
output databaseId string = database.id
output databaseName string = database.name
output ownershipTags object = ownedTags
output sqlBillingMode string = sqlBillingMode
output logsWorkspaceId string = logs.id
output logsWorkspaceName string = logs.name
