import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from '../dist/src/process.js';

test('personal-free template contains only SWA Free and Azure SQL free-offer resources', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sql-apps-personal-free-infra-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'main.json');
  await run('az', ['bicep', 'build', '--file', resolve('infra', 'personal-free.bicep'), '--outfile', output]);
  const template = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(
    [...new Set(template.resources.map(resource => resource.type))].sort(),
    [
      'Microsoft.Sql/servers',
      'Microsoft.Sql/servers/databases',
      'Microsoft.Sql/servers/firewallRules',
      'Microsoft.Web/staticSites',
      'Microsoft.Web/staticSites/config',
    ],
  );
  const site = template.resources.find(resource => resource.type === 'Microsoft.Web/staticSites');
  assert.deepEqual(site.sku, { name: 'Free', tier: 'Free' });
  const server = template.resources.find(resource => resource.type === 'Microsoft.Sql/servers');
  assert.equal(server.properties.publicNetworkAccess, 'Enabled');
  assert.equal(server.properties.minimalTlsVersion, '1.2');
  const firewall = template.resources.find(resource => resource.type === 'Microsoft.Sql/servers/firewallRules');
  assert.equal(firewall.properties.startIpAddress, '0.0.0.0');
  assert.equal(firewall.properties.endIpAddress, '0.0.0.0');
  const database = template.resources.find(resource => resource.type === 'Microsoft.Sql/servers/databases');
  assert.equal(database.properties.useFreeLimit, true);
  assert.equal(database.properties.freeLimitExhaustionBehavior, 'AutoPause');
  assert.equal(database.properties.maxSizeBytes, 34359738368);
  assert.equal(database.properties.requestedBackupStorageRedundancy, 'Local');
  assert.equal(database.properties.autoPauseDelay, 60);
  assert.equal(database.properties.minCapacity, "[json('0.5')]");
  assert.deepEqual(template.variables.tags, {
    project: 'sql-apps',
    environment: "[parameters('environment')]",
    deployment: 'personal-free',
  });
  for (const resource of [site, server, database]) {
    assert.equal(resource.tags, "[variables('tags')]");
  }
  const forbidden = template.resources.filter(resource =>
    /Microsoft\.(App\/|ContainerRegistry|Network\/(?:virtualNetworks|privateEndpoints)|OperationalInsights|Insights\/components|KeyVault)/.test(resource.type));
  assert.deepEqual(forbidden, []);
  assert.equal(template.parameters.sqlAdministratorPassword.type, 'securestring');
  assert.equal(template.parameters.runtimePassword.type, 'securestring');
  assert.ok(Object.keys(template.outputs).every(name => !/password|secret|token|connection/i.test(name)));
});
