import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';
import { z } from 'zod';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
interface ImageFixture { directory: string; local: boolean; entry?: string }

const buildCommands = new Map<string, (builder: string) => Promise<void>>([
  ['RUN npx tsc --project tsconfig.runtime.json && npm prune --omit=dev', builder =>
    isolated(builder, [require.resolve('typescript/lib/tsc.js'), '--project', 'tsconfig.runtime.json'])],
  ['RUN npm run build && npm prune --omit=dev', async builder => {
    const script = z.object({ scripts: z.object({ build: z.string().regex(/^node scripts\/[\w.-]+\.mjs$/) }) })
      .parse(JSON.parse(await readFile(join(builder, 'package.json'), 'utf8'))).scripts.build;
    await isolated(builder, [contained(builder, script.slice('node '.length))]);
  }],
]);

async function isolated(builder: string, args: string[]): Promise<void> {
  try {
    await execute(process.execPath, args, { cwd: builder, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  } catch (cause) {
    const stdout = cause instanceof Error && 'stdout' in cause && typeof cause.stdout === 'string' ? cause.stdout : '';
    const stderr = cause instanceof Error && 'stderr' in cause && typeof cause.stderr === 'string' ? cause.stderr : '';
    throw new Error(`Isolated image build failed:\n${stdout}${stderr}`, { cause });
  }
}

function contained(root: string, path: string): string {
  const candidate = resolve(root, ...path.split('/'));
  const location = relative(root, candidate);
  assert.ok(!isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`));
  return candidate;
}

async function dependencyLink(destination: string): Promise<void> {
  await symlink(resolve('node_modules'), destination, process.platform === 'win32' ? 'junction' : 'dir');
}

async function materializeFunctionsImage(
  t: TestContext, recipe: string, transform: (text: string) => string = text => text,
): Promise<ImageFixture> {
  const root = await mkdtemp(join(tmpdir(), 'sql-apps-functions-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const builder = join(root, 'builder');
  const image = join(root, 'image');
  await Promise.all([mkdir(builder), mkdir(image)]);
  await dependencyLink(join(builder, 'node_modules'));
  let stage = 0;
  let compiled = false;
  let entry: string | undefined;
  const instructions = transform(await readFile(recipe, 'utf8')).replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/);
  for (const instruction of instructions) {
    const line = instruction.trim();
    if (/^FROM\s/.test(line)) {
      stage++;
      assert.ok(stage <= 2, 'Update this bounded fixture explicitly for a new recipe stage');
    } else if (/^RUN\s/.test(line)) {
      assert.equal(stage, 1);
      if (line === 'RUN npm ci') continue;
      const action = buildCommands.get(line);
      assert.ok(action, `Update this bounded fixture explicitly for the build command: ${line}`);
      await action(builder);
      compiled = true;
    } else if (/^CMD\s/.test(line)) {
      const command = z.array(z.string()).parse(JSON.parse(line.slice(4).trim()));
      assert.deepEqual(command.slice(0, 1), ['node'], 'Only a node entry point is replayed');
      assert.equal(command.length, 2);
      entry = command[1];
    } else if (/^COPY\s/.test(line)) {
      const args = line.slice(5).trim().split(/\s+/);
      const fromBuild = args[0] === '--from=build';
      if (fromBuild) args.shift();
      if (args[0]?.startsWith('--chown=')) args.shift();
      assert.ok(args.every(arg => !arg.startsWith('--')), 'Unsupported COPY option');
      const destination = args.pop();
      assert.ok(destination && args.length);
      const destinationRoot = stage === 1 ? builder : image;
      for (const source of args) {
        const input = fromBuild ? source.replace(/^\/app\//, '') : source;
        const sourceRoot = fromBuild ? builder : process.cwd();
        if (fromBuild && input === 'node_modules') {
          await dependencyLink(contained(destinationRoot, destination));
          continue;
        }
        const name = basename(input);
        const pattern = new RegExp(`^${name.split('*')
          .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
        const directory = contained(sourceRoot, dirname(input));
        const names = name.includes('*') ? (await readdir(directory)).filter(value => pattern.test(value)) : [name];
        assert.ok(names.length, `COPY matched no files: ${source}`);
        for (const entry of names) {
          const target = contained(destinationRoot,
            destination.endsWith('/') || args.length > 1 || name.includes('*')
              ? `${destination}/${entry}` : destination);
          await mkdir(dirname(target), { recursive: true });
          await cp(join(directory, entry), target, { recursive: true });
        }
      }
    }
  }
  assert.equal(stage, 2);
  assert.equal(compiled, true);
  return { directory: image, local: basename(recipe) === 'local.Dockerfile', ...(entry ? { entry } : {}) };
}

async function assertImageModuleClosure(image: ImageFixture): Promise<void> {
  const manifest = z.object({ main: z.string().optional() })
    .parse(JSON.parse(await readFile(join(image.directory, 'package.json'), 'utf8')));
  const start = image.entry ?? manifest.main;
  assert.ok(start, 'The image must declare an entry point through CMD or package.json main');
  const pending = [contained(image.directory, start)];
  if (image.local) {
    const collect = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await collect(path);
        else if (/\.(?:js|mjs)$/.test(entry.name)) pending.push(path);
      }
    };
    await collect(join(image.directory, 'dist', 'src'));
  }
  const visited = new Set<string>();
  while (pending.length) {
    const file = pending.pop();
    assert.ok(file);
    if (visited.has(file)) continue;
    visited.add(file);
    const text = await readFile(file, 'utf8');
    for (const dependency of ts.preProcessFile(text, true, true).importedFiles) {
      if (!dependency.fileName.startsWith('.')) continue;
      const next = resolve(dirname(file), ...dependency.fileName.split('/'));
      contained(image.directory, relative(image.directory, next).split(sep).join('/'));
      pending.push(next);
    }
  }
}

