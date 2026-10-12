import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';

export const PROJECT_MANIFEST = '.sql-apps-project.json';

const MAX_MANIFEST_BYTES = 16 * 1024;
const manifestKeys = ['version', 'id', 'name', 'slug', 'starter', 'profile', 'scaffoldVersion', 'tooling'];
const toolingKeys = ['package', 'version'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[a-zA-Z-][0-9a-zA-Z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[a-zA-Z-][0-9a-zA-Z-]*)))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

function projectError(code, message, cause) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, expected) {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every(key => expected.includes(key));
}

export function parseProjectManifest(value) {
  const invalid = message => { throw projectError('PROJECT_MANIFEST_INVALID', message); };
  if (!plainObject(value) || !exactKeys(value, manifestKeys)) invalid('Project manifest has an invalid shape.');
  if (value.version !== 1) invalid('Project manifest version must be 1.');
  if (typeof value.id !== 'string' || !uuid.test(value.id)) invalid('Project id must be a UUID.');
  if (typeof value.name !== 'string' || !value.name.trim()) invalid('Project name must not be empty.');
  if (typeof value.slug !== 'string' || !slug.test(value.slug)) invalid('Project slug is invalid.');
  if (!['data', 'files-jobs'].includes(value.starter)) invalid('Project starter is invalid.');
  const expectedProfile = value.starter === 'data' ? 'role-based-data' : 'foundation';
  if (value.profile !== expectedProfile) invalid('Project starter and profile are incompatible.');
  if (!Number.isInteger(value.scaffoldVersion) || value.scaffoldVersion < 1) {
    invalid('Project scaffoldVersion must be a positive integer.');
  }
  if (!plainObject(value.tooling) || !exactKeys(value.tooling, toolingKeys) ||
      value.tooling.package !== '@microsoft/sql-apps' ||
      typeof value.tooling.version !== 'string' || !semver.test(value.tooling.version)) {
    invalid('Project tooling must identify @microsoft/sql-apps at an exact SemVer version.');
  }
  return {
    version: 1,
    id: value.id.toLowerCase(),
    name: value.name.trim(),
    slug: value.slug,
    starter: value.starter,
    profile: value.profile,
    scaffoldVersion: value.scaffoldVersion,
    tooling: {
      package: '@microsoft/sql-apps',
      version: value.tooling.version,
    },
  };
}

async function canonicalDirectory(directory) {
  try {
    const canonical = await realpath(directory);
    const info = await lstat(canonical);
    if (!info.isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch (error) {
    throw projectError('PROJECT_PATH_UNSAFE', 'Project path must resolve to a directory.', error);
  }
}

async function inspectManifest(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw projectError('PROJECT_PATH_UNSAFE', 'Project manifest path could not be inspected.', error);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw projectError('PROJECT_PATH_UNSAFE', 'Project manifest must be an unlinked regular file.');
  }
  if (info.size > MAX_MANIFEST_BYTES) {
    throw projectError('PROJECT_MANIFEST_INVALID', 'Project manifest exceeds 16 KiB.');
  }
  return info;
}

export async function readBoundedManifestText(handle) {
  const buffer = Buffer.allocUnsafe(MAX_MANIFEST_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_MANIFEST_BYTES) {
    throw projectError('PROJECT_MANIFEST_INVALID', 'Project manifest exceeds 16 KiB.');
  }
  return buffer.toString('utf8', 0, offset);
}

export async function readProjectManifest(root) {
  const home = await canonicalDirectory(root);
  const path = join(home, PROJECT_MANIFEST);
  const inspected = await inspectManifest(path);
  if (!inspected) throw projectError('PROJECT_MANIFEST_INVALID', 'Project manifest is missing.');

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_MANIFEST_BYTES ||
        opened.dev !== inspected.dev || opened.ino !== inspected.ino) {
      throw projectError('PROJECT_PATH_UNSAFE', 'Project manifest changed while it was being opened.');
    }
    const text = await readBoundedManifestText(handle);
    let value;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw projectError('PROJECT_MANIFEST_INVALID', 'Project manifest is not valid JSON.', error);
    }
    return parseProjectManifest(value);
  } catch (error) {
    if (error.code === 'PROJECT_MANIFEST_INVALID' || error.code === 'PROJECT_PATH_UNSAFE') throw error;
    throw projectError('PROJECT_PATH_UNSAFE', 'Project manifest could not be read safely.', error);
  } finally {
    await handle?.close();
  }
}

export async function findProjectHome(directory = process.cwd()) {
  let current = await canonicalDirectory(directory);
  const filesystemRoot = parse(current).root;
  while (true) {
    const manifest = join(current, PROJECT_MANIFEST);
    if (await inspectManifest(manifest)) {
      await readProjectManifest(current);
      return current;
    }
    if (current === filesystemRoot) break;
    current = dirname(current);
  }
  throw projectError('PROJECT_NOT_FOUND', 'No SQL Apps project was found.');
}
