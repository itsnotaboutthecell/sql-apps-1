import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPersonalFreeArtifact } from '../src/personal-free-build.js';

test('personal-free build emits only static and managed Functions artifacts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sql-apps-personal-free-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'public'), { recursive: true });
  await writeFile(join(root, 'public', 'index.html'), '<main>Personal</main>');
  await writeFile(join(root, 'public', 'style.css'), 'main{display:block}');
  await writeFile(join(root, 'public', 'app.js'), 'document.body.dataset.ready="true";');
  await writeFile(join(root, 'public', 'staticwebapp.config.json'), JSON.stringify({
    routes: [{ route: '/api/*', allowedRoles: ['owner'] }],
  }));
  await writeFile(join(root, 'personal-free-api.json'), JSON.stringify({
    version: 1,
    authenticationProvider: 'aad',
    routes: [{
      method: 'GET',
      path: '/api/AppReady',
      procedure: { name: 'AppReady', parameters: {} },
    }],
  }));
  const destination = join(root, 'artifact');
  const manifest = await buildPersonalFreeArtifact(root, destination);
  assert.equal(manifest.version, 1);
  assert.deepEqual((await readdir(destination)).sort(), ['api', 'personal-free-build.json', 'static']);
  for (const file of [
    'static/index.html',
    'static/style.css',
    'static/app.js',
    'static/staticwebapp.config.json',
    'static/auth-config.json',
    'api/dist/index.mjs',
    'api/host.json',
    'api/package.json',
  ]) {
    assert.ok((await readFile(join(destination, file))).length > 0, file);
  }
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'static', 'auth-config.json'), 'utf8')), {
    mode: 'static-web-apps',
    provider: 'aad',
    readinessPath: '/api/AppReady',
  });
  const serialized = await readFile(join(destination, 'personal-free-build.json'), 'utf8');
  assert.doesNotMatch(serialized, /password|token|connection/i);
  assert.doesNotMatch(await readFile(join(destination, 'api', 'dist', 'index.mjs'), 'utf8'), /test-only-not-a-real-password/);
});
