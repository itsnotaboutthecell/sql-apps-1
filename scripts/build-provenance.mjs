import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { cp, copyFile, lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectHome, toolingHome } from '../src/tooling-context.mjs';
import { inspectSource, recordBuild } from './workspace-check.mjs';

const execute = promisify(execFile);

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function compileTypeScript(project, tools, config) {
  const require = createRequire(join(tools, 'package.json'));
  try {
    const result = await execute(process.execPath, [require.resolve('typescript/lib/tsc.js'), '--project', config],
      { cwd: project, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw new Error(`TypeScript runtime build failed: ${error instanceof Error ? error.message : 'unknown error'}`, { cause: error });
  }
}

async function esbuild(tools) {
  const require = createRequire(join(tools, 'package.json'));
  return import(pathToFileURL(require.resolve('esbuild')).href);
}

async function buildFoundation(home) {
  await compileTypeScript(home, home, 'tsconfig.runtime.json');
  for (const module of [
    'workspace.mjs', 'file-lock.mjs', 'local-consent.mjs', 'local-auth.mjs',
    'role-based-rules.mjs', 'project-contract.mjs', 'tooling-context.mjs',
  ]) {
    await copyFile(join(home, 'src', module), join(home, 'dist', 'src', module));
  }
  await mkdir(join(home, 'dist', 'scripts'), { recursive: true });
  for (const script of [
    'build-provenance.mjs', 'setup.mjs', 'setup-check.mjs', 'guide.mjs', 'workspace-check.mjs',
    'local-consent.mjs', 'check-application.mjs',
  ]) {
    await copyFile(join(home, 'scripts', script), join(home, 'dist', 'scripts', script));
  }
  const { build } = await esbuild(home);
  await build({
    absWorkingDir: home,
    entryPoints: { app: 'src/web/app.ts', 'auth/redirect': 'src/web/auth-redirect.ts' },
    bundle: true, format: 'esm', outdir: 'public',
  });
  await mkdir(join(home, 'dist', 'src', 'web'), { recursive: true });
  await copyFile(join(home, 'src', 'web', 'developer.html'), join(home, 'dist', 'src', 'web', 'developer.html'));
  await build({
    absWorkingDir: home,
    entryPoints: [join(home, 'src', 'web', 'developer.ts')],
    bundle: true, format: 'esm', outfile: join(home, 'dist', 'src', 'web', 'developer.bundle.js'),
  });
}

async function buildProject(project, tools) {
  await mkdir(join(project, 'dist'), { recursive: true });
  await cp(join(tools, 'dist', 'src'), join(project, 'dist', 'src'), { recursive: true, force: true });
  if (await exists(join(tools, 'dist', 'functions'))) {
    await cp(join(tools, 'dist', 'functions'), join(project, 'dist', 'functions'), { recursive: true, force: true });
  }
  await compileTypeScript(project, tools, 'tsconfig.json');
  const { build } = await esbuild(tools);
  if (await exists(join(project, 'src', 'web', 'app.ts'))) {
    const entries = { app: join(project, 'src', 'web', 'app.ts') };
    if (await exists(join(project, 'src', 'web', 'auth-redirect.ts'))) {
      entries['auth/redirect'] = join(project, 'src', 'web', 'auth-redirect.ts');
    }
    await build({ absWorkingDir: project, entryPoints: entries, bundle: true, format: 'esm', outdir: join(project, 'public') });
  }
  if (await exists(join(project, 'src', 'web', 'developer.ts'))) {
    await mkdir(join(project, 'dist', 'src', 'web'), { recursive: true });
    await build({
      absWorkingDir: project,
      entryPoints: [join(project, 'src', 'web', 'developer.ts')],
      bundle: true, format: 'esm', outfile: join(project, 'dist', 'src', 'web', 'developer.bundle.js'),
    });
    if (await exists(join(project, 'src', 'web', 'developer.html'))) {
      await copyFile(join(project, 'src', 'web', 'developer.html'), join(project, 'dist', 'src', 'web', 'developer.html'));
    }
  }
}

export async function main() {
  const tools = await toolingHome(import.meta.url);
  let project;
  let foundation = false;
  try { project = await projectHome(); }
  catch (error) {
    if (error.code !== 'PROJECT_NOT_FOUND' || resolve(process.cwd()) !== tools) throw error;
    project = tools;
    foundation = true;
  }
  const source = await inspectSource(project, { toolingHome: tools, foundation });
  if (!source.ready) throw new Error(`Source preflight failed: ${source.code}`);
  if (foundation) await buildFoundation(project);
  else await buildProject(project, tools);
  await recordBuild(project, source.fingerprint, source.toolingFingerprint, { toolingHome: tools, foundation });
  console.log('Runtime built; project and tooling provenance recorded.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Build failed.');
    process.exitCode = 1;
  });
}
