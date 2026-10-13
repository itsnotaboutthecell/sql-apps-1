import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, readdir, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join, isAbsolute, relative } from 'node:path';
import { runtimeFor, readWorkspace, describeWorkspace } from './workspace.mjs';
import { withFileLock } from './file-lock.mjs';
import { readProjectManifest } from './project-contract.mjs';
import { toolingHome } from './tooling-context.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const launchOperations = { 'role-based-data': 'app' };
export const SQL_TERMS = Object.freeze({
  url: 'https://aka.ms/azuresqldb-container',
  statement: 'Local SQL startup passes ACCEPT_EULA=Y to the Azure SQL Database container (private preview). ' +
    'I have reviewed the container documentation at https://aka.ms/azuresqldb-container and the preview terms supplied with my ' +
    'registry access, and I accept them for this checkout\'s local SQL container. This accepts no other license.',
});
const readOnly = new Set(['help', 'workspace-plan', 'verify', 'app-check']);
const scopeNames = ['restore', 'build', 'workspace', 'sql-start', 'schema', 'services', 'synthetic', 'stop', 'maintenance'];
const runtimeCommands = new Set([
  'app', 'serve', 'role-based-app', 'role-based-serve', 'start-sql', 'init', 'test', 'data', 'app-test', 'stop',
  'recover-sql', 'selected-app', 'selected-serve', 'selected-stop', 'selected-test',
]);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

async function stateDirectory(home, create = false) {
  const directory = join(home, '.sql-apps');
  if (create) await mkdir(directory, { recursive: true });
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Consent state directory must not be a symlink');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return directory;
}

async function readJson(path) {
  let text;
  try { text = (await regularFile(path, 64 * 1024)).toString('utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { return JSON.parse(text); }
  catch { throw new Error('Invalid consent JSON; review it without resetting state'); }
}

async function readState(home) {
  const directory = await stateDirectory(home);
  const state = await readJson(join(directory, 'consent.json'));
  if (state === null) return { version: 1, home, grants: [] };
  object(state, ['version', 'home', 'grants'], 'consent state');
  if (state.version !== 1 || state.home !== home) throw new Error('Consent state belongs to another checkout or version');
  if (!Array.isArray(state.grants) || state.grants.length > 100) throw new Error('Invalid consent grants');
  for (const grant of state.grants) {
    object(grant, ['scope', 'contract', 'savedAt', 'once'], 'consent grant');
    if (!scopeNames.includes(grant.scope) || !validHash(grant.contract) || !validTime(grant.savedAt) ||
        typeof grant.once !== 'boolean') throw new Error('Invalid consent grant');
  }
  return state;
}

async function termsAcknowledged(home) {
  const directory = await stateDirectory(home);
  const terms = await readJson(join(directory, 'terms.json'));
  if (!terms) return false;
  object(terms, ['version', 'home', 'document', 'url', 'sha256', 'acknowledgedAt'], 'terms acknowledgement');
  if (terms.version !== 1 || terms.home !== home) throw new Error('Terms acknowledgement belongs to another checkout or version');
  if ((terms.url === undefined) === (terms.document === undefined) || !validHash(terms.sha256) || !validTime(terms.acknowledgedAt)) {
    throw new Error('Invalid terms acknowledgement');
  }
  if (terms.url !== undefined) return terms.url === SQL_TERMS.url && terms.sha256 === digest(SQL_TERMS.statement);
  if (!isAbsolute(terms.document)) throw new Error('Invalid terms acknowledgement');
  let bytes;
  try { bytes = await regularFile(terms.document, 4 * 1024 * 1024); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  return digest(bytes) === terms.sha256;
}

async function withStateLock(home, action) {
  const directory = await stateDirectory(home, true);
  return withFileLock(join(directory, 'consent.lock'), () => action(directory), 50);
}

async function saveState(directory, name, state) {
  const temporary = join(directory, `${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, name));
  } finally {
    try { await unlink(temporary); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid ${label}`);
}

async function regularFile(path, maximum = 1024 * 1024) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) {
    throw new Error('Consent inputs must be bounded regular files, not symlinks');
  }
  const bytes = await readFile(path);
  if (bytes.length > maximum) throw new Error('Consent input exceeds its size limit');
  return bytes;
}

async function inputHashes(home, paths) {
  const hashes = [];
  async function visit(name) {
    const path = join(home, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Consent inputs must not be symlinks');
    if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort()) {
        if (!['bin', 'obj', 'node_modules'].includes(child)) await visit(join(name, child));
      }
    } else hashes.push([name.replaceAll('\\', '/'), digest(await regularFile(path))]);
  }
  for (const path of paths) await visit(path);
  return hashes;
}

