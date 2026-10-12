import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROJECT_MANIFEST,
  findProjectHome,
  parseProjectManifest,
  readProjectManifest,
} from '../src/project-contract.mjs';

const validManifest = () => ({
  version: 1,
  id: 'b91d4857-9570-4d4b-a740-918471ca7e26',
  name: 'Customer Data',
  slug: 'customer-data',
  starter: 'data',
  profile: 'role-based-data',
  scaffoldVersion: 1,
  tooling: { package: '@microsoft/sql-apps', version: '1.2.3' },
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sql-apps-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeManifest(root, value = validManifest()) {
  await writeFile(join(root, PROJECT_MANIFEST), `${JSON.stringify(value)}\n`);
}

test('parses a valid version 1 manifest into a new normalized object', () => {
  const input = validManifest();
  const parsed = parseProjectManifest(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.tooling, input.tooling);
});

test('reads a valid manifest from a canonical project root', async t => {
  const root = await fixture(t);
  await writeManifest(root);
  const result = await readProjectManifest(root);
  assert.deepEqual(result, validManifest());
});

test('discovers the canonical project root from a nested directory', async t => {
  const root = await fixture(t);
  const nested = join(root, 'one', 'two');
  await mkdir(nested, { recursive: true });
  await writeManifest(root);
  assert.equal(await findProjectHome(nested), await realpath(root));
});

test('rejects unknown manifest and tooling fields', () => {
  assert.throws(
    () => parseProjectManifest({ ...validManifest(), extra: true }),
    { code: 'PROJECT_MANIFEST_INVALID' },
  );
  assert.throws(
    () => parseProjectManifest({
      ...validManifest(),
      tooling: { ...validManifest().tooling, extra: true },
    }),
    { code: 'PROJECT_MANIFEST_INVALID' },
  );
});

test('rejects an invalid UUID', () => {
  assert.throws(
    () => parseProjectManifest({ ...validManifest(), id: 'not-a-uuid' }),
    { code: 'PROJECT_MANIFEST_INVALID' },
  );
});

test('rejects an invalid starter and profile pair', () => {
  assert.throws(
    () => parseProjectManifest({ ...validManifest(), starter: 'data', profile: 'foundation' }),
    { code: 'PROJECT_MANIFEST_INVALID' },
  );
  assert.throws(
    () => parseProjectManifest({
      ...validManifest(),
      starter: 'files-jobs',
      profile: 'role-based-data',
    }),
    { code: 'PROJECT_MANIFEST_INVALID' },
  );
});

test('rejects a tooling version range', () => {
  assert.throws(
    () => parseProjectManifest({
      ...validManifest(),
      tooling: { package: '@microsoft/sql-apps', version: '^1.2.3' },
    }),
    { code: 'PROJECT_MANIFEST_INVALID' },
  );
});

test('reports a missing project', async t => {
  const root = await fixture(t);
  await assert.rejects(findProjectHome(root), { code: 'PROJECT_NOT_FOUND' });
});

test('rejects oversized and non-regular manifests', async t => {
  const oversized = await fixture(t);
  await writeFile(join(oversized, PROJECT_MANIFEST), 'x'.repeat(16 * 1024 + 1));
  await assert.rejects(readProjectManifest(oversized), { code: 'PROJECT_MANIFEST_INVALID' });

  const nonRegular = await fixture(t);
  await mkdir(join(nonRegular, PROJECT_MANIFEST));
  await assert.rejects(readProjectManifest(nonRegular), { code: 'PROJECT_PATH_UNSAFE' });
});

test('rejects linked manifests when the host supports links', async t => {
  const root = await fixture(t);
  const target = join(root, 'manifest-target.json');
  await writeFile(target, JSON.stringify(validManifest()));
  try {
    await symlink(target, join(root, PROJECT_MANIFEST), 'file');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
    const directoryTarget = join(root, 'manifest-target');
    await mkdir(directoryTarget);
    try {
      await symlink(directoryTarget, join(root, PROJECT_MANIFEST),
        process.platform === 'win32' ? 'junction' : 'dir');
    } catch (fallbackError) {
      if (!['EPERM', 'EACCES', 'ENOSYS'].includes(fallbackError.code)) throw fallbackError;
      t.skip(`links unavailable: ${fallbackError.code}`);
      return;
    }
  }
  await assert.rejects(readProjectManifest(root), { code: 'PROJECT_PATH_UNSAFE' });
  await assert.rejects(findProjectHome(root), { code: 'PROJECT_PATH_UNSAFE' });
});

test('canonicalizes a linked starting directory when the host supports links', async t => {
  const root = await fixture(t);
  const project = join(root, 'project');
  const alias = join(root, 'alias');
  await mkdir(join(project, 'nested'), { recursive: true });
  await writeManifest(project);
  try {
    await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.equal(await findProjectHome(join(alias, 'nested')), await realpath(project));
});
