targetScope = 'resourceGroup'

@minLength(3)
@maxLength(20)
param name string = 'sqlapps'
@allowed(['dev', 'test', 'prod'])
param environment string
param registryServer string
param gatewayPrincipalId string
param dabPrincipalId string

var prefix = '${name}-${environment}'
var acrPull = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: split(registryServer, '.')[0]
}

resource pullRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (principal, index) in [gatewayPrincipalId, dabPrincipalId]: {
  name: guid(registry.id, ['gateway', 'data'][index], prefix, acrPull)
  scope: registry
  properties: {
    roleDefinitionId: acrPull
    principalId: principal
    principalType: 'ServicePrincipal'
  }
}]

output assignmentCount int = 2