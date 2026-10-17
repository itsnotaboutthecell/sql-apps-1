import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialProgress } from '../src/creation-progress.mjs';
import { readCreationJson, writeCreationJson } from '../src/creation-session.mjs';
import { startCreationProcess } from '../scripts/creation.mjs';

async function freeOrigin() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await new Promise(done => server.close(done));
  return origin;
}

async function stopOwnedProcess(pid) {
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) { if (error.code === 'ESRCH') return; throw error; }
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error('Owned front-door process did not stop.');
}

test('a failed process-receipt write stops the newly started front door', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sql-apps-creation-process-'));
  const home = join(root, 'app'), directory = join(root, 'session');
  let pid;
  t.after(async () => {
    if (pid) await stopOwnedProcess(pid);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(home);
  const snapshot = initialProgress({ home, name: 'Creation process test', workspaceId: 'fixture',
    publicOrigin: await freeOrigin(), gatewayOrigin: await freeOrigin() });
  await writeCreationJson(join(directory, 'progress.json'), snapshot);
  await writeCreationJson(join(home, '.sql-apps', 'creation-session.json'),
    { version: 1, home, directory, sessionId: snapshot.sessionId });

  let failure;
  try {
    await startCreationProcess(directory, process.cwd(), {
      writeReceipt: async (_path, receipt) => {
        pid = receipt.pid;
        throw new Error('process receipt write failed');
      },
    });
    pid = (await readCreationJson(join(directory, 'process.json'))).pid;
    await stopOwnedProcess(pid);
    pid = undefined;
    failure = new Error('process receipt writer was not used');
  } catch (error) { failure = error; }
  assert.match(failure?.message ?? '', /process receipt write failed/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
