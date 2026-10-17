import { lstat, mkdir, readdir, realpath, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectSource } from './workspace-check.mjs';
import { withFileLock } from '../src/file-lock.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist', 'tooling-package');
const assets = [
  '.config/dotnet-tools.json',
  '.config/host-dab/dotnet-tools.json',
  'scripts/sql-express.ps1',
  'src/web/app.ts',
  'sql',
  'dab',
  'public/index.html',
  'public/style.css',
  'public/staticwebapp.config.json',
  'public/auth/redirect.html',
  'infra',
  'Dockerfile',
  'runtime-contract.json',
];

function assertContained(parent, child) {
  const path = relative(parent, child);
  if (!path || path.startsWith('..') || isAbsolute(path)) {
    throw new Error(`Refusing unsafe tooling package path: ${child}`);
  }
}

async function copyEntry(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Runtime package inputs must not contain links: ${source}`);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of (await readdir(source)).sort()) {
      if (['.git', '.sql-apps', 'examples', 'tests', 'node_modules', 'plugins'].includes(entry) ||
          entry.startsWith('.env')) {
        throw new Error(`Excluded runtime package input: ${join(source, entry)}`);
      }
      await copyEntry(join(source, entry), join(destination, entry));
    }
    return;
  }
  if (!info.isFile()) throw new Error(`Runtime package inputs must be regular files: ${source}`);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function stageToolingPackage(destination) {
  const canonicalRoot = await realpath(root);
  const expected = resolve(destination);
  if (dirname(expected) !== join(canonicalRoot, 'dist')) {
    throw new Error('Tooling package output must be a direct child of dist.');
  }
  assertContained(canonicalRoot, expected);

  const source = await inspectSource(canonicalRoot, { toolingHome: canonicalRoot, foundation: true });
  if (!source.ready || !source.build?.ready) {
    throw new Error(`A successful current root build is required (${source.build?.code ?? source.code}).`);
  }

  try {
    const current = await lstat(expected);
    if (current.isSymbolicLink() || !current.isDirectory()) {
      throw new Error('Refusing to replace an unsafe tooling package output.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await rm(expected, { recursive: true, force: true });
  await mkdir(expected, { recursive: true });

  await copyEntry(join(canonicalRoot, 'packages', 'sql-apps', 'package.json'), join(expected, 'package.json'));
  await copyEntry(join(canonicalRoot, 'packages', 'sql-apps', 'bin'), join(expected, 'bin'));
  await copyEntry(join(canonicalRoot, 'dist', 'src'), join(expected, 'dist', 'src'));
  await copyEntry(join(canonicalRoot, 'dist', 'scripts'), join(expected, 'dist', 'scripts'));
  await copyEntry(join(canonicalRoot, 'LICENSE'), join(expected, 'LICENSE'));
  for (const asset of assets) {
    await copyEntry(join(canonicalRoot, asset), join(expected, 'assets', asset));
  }
  const app = join(expected, 'assets', 'src', 'web', 'app.ts');
  await writeFile(app, (await readFile(app, 'utf8')).replace("'../browser.js'", "'@microsoft/sql-apps/browser'"));
  console.log(`Tooling package staged at ${expected}`);
}

export async function buildToolingPackage(destination = output) {
  const target = resolve(destination);
  return withFileLock(`${target}-build.lock`, () => stageToolingPackage(target), 600);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildToolingPackage().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
