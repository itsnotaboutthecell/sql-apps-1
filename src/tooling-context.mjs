import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { findProjectHome, readProjectManifest } from './project-contract.mjs';

async function packageName(directory) {
  try {
    const info = await lstat(join(directory, 'package.json'));
    if (!info.isFile() || info.isSymbolicLink()) return null;
    return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).name ?? null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function installedTooling(home) {
  try { await lstat(join(home, '.sql-apps-project.json')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const require = createRequire(join(home, 'package.json'));
  for (const modules of require.resolve.paths('@microsoft/sql-apps') ?? []) {
    const candidate = join(modules, '@microsoft', 'sql-apps');
    try { await lstat(candidate); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const [project, pkg] = await Promise.all([
      readProjectManifest(home),
      readFile(join(candidate, 'package.json'), 'utf8').then(JSON.parse),
    ]);
    if (pkg.name !== project.tooling.package || pkg.version !== project.tooling.version) {
      throw new Error('Installed SQL Apps tooling does not match the project pin; restore its exact version before continuing.');
    }
    return realpath(candidate);
  }
  return undefined;
}

export async function toolingHome(meta = import.meta.url) {
  if (process.env.SQL_APPS_PROJECT_HOME) {
    const installed = await installedTooling(process.env.SQL_APPS_PROJECT_HOME);
    if (installed) return installed;
  }
  let current = await realpath(dirname(fileURLToPath(meta)));
  const filesystemRoot = parse(current).root;
  while (true) {
    if (await packageName(current) === '@microsoft/sql-apps') return current;
    try {
      const [script, packageManifest] = await Promise.all([
        lstat(join(current, 'scripts', 'build-tooling-package.mjs')),
        lstat(join(current, 'packages', 'sql-apps', 'package.json')),
      ]);
      if (script.isFile() && packageManifest.isFile()) return current;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current === filesystemRoot) break;
    current = dirname(current);
  }
  throw Object.assign(new Error('SQL Apps tooling package root could not be resolved.'), {
    code: 'TOOLING_HOME_NOT_FOUND',
  });
}

export async function projectHome(env = process.env, cwd = process.cwd()) {
  if (env.SQL_APPS_PROJECT_HOME !== undefined) {
    if (typeof env.SQL_APPS_PROJECT_HOME !== 'string' || !env.SQL_APPS_PROJECT_HOME ||
        !isAbsolute(env.SQL_APPS_PROJECT_HOME)) {
      throw Object.assign(new Error('SQL_APPS_PROJECT_HOME must be an absolute project path.'), {
        code: 'PROJECT_PATH_UNSAFE',
      });
    }
    const home = await realpath(env.SQL_APPS_PROJECT_HOME);
    await readProjectManifest(home);
    return home;
  }
  return findProjectHome(cwd);
}
