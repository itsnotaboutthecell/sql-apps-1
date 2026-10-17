targetScope = 'resourceGroup'

param serverName string
param databaseName string
param location string
param tenantId string
param administratorObjectId string
param administratorName string
param clientIp string
@secure()
param administratorPassword string

resource server 'Microsoft.Sql/servers@2023-08-01' = {
  name: serverName
  location: location
  tags: {
    project: 'sql-apps'
    purpose: 'development-database'
  }
  properties: {
    version: '12.0'
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    administratorLogin: 'sqlappsbootstrap'
    administratorLoginPassword: administratorPassword
    administrators: {
      administratorType: 'ActiveDirectory'
      login: administratorName
      sid: administratorObjectId
      tenantId: tenantId
      azureADOnlyAuthentication: false
    }
  }
}

resource client 'Microsoft.Sql/servers/firewallRules@2023-08-01' = {
  parent: server
  name: 'SqlAppsDevelopmentClient'
  properties: {
    startIpAddress: clientIp
    endIpAddress: clientIp
  }
}

resource database 'Microsoft.Sql/servers/databases@2023-08-01' = {
  parent: server
  name: databaseName
  location: location
  sku: {
    name: 'GP_S_Gen5_2'
    tier: 'GeneralPurpose'
    family: 'Gen5'
    capacity: 2
  }
  properties: {
    useFreeLimit: true
    freeLimitExhaustionBehavior: 'AutoPause'
    autoPauseDelay: 60
    minCapacity: json('0.5')
    maxSizeBytes: 34359738368
    requestedBackupStorageRedundancy: 'Local'
    zoneRedundant: false
  }
}