async function consentInputs(home) {
  try {
    const project = await readProjectManifest(home);
    const tools = await toolingHome(import.meta.url);
    const pkg = JSON.parse(await regularFile(join(tools, 'package.json')));
    return { generated: true, tools, packaged: pkg.name === '@microsoft/sql-apps', version: project.tooling.version };
  } catch (error) {
    if (!['PROJECT_MANIFEST_INVALID', 'PROJECT_PATH_UNSAFE'].includes(error.code)) throw error;
    return { generated: false, tools: home, packaged: false, version: null };
  }
}

function toolingInput(path, packaged) {
  if (!packaged) return path;
  if (path.startsWith('src/') && path.endsWith('.ts')) return `dist/${path.slice(0, -3)}.js`;
  if (path.startsWith('scripts/')) return `dist/${path}`;
  return path;
}

async function requirementsFor(home, request, proposed) {
  object(request, ['operation', 'selection'], 'consent request');
  const { operation, selection } = request;
  if (typeof operation !== 'string' || (selection !== undefined &&
      (typeof selection !== 'string' || !selection || selection.length > 4096))) throw new Error('Invalid consent request');
  if (readOnly.has(operation)) return [];
  if (!['restore', 'build', 'workspace-init'].includes(operation) && !runtimeCommands.has(operation)) {
    throw new Error(`Unsupported consent operation: ${operation}. Use restore, build, workspace-init <base-port|legacy>, ${[...runtimeCommands].join(', ')}`);
  }
  if (operation === 'app-test' && selection !== undefined) {
    throw new Error('app-test takes no container selection; it tests the selected workspace gateway');
  }
  const requirements = [];
  const context = await consentInputs(home);
  let artifact;
  const add = async (scope, target, effects, paths = [], reusable = true, artifactPaths = []) => {
    const projectPaths = context.generated
      ? paths.filter(path => !path.startsWith('src/') && !path.startsWith('scripts/'))
      : paths;
    const implementationPaths = context.generated
      ? paths.filter(path => path.startsWith('src/') || path.startsWith('scripts/'))
        .map(path => toolingInput(path, context.packaged))
      : [];
    const inputs = await inputHashes(home, projectPaths);
    if (context.generated) {
      inputs.push(['tooling/version', digest(context.version)]);
      inputs.push(...(await inputHashes(context.tools, ['package.json', ...implementationPaths]))
        .map(([name, hash]) => [`tooling/${name}`, hash]));
    }
    if (artifactPaths.length) {
      inputs.push(['artifact-contract', digest(JSON.stringify({
        name: artifact.name, profile: artifact.profile, capabilities: artifact.capabilities,
        routes: artifact.routes, procedures: artifact.procedures, sessions: artifact.sessions,
      }))]);
      inputs.push(...(await inputHashes(selection, artifactPaths)).map(([name, hash]) => [`artifact/${name}`, hash]));
    }
    requirements.push({ scope, target, effects, reusable,
      contract: digest(JSON.stringify({ version: 1, scope, target, effects, inputs, reusable })) });
  };
  const restore = () => add('restore', home, ['Restore npm and SQL tool dependencies; downloads and local disk writes.'],
    ['package.json', 'package-lock.json', '.config/dotnet-tools.json']);
  const build = () => add('build', home, ['Compile project runtime, browser and SQL artifacts; local disk writes.'],
    ['package.json', 'scripts/build-provenance.mjs', context.generated ? 'tsconfig.json' : 'tsconfig.runtime.json']);
  if (operation === 'restore' || operation === 'build') {
    if (selection !== undefined) throw new Error(`${operation} takes no selection`);
    await (operation === 'restore' ? restore() : build());
    return requirements;
  }
  if (operation === 'workspace-init') {
    if (selection !== 'legacy' && !(selection && /^\d+$/.test(selection) &&
        Number(selection) >= 20000 && Number(selection) <= 60000 && Number(selection) % 10 === 0)) {
      throw new Error('Select legacy or a port block aligned to 10 between 20000 and 60000');
    }
    await add('workspace', `${home}:${selection}`, ['Create workspace descriptor only; no startup or data migration.']);
    return requirements;
  }
  const selected = operation.startsWith('selected-');
  const runtime = runtimeFor(selected ? undefined : selection, home, proposed);
  if (runtime.mode === 'legacy-unselected') throw new Error('Explicit workspace selection required before planning local operations: setup plan proposes a port block; review consent-plan workspace-init <base-port|legacy> first.');
  if (selected && operation !== 'selected-stop') {
    if (!selection || !isAbsolute(selection)) throw new Error('Selected consent requires an absolute artifact directory');
    const directory = await realpath(selection);
    const location = relative(join(runtime.stateDirectory, 'applications'), directory);
    if (!location || location.startsWith('..') || isAbsolute(location)) throw new Error('Artifact is outside the selected workspace');
    artifact = JSON.parse((await regularFile(join(directory, 'application-build.json'))).toString('utf8'));
    if (artifact.home !== home || artifact.workspaceId !== runtime.id || artifact.profile !== 'local-simulation' ||
        !/^[a-z][a-z0-9-]{0,31}$/.test(artifact.name)) throw new Error('Selected artifact belongs to another workspace/profile');
  }
  if (operation === 'selected-stop' && !/^[a-z][a-z0-9-]{0,31}$/.test(selection ?? '')) throw new Error('Invalid application selection');
  const profile = selected ? `selected:${artifact?.name ?? selection}` : 'role-based-data';
  const target = JSON.stringify({ home, workspace: runtime.id, mode: runtime.mode, ports: runtime.ports,
    container: runtime.sqlContainer, database: artifact ? `${runtime.database}_${artifact.name.replaceAll('-', '_')}` : runtime.database,
    profile });
  const sqlTarget = JSON.stringify({ home, workspace: runtime.id, mode: runtime.mode, ports: runtime.ports, container: runtime.sqlContainer });
  const sql = () => add('sql-start', sqlTarget, ['Start/create owned SQL container, volume/network and download image; pass ACCEPT_EULA=Y.'],
    ['src/local.ts']);
  // Contracts bind launcher code, target and effects; editing app SQL, DAB config or role settings must not re-prompt.
  const schema = () => add('schema', target, ['Publish non-destructive schema and runtime SQL grants; preserve existing data.'],
    artifact ? ['src/local.ts', 'src/selected-local.ts'] :
      ['src/local.ts', 'src/role-based-profile.ts'],
    true, artifact ? ['sql', 'setup', 'dab/dab-config.json'] : []);
  const services = () => add('services', target, [
    `Start/reuse ${profile} loopback services; download images and write owned configuration.`,
  ], ['src/artifacts.ts', 'src/local.ts', 'src/local-app.ts',
    ...(artifact ? ['src/selected-local.ts'] : ['src/role-based-profile.ts'])], true, artifact ? ['server', 'dab/dab-config.json'] : []);
  const composite = ['app', 'role-based-app', 'selected-app'].includes(operation);
  if (composite || operation === 'init') { await restore(); await build(); }
  if ((composite && (selected || runtime.ownsSqlName)) || operation === 'start-sql' || operation === 'recover-sql') await sql();
  if (composite || operation === 'init') await schema();
  if (composite || ['data', 'serve', 'role-based-serve', 'selected-serve'].includes(operation)) await services();
  if (['test', 'app-test', 'selected-test'].includes(operation)) {
    await add('synthetic', `${target}:${operation}`, [`Run ${operation}; create synthetic fixtures and perform its documented scoped cleanup.`],
      artifact ? ['src/selected-local.ts', `examples/${artifact.name}/demo/smoke.mjs`] :
        ['src/local.ts', 'sql/local/acceptance.sql', ...(operation === 'app-test' ? ['src/local-app-smoke.ts'] : [])],
      true, artifact ? ['sql', 'setup', 'server', 'dab/dab-config.json'] : []);
  }
  if (['app', 'role-based-app', 'init'].includes(operation)) {
    await add('synthetic', `${sqlTarget}:sql-acceptance`,
      ['Run the built-in read-only SQL acceptance check on the least-privilege app user during initialization.'],
      ['src/local.ts', 'sql/local/acceptance.sql']);
  }
  if (['stop', 'selected-stop'].includes(operation)) {
    await add('stop', target, [`Stop/remove only verified owned ${profile} services; preserve SQL volumes and credentials.`],
      ['src/local.ts', 'src/selected-local.ts']);
  }
  if (operation === 'recover-sql') {
    requirements.length = 0;
    await add('sql-start', `${target}:recovery`, ['Recreate only stopped owned SQL container; preserve image, credentials and volume. One operation only.'],
      ['src/local.ts'], false);
  }
  return requirements;
}

