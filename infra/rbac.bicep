targetScope = 'resourceGroup'

@minLength(3)
@maxLength(20)
param name string = 'sqlapps'
@allowed(['dev', 'test', 'prod'])
param environment string
@allowed(['foundation', 'role-based-data'])
param profile string = 'foundation'
param registryServer string
param gatewayPrincipalId string
param dabPrincipalId string
param functionPrincipalId string = ''

var prefix = '${name}-${environment}'
var fullFoundation = profile == 'foundation'
var suffix = uniqueString(resourceGroup().id, prefix)
var storageName = 'sqlapps${suffix}'
var vaultName = 'sqlapps-${suffix}'
var blobContributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var blobOwner = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')
var queueContributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
var tableContributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
var secretsUser = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var acrPull = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource gatewayIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${prefix}-gateway'
}
resource functionIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = if (fullFoundation) {
  name: '${prefix}-functions'
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: split(registryServer, '.')[0]
}
resource files 'Microsoft.Storage/storageAccounts@2023-05-01' existing = if (fullFoundation) {
  name: storageName
}
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = if (fullFoundation) {
  parent: files
  name: 'default'
}
resource fileContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = if (fullFoundation) {
  parent: blobService
  name: 'files'
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = if (fullFoundation) {
  name: vaultName
}

resource pullRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for index in range(0, fullFoundation ? 3 : 2): {
  name: guid(registry.id, ['gateway', 'data', 'functions'][index], prefix, acrPull)
  scope: registry
  properties: {
    roleDefinitionId: acrPull
    principalId: index == 0 ? gatewayPrincipalId : index == 1 ? dabPrincipalId : functionPrincipalId
    principalType: 'ServicePrincipal'
  }
}]
resource gatewayStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (fullFoundation) {
  name: guid(fileContainer.id, gatewayIdentity.id, blobContributor)
  scope: fileContainer
  properties: {
    roleDefinitionId: blobContributor
    principalId: gatewayPrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource hostStorageRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for role in (fullFoundation ? [blobOwner, queueContributor, tableContributor] : []): {
  name: guid(files.id, functionIdentity.id, role)
  scope: files
  properties: {
    roleDefinitionId: role
    principalId: functionPrincipalId
    principalType: 'ServicePrincipal'
  }
}]
resource functionSecretsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (fullFoundation) {
  name: guid(vault.id, functionIdentity.id, 'secrets-user')
  scope: vault
  properties: {
    roleDefinitionId: secretsUser
    principalId: functionPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output assignmentCount int = fullFoundation ? 8 : 2
