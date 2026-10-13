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
param requiredRole string
param readinessPath string
param sqlAdminObjectId string
param sqlAdminName string
param gatewayImage string
param dabImage string
param registryServer string
param deployGateway bool = true
@description('Explicit point-in-time restore window for the application database. Longer retention increases backup storage cost and must be reviewed.')
@minValue(1)
@maxValue(35)
param sqlBackupRetentionDays int = 7
@description('Explicit backup storage redundancy for the application database.')
@allowed(['Local', 'Zone', 'Geo', 'GeoZone'])
param sqlBackupRedundancy string = 'Local'

var prefix = '${name}-${environment}'
var suffix = uniqueString(resourceGroup().id, prefix)
var sqlName = '${prefix}-${suffix}'
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
      { name: 'endpoints', properties: { addressPrefix: '10.42.3.0/24', privateEndpointNetworkPolicies: 'Disabled' } }
    ]
  }
}
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  tags: tags
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30, workspaceCapping: { dailyQuotaGb: json('0.1') } }
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
  sku: { name: 'GP_S_Gen5_2', tier: 'GeneralPurpose', family: 'Gen5', capacity: 2 }
  properties: {
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    zoneRedundant: false
    requestedBackupStorageRedundancy: sqlBackupRedundancy
    maxSizeBytes: 34359738368
    useFreeLimit: true
    freeLimitExhaustionBehavior: 'AutoPause'
    autoPauseDelay: 60
    minCapacity: json('0.5')
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

module sqlEndpoint 'private-endpoint.bicep' = {
  name: 'sql-endpoint'
  params: { name: '${prefix}-sql', location: location, networkId: network.id, targetId: sql.id, groupId: 'sqlServer', dnsZone: 'privatelink${az.environment().suffixes.sqlServerHostname}' }
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
      scale: { minReplicas: 0, maxReplicas: 2 }
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
      scale: { minReplicas: 0, maxReplicas: 2 }
      containers: [{
        name: 'gateway'
        image: gatewayImage
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: [
          { name: 'AZURE_CLIENT_ID', value: gatewayIdentity.properties.clientId }
          { name: 'AZURE_TENANT_ID', value: tenantId }
          { name: 'API_CLIENT_ID', value: apiClientId }
          { name: 'DAB_URL', value: 'https://${dataApp!.properties.configuration.ingress.fqdn}' }
          { name: 'SQL_APPS_REQUIRED_ROLE', value: requiredRole }
          { name: 'SQL_APPS_READINESS_PATH', value: readinessPath }
        ]
        probes: [
          { type: 'Liveness', httpGet: { path: '/health/live', port: 8080 }, initialDelaySeconds: 10, periodSeconds: 30 }
          { type: 'Readiness', httpGet: { path: '/health/ready', port: 8080 }, initialDelaySeconds: 10, periodSeconds: 10 }
        ]
      }]
    }
  }
}

output gatewayUrl string = deployGateway ? 'https://${gateway!.properties.configuration.ingress.fqdn}' : ''
output sqlServer string = '${sql.name}${az.environment().suffixes.sqlServerHostname}'
output databaseName string = database.name
output dabPrincipalId string = dabIdentity.properties.principalId
output gatewayPrincipalId string = gatewayIdentity.properties.principalId
output gatewayName string = '${prefix}-gateway'
output networkId string = network.id
output sqlBackupRetentionDays int = sqlBackupRetentionDays
output sqlBackupRedundancy string = sqlBackupRedundancy
output sqlAuditWorkspaceName string = logs.name