export async function planConsent(value, request) {
  const home = await realpath(value);
  const requirements = await requirementsFor(home, request);
  const state = await readState(home);
  const termsRequired = requirements.some(item => item.scope === 'sql-start');
  const acknowledged = await termsAcknowledged(home);
  const missing = requirements.filter(item => !state.grants.some(grant =>
    grant.scope === item.scope && grant.contract === item.contract && (item.reusable || grant.once)));
  return { version: 1, home, request, requirements, missing, termsRequired, termsAcknowledged: acknowledged,
    allowed: missing.length === 0 && (!termsRequired || acknowledged) };
}

export async function grantConsent(value, approved, options = {}) {
  object(options, ['once'], 'grant options');
  if (options.once !== undefined && typeof options.once !== 'boolean') throw new Error('Invalid one-operation grant option');
  const home = await realpath(value);
  object(approved, ['version', 'home', 'request', 'requirements', 'missing', 'termsRequired', 'termsAcknowledged', 'allowed'], 'approved plan');
  if (approved.version !== 1 || approved.home !== home) throw new Error('Approved plan belongs to another checkout or version');
  await withStateLock(home, async directory => {
    const current = await planConsent(home, approved.request);
    if (JSON.stringify(current.requirements) !== JSON.stringify(approved.requirements)) {
      throw new Error('Consent plan changed; review a fresh plan before granting');
    }
    if (current.requirements.some(item => !item.reusable) && !options.once) {
      throw new Error('This operation requires an explicit one-operation grant; use grant-once');
    }
    const state = await readState(home);
    for (const item of current.requirements) {
      state.grants = state.grants.filter(grant => !(grant.scope === item.scope && grant.contract === item.contract));
      state.grants.push({ scope: item.scope, contract: item.contract, savedAt: new Date().toISOString(), once: options.once === true });
    }
    if (state.grants.length > 100) throw new Error('Too many consent grants; revoke obsolete scopes before granting');
    await saveState(directory, 'consent.json', state);
  });
}

