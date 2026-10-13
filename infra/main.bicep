targetScope = 'resourceGroup'

@minLength(3)
@maxLength(20)
@description('Deployment name used in generated hostnames. The SQL Apps starter uses sqlapps; changing an existing name selects different resources.')
param name string = 'sqlapps'
@allowed(['dev', 'test', 'prod'])
param environment string
param location string = resourceGroup().location
param tenantId string
param apiClientId string
@allowed(['foundation', 'role-based-data'])
param profile string = 'foundation'
param requiredRole string = ''
param readinessPath string = ''
param sqlAdminObjectId string
param sqlAdminName string
param gatewayImage string
param dabImage string
param functionsImage string = ''
param registryServer string
param deployGateway bool = true
@description('Explicit point-in-time restore window for the application database. Longer retention increases backup storage cost and must be reviewed.')
@minValue(1)
@maxValue(35)
param sqlBackupRetentionDays int = 7
@description('Explicit backup storage redundancy for the application database.')
@allowed(['Local', 'Zone', 'Geo', 'GeoZone'])
param sqlBackupRedundancy string = 'Geo'

var prefix = '${name}-${environment}'
var fullFoundation = profile == 'foundation'
var suffix = uniqueString(resourceGroup().id, prefix)
var sqlName = '${prefix}-${suffix}'
var storageName = 'sqlapps${suffix}'
var vaultName = 'sqlapps-${suffix}'
var functionName = '${prefix}-fn-${suffix}'
var tags = { project: 'sql-apps', environment: environment }
resource gatewayIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-gateway'
  location: location
  tags: tags
}
resource dabIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-data'
  location: location
  tags: tags
}
resource functionIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (fullFoundation) {
  name: '${prefix}-functions'
  location: location
  tags: tags
}
resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${prefix}-network'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.42.0.0/16'] }
    subnets: [
      {
        name: 'containers'
        properties: {
          addressPrefix: '10.42.0.0/23'
          delegations: [{ name: 'containers', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      ...(fullFoundation ? [{
        name: 'functions'
        properties: {
          addressPrefix: '10.42.2.0/24'
          delegations: [{ name: 'functions', properties: { serviceName: 'Microsoft.Web/serverFarms' } }]
        }
      }] : [])
      { name: 'endpoints', properties: { addressPrefix: '10.42.3.0/24', privateEndpointNetworkPolicies: 'Disabled' } }
    ]
  }
}
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  tags: tags
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}
resource insights 'Microsoft.Insights/components@2020-02-02' = if (fullFoundation) {
  name: '${prefix}-insights'
  location: location
  kind: 'web'
  tags: tags
  properties: { Application_Type: 'web', WorkspaceResourceId: logs.id }
}
resource containers 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-containers'
  location: location
  tags: tags
  properties: {
    vnetConfiguration: { infrastructureSubnetId: '${network.id}/subnets/containers', internal: false }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
  }
}
resource sql 'Microsoft.Sql/servers@2023-08-01' = {
  name: sqlName
  location: location
  tags: tags
  properties: {
    version: '12.0'
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Disabled'
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
  tags: tags
  sku: { name: 'S0', tier: 'Standard', capacity: 10 }
  properties: {
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    zoneRedundant: false
    requestedBackupStorageRedundancy: sqlBackupRedundancy
  }
}
resource backupRetention 'Microsoft.Sql/servers/databases/backupShortTermRetentionPolicies@2023-08-01' = {
  parent: database
  name: 'default'
  properties: { retentionDays: sqlBackupRetentionDays }
}
resource sqlAudit 'Microsoft.Sql/servers/auditingSettings@2023-08-01' = {
  parent: sql
  name: 'default'
  properties: {
    state: 'Enabled'
    isAzureMonitorTargetEnabled: true
    isManagedIdentityInUse: false
  }
}
resource sqlAuditLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: database
  name: 'sql-audit'
  properties: {
    workspaceId: logs.id
    logs: [
      { category: 'SQLSecurityAuditEvents', enabled: true }
      { category: 'SQLInsights', enabled: true }
      { category: 'Errors', enabled: true }
    ]
  }
}
resource files 'Microsoft.Storage/storageAccounts@2023-05-01' = if (fullFoundation) {
  name: storageName
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'None' }
  }
}
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = if (fullFoundation) {
  parent: files
  name: 'default'
  properties: { deleteRetentionPolicy: { enabled: true, days: 7 }, containerDeleteRetentionPolicy: { enabled: true, days: 7 } }
}
resource fileContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (fullFoundation) {
  parent: blobService
  name: 'files'
  properties: { publicAccess: 'None' }
}
resource hostContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (fullFoundation) {
  parent: blobService
  name: 'azure-webjobs-hosts'
  properties: { publicAccess: 'None' }
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = if (fullFoundation) {
  name: vaultName
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'None' }
  }
}
resource functionPlan 'Microsoft.Web/serverfarms@2023-12-01' = if (fullFoundation) {
  name: '${prefix}-functions-plan'
  location: location
  tags: tags
  kind: 'elastic'
  sku: { name: 'EP1', tier: 'ElasticPremium', capacity: 1 }
  properties: { reserved: true }
}
resource functions 'Microsoft.Web/sites@2023-12-01' = if (fullFoundation) {
  name: functionName
  location: location
  tags: tags
  kind: 'functionapp,linux,container'
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${functionIdentity.id}': {} } }
  properties: {
    serverFarmId: functionPlan.id
    httpsOnly: true
    publicNetworkAccess: 'Disabled'
    virtualNetworkSubnetId: '${network.id}/subnets/functions'
    vnetRouteAllEnabled: true
    vnetImagePullEnabled: true
    siteConfig: {
      linuxFxVersion: 'DOCKER|${functionsImage}'
      acrUseManagedIdentityCreds: true
      acrUserManagedIdentityID: functionIdentity!.properties.clientId
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'false' }
        { name: 'AZURE_TENANT_ID', value: tenantId }
        { name: 'API_CLIENT_ID', value: apiClientId }
        { name: 'GATEWAY_PRINCIPAL_ID', value: gatewayIdentity.properties.principalId }
        { name: 'FUNCTIONS_IDENTITY_CLIENT_ID', value: functionIdentity!.properties.clientId }
        { name: 'KEY_VAULT_URL', value: vault!.properties.vaultUri }
        { name: 'AzureWebJobsStorage__accountName', value: files.name }
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
        { name: 'AzureWebJobsStorage__clientId', value: functionIdentity!.properties.clientId }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights!.properties.ConnectionString }
      ]
    }
  }
}

