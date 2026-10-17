import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { readSqlTarget } from './sql-target.mjs';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 12);
export const workspaceIdentity = hash;
// Offsets inside the 10-port block stay fixed so existing isolated workspaces keep their SQL port.
const offsets = { gateway: 0, data: 1, sql: 5 };
const keys = Object.keys(offsets);
const legacyPorts = { gateway: 18080, data: 15000, sql: null };
const validBlock = value => Number.isInteger(value) && value >= 20000 && value <= 60000 && value % 10 === 0;

export const workspaceFile = (root = process.cwd()) => join(root, '.sql-apps', 'workspace.json');

export function readWorkspace(root = process.cwd()) {
  const home = realpathSync.native(root);
  let text;
  try { text = readFileSync(workspaceFile(home), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let descriptor;
  try { descriptor = JSON.parse(text); }
  catch { throw new Error('Invalid workspace JSON; review .sql-apps/workspace.json without resetting state.'); }
  if (!descriptor || ![1, 2].includes(descriptor.version) || !['isolated', 'legacy'].includes(descriptor.mode) ||
      typeof descriptor.home !== 'string' || typeof descriptor.id !== 'string' ||
      Object.keys(descriptor).some(key => !['version', 'mode', 'home', 'id', 'basePort', 'topology'].includes(key)) ||
      (descriptor.version === 2 ? descriptor.topology !== 'front-door' || descriptor.mode !== 'isolated' : descriptor.topology !== undefined) ||
      (descriptor.mode === 'isolated' ? !validBlock(descriptor.basePort) : descriptor.basePort !== null)) {
    throw new Error('Invalid workspace descriptor; review the selected mode and port block without resetting state.');
  }
  if (descriptor.home !== home || descriptor.id !== hash(home)) {
    throw new Error('Workspace descriptor belongs to another checkout; select a new workspace explicitly, preserving existing state.');
  }
  return descriptor;
}

// A proposed descriptor lets consent plans compute the same contracts before workspace-init writes it.
export function describeWorkspace(root, selection) {
  const home = realpathSync.native(root);
  return selection === 'legacy' ? { version: 1, mode: 'legacy', home, id: hash(home), basePort: null } : candidate(home, selection);
}

export function runtimeFor(container, root = process.cwd(), proposed) {
  const home = realpathSync.native(root);
  const descriptor = proposed ?? readWorkspace(home);
  const isolated = descriptor?.mode === 'isolated';
  const id = hash(home);
  const defaultSql = isolated ? `sql-apps-${id}-sql` : 'sql-apps-sql';
  const sqlContainer = container ?? defaultSql;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(sqlContainer)) throw new Error('Invalid SQL container name');
  const suffix = hash(isolated ? `${id}/${sqlContainer}` : sqlContainer);
  const stateDirectory = isolated ? join(home, '.sql-apps', 'workspaces', id) : join(home, '.sql-apps');
  const ports = isolated ? Object.fromEntries(keys.map(key => [key, descriptor.basePort + offsets[key]])) : { ...legacyPorts };
  if (descriptor?.version === 2) ports.internalGateway = descriptor.basePort + 2;
  const prefix = isolated ? `sql-apps-${id}` : 'sql-apps';
  return {
    home, id, mode: descriptor?.mode ?? 'legacy-unselected', defaultSql, sqlContainer,
    database: isolated ? `sql_apps_local_${id}` : 'sql_apps_local',
    login: isolated ? `sql_apps_local_dab_${id}` : 'sql_apps_local_dab',
    ownsSqlName: isolated && sqlContainer === defaultSql, stateDirectory, ports,
    origins: {
      app: `http://127.0.0.1:${ports.gateway}`, data: `http://127.0.0.1:${ports.data}`,
    },
    names: {
      data: `${prefix}-local-data-${suffix}`,
      sqlNetwork: `${prefix}-sql-network`,
      sqlState: join(stateDirectory, `local-${suffix}.json`),
      dataConfig: join(stateDirectory, `dab-local-${suffix}.json`),
    },
    labels: isolated ? ['--label', `sql-apps.workspace=${id}`] : [],
  };
}

export async function portState(port) {
  return new Promise(done => {
    const server = createServer();
    const timer = setTimeout(() => { server.close(); done('unknown'); }, 2000);
    server.once('error', error => { clearTimeout(timer); done(error.code === 'EADDRINUSE' ? 'occupied' : 'unknown'); });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      clearTimeout(timer);
      server.close(() => done('free'));
    });
  });
}

