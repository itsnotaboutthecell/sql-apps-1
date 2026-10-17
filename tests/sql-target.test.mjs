import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let targets;
try { targets = await import('../src/sql-target.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const azure = { version: 1, provider: 'azure', server: 'example.database.windows.net', database: 'development',
  subscriptionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', resourceGroup: 'development' };
const express = { version: 1, provider: 'express', instance: 'SQLEXPRESS', server: '127.0.0.1', port: 1433, database: 'development' };

test('SQL targets validate provider-specific nonsecret input', () => {
  assert.equal(typeof targets?.validateSqlTarget, 'function');
  for (const value of [azure, express, { version: 1, provider: 'container', container: 'owned-sql' }]) {
    assert.deepEqual(targets.validateSqlTarget(value), value);
  }
});

test('SQL targets reject credentials, invalid endpoints and unsupported selection', () => {
  assert.equal(typeof targets?.validateSqlTarget, 'function');
  for (const value of [
    { ...azure, password: 'secret' }, { ...azure, server: 'example.database.windows.net;Encrypt=False' },
    { ...azure, database: 'master' }, { ...azure, subscriptionId: '' }, { ...azure, resourceGroup: '../other' },
    { ...express, server: '0.0.0.0' }, { ...express, port: 0 }, { ...express, port: 65536 },
    { ...express, instance: 'sql;command' }, { version: 1, provider: 'sqlite' },
  ]) assert.throws(() => targets.validateSqlTarget(value), /SQL target/);
});

test('target fingerprints are canonical and distinguish databases and providers', () => {
  assert.equal(typeof targets?.sqlTargetFingerprint, 'function');
  assert.equal(targets.sqlTargetFingerprint(azure), targets.sqlTargetFingerprint(Object.fromEntries(Object.entries(azure).reverse())));
  assert.notEqual(targets.sqlTargetFingerprint(azure), targets.sqlTargetFingerprint({ ...azure, database: 'other' }));
  assert.notEqual(targets.sqlTargetFingerprint(azure), targets.sqlTargetFingerprint(express));
});

test('route recommendations preserve container then Azure then Express ordering', () => {
  assert.equal(typeof targets?.recommendSqlRoutes, 'function');
  const routes = [
    { provider: 'express', availability: 'ready', code: 'EXPRESS_FOUND' },
    { provider: 'azure', availability: 'action-required', code: 'AZURE_REVIEW' },
    { provider: 'container', availability: 'ready', code: 'SQL_IMAGE_CACHED' },
  ];
  assert.equal(targets.recommendSqlRoutes(routes).recommended, 'container');
  assert.equal(targets.recommendSqlRoutes(routes.map(route => route.provider === 'container' ? { ...route, availability: 'unavailable' } : route)).recommended, 'azure');
  assert.equal(targets.recommendSqlRoutes(routes.map(route => route.provider === 'express' ? route : { ...route, availability: 'unavailable' })).recommended, 'express');
});

test('unknown probes and explicit selections never cause automatic failover', () => {
  assert.equal(typeof targets?.recommendSqlRoutes, 'function');
  const routes = [
    { provider: 'container', availability: 'unknown', code: 'OWNERSHIP_UNKNOWN' },
    { provider: 'azure', availability: 'unavailable', code: 'AZURE_UNAVAILABLE' },
    { provider: 'express', availability: 'ready', code: 'EXPRESS_FOUND' },
  ];
  assert.equal(targets.recommendSqlRoutes(routes).recommended, undefined);
  assert.equal(targets.recommendSqlRoutes(routes, 'azure').recommended, 'azure');
  assert.equal(targets.recommendSqlRoutes(routes, 'azure').selectionRequired, false);
  assert.equal(targets.recommendSqlRoutes(routes).selectionRequired, true);
});

test('reading target selection is read-only, strict, workspace bound and backward compatible', async t => {
  assert.equal(typeof targets?.readSqlTarget, 'function');
  const home = await realpath(await mkdtemp(join(tmpdir(), 'sql-target-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await targets.readSqlTarget(home, 'original-sql'), { version: 1, provider: 'container', container: 'original-sql' });
  await mkdir(join(home, '.sql-apps'));
  await writeFile(join(home, '.sql-apps', 'sql-target.json'), JSON.stringify({ version: 1, home, target: azure }));
  assert.deepEqual(await targets.readSqlTarget(home, 'original-sql'), azure);
  await writeFile(join(home, '.sql-apps', 'sql-target.json'), JSON.stringify({ version: 1, home: `${home}-other`, target: azure }));
  await assert.rejects(targets.readSqlTarget(home, 'original-sql'), /another checkout/);
});
