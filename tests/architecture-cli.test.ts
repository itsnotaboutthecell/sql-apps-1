import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { join, resolve } from 'node:path';
import { run } from '../src/process.js';

const cli = resolve('dist/src/cli.js');
const example = resolve('azure-architecture-intent.example.json');

test('architecture-plan compiles the example as pretty review-only JSON', async () => {
  const output = await run(process.execPath, [cli, 'architecture-plan', example]);
  const plan = JSON.parse(output);

  assert.equal(plan.authorized, false);
  assert.equal(plan.deployable, false);
  assert.deepEqual(plan.mandatoryCore, ['azure-sql-free', 'dab']);
  assert.match(plan.approval, /^[a-f0-9]{12}$/);
  assert.equal(plan.version, 1);
  assert.equal(output, `${JSON.stringify(plan, null, 2)}\n`);
});

test('architecture-plan rejects intent containing unknown resources', async t => {
  const directory = resolve('.sql-apps', `architecture-cli-invalid-${process.pid}`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'invalid.json');
  const intent = JSON.parse(await readFile(example, 'utf8'));
  await writeFile(path, JSON.stringify({ ...intent, resources: ['unknown-resource'] }));

  await assert.rejects(
    run(process.execPath, [cli, 'architecture-plan', path]),
    /resources/,
  );
});

test('architecture-plan requires exactly one intent path', async () => {
  await assert.rejects(
    run(process.execPath, [cli, 'architecture-plan']),
    /Usage: architecture-plan <architecture-intent\.json>/,
  );
  await assert.rejects(
    run(process.execPath, [cli, 'architecture-plan', example, 'extra']),
    /Usage: architecture-plan <architecture-intent\.json>/,
  );
});

test('help describes architecture-plan as offline read-only review, not approval', async () => {
  const output = await run(process.execPath, [cli, 'help']);

  assert.match(output, /architecture-plan/);
  assert.match(output, /offline.*read-only.*no Azure writes/i);
  assert.match(output, /no Azure calls/i);
  assert.match(output, /not deployment approval/i);
});

test('architecture-plan neither attempts Azure CLI execution nor mutates its input', async t => {
  const directory = resolve('.sql-apps', `architecture-cli-offline-${process.pid}`);
  const marker = join(directory, 'az-attempted');
  const preload = join(directory, 'reject-az.mjs');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(directory, { recursive: true });
  await writeFile(preload, `
    import childProcess from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = function(command, args, options) {
      if (command === 'az' || (command === 'where.exe' && args?.[0] === 'az')) {
        writeFileSync(${JSON.stringify(marker)}, 'attempted');
        throw new Error('architecture-plan attempted Azure CLI execution');
      }
      return originalSpawn.call(this, command, args, options);
    };
    syncBuiltinESMExports();
  `);
  const before = await readFile(example, 'utf8');

  await run(process.execPath, [cli, 'architecture-plan', example], {
    env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
  });

  assert.equal(existsSync(marker), false);
  assert.equal(await readFile(example, 'utf8'), before);
});