export async function planBundle(value, options) {
  object(options, ['profile', 'workspace'], 'bundle request');
  const home = await realpath(value);
  const operation = launchOperations[options.profile];
  if (!operation) throw new Error('Select bundle profile role-based-data');
  if (options.workspace !== undefined && typeof options.workspace !== 'string') throw new Error('Invalid bundle workspace selection');
  const existing = readWorkspace(home);
  const requirements = [];
  let proposed;
  let workspace = options.workspace;
  if (existing) {
    const current = existing.mode === 'legacy' ? 'legacy' : String(existing.basePort);
    if (workspace !== undefined && workspace !== current) {
      throw new Error(`Requested workspace ${workspace} differs from the existing selection ${current}; inspect it without overwriting.`);
    }
    workspace = current;
  } else {
    if (workspace === undefined) throw new Error('Choose a workspace port block (setup plan proposes one) or legacy before approving startup');
    requirements.push(...await requirementsFor(home, { operation: 'workspace-init', selection: workspace }));
    proposed = describeWorkspace(home, workspace === 'legacy' ? 'legacy' : Number(workspace));
  }
  for (const item of await requirementsFor(home, { operation }, proposed)) {
    if (!requirements.some(other => other.contract === item.contract)) requirements.push(item);
  }
  const state = await readState(home);
  const missing = requirements.filter(item => !state.grants.some(grant => grant.scope === item.scope && grant.contract === item.contract));
  const required = requirements.some(item => item.scope === 'sql-start');
  const sha256 = digest(SQL_TERMS.statement);
  const acknowledged = await termsAcknowledged(home);
  const approval = digest(JSON.stringify({ home, operation, workspace, requirements, terms: required ? sha256 : null })).slice(0, 12);
  return { version: 1, home, profile: options.profile, workspace, operation, requirements, missing,
    terms: { required, url: SQL_TERMS.url, statement: SQL_TERMS.statement, sha256, acknowledged },
    approval, allowed: missing.length === 0 && (!required || acknowledged) };
}

