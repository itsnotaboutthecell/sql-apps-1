import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
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

export async function toolingHome(meta = import.meta.url) {
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