function candidate(home, basePort) {
  if (!validBlock(basePort)) throw new Error('Choose an explicit port block aligned to 10 between 20000 and 60000.');
  return { version: 1, mode: 'isolated', home, id: hash(home), basePort };
}

async function inspectPorts(descriptor, probe, includeSql) {
  return Promise.all(keys.filter(name => includeSql || name !== 'sql').map(async name => ({ name, port: descriptor.basePort + offsets[name],
    state: await probe(descriptor.basePort + offsets[name]) })));
}

export async function proposeWorkspace(root = process.cwd(), probe = portState, options = {}) {
  const home = realpathSync.native(root);
  const existing = readWorkspace(home);
  if (existing) return { selected: existing, scope: 'Existing selection; resource ownership still needs verification before startup.' };
  const includeSql = options.includeSql ?? (await readSqlTarget(home, runtimeFor(undefined, home).defaultSql)).provider === 'container';
  const basePort = 20000 + (parseInt(hash(home).slice(0, 8), 16) % 4000) * 10;
  const descriptor = candidate(home, basePort);
  const ports = await inspectPorts(descriptor, probe, includeSql);
  const conflicts = ports.filter(port => port.state !== 'free');
  let alternative = null;
  if (conflicts.length) {
    for (let attempt = 1; attempt <= 100; attempt++) {
      const other = candidate(home, 20000 + ((basePort - 20000 + attempt * 10) % 40000));
      if ((await inspectPorts(other, probe, includeSql)).every(port => port.state === 'free')) { alternative = other; break; }
    }
  }
  return { descriptor, ports, conflicts, alternative,
    nextAction: 'Review existing resources, then explicitly run workspace-init <base-port> for isolation or workspace-init legacy to preserve the legacy stack.',
    scope: 'Read-only proposal; free ports are observations, not reservations or proof of container ownership.' };
}

export async function initializeWorkspace(root = process.cwd(), selection, probe = portState, options = {}) {
  const home = realpathSync.native(root);
  if (readWorkspace(home)) throw new Error('Workspace already selected; review existing state instead of overwriting its descriptor.');
  const descriptor = describeWorkspace(home, selection);
  if (options.frontDoor) {
    if (descriptor.mode !== 'isolated') throw new Error('Progressive creation requires an isolated workspace.');
    descriptor.version = 2;
    descriptor.topology = 'front-door';
  }
  if (descriptor.mode === 'isolated') {
    const ownedProbe = async port => {
      if (options.frontDoor && port === descriptor.basePort) {
        const response = await fetch(`http://127.0.0.1:${port}/__sql_apps/identity`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
        const identity = await response.json();
        if (!response.ok || identity.sessionId !== options.sessionId || identity.workspaceId !== descriptor.id ||
            identity.home !== home) throw new Error('Creation front-door ownership does not match this workspace.');
        return 'free';
      }
      return probe(port);
    };
    const ports = await inspectPorts(descriptor, ownedProbe,
      (await readSqlTarget(home, runtimeFor(undefined, home).defaultSql)).provider === 'container');
    if (options.frontDoor) ports.push({ name: 'internalGateway', port: descriptor.basePort + 2, state: await probe(descriptor.basePort + 2) });
    if (ports.some(port => port.state !== 'free')) throw new Error('Selected port block is occupied or unverifiable; rerun workspace-plan and approve a free alternative.');
  }
  await mkdir(join(home, '.sql-apps'), { recursive: true });
  try { await writeFile(workspaceFile(home), `${JSON.stringify(descriptor, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Workspace already selected by another operation; inspect it without overwriting.');
    throw error;
  }
  return runtimeFor(undefined, home);
}
