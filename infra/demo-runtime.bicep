targetScope = 'resourceGroup'

@description('Explicit Container App name and hostname prefix. Use a sqlapps-prefixed name for the SQL Apps starter; this must match the reviewed deployment target.')
param applicationName string
param selectedApplication string
param deploymentId string
param location string
param tags object
param environmentName string
param runtimeIdentityName string
param registryName string
param sqlServerName string
param databaseName string
@allowed([
  'starter'
  'hardened'
])
param securityPosture string
@description('Explicit supported Azure Static Web Apps resource location. This can differ from the Container Apps backend region.')
param staticWebAppLocation string
@minLength(3)
@maxLength(40)
param staticWebAppName string
@description('Approved selected gateway image pinned to its immutable sha256 digest.')
param gatewayImage string
@description('Approved selected DAB configuration image pinned to its immutable sha256 digest.')
param dabImage string

var ownedTags = union(tags, {
  'sql-apps-deployment': deploymentId
  'sql-apps-application': selectedApplication
  'sql-apps-profile': 'public-demo'
})

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}
resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: runtimeIdentityName
}
resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' existing = {
  name: registryName
}
resource sql 'Microsoft.Sql/servers@2023-08-01' existing = {
  name: sqlServerName
}

var starterRegistry = securityPosture == 'starter'
var registryCredentials = starterRegistry ? registry.listCredentials() : null

resource staticSite 'Microsoft.Web/staticSites@2023-12-01' = {
  name: staticWebAppName
  location: staticWebAppLocation
  tags: ownedTags
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  properties: {
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: 'Disabled'
  }
}

var publicOrigin = 'https://${staticSite.properties.defaultHostname}'

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: applicationName
  location: location
  tags: ownedTags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${runtimeIdentity.id}': {} } }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true, targetPort: 8080, transport: 'http', allowInsecure: false }
      secrets: starterRegistry ? [
        {
          name: 'registry-password'
          value: registryCredentials!.passwords[0].value
        }
      ] : []
      registries: starterRegistry ? [
        {
          server: registry.properties.loginServer
          username: registryCredentials!.username
          passwordSecretRef: 'registry-password'
        }
      ] : [
        {
          server: registry.properties.loginServer
          identity: runtimeIdentity.id
        }
      ]
    }
    template: {
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '10' } } }]
      }
      containers: [
        {
          name: 'gateway'
          image: gatewayImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '8080' }
            { name: 'SQL_APPS_PROFILE', value: 'public-demo' }
            { name: 'PUBLIC_ORIGIN', value: publicOrigin }
            { name: 'DAB_URL', value: 'http://127.0.0.1:5000' }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/health/live', port: 8080 }, initialDelaySeconds: 30, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/health/ready', port: 8080 }, initialDelaySeconds: 10, periodSeconds: 10 }
            { type: 'Startup', httpGet: { path: '/health/live', port: 8080 }, periodSeconds: 5, failureThreshold: 60 }
          ]
        }
        {
          name: 'data'
          image: dabImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'ASPNETCORE_URLS', value: 'http://127.0.0.1:5000' }
            { name: 'SQL_CONNECTION_STRING', value: 'Server=tcp:${sql.properties.fullyQualifiedDomainName},1433;Database=${databaseName};Authentication=Active Directory Managed Identity;User Id=${runtimeIdentity.properties.clientId};Encrypt=True;TrustServerCertificate=False;' }
          ]
        }
      ]
    }
  }
}

resource linkedBackend 'Microsoft.Web/staticSites/linkedBackends@2023-12-01' = {
  parent: staticSite
  name: 'linkedBackend'
  properties: {
    backendResourceId: app.id
    region: location
  }
}

output applicationId string = app.id
output publicUrl string = publicOrigin
output backendUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output staticWebAppName string = staticSite.name
