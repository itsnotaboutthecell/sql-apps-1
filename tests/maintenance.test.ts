import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deploymentSchema, environmentKey } from '../src/config.js';
import type { DeploymentState } from '../src/deployment.js';
import { deployStatic, setSecret, updateImage } from '../src/maintenance.js';

const config = deploymentSchema.parse(JSON.parse(await readFile('sql-apps.example.json', 'utf8')));
const state: DeploymentState = {
  environmentKey: environmentKey(config), configHash: 'hash', stage: 'ready',
  outputs: {
    sqlServer: 'example.database.windows.net', databaseName: 'app',
    dabPrincipalId: config.apiClientId, gatewayPrincipalId: config.apiClientId,
    gatewayName: 'gateway', gatewayUrl: 'https://gateway.example', functionsName: 'functions',
    storageAccount: 'storage', networkId: '/network', vaultName: 'vault',
    sqlBackupRetentionDays: 7, sqlBackupRedundancy: 'Geo' as const, sqlAuditWorkspaceName: 'logs',
  },
};
test('image-only updates use native Azure commands without touching SQL', async () => {
  const calls: string[][] = [];
  const runner = async (command: string, args: readonly string[]) => { calls.push([command, ...args]); return ''; };
  await updateImage('gateway', config, state, runner);
  await updateImage('functions', config, state, runner);
  assert.deepEqual(calls.map(call => call.slice(0, 3)), [['az', 'containerapp', 'update'], ['az', 'functionapp', 'config']]);
  assert.equal(calls.some(call => call.includes('/Action:Publish')), false);
  assert.ok(calls[0]?.includes(config.gatewayImage));
  assert.ok(calls[1]?.includes(config.functionsImage));
});
test('secret commands reject invalid inputs and suppress secret output', async () => {
  const calls: string[][] = [];
  const runner = async (command: string, args: readonly string[]) => { calls.push([command, ...args]); return ''; };
  await assert.rejects(setSecret('../bad', 'value', config, state, runner));
  await assert.rejects(setSecret('valid', '', config, state, runner));
  assert.equal(calls.length, 0);
  await setSecret('valid', 'test-secret', config, state, runner);
  assert.deepEqual(calls[0]?.slice(-2), ['-o', 'none']);
});
test('static-only deployment preserves a pinned runtime and changes only public assets', async () => {
  const calls: string[][] = [];
  const current = `${config.registryServer}/sql-apps@sha256:${'a'.repeat(64)}`;
  let built = false;
  const runner = async (command: string, args: readonly string[]) => {
    calls.push([command, ...args]);
    return args.includes('repository') ? `sha256:${'b'.repeat(64)}` : args.includes('show') ? current : '';
  };
  const pinned = await deployStatic(config, state, runner, async () => { built = true; });
  assert.equal(built, true);
  assert.ok(calls[1]?.includes(`RUNTIME_IMAGE=${current}`));
  assert.ok(calls[1]?.includes('infra/static.Dockerfile'));
  assert.equal(calls.some(call => call.includes('/Action:Publish')), false);
  assert.equal(pinned.gatewayImage, `${config.registryServer}/sql-apps@sha256:${'b'.repeat(64)}`);
  assert.ok(calls.at(-1)?.includes(pinned.gatewayImage));
  await assert.rejects(deployStatic(config, state, async () => 'image:mutable', async () => {}), /pinned/);
});