// Records every bundle scope and the inline terms in one locked write, only if the reviewed approval id still matches.
export async function grantBundle(value, approved) {
  object(approved, ['profile', 'workspace', 'approval'], 'bundle approval');
  if (typeof approved.approval !== 'string' || !/^[a-f0-9]{12}$/.test(approved.approval)) throw new Error('Provide the approval id shown by setup approval');
  const home = await realpath(value);
  await withStateLock(home, async directory => {
    const current = await planBundle(home, { profile: approved.profile,
      ...(approved.workspace === undefined ? {} : { workspace: approved.workspace }) });
    if (current.approval !== approved.approval) throw new Error('Approval bundle changed; review a fresh setup approval before approving');
    if (current.requirements.some(item => !item.reusable)) throw new Error('Bundle contains a one-operation scope; approve it separately');
    const state = await readState(home);
    const savedAt = new Date().toISOString();
    for (const item of current.requirements) {
      state.grants = state.grants.filter(grant => !(grant.scope === item.scope && grant.contract === item.contract));
      state.grants.push({ scope: item.scope, contract: item.contract, savedAt, once: false });
    }
    if (state.grants.length > 100) throw new Error('Too many consent grants; revoke obsolete scopes before granting');
    await saveState(directory, 'consent.json', state);
    if (current.terms.required) {
      await saveState(directory, 'terms.json', { version: 1, home, url: SQL_TERMS.url, sha256: current.terms.sha256, acknowledgedAt: savedAt });
    }
  });
}

export async function acknowledgeTerms(value, document) {
  const home = await realpath(value);
  if (typeof document !== 'string' || !isAbsolute(document)) throw new Error('Provide the absolute reviewed terms document path');
  const bytes = await regularFile(document, 4 * 1024 * 1024);
  if (bytes.length === 0) throw new Error('Reviewed terms document is empty');
  const canonical = await realpath(document);
  await withStateLock(home, async directory => {
    await readState(home);
    await saveState(directory, 'terms.json', {
      version: 1, home, document: canonical, sha256: digest(bytes), acknowledgedAt: new Date().toISOString(),
    });
  });
}

export async function revokeConsent(value, scope) {
  const home = await realpath(value);
  if (scope !== undefined && ![...scopeNames, 'terms'].includes(scope)) throw new Error('Unknown consent scope to revoke');
  await withStateLock(home, async directory => {
    const state = await readState(home);
    if (scope !== 'terms') {
      state.grants = scope === undefined ? [] : state.grants.filter(grant => grant.scope !== scope);
      await saveState(directory, 'consent.json', state);
    }
    if (scope === undefined || scope === 'terms') {
      try { await unlink(join(directory, 'terms.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  });
}

export async function assertConsent(home, request) {
  const plan = await planConsent(home, request);
  const deny = current => {
    if (!current.allowed) throw new Error(`Missing local permission: ${current.missing.map(item => item.scope).join(', ') || 'none'}${
      current.termsRequired && !current.termsAcknowledged ? '; matching terms acknowledgement required' : ''
    }. Run npm run consent -- plan ${request.operation} and review its effects before granting.`);
  };
  deny(plan);
  const state = await readState(plan.home);
  if (!state.grants.some(grant => grant.once && plan.requirements.some(item => item.contract === grant.contract))) return;
  await withStateLock(plan.home, async directory => {
    const current = await planConsent(plan.home, request);
    deny(current);
    const locked = await readState(plan.home);
    locked.grants = locked.grants.filter(grant => !grant.once || !current.requirements.some(item => item.contract === grant.contract));
    await saveState(directory, 'consent.json', locked);
  });
}
