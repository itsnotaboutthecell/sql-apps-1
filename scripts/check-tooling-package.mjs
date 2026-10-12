import { execFile } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staged = join(root, 'dist', 'tooling-package');
const excluded = new Set(['.git', '.sql-apps', 'examples', 'tests', 'node_modules', 'plugins']);

export async function validatePackageTree(directory = staged) {
  const paths = [];
  async function visit(current) {
    for (const entry of (await readdir(current)).sort()) {
      if (excluded.has(entry) || entry.startsWith('.env')) {
        throw new Error(`Excluded path in tooling package: ${join(current, entry)}`);
      }
      const path = join(current, entry);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Link in tooling package: ${path}`);
      if (!info.isDirectory() && !info.isFile()) throw new Error(`Non-regular package path: ${path}`);
      const packaged = relative(directory, path).replaceAll('\\', '/');
      paths.push(packaged);
      if (info.isDirectory()) await visit(path);
    }
  }
  await visit(directory);
  for (const path of paths) {
    const top = path.split('/')[0];
    if (!['bin', 'dist', 'assets', 'package.json', 'LICENSE', 'README.md'].includes(top)) {
      throw new Error(`Unexpected top-level package path: ${path}`);
    }
  }
  return paths;
}

export async function checkToolingPackage() {
  const pkg = JSON.parse(await readFile(join(staged, 'package.json'), 'utf8'));
  if (pkg.name !== '@microsoft/sql-apps' || pkg.private !== undefined) {
    throw new Error('Invalid staged tooling package metadata.');
  }
  await validatePackageTree(staged);

  await execute(process.execPath, [join(staged, 'bin', 'sql-apps.mjs'), '--help'], {
    cwd: root,
    windowsHide: true,
  });
  const npmCommand = process.platform === 'win32' ? process.env.ComSpec : 'npm';
  const npmArguments = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm pack .\\dist\\tooling-package --dry-run --json']
    : ['pack', './dist/tooling-package', '--dry-run', '--json'];
  const { stdout } = await execute(npmCommand, npmArguments, {
    cwd: root,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const report = JSON.parse(stdout);
  if (!Array.isArray(report) || report.length !== 1) throw new Error('Unexpected npm pack report.');
  for (const file of report[0].files ?? []) {
    const path = file.path.replaceAll('\\', '/');
    const top = path.split('/')[0];
    if (!['bin', 'dist', 'assets', 'package.json', 'LICENSE', 'README.md'].includes(top)) {
      throw new Error(`Unexpected packed path: ${path}`);
    }
  }
  console.log('Tooling package checks passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkToolingPackage().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
