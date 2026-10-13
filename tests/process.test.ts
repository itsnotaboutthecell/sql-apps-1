import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/process.js';

test('command runner captures complete large output before resolving', async () => {
  const size = 2 * 1024 * 1024;
  const output = await run(process.execPath, ['-e', `process.stdout.write('x'.repeat(${size}))`]);
  assert.equal(output.length, size);
  assert.equal(output, 'x'.repeat(size));
});

test('command runner passes arguments literally without shell interpolation', async () => {
  const argument = 'value; & echo not-a-command $(anything) "quoted"';
  const output = await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', argument]);
  assert.equal(output, argument);
});

test('command runner redacts declared secret values from errors', async () => {
  const secret = 'test-only-sql-password';
  await assert.rejects(run(process.execPath, [
    '-e', 'process.stderr.write(process.argv.slice(1).join(" "));process.exitCode=7',
    'password', secret,
  ], { redact: [secret] }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /failed \(7\)/);
    assert.equal(error.message.includes(secret), false);
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
});

test('command runner rejects missing executables explicitly', async () => {
  await assert.rejects(run('sql-apps-nonexistent-command-df513f3a', []),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});
test('command runner supports input and per-command environment with explicit redaction', async () => {
  const value = 'test-only-environment-secret';
  const output = await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'SQL through stdin' });
  assert.equal(output, 'SQL through stdin');
  await assert.rejects(run(process.execPath,
    ['-e', 'process.stderr.write(process.env.TEST_SECRET);process.exitCode=1'],
    { env: { TEST_SECRET: value }, redact: [value] }),
  (error: unknown) => error instanceof Error && !error.message.includes(value) && error.message.includes('[REDACTED]'));
});

test('command runner can suppress all output from secret-returning commands', async () => {
  const value = 'unavailable-before-command-completes';
  await assert.rejects(run(process.execPath,
    ['-e', 'process.stdout.write(process.argv[1]);process.exitCode=1', value],
    { sensitiveOutput: true }),
  (error: unknown) => error instanceof Error &&
    !error.message.includes(value) && error.message.includes('sensitive command output omitted'));
});