for (const name of ['Dockerfile']) {
  test(`functions\\${name} compiles from its own inputs and ships its entry-point closure`, async t => {
    const image = await materializeFunctionsImage(t, resolve('functions', name));
    await assertImageModuleClosure(image);
  });
}

test('the gateway image compiles from its own inputs and ships its entry-point closure', async t => {
  const image = await materializeFunctionsImage(t, resolve('Dockerfile'));
  assert.equal(image.entry, 'dist/src/server.js');
  await assertImageModuleClosure(image);
  for (const required of ['dist/src/server.js', 'public/app.js', 'package.json']) {
    await readFile(contained(image.directory, required));
  }
});

test('the gateway clean room cannot borrow an omitted source directory from the checkout', async t => {
  await assert.rejects(materializeFunctionsImage(t, resolve('Dockerfile'), text =>
    text.replace(/^COPY scripts \.\/scripts\r?$/m, '')), /Isolated image build failed/);
});

test('clean-room compiler cannot borrow an omitted script from the checkout', async t => {
  await assert.rejects(materializeFunctionsImage(t, resolve('functions', 'local.Dockerfile'), text =>
    text.replace(/^COPY scripts\/workspace-check\.mjs scripts\/workspace-check\.d\.mts \.\/scripts\/\r?$/m, '')),
  /TS2307/);
});

test('local module closure rejects an omitted lock helper', async t => {
  const image = await materializeFunctionsImage(t, resolve('functions', 'local.Dockerfile'));
  await rm(join(image.directory, 'dist', 'src', 'file-lock.mjs'));
  await assert.rejects(assertImageModuleClosure(image), /file-lock\.mjs/);
});

test('local Functions image consumes only packaged implementation assets', async () => {
  const recipe = await readFile(resolve('functions', 'local.Dockerfile'), 'utf8');
  assert.match(recipe, /COPY dist\/src \.\/dist\/src/);
  assert.match(recipe, /COPY dist\/functions \.\/dist\/functions/);
  assert.match(recipe, /COPY assets\/functions\/local-package\.json \.\/package\.json/);
  assert.doesNotMatch(recipe, /COPY (?:src|scripts|functions) /);
  assert.doesNotMatch(recipe, /tsc|tsconfig/);
});
