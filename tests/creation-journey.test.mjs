import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { planProjectCreation, createProject } from '../scripts/projects.mjs';
import { creationSession } from '../src/creation-session.mjs';
import { stopCreationProcess } from '../scripts/creation.mjs';

test('approved creation opens a front door without app restore, preserves direct creation and stops only its owned helper', async t => {
  const userHome = await realpath(await mkdtemp(join(tmpdir(), 'sql-apps-creation-journey-')));
  let session;
  t.after(async () => {
    if (session) await stopCreationProcess(session.directory);
    await rm(userHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const source = resolve(import.meta.dirname, '..');
  const plan = await planProjectCreation(source, 'Progressive fixture', { userHome });
  assert.equal(plan.effects.some(effect => effect.includes('loopback')), true);
  await assert.rejects(createProject(source, 'Progressive fixture', { userHome, progressive: true, approval: 'wrong' }), /approve/i);
  const project = await createProject(source, 'Progressive fixture', {
    userHome, progressive: true, approval: plan.approval, browser: false, initializeGit: false,
  });
  session = await creationSession(project.path);
  const response = await fetch(project.launchUrl);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Bringing your application to life/);
  const workspace = JSON.parse(await readFile(join(project.path, '.sql-apps', 'workspace.json'), 'utf8'));
  assert.equal(workspace.version, 2);
  assert.equal(workspace.topology, 'front-door');
  const state = await (await fetch(`${project.launchUrl}/__sql_apps/progress`)).json();
  assert.equal(state.ready, false);
  assert.equal(state.capabilities.every(item => item.state !== 'verified'), true);
  await assert.rejects(readFile(join(project.path, 'node_modules', '@microsoft', 'sql-apps', 'package.json')), { code: 'ENOENT' });
});
