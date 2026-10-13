import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deploymentSchema } from '../src/config.js';
import { buildArtifacts, imageDigest, imageFields } from '../src/artifacts.js';
import type { Run } from '../src/process.js';

const config = deploymentSchema.parse(JSON.parse(await readFile('sql-apps-foundation.example.json', 'utf8')));
const digest = `sha256:${'a'.repeat(64)}`;

test('artifact builds use ACR for all services and return immutable validated configuration', async () => {
  const calls: string[][] = [];
  const run: Run = async (command, args) => {
    calls.push([command, ...args]);
    return args[1] === 'repository' ? digest : '';
  };
  const result = await buildArtifacts(config, run);
  const builds = calls.filter(call => call.includes('build'));
  assert.equal(builds.length, 3);
  assert.deepEqual(builds.map(call => call[call.indexOf('--file') + 1]), [
    resolve('Dockerfile'), resolve('dab', 'Dockerfile'), resolve('functions', 'Dockerfile'),
  ]);
  assert.deepEqual(builds.map(call => call.at(-1)), [resolve('.'), resolve('.'), resolve('.')]);
  for (const field of imageFields) {
    assert.equal(result[field], `${config[field].split(':')[0]}@${digest}`);
  }
  assert.equal(config.gatewayImage.endsWith(':0.1.2'), true);
  assert.equal(calls.every(call => call.includes(config.subscriptionId)), true);
});

test('Docker build context excludes workspace-only state', async () => {
  const ignored = new Set((await readFile('.dockerignore', 'utf8')).split(/\r?\n/).filter(Boolean));
  for (const path of ['.git', '.worktrees', '.vscode', '.azure', '.sql-apps', 'sql-apps.json']) {
    assert.equal(ignored.has(path), true, `${path} must not enter remote ACR build contexts`);
  }
});

test('artifact builds fail explicitly and stop before later builds', async () => {
  let builds = 0;
  const run: Run = async (_command, args) => {
    if (args[1] === 'build' && ++builds === 2) throw new Error('ACR build failed');
    return args[1] === 'repository' ? digest : '';
  };
  await assert.rejects(buildArtifacts(config, run), /ACR build failed/);
  assert.equal(builds, 2);
});

test('builds reject digest outputs and colliding image references before side effects', async () => {
  let calls = 0;
  const run: Run = async () => { calls++; return ''; };
  await assert.rejects(buildArtifacts({ ...config, gatewayImage: `${config.registryServer}/gateway@${digest}` }, run), /version tags/);
  await assert.rejects(buildArtifacts({ ...config, dabImage: config.gatewayImage }, run), /distinct/);
  assert.equal(calls, 0);
});

test('image resolution rejects missing, malformed and mismatched digests', async () => {
  for (const value of ['', 'sha256:bad', 'error']) {
    await assert.rejects(imageDigest(config.gatewayImage, config, async () => value), /invalid digest/);
  }
  await assert.rejects(imageDigest(`${config.registryServer}/gateway@sha256:${'b'.repeat(64)}`, config, async () => digest), /mismatch/);
});
