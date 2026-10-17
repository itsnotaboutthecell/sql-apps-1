import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export const sqlProviders = Object.freeze(['container', 'azure', 'express']);
const identifier = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const containerName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);

export function validateSqlTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      !sqlProviders.includes(value.provider)) throw new Error('Invalid SQL target version/provider.');
  const keys = value.provider === 'container' ? ['version', 'provider', 'container'] :
    value.provider === 'azure' ? ['version', 'provider', 'server', 'database', 'subscriptionId', 'tenantId', 'resourceGroup'] :
      ['version', 'provider', 'instance', 'server', 'port', 'database'];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error('SQL target must contain only its nonsecret provider fields; credentials belong in protected state.');
  }
  if (value.provider === 'container') {
    if (!containerName(value.container)) throw new Error('Invalid SQL target container.');
  } else {
    if (!identifier(value.database) || ['master', 'model', 'msdb', 'tempdb'].includes(value.database.toLowerCase())) {
      throw new Error('SQL target must name a development user database.');
    }
    if (value.provider === 'azure') {
      if (typeof value.server !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}\.database\.windows\.net$/.test(value.server) ||
          !uuid(value.subscriptionId) || !uuid(value.tenantId) ||
          typeof value.resourceGroup !== 'string' || !/^[A-Za-z0-9_()[\].-]{1,90}$/.test(value.resourceGroup) ||
          value.resourceGroup.endsWith('.')) throw new Error('Invalid Azure SQL target endpoint/resource identity.');
    } else if (!identifier(value.instance) || value.server !== '127.0.0.1' ||
        !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
      throw new Error('Invalid Express SQL target; use a selected instance and explicit loopback TCP port.');
    }
  }
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

export function sqlTargetFingerprint(target) {
  return createHash('sha256').update(JSON.stringify(validateSqlTarget(target))).digest('hex');
}

export async function readSqlTargetFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw new Error('SQL target must be a bounded regular JSON file.');
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > 16384) throw new Error('SQL target is too large.');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

export async function readSqlTarget(root, fallbackContainer) {
  const home = await realpath(root);
  let state;
  try { state = await readSqlTargetFile(join(home, '.sql-apps', 'sql-target.json')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return validateSqlTarget({ version: 1, provider: 'container', container: fallbackContainer });
  }

  if (!state || state.version !== 1 || state.home !== home ||
      Object.keys(state).some(key => !['version', 'home', 'target'].includes(key))) {
    throw new Error('SQL target belongs to another checkout or has invalid state; preserve it and review the selection.');
  }
  return validateSqlTarget(state.target);
}

export async function resolveSqlTarget(root, fallbackContainer, options = {}) {
  const target = options.sqlTarget === undefined ? await readSqlTarget(root, fallbackContainer) :
    validateSqlTarget(await readSqlTargetFile(options.sqlTarget));
  if (options.sqlProvider !== undefined && options.sqlProvider !== target.provider ||
      options.container !== undefined && target.provider !== 'container' ||
      target.provider === 'container' && target.container !== fallbackContainer) {
    throw new Error('SQL target conflicts with the provider/container selection. Supply a matching nonsecret --sql-target JSON file.');
  }
  return target;
}

export function recommendSqlRoutes(evidence, selected) {
  if (!Array.isArray(evidence) || evidence.length !== sqlProviders.length ||
      sqlProviders.some(provider => evidence.filter(route => route.provider === provider).length !== 1) ||
      evidence.some(route => !['ready', 'action-required', 'unavailable', 'unknown'].includes(route.availability) ||
        typeof route.code !== 'string' || !route.code)) throw new Error('Invalid SQL route evidence.');
  if (selected !== undefined && !sqlProviders.includes(selected)) throw new Error('Invalid selected SQL target provider.');
  const routes = sqlProviders.map(provider => evidence.find(route => route.provider === provider));
  let recommended = selected;
  if (recommended === undefined) {
    for (const route of routes) {
      if (route.availability === 'unknown') break;
      if (route.availability !== 'unavailable') { recommended = route.provider; break; }
    }
  }
  return { routes, ...(recommended ? { recommended } : {}), selectionRequired: selected === undefined,
    scope: 'Read-only recommendation; selecting a route never authorizes installation, cloud resources or moving data.' };
}
