import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../dist/src/process.js';
import { reviewDemoCost } from '../dist/src/demo-cost.js';

async function compile(t, name) {
  await assert.doesNotReject(access(resolve('infra', `${name}.bicep`)), `${name} template must exist`);
  const directory = await mkdtemp(join(tmpdir(), 'sql-apps-demo-infra-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, `${name}.json`);
  await run('az', ['bicep', 'build', '--file', resolve('infra', `${name}.bicep`), '--outfile', output]);
  return JSON.parse(await readFile(output, 'utf8'));
}

test('compiled minimal foundation has reviewed SQL sizing, narrow networking and no unrelated services', async t => {
  const template = await compile(t, 'demo');
  assert.equal(template.parameters.name.defaultValue, 'sqlapps');
  const resources = template.resources;
  assert.deepEqual(resources.map(resource => resource.type).sort(), [
    'Microsoft.App/managedEnvironments',
    'Microsoft.ContainerRegistry/registries',
    'Microsoft.Insights/diagnosticSettings',
    'Microsoft.ManagedIdentity/userAssignedIdentities',
    'Microsoft.Network/virtualNetworks',
    'Microsoft.OperationalInsights/workspaces',
    'Microsoft.Sql/servers',
    'Microsoft.Sql/servers/databases',
    'Microsoft.Sql/servers/virtualNetworkRules',
  ].sort());
  for (const field of ['sqlBillingMode', 'sqlSku', 'sqlMaxSizeBytes', 'sqlBackupRedundancy', 'location', 'tenantId', 'deploymentId', 'tags', 'securityPosture']) {
    assert.equal(Object.hasOwn(template.parameters[field], 'defaultValue'), false, `${field} must be explicit`);
  }
  const database = resources.find(resource => resource.type === 'Microsoft.Sql/servers/databases');
  assert.deepEqual(template.parameters.sqlBillingMode.allowedValues, ['free-paused', 'paid-reviewed']);
  assert.equal(template.variables.freeSql, "[equals(parameters('sqlBillingMode'), 'free-paused')]");
  assert.deepEqual(template.variables.freeSqlSku, { name: 'GP_S_Gen5_2', tier: 'GeneralPurpose', family: 'Gen5', capacity: 2 });
  assert.equal(database.sku, "[if(variables('freeSql'), variables('freeSqlSku'), parameters('sqlSku'))]");
  assert.match(database.properties, /useFreeLimit.*variables\('freeSql'\)/);
  assert.match(database.properties, /maxSizeBytes.*34359738368.*sqlMaxSizeBytes/);
  assert.match(database.properties, /requestedBackupStorageRedundancy.*Local.*sqlBackupRedundancy/);
  assert.match(database.properties, /if\(variables\('freeSql'\).*freeLimitExhaustionBehavior.*AutoPause.*autoPauseDelay.*60.*minCapacity.*0\.5/);
  assert.doesNotMatch(database.properties, /BillOverUsage|BillForUsage/);
  const sql = resources.find(resource => resource.type === 'Microsoft.Sql/servers');
  assert.equal(sql.properties.publicNetworkAccess, 'Enabled');
  assert.equal(sql.properties.minimalTlsVersion, '1.2');
  assert.equal(sql.properties.administrators.azureADOnlyAuthentication, true);
  assert.equal(Object.hasOwn(sql.properties, 'administratorLoginPassword'), false);
  const network = resources.find(resource => resource.type === 'Microsoft.Network/virtualNetworks');
  assert.equal(network.properties.subnets.length, 1);
  assert.deepEqual(network.properties.subnets[0].properties.serviceEndpoints.map(endpoint => endpoint.service), ['Microsoft.Sql']);
  assert.equal(network.properties.subnets[0].properties.addressPrefix, '10.43.0.0/27');
  const rule = resources.find(resource => resource.type === 'Microsoft.Sql/servers/virtualNetworkRules');
  assert.equal(rule.properties.ignoreMissingVnetServiceEndpoint, false);
  const registry = resources.find(resource => resource.type === 'Microsoft.ContainerRegistry/registries');
  assert.equal(registry.sku.name, 'Basic', 'Cost review must reflect the actual fixed-charge registry');
  assert.equal(registry.name, "[parameters('registryName')]");
  assert.equal(Object.hasOwn(template.parameters.registryName, 'defaultValue'), false);
  for (const key of ['sql-apps-deployment', 'sql-apps-application', 'sql-apps-profile']) {
    assert.ok(JSON.stringify(template.variables.ownedTags).includes(key), `Missing ownership tag ${key}`);
  }
  assert.equal(registry.properties.adminUserEnabled, "[variables('starterRegistry')]");
  assert.deepEqual(template.parameters.securityPosture.allowedValues, ['starter', 'hardened']);
  assert.equal(template.variables.starterRegistry, "[equals(parameters('securityPosture'), 'starter')]");
  assert.equal(resources.some(resource => resource.type === 'Microsoft.Authorization/roleAssignments'), false);
  assert.equal(registry.properties.policies.azureADAuthenticationAsArmPolicy.status, 'enabled');
  const environment = resources.find(resource => resource.type === 'Microsoft.App/managedEnvironments');
  assert.deepEqual(environment.properties.workloadProfiles, [{ name: 'Consumption', workloadProfileType: 'Consumption' }]);
  assert.equal(environment.properties.appLogsConfiguration.destination, 'azure-monitor');
  const workspace = resources.find(resource => resource.type === 'Microsoft.OperationalInsights/workspaces');
  assert.equal(workspace.properties.sku.name, 'PerGB2018');
  assert.equal(workspace.properties.workspaceCapping.dailyQuotaGb, '[json(\'0.1\')]',
    'The demo workspace must stay inside the free daily ingestion allowance');
  assert.equal(workspace.properties.retentionInDays, "[parameters('logRetentionDays')]");
  assert.equal(template.parameters.logRetentionDays.defaultValue, 30);
  assert.equal(template.parameters.logRetentionDays.maxValue, 90,
    'Retention beyond the included 31 days is billable; keep the reviewed ceiling');
  assert.equal(workspace.properties.features.disableLocalAuth, true);
  const diagnostics = resources.find(resource => resource.type === 'Microsoft.Insights/diagnosticSettings');
  assert.match(JSON.stringify(diagnostics.properties.workspaceId), /workspaces/);
  assert.deepEqual(diagnostics.properties.logs, [{ categoryGroup: 'allLogs', enabled: true }]);
  for (const key of ['runtimeIdentityResourceId', 'runtimeIdentityClientId', 'runtimeIdentityPrincipalId', 'sqlServerId', 'databaseId', 'subnetId', 'registryId', 'logsWorkspaceId']) {
    assert.ok(template.outputs[key], `Missing exact tracked resource output ${key}`);
  }
  assert.doesNotMatch(JSON.stringify(template), /0\.0\.0\.0|listCredentials|Microsoft\.Graph|Microsoft\.Web|Microsoft\.Storage|privateEndpoints/);
});

test('compiled runtime exposes an SWA-linked HTTPS gateway with internal DAB and one scale-to-zero replica', async t => {
  const template = await compile(t, 'demo-runtime');
  assert.equal(template.resources.length, 3);
  const staticSite = template.resources.find(resource => resource.type === 'Microsoft.Web/staticSites');
  assert.ok(staticSite);
  assert.equal(Object.hasOwn(template.parameters.staticWebAppLocation, 'defaultValue'), false);
  assert.equal(staticSite.location, "[parameters('staticWebAppLocation')]");
  assert.equal(staticSite.sku.name, 'Standard');
  assert.equal(staticSite.sku.tier, 'Standard');
  assert.equal(staticSite.properties.allowConfigFileUpdates, true);
  assert.equal(staticSite.properties.stagingEnvironmentPolicy, 'Disabled');
  const linked = template.resources.find(resource => resource.type === 'Microsoft.Web/staticSites/linkedBackends');
  assert.ok(linked);
  assert.match(linked.properties.backendResourceId, /Microsoft\.App\/containerApps/);
  assert.equal(linked.properties.region, "[parameters('location')]");
  const app = template.resources.find(resource => resource.type === 'Microsoft.App/containerApps');
  assert.ok(app);
  assert.equal(app.type, 'Microsoft.App/containerApps');
  assert.equal(app.properties.workloadProfileName, 'Consumption');
  assert.equal(app.properties.configuration.ingress.external, true);
  assert.equal(app.properties.configuration.ingress.allowInsecure, false);
  assert.equal(app.properties.configuration.ingress.targetPort, 8080);
  assert.equal(Object.hasOwn(app.properties.configuration.ingress, 'additionalPortMappings'), false);
  assert.equal(app.properties.configuration.activeRevisionsMode, 'Single');
  assert.deepEqual(template.parameters.securityPosture.allowedValues, ['starter', 'hardened']);
  assert.equal(template.variables.starterRegistry, "[equals(parameters('securityPosture'), 'starter')]");
  const registryConfiguration = JSON.stringify({
    secrets: app.properties.configuration.secrets,
    registries: app.properties.configuration.registries,
  });
  assert.match(registryConfiguration, /listCredentials/);
  assert.match(registryConfiguration, /registry-password/);
  assert.match(registryConfiguration, /passwordSecretRef/);
  assert.match(registryConfiguration, /runtimeIdentity/);
  assert.match(app.properties.configuration.registries,
    /starterRegistry.*passwordSecretRef.*registry-password.*identity.*runtimeIdentityName/);
  assert.doesNotMatch(JSON.stringify(template.parameters), /password|credential/i);
  assert.doesNotMatch(JSON.stringify(template.outputs), /password|credential/i);
  assert.equal(app.properties.template.scale.minReplicas, 0);
  assert.equal(app.properties.template.scale.maxReplicas, 1);
  assert.deepEqual(app.properties.template.containers.map(container => container.name), ['gateway', 'data']);
  const gateway = app.properties.template.containers[0];
  const data = app.properties.template.containers[1];
  const costs = reviewDemoCost(JSON.parse(await readFile('azure-demo-cost.example.json', 'utf8')));
  for (const selected of costs.compute.containers) {
    const container = app.properties.template.containers.find(container => container.name === selected.name);
    assert.ok(container, `Missing reviewed container ${selected.name}`);
    assert.equal(container.resources.cpu, `[json('${selected.vCpu}')]`);
    assert.equal(container.resources.memory, `${selected.memoryGiB}Gi`);
  }
  const memory = [gateway, data].reduce((sum, container) => sum + Number(container.resources.memory.replace('Gi', '')), 0);
  assert.equal(memory, costs.compute.resources.memoryGiB);
  assert.equal(app.properties.template.scale.minReplicas, costs.compute.minReplicas);
  assert.equal(app.properties.template.scale.maxReplicas, costs.compute.maxReplicas);
  assert.equal(gateway.image, "[parameters('gatewayImage')]");
  assert.equal(data.image, "[parameters('dabImage')]");
  assert.equal(gateway.env.find(variable => variable.name === 'SQL_APPS_PROFILE').value, 'public-demo');
  for (const key of ['sql-apps-deployment', 'sql-apps-application', 'sql-apps-profile']) {
    assert.ok(JSON.stringify(template.variables.ownedTags).includes(key), `Missing runtime ownership tag ${key}`);
  }
  assert.equal(gateway.env.find(variable => variable.name === 'DAB_URL').value, 'http://127.0.0.1:5000');
  assert.equal(
    gateway.env.find(variable => variable.name === 'PUBLIC_ORIGIN').value,
    "[format('https://{0}', reference(resourceId('Microsoft.Web/staticSites', parameters('staticWebAppName')), '2023-12-01').defaultHostname)]",
  );
  const connection = data.env.find(variable => variable.name === 'SQL_CONNECTION_STRING').value;
  assert.match(connection, /Active Directory Managed Identity/);
  assert.match(connection, /clientId/);
  assert.match(connection, /TrustServerCertificate=False/);
  assert.doesNotMatch(connection, /Password=/i);
  assert.deepEqual(data.env.filter(variable => /URLS|PORT/.test(variable.name)), [
    { name: 'ASPNETCORE_URLS', value: 'http://127.0.0.1:5000' },
  ]);
  assert.ok(gateway.probes.some(probe => probe.type === 'Readiness' && probe.httpGet.path === '/health/ready'));
  for (const key of ['publicUrl', 'backendUrl', 'staticWebAppName']) {
    assert.ok(template.outputs[key], `Missing runtime output ${key}`);
  }
  assert.doesNotMatch(JSON.stringify(template), /Simulator|Microsoft\.Graph|functionsImage/);
});
