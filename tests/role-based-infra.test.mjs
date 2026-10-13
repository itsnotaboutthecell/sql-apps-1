import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { run } from '../dist/src/process.js';

test('compiled templates deploy only private SQL, DAB and the gateway with trusted authorized settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sql-apps-role-based-infra-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'main.json');
  const rbacOutput = join(directory, 'rbac.json');
  await run('az', ['bicep', 'build', '--file', resolve('infra', 'main.bicep'), '--outfile', output]);
  await run('az', ['bicep', 'build', '--file', resolve('infra', 'rbac.bicep'), '--outfile', rbacOutput]);
  const template = JSON.parse(await readFile(output, 'utf8'));
  const rbac = JSON.parse(await readFile(rbacOutput, 'utf8'));
  assert.equal(template.parameters.profile, undefined, 'role-based-data is the only profile; nothing to select');
  assert.equal(template.variables?.fullFoundation, undefined);
  assert.equal(template.resources.some(resource =>
    /Microsoft\.(Storage|Web|KeyVault)\/|Microsoft\.Insights\/components/.test(resource.type)), false,
  'Functions, Storage, Key Vault and Application Insights belong to the maintained Azure skills, not SQL Apps');
  const audit = template.resources.find(resource => resource.type === 'Microsoft.Sql/servers/auditingSettings');
  assert.equal(audit.condition, undefined);
  assert.equal(audit.properties.state, 'Enabled');
  assert.equal(audit.properties.isAzureMonitorTargetEnabled, true);
  const auditLogs = template.resources.find(resource => resource.type === 'Microsoft.Insights/diagnosticSettings');
  assert.equal(auditLogs.condition, undefined);
  assert.ok(auditLogs.properties.logs.some(entry => entry.category === 'SQLSecurityAuditEvents' && entry.enabled));
  assert.match(JSON.stringify(auditLogs.properties.workspaceId), /workspaces/);
  const retention = template.resources.find(resource => resource.type === 'Microsoft.Sql/servers/databases/backupShortTermRetentionPolicies');
  assert.equal(retention.properties.retentionDays, "[parameters('sqlBackupRetentionDays')]");
  assert.equal(template.parameters.sqlBackupRetentionDays.defaultValue, 7);
  assert.equal(template.parameters.sqlBackupRetentionDays.maxValue, 35);
  assert.equal(template.parameters.sqlBackupRedundancy.defaultValue, 'Local', 'matches what 0.1.x role-based deployments already used');
  for (const key of ['sqlBackupRetentionDays', 'sqlBackupRedundancy', 'sqlAuditWorkspaceName']) {
    assert.ok(template.outputs[key], `status must be able to report ${key}`);
  }
  const sql = template.resources.find(resource => resource.type === 'Microsoft.Sql/servers');
  assert.equal(sql.properties.publicNetworkAccess, 'Disabled');
  assert.equal(sql.properties.administrators.azureADOnlyAuthentication, true);
  const sqlEndpoint = template.resources.find(resource => resource.name === 'sql-endpoint');
  assert.equal(sqlEndpoint.condition, undefined);
  const database = template.resources.find(resource => resource.type === 'Microsoft.Sql/servers/databases');
  assert.deepEqual(database.sku, { name: 'GP_S_Gen5_2', tier: 'GeneralPurpose', family: 'Gen5', capacity: 2 });
  assert.equal(database.properties.useFreeLimit, true);
  assert.equal(database.properties.freeLimitExhaustionBehavior, 'AutoPause');
  assert.equal(database.properties.autoPauseDelay, 60);
  const apps = template.resources.filter(resource => resource.type === 'Microsoft.App/containerApps');
  assert.equal(apps.length, 2);
  for (const resource of apps) {
    assert.equal(resource.properties.template.scale.minReplicas, 0);
    assert.equal(resource.properties.template.scale.maxReplicas, 2);
    assert.equal(resource.properties.template.containers[0].resources.cpu, "[json('0.5')]");
    assert.equal(resource.properties.template.containers[0].resources.memory, '1Gi');
    assert.equal(resource.properties.configuration.ingress.allowInsecure, false);
  }
  const data = apps.find(resource => resource.properties.template.containers[0].name === 'data');
  assert.equal(data.properties.configuration.ingress.external, false);
  const gateway = apps.find(resource => resource.properties.template.containers[0].name === 'gateway');
  assert.equal(gateway.properties.configuration.ingress.external, true);
  const env = JSON.stringify(gateway.properties.template.containers[0].env);
  assert.match(env, /SQL_APPS_REQUIRED_ROLE.*SQL_APPS_READINESS_PATH/);
  assert.equal(template.resources.some(resource => resource.type === 'Microsoft.Authorization/roleAssignments'), false,
    'ordinary infrastructure deployment must not require roleAssignments/write');
  const pulls = rbac.resources.find(resource => resource.copy?.name === 'pullRoles');
  assert.equal(pulls.copy.count, "[length(createArray(parameters('gatewayPrincipalId'), parameters('dabPrincipalId')))]");
  assert.deepEqual(Object.keys(rbac.parameters).filter(name => name.endsWith('PrincipalId')).sort(), ['dabPrincipalId', 'gatewayPrincipalId']);
  assert.equal(rbac.resources.length, 1, 'AcrPull for the two app identities is the only RBAC write');
  const workspace = template.resources.find(resource => resource.type === 'Microsoft.OperationalInsights/workspaces');
  assert.equal(workspace.properties.workspaceCapping.dailyQuotaGb, "[json('0.1')]");
});
