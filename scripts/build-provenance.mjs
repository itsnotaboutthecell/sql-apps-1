import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir } from 'node:fs/promises';
import { inspectSource, recordBuild } from './workspace-check.mjs';

const home = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const source = await inspectSource(home);
if (!source.ready) throw new Error(`Source preflight failed: ${source.code}`);
try {
  const result = await execute(process.execPath, [require.resolve('typescript/lib/tsc.js'), '--project', 'tsconfig.runtime.json'],
    { cwd: home, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw new Error('TypeScript runtime build failed', { cause: error });
}
const { build } = await import('esbuild');
await copyFile(resolve(home, 'src', 'workspace.mjs'), resolve(home, 'dist', 'src', 'workspace.mjs'));
await copyFile(resolve(home, 'src', 'file-lock.mjs'), resolve(home, 'dist', 'src', 'file-lock.mjs'));
await copyFile(resolve(home, 'src', 'local-consent.mjs'), resolve(home, 'dist', 'src', 'local-consent.mjs'));
await copyFile(resolve(home, 'src', 'local-auth.mjs'), resolve(home, 'dist', 'src', 'local-auth.mjs'));
await copyFile(resolve(home, 'src', 'role-based-rules.mjs'), resolve(home, 'dist', 'src', 'role-based-rules.mjs'));
await copyFile(resolve(home, 'src', 'project-contract.mjs'), resolve(home, 'dist', 'src', 'project-contract.mjs'));
await mkdir(resolve(home, 'dist', 'scripts'), { recursive: true });
await copyFile(resolve(home, 'scripts', 'workspace-check.mjs'), resolve(home, 'dist', 'scripts', 'workspace-check.mjs'));
await build({ absWorkingDir: home, entryPoints: { app: 'src/web/app.ts', 'auth/redirect': 'src/web/auth-redirect.ts' },
  bundle: true, format: 'esm', outdir: 'public' });
await mkdir(resolve(home, 'dist', 'src', 'web'), { recursive: true });
await copyFile(resolve(home, 'src', 'web', 'developer.html'), resolve(home, 'dist', 'src', 'web', 'developer.html'));
await build({ absWorkingDir: home, entryPoints: [resolve(home, 'src', 'web', 'developer.ts')],
  bundle: true, format: 'esm', outfile: resolve(home, 'dist', 'src', 'web', 'developer.bundle.js') });
await recordBuild(home, source.fingerprint);
console.log('Runtime built; source and artifact provenance recorded.');
