import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const helper = fileURLToPath(new URL('../scripts/sql-express.ps1', import.meta.url));
const harness = fileURLToPath(new URL('./sql-express-installer.ps1', import.meta.url));
const cases = [
  ['existing-instance', /already registered/, []],
  ['inventory-error', /inventory unavailable/, []],
  ['not-administrator', /administrator required/, ['administrator']],
  ['bad-hash', /hash does not match/, ['administrator', 'download', 'hash']],
  ['cached-bad-hash', /hash does not match/, ['administrator', 'hash']],
  ['bad-signature', /valid Microsoft signature/, ['administrator', 'download', 'hash', 'signature']],
  ['wrong-signer', /valid Microsoft signature/, ['administrator', 'download', 'hash', 'signature']],
  ['missing-certificate', /valid Microsoft signature/, ['administrator', 'download', 'hash', 'signature']],
  ['success', null, ['administrator', 'download', 'hash', 'signature', 'launch', 'verify']],
  ['restart', null, ['administrator', 'download', 'hash', 'signature', 'launch']],
  ['installer-error', /installer failed \(1603\)/, ['administrator', 'download', 'hash', 'signature', 'launch']],
  ['wrong-engine', /identity did not verify/, ['administrator', 'download', 'hash', 'signature', 'launch', 'verify']],
];

for (const [scenario, failure, calls] of cases) {
  test(`Express installer helper: ${scenario}`, { skip: process.platform !== 'win32' }, async t => {
    const home = await mkdtemp(join(tmpdir(), 'sql-apps-installer-guards-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', harness,
      '-Helper', helper, '-Scenario', scenario, '-Cache', home], { windowsHide: true, timeout: 15000 });
    const report = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
    assert.deepEqual(report.calls, calls);
    if (failure) {
      assert.match(report.failure, failure);
      assert.equal(report.exitCode, null);
    } else {
      assert.equal(report.failure, null);
      assert.equal(report.exitCode, scenario === 'restart' ? 3010 : 0);
    }
    if (calls.includes('launch')) {
      assert.deepEqual(report.arguments, [
        '/IACCEPTSQLSERVERLICENSETERMS', '/ENU', '/ACTION=Install', '/quiet',
        '/InstallPath="C:\\Program Files\\Microsoft SQL Server"',
      ]);
    }
  });
}