module sqlEndpoint 'private-endpoint.bicep' = {
  name: 'sql-endpoint'
  params: { name: '${prefix}-sql', location: location, networkId: network.id, targetId: sql.id, groupId: 'sqlServer', dnsZone: 'privatelink${az.environment().suffixes.sqlServerHostname}' }
}
module storageEndpoints 'private-endpoint.bicep' = [for kind in (fullFoundation ? ['blob', 'queue', 'table'] : []): {
  name: '${kind}-endpoint'
  params: { name: '${prefix}-${kind}', location: location, networkId: network.id, targetId: files.id, groupId: kind, dnsZone: 'privatelink.${kind}.core.windows.net' }
}]
module vaultEndpoint 'private-endpoint.bicep' = if (fullFoundation) {
  name: 'vault-endpoint'
  params: { name: '${prefix}-vault', location: location, networkId: network.id, targetId: vault.id, groupId: 'vault', dnsZone: 'privatelink.vaultcore.azure.net' }
}
module functionEndpoint 'private-endpoint.bicep' = if (fullFoundation) {
  name: 'function-endpoint'
  params: { name: '${prefix}-function', location: location, networkId: network.id, targetId: functions.id, groupId: 'sites', dnsZone: 'privatelink.azurewebsites.net' }
}
resource dataApp 'Microsoft.App/containerApps@2024-03-01' = if (deployGateway) {
  name: '${prefix}-data'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${dabIdentity.id}': {} } }
  properties: {
    managedEnvironmentId: containers.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: false, targetPort: 5000, allowInsecure: false }
      registries: [{ server: registryServer, identity: dabIdentity.id }]
    }
    template: {
      scale: { minReplicas: 1, maxReplicas: 2 }
      containers: [{
        name: 'data'
        image: dabImage
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: [
          { name: 'ASPNETCORE_URLS', value: 'http://+:5000' }
          { name: 'API_CLIENT_ID', value: apiClientId }
          { name: 'ENTRA_ISSUER', value: '${az.environment().authentication.loginEndpoint}${tenantId}/v2.0' }
          { name: 'SQL_CONNECTION_STRING', value: 'Server=tcp:${sql.name}${az.environment().suffixes.sqlServerHostname},1433;Database=app;Authentication=Active Directory Managed Identity;User Id=${dabIdentity.properties.clientId};Encrypt=True;TrustServerCertificate=False;' }
        ]
        probes: [
          { type: 'Liveness', httpGet: { path: '/health', port: 5000 }, initialDelaySeconds: 30, periodSeconds: 30 }
          { type: 'Readiness', httpGet: { path: '/health', port: 5000 }, initialDelaySeconds: 10, periodSeconds: 10 }
        ]
      }]
    }
  }
  dependsOn: [sqlEndpoint]
}
resource gateway 'Microsoft.App/containerApps@2024-03-01' = if (deployGateway) {
  name: '${prefix}-gateway'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${gatewayIdentity.id}': {} } }
  properties: {
    managedEnvironmentId: containers.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true, targetPort: 8080, allowInsecure: false }
      registries: [{ server: registryServer, identity: gatewayIdentity.id }]
    }
    template: {
      scale: { minReplicas: 1, maxReplicas: 2 }
      containers: [{
        name: 'gateway'
        image: gatewayImage
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: [
          { name: 'AZURE_CLIENT_ID', value: gatewayIdentity.properties.clientId }
          { name: 'AZURE_TENANT_ID', value: tenantId }
          { name: 'API_CLIENT_ID', value: apiClientId }
          { name: 'DAB_URL', value: 'https://${dataApp!.properties.configuration.ingress.fqdn}' }
          ...(fullFoundation ? [
            { name: 'BLOB_ACCOUNT_URL', value: files!.properties.primaryEndpoints.blob }
            { name: 'BLOB_CONTAINER', value: fileContainer!.name }
            { name: 'FUNCTIONS_URL', value: 'https://${functions!.properties.defaultHostName}' }
          ] : [
            { name: 'SQL_APPS_PROFILE', value: profile }
            { name: 'SQL_APPS_REQUIRED_ROLE', value: requiredRole }
            { name: 'SQL_APPS_READINESS_PATH', value: readinessPath }
          ])
        ]
        probes: [
          { type: 'Liveness', httpGet: { path: '/health/live', port: 8080 }, initialDelaySeconds: 10, periodSeconds: 30 }
          { type: 'Readiness', httpGet: { path: '/health/ready', port: 8080 }, initialDelaySeconds: 10, periodSeconds: 10 }
        ]
      }]
    }
  }
  dependsOn: [storageEndpoints, functionEndpoint]
}

output gatewayUrl string = deployGateway ? 'https://${gateway!.properties.configuration.ingress.fqdn}' : ''
output sqlServer string = '${sql.name}${az.environment().suffixes.sqlServerHostname}'
output databaseName string = database.name
output dabPrincipalId string = dabIdentity.properties.principalId
output gatewayPrincipalId string = gatewayIdentity.properties.principalId
output functionPrincipalId string = fullFoundation ? functionIdentity!.properties.principalId : ''
output gatewayName string = '${prefix}-gateway'
output functionsName string = fullFoundation ? functions!.name : ''
output networkId string = network.id
output storageAccount string = fullFoundation ? files!.name : ''
output vaultName string = fullFoundation ? vault!.name : ''
output sqlBackupRetentionDays int = sqlBackupRetentionDays
output sqlBackupRedundancy string = sqlBackupRedundancy
output sqlAuditWorkspaceName string = logs.name
