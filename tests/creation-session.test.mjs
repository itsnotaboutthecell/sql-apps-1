import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialProgress } from '../src/creation-progress.mjs';
import { creationSession, updateCreation, writeCreationJson } from '../src/creation-session.mjs';

test('file control channel preserves identity and serializes concurrent coordinator updates', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sql-apps-creation-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'app'), directory = join(root, 'session');
  await mkdir(join(home, '.sql-apps'), { recursive: true });
  const snapshot = initialProgress({ home, name: 'Test', publicOrigin: 'http://127.0.0.1:30000',
    gatewayOrigin: 'http://127.0.0.1:30002', workspaceId: 'owned' });
  await writeCreationJson(join(directory, 'progress.json'), snapshot);
  await writeCreationJson(join(home, '.sql-apps', 'creation-session.json'),
    { version: 1, home, directory, sessionId: snapshot.sessionId });
  await Promise.all(Array.from({ length: 4 }, () => updateCreation(home, value => ({ ...value, sequence: value.sequence + 1 }))));
  assert.equal((await creationSession(home)).snapshot.sequence, 4);
  await assert.rejects(updateCreation(home, value => ({ ...value, home: root })), /identity/i);
  await writeFile(join(directory, 'progress.json'), '{broken');
  await assert.rejects(creationSession(home), SyntaxError);
});
