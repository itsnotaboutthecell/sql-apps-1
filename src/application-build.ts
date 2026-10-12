import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, lstat, readdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { z } from 'zod';
import { inspectSource } from '../scripts/workspace-check.mjs';
import { runtimeFor } from './workspace.mjs';
import { saveJson, withDeploymentLock } from './deployment.js';
import { composeApplication, type ApplicationDefinition, type ApplicationProfile } from './application.js';
import { pinnedDabImage } from './artifacts.js';

const selection = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const path = z.string().min(1).refine(value => !isAbsolute(value) &&
  !value.split(/[\\/]/).some(part => !part || part === '..' || part === '.') && !value.includes(':'));
const route = z.strictObject({ method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), path: z.string().startsWith('/') });
const metadata = z.object({
  name: selection, capabilities: z.array(z.string().min(1)).min(1),
  profiles: z.array(z.enum(['local-simulation', 'public-demo'])).min(1),
  routes: z.array(route).min(1),
  inputs: z.strictObject({
    browser: path, html: path, css: path, sqlProject: path, sqlFiles: z.array(path).min(1), grants: path, dab: path,
    publicAcceptance: path,
  }),
  procedures: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)).min(1),
  sessions: z.strictObject({ create: z.string(), get: z.string(), delete: z.string(), ready: z.string() }),
});
const file = z.strictObject({ path, sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const manifestSchema = metadata.extend({
  version: z.literal(1), home: z.string(), workspaceId: z.string(),
  profile: z.enum(['local-simulation', 'public-demo']), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sources: z.array(file).min(1), files: z.array(file).min(1),
}).strict();
export type ApplicationBuildManifest = z.infer<typeof manifestSchema>;

async function checkedFile(home: string, name: string): Promise<Buffer> {
  const validated = path.parse(name);
  let current = resolve(home);
  for (const part of validated.split(/[\\/]/)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Selected application inputs/artifacts must not be symlinks');
  }
  if (!(await lstat(current)).isFile()) throw new Error('Selected application input is not a file');
  return readFile(current);
}
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
async function snapshots(home: string, names: readonly string[]) {
  return Promise.all([...new Set(names.map(name => name.replaceAll('\\', '/')))].sort((a, b) => a.localeCompare(b, 'en'))
    .map(async name => ({ path: name, sha256: digest(await checkedFile(home, name)) })));
}
async function deliveryFiles(home: string): Promise<string[]> {
  const names: string[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(join(home, directory), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Selected application artifacts must not be symlinks');
      const name = join(directory, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.name !== 'application-build.json') names.push(name);
    }
  }
  await visit('');
  return names;
}

export async function checkSelectedApplication(
  home: string, directory: string, profile: ApplicationProfile,
): Promise<ApplicationBuildManifest> {
  const source = await inspectSource(home, { foundation: true });
  const runtime = runtimeFor(undefined, source.home);
  const manifest = manifestSchema.parse(JSON.parse(await checkedFile(directory, 'application-build.json').then(value => value.toString('utf8'))));
  const base = join(runtime.stateDirectory, 'applications');
  const location = relative(base, resolve(directory));
  if (runtime.mode !== 'isolated' || manifest.home !== source.home || manifest.workspaceId !== runtime.id ||
      location.startsWith('..') || isAbsolute(location)) throw new Error('Selected application build belongs to another workspace');
  if (manifest.profile !== profile || !manifest.profiles.includes(profile)) throw new Error('Selected application build profile mismatch');
  if (!source.ready || manifest.sourceFingerprint !== source.fingerprint ||
      JSON.stringify(await snapshots(home, manifest.sources.map(item => item.path))) !== JSON.stringify(manifest.sources)) {
    throw new Error('Selected application source changed; rebuild before using this artifact');
  }
  const actual = await snapshots(directory, await deliveryFiles(directory));
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Selected application artifact changed; rebuild before using it');
  return manifest;
}

export async function buildSelectedApplication(home: string, name: string, profile: ApplicationProfile) {
  if (!selection.safeParse(name).success) throw new Error('Invalid application selection');
  const source = await inspectSource(home, { foundation: true });
  if (!source.ready || !source.fingerprint) throw new Error(`Selected source preflight failed: ${source.code}`);
  home = source.home;
  const runtime = runtimeFor(undefined, home);
  if (runtime.mode !== 'isolated') throw new Error('Selected application requires an explicitly initialized isolated workspace');
  const sourceRoot = join('examples', name);
  await checkedFile(home, join(sourceRoot, 'application.ts'));
  const base = join(runtime.stateDirectory, 'applications', name, profile);
  return withDeploymentLock(join(base, 'build'), async () => {
    const temporary = join(base, `artifact-${randomUUID()}`);
    let published = false;
    await mkdir(join(temporary, 'server'), { recursive: true });
    try {
      const output = await build({
        absWorkingDir: home,
        stdin: { contents: `
import { application } from ${JSON.stringify(`./examples/${name}/application.ts`)};
import { createDemoApplication } from './src/demo-app.ts';
export { application };
export const createApplication = (options, fetcher) => createDemoApplication(application, options, fetcher);
`, resolveDir: home, sourcefile: 'selected-application.ts' },
        bundle: true, platform: 'node', format: 'esm', packages: 'external', metafile: true,
        outfile: join(temporary, 'server', 'application.mjs'),
      });
      const bundled = Object.keys(output.metafile.inputs).filter(input => input !== 'selected-application.ts' && !input.split(/[\\/]/).includes('node_modules'));
      const checkImports = (inputs: readonly string[]) => {
        for (const input of inputs) {
          const normalized = input.replaceAll('\\', '/');
          if (normalized.startsWith('examples/') && !normalized.startsWith(`examples/${name}/`)) {
            throw new Error('Selected application cannot import an unselected example');
          }
        }
      };
      checkImports(bundled);
      const loaded: unknown = await import(pathToFileURL(join(temporary, 'server', 'application.mjs')).href);
      if (typeof loaded !== 'object' || loaded === null || !('application' in loaded)) throw new Error('Selected application must export its definition');
      const definition = metadata.extend({
        register: z.custom<ApplicationDefinition['register']>(value => typeof value === 'function'),
      }).strict().parse(loaded.application);
      if (definition.name !== name || !definition.profiles.includes(profile)) throw new Error('Selected application name/profile mismatch');
      for (const supported of definition.profiles) {
        const inspected = await composeApplication(definition, {
          profile: supported, capabilities: ['data', 'visitor-sessions'],
          async register() {}, async ready() {},
          async subject() { throw new Error('Build inspection cannot authorize a request'); },
          async execute() { throw new Error('Build inspection cannot execute data procedures'); },
        });
        await inspected.close();
      }
      const required = [join(sourceRoot, 'application.ts'), ...[
        definition.inputs.browser, definition.inputs.html, definition.inputs.css, definition.inputs.sqlProject,
        ...definition.inputs.sqlFiles, definition.inputs.grants, definition.inputs.dab, definition.inputs.publicAcceptance,
      ].map(input => join(sourceRoot, input)), ...(profile === 'public-demo' ? ['public/staticwebapp.config.json'] : [])];
      const sources = await snapshots(home, [...required, ...bundled, 'package.json', 'package-lock.json']);
      for (const folder of ['public', 'static', 'sql', 'setup', 'dab']) await mkdir(join(temporary, folder));
      await build({
        absWorkingDir: home, entryPoints: [join(sourceRoot, definition.inputs.browser)],
        bundle: true, format: 'esm', outfile: join(temporary, 'public', 'app.js'), metafile: true,
      }).then(async browser => {
        const inputs = Object.keys(browser.metafile.inputs).filter(input => !input.split(/[\\/]/).includes('node_modules'));
        checkImports(inputs);
        const extra = await snapshots(home, inputs.filter(input => !sources.some(item => item.path === input.replaceAll('\\', '/'))));
        sources.push(...extra);
        sources.sort((a, b) => a.path.localeCompare(b.path, 'en'));
      });
      await mkdir(join(temporary, 'acceptance'));
      await build({
        absWorkingDir: home, entryPoints: [join(sourceRoot, definition.inputs.publicAcceptance)],
        bundle: true, platform: 'node', format: 'esm', outfile: join(temporary, 'acceptance', 'public.mjs'), metafile: true,
      }).then(async acceptance => {
        const inputs = Object.keys(acceptance.metafile.inputs).filter(input => !input.split(/[\\/]/).includes('node_modules'));
        checkImports(inputs);
        const extra = await snapshots(home, inputs.filter(input => !sources.some(item => item.path === input.replaceAll('\\', '/'))));
        sources.push(...extra);
        sources.sort((a, b) => a.path.localeCompare(b.path, 'en'));
      });
      const copies = [
        [join(sourceRoot, definition.inputs.html), 'public/index.html'],
        [join(sourceRoot, definition.inputs.css), 'public/app.css'],
        [join(sourceRoot, definition.inputs.sqlProject), 'sql/database.sqlproj'],
        [join(sourceRoot, definition.inputs.grants), 'setup/grants.sql'],
        [join(sourceRoot, definition.inputs.dab), 'dab/dab-config.json'],
        ['package-lock.json', 'package-lock.json'],
        ...definition.inputs.sqlFiles.map(input => {
          const local = relative(dirname(definition.inputs.sqlProject), input);
          path.parse(local);
          return [join(sourceRoot, input), join('sql', local)];
        }),
      ];
      if (new Set(copies.map(([, target]) => target)).size !== copies.length) throw new Error('Selected inputs have conflicting delivery paths');
      for (const [input, target] of copies) {
        await mkdir(dirname(join(temporary, target!)), { recursive: true });
        await checkedFile(home, input!);
        await copyFile(join(home, input!), join(temporary, target!));
      }
      if (profile === 'public-demo') {
        for (const name of ['index.html', 'app.css', 'app.js']) {
          await copyFile(join(temporary, 'public', name), join(temporary, 'static', name));
        }
        await copyFile(join(home, 'public', 'staticwebapp.config.json'),
          join(temporary, 'static', 'staticwebapp.config.json'));
      }
      const pkg = z.object({ scripts: z.record(z.string(), z.string()).optional() }).passthrough()
        .parse(JSON.parse(await readFile(join(home, 'package.json'), 'utf8')));
      await saveJson(join(temporary, 'package.json'), { ...pkg, scripts: { start: 'node server/start.mjs' } });
      await saveJson(join(temporary, 'application.json'), { name, selectedExamples: [name] });
      await writeFile(join(temporary, 'server', 'start.mjs'), `
import { createApplication } from './application.mjs';
const profile = process.env.SQL_APPS_PROFILE;
if (!['local-simulation', 'public-demo'].includes(profile)) throw new Error('Explicit SQL_APPS_PROFILE is required');
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Explicit valid PORT is required');
if (!process.env.PUBLIC_ORIGIN || !process.env.DAB_URL) throw new Error('PUBLIC_ORIGIN and internal DAB_URL are required');
const publicDemo = profile === 'public-demo';
const app = await createApplication({profile, origin:process.env.PUBLIC_ORIGIN, dabUrl:process.env.DAB_URL,
  transport:publicDemo?'static-web-apps':'direct', ...(publicDemo?{}:{publicDirectory:'public'})});
await app.listen({host:profile === 'public-demo' ? '0.0.0.0' : '127.0.0.1', port});
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { void app.close(); });
`);
      const imageLabels = `LABEL io.sql-apps.application="${name}" \\
      io.sql-apps.profile="${profile}" \\
      io.sql-apps.source-fingerprint="${source.fingerprint}" \\
      io.sql-apps.selected-inputs-fingerprint="${digest(JSON.stringify(sources))}" \\
      io.sql-apps.routes-fingerprint="${digest(JSON.stringify(definition.routes))}"`;
      await writeFile(join(temporary, '.dockerignore'), `*
!Dockerfile
!package.json
!package-lock.json
!server/
!server/**
${profile === 'local-simulation' ? '!public/\n!public/**' : ''}
!dab/
!dab/**
`);
      await writeFile(join(temporary, 'dab', 'Dockerfile'), `FROM ${pinnedDabImage}
${imageLabels}
COPY dab/dab-config.json /App/dab-config.json
`);
      await writeFile(join(temporary, 'Dockerfile'), `FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e
${imageLabels}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node server ./server
${profile === 'local-simulation' ? 'COPY --chown=node:node public ./public' : ''}
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node","server/start.mjs"]
`);
      const current = await inspectSource(home, { foundation: true });
      if (current.fingerprint !== source.fingerprint || JSON.stringify(await snapshots(home, sources.map(item => item.path))) !== JSON.stringify(sources)) {
        throw new Error('Selected source changed during build; no artifact was published');
      }
      const { register: _register, ...description } = definition;
      const manifest: ApplicationBuildManifest = {
        ...description, version: 1, home, workspaceId: runtime.id, profile,
        sourceFingerprint: source.fingerprint!, sources, files: await snapshots(temporary, await deliveryFiles(temporary)),
      };
      await saveJson(join(temporary, 'application-build.json'), manifest);
      await checkSelectedApplication(home, temporary, profile);
      published = true;
      return { directory: temporary, manifest };
    } finally {
      if (!published) await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
}
