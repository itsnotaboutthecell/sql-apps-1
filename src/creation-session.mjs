import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock } from './file-lock.mjs';
import { capabilityResult, changeBuild, fingerprint, validateProgress } from './creation-progress.mjs';
import { readLocalAuthentication } from './local-auth.mjs';

export async function readCreationJson(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error('Creation state must be a bounded regular file.');
  const content = await readFile(path, 'utf8');
  if (Buffer.byteLength(content) > 65536) throw new Error('Creation state exceeds its size limit.');
  return JSON.parse(content);
}

export async function writeCreationJson(path, value) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Creation state directory must not be a symlink.');
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Creation state must not be a symlink.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const content = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(content) > 65536) throw new Error('Creation state exceeds its size limit.');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function creationSession(home) {
  const root = await realpath(home);
  try {
    if ((await lstat(join(root, '.sql-apps'))).isSymbolicLink()) throw new Error('Creation project state must not be a symlink.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let pointer;
  try { pointer = await readCreationJson(join(root, '.sql-apps', 'creation-session.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (pointer.version !== 1 || pointer.home !== root || !isAbsolute(pointer.directory) ||
      typeof pointer.sessionId !== 'string' || Object.keys(pointer).some(key => !['version', 'home', 'directory', 'sessionId'].includes(key))) {
    throw new Error('Creation session pointer belongs to another project or version.');
  }
  const directory = await realpath(pointer.directory);
  if ((await lstat(pointer.directory)).isSymbolicLink() || directory !== pointer.directory) throw new Error('Creation session must use a canonical directory, not a symlink.');
  const snapshot = validateProgress(await readCreationJson(join(directory, 'progress.json')));
  if (snapshot.home !== root || snapshot.sessionId !== pointer.sessionId) throw new Error('Creation session identity mismatch.');
  return { directory, snapshot };
}

export async function updateCreation(home, update) {
  const session = await creationSession(home);
  if (!session) return null;
  return withFileLock(join(session.directory, 'progress.lock'), async () => {
    const current = validateProgress(await readCreationJson(join(session.directory, 'progress.json')));
    if (current.home !== session.snapshot.home || current.sessionId !== session.snapshot.sessionId) throw new Error('Creation session changed while updating.');
    const next = validateProgress(await update(current));
    if (next.sessionId !== current.sessionId || next.home !== current.home ||
        next.publicOrigin !== current.publicOrigin || next.gatewayOrigin !== current.gatewayOrigin || next.sequence < current.sequence) {
      throw new Error('Creation update changed owned identity.');
    }
    await writeCreationJson(join(session.directory, 'progress.json'), next);
    return next;
  }, 50);
}

export async function creationBuild(home) {
  const provenance = await readCreationJson(join(home, 'dist', 'build-provenance.json'));
  if (provenance.version !== 2 || provenance.home !== await realpath(home) ||
      !/^[a-f0-9]{64}$/.test(provenance.sourceFingerprint) || !/^[a-f0-9]{64}$/.test(provenance.toolingFingerprint)) {
    throw new Error('Creation evidence needs current project build provenance.');
  }
  const target = await readCreationJson(join(home, '.sql-apps', 'sql-target.json')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  return fingerprint({ source: provenance.sourceFingerprint, tooling: provenance.toolingFingerprint, target,
    authentication: readLocalAuthentication() });
}

export async function recordCreationCapability(home, id, state, proof = null, diagnostic = null) {
  if (!await creationSession(home)) return;
  const build = await creationBuild(home);
  await updateCreation(home, current => capabilityResult(changeBuild(current, build), id, state, proof, diagnostic));
}
