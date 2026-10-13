import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { run } from '../dist/src/process.js';
import { reviewRoleBasedCost } from '../dist/src/role-based-cost.js';

test('compiled authorized profile gates excluded resources and retains private SQL and trusted authorized settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sql-apps-role-based-infra-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'main.json');
  const rbacOutput = join(directory, 'rbac.json');
  await run('az', ['bicep', 'build', '--file', resolve('infra', 'main.bicep'), '--outfile', output]);
  await run('az', ['bicep', 'build', '--file', resolve('infra', 'rbac.bicep'), '--outfile', rbacOutput]);
  const template = JSON.parse(await readFile(output, 'utf8'));
  const rbac = JSON.parse(await readFile(rbacOutput, 'utf8'));
  assert.equal(template.parameters.profile.defaultValue, 'foundation');
  assert.deepEqual(template.parameters.profile.allowedValues, ['foundation', 'role-based-data']);
  assert.equal(template.variables.fullFoundation, "[equals(parameters('profile'), 'foundation')]");
  for (const resource of template.resources.filter(resource =>
    /Microsoft\.(Storage|Web|KeyVault)\/|Microsoft\.Insights\/components/.test(resource.type))) {
    assert.equal(resource.condition, "[variables('fullFoundation')]", `Excluded resource ${resource.type} must be gated`);
  }
  const audit = template.resources.find(resource => resource.type === 'Microsoft.Sql/servers/auditingSettings');
  assert.equal(audit.condition, undefined, 'SQL auditing must apply to both profiles');
  assert.equal(audit.properties.state, 'Enabled');
  assert.equal(audit.properties.isAzureMonitorTargetEnabled, true);
  const auditLogs = template.resources.find(resource => resource.type === 'Microsoft.Insights/diagnosticSettings');
  assert.equal(auditLogs.condition, undefined, 'SQL audit delivery must apply to both profiles');
  assert.ok(auditLogs.properties.logs.some(entry => entry.category === 'SQLSecurityAuditEvents' && entry.enabled));
  assert.match(JSON.stringify(auditLogs.properties.workspaceId), /workspaces/);
  const retention = template.resources.find(resource => resource.type === 'Microsoft.Sql/servers/databases/backupShortTermRetentionPolicies');
  assert.equal(retention.properties.retentionDays, "[parameters('sqlBackupRetentionDays')]");
  assert.equal(template.parameters.sqlBackupRetentionDays.defaultValue, 7);
  assert.equal(template.parameters.sqlBackupRetentionDays.maxValue, 35);
  assert.equal(template.parameters.sqlBackupRedundancy.defaultValue, 'Geo');
  for (const key of ['sqlBackupRetentionDays', 'sqlBackupRedundancy', 'sqlAuditWorkspaceName']) {
    assert.ok(template.outputs[key], `status must be able to report ${key}`);
  }
  for (const name of ['vault-endpoint', 'function-endpoint']) {
    assert.equal(template.resources.find(resource => resource.name === name).condition, "[variables('fullFoundation')]");
  }
  const sql = template.resources.find(resource => resource.type === 'Microsoft.Sql/servers');
  assert.equal(sql.properties.publicNetworkAccess, 'Disabled');
  assert.equal(sql.properties.administrators.azureADOnlyAuthentication, true);
  const sqlEndpoint = template.resources.find(resource => resource.name === 'sql-endpoint');
  assert.equal(sqlEndpoint.condition, undefined);
  const cost = reviewRoleBasedCost(JSON.parse(await readFile('azure-role-based-cost.example.json', 'utf8')));
  const database = template.resources.find(resource => resource.type === 'Microsoft.Sql/servers/databases');
  assert.equal(database.sku.name, cost.resources[0].sku);
  for (const resource of template.resources.filter(resource => resource.type === 'Microsoft.App/containerApps')) {
    assert.equal(resource.properties.template.scale.minReplicas, cost.resources[2].minReplicas);
    assert.equal(resource.properties.template.scale.maxReplicas, cost.resources[2].maxReplicas);
    assert.equal(resource.properties.template.containers[0].resources.cpu, "[json('0.5')]");
    assert.equal(resource.properties.template.containers[0].resources.memory, '1Gi');
    assert.equal(resource.properties.configuration.ingress.allowInsecure, false);
  }
  const data = template.resources.find(resource => resource.type === 'Microsoft.App/containerApps' &&
    resource.properties.template.containers[0].name === 'data');
  assert.equal(data.properties.configuration.ingress.external, false);
  const gateway = template.resources.find(resource => resource.type === 'Microsoft.App/containerApps' &&
    resource.properties.template.containers[0].name === 'gateway');
  assert.equal(gateway.properties.configuration.ingress.external, true);
  const env = gateway.properties.template.containers[0].env;
  assert.match(env, /if\(variables\('fullFoundation'\)/);
  assert.match(env, /SQL_APPS_PROFILE.*SQL_APPS_REQUIRED_ROLE.*SQL_APPS_READINESS_PATH/);
  assert.equal(template.resources.some(resource => resource.type === 'Microsoft.Authorization/roleAssignments'), false,
    'ordinary infrastructure deployment must not require roleAssignments/write');
  const pulls = rbac.resources.find(resource => resource.copy?.name === 'pullRoles');
  assert.match(pulls.copy.count, /if\(variables\('fullFoundation'\), 3, 2\)/);
  const storageRoles = rbac.resources.find(resource => resource.copy?.name === 'hostStorageRoles');
  assert.match(storageRoles.copy.count, /if\(variables\('fullFoundation'\).*createArray\(\)/);
  assert.equal(rbac.resources.find(resource => resource.properties?.roleDefinitionId === "[variables('blobContributor')]").condition,
    "[variables('fullFoundation')]");
  assert.equal(rbac.resources.find(resource => resource.properties?.roleDefinitionId === "[variables('secretsUser')]").condition,
    "[variables('fullFoundation')]");
  for (const name of ['gatewayPrincipalId', 'dabPrincipalId', 'functionPrincipalId']) {
    assert.ok(rbac.parameters[name], `RBAC handoff requires ${name}`);
  }
  const storageEndpoints = template.resources.find(resource => resource.copy?.name === 'storageEndpoints');
  assert.match(storageEndpoints.copy.count, /if\(variables\('fullFoundation'\).*createArray\(\)/);
});
