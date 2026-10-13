import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

const ownerName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/;
const hasCode = (error, ...codes) => codes.includes(error?.code);

async function inspect(path) {
  try { return await lstat(path); }
  catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
}

async function removeOwnedDirectory(path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rmdir(path);
      return;
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return;
      if (!hasCode(error, 'EBUSY', 'EPERM') || attempt === 4) throw error;
      await new Promise(done => setTimeout(done, 20 * (attempt + 1)));
      if (!await inspect(path)) return;
    }
  }
}

async function stale(path, info, token) {
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('Lock owner must be a bounded regular file');
  let owner;
  try { owner = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  if (!owner || !Number.isInteger(owner.pid) || owner.pid < 1 || owner.pid > 2147483647 ||
      typeof owner.token !== 'string' || !owner.token || owner.token.length > 128) {
    return Date.now() - info.mtimeMs >= 30_000;
  }
  if (token !== undefined && owner.token !== token) throw new Error('Lock owner does not match its unique file name');
  if (owner.host !== undefined && owner.host !== hostname()) throw new Error('Lock belongs to another host; inspect it before recovery');
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { if (hasCode(error, 'ESRCH')) return true; throw error; }
}

async function clearStale(lock) {
  const info = await inspect(lock);
  if (!info) return true;
  if (info.isSymbolicLink()) throw new Error('Lock must not be a symlink');
  if (info.isFile()) {
    // Legacy locks were files. New owners are directories, so unlink cannot remove a replacement.
    try {
      if (!await stale(lock, info)) return false;
      await unlink(lock);
      return true;
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return true;
      if (hasCode(error, 'EISDIR', 'EPERM') && (await inspect(lock))?.isDirectory()) return false;
      throw error;
    }
  }
  if (!info.isDirectory()) throw new Error('Lock must be a regular file or directory');
  let entries;
  try { entries = await readdir(lock); }
  catch (error) {
    if (hasCode(error, 'ENOENT')) return true;
    if (hasCode(error, 'EPERM') && !await inspect(lock)) return true;
    throw error;
  }
  if (entries.length > 1 || entries.length === 1 && !ownerName.test(entries[0])) {
    throw new Error('Lock directory has unexpected contents; inspect it without resetting state');
  }
  if (entries.length) {
    const owner = join(lock, entries[0]);
    const ownerInfo = await inspect(owner);
    if (!ownerInfo) return false;
    try {
      if (!await stale(owner, ownerInfo, entries[0].slice(0, -5))) return false;
      await unlink(owner);
    } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  } else if (Date.now() - info.mtimeMs < 30_000) return false;
  try { await rmdir(lock); return true; }
  catch (error) {
    if (hasCode(error, 'ENOENT')) return true;
    if (hasCode(error, 'EPERM') && !await inspect(lock)) return true;
    if (hasCode(error, 'ENOTEMPTY', 'EEXIST')) return false;
    throw error;
  }
}

export async function withFileLock(lock, action, attempts = 1) {
  await mkdir(dirname(lock), { recursive: true });
  const token = randomUUID();
  const name = `${token}.json`;
  const pending = `${lock}.${token}.tmp`;
  await mkdir(pending, { mode: 0o700 });
  let acquired = false;
  try {
    await writeFile(join(pending, name), JSON.stringify({ pid: process.pid, token, host: hostname() }),
      { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt) await new Promise(done => setTimeout(done, 20));
      if (!await clearStale(lock)) continue;
      try {
        // Publish a populated directory atomically; rename cannot replace another populated owner.
        await rename(pending, lock);
        acquired = true;
        break;
      } catch (error) {
        if (hasCode(error, 'EEXIST', 'ENOTEMPTY')) continue;
        if (hasCode(error, 'EPERM') && (await inspect(lock))?.isDirectory()) continue;
        throw error;
      }
    }
    if (!acquired) throw Object.assign(new Error(`Operation is locked; inspect the other owner before retrying: ${lock}`), { code: 'EEXIST' });
    return await action();
  } finally {
    const directory = acquired ? lock : pending;
    try { await unlink(join(directory, name)); }
    catch (error) {
      if (acquired || !hasCode(error, 'ENOENT')) throw error;
    }
    try { await removeOwnedDirectory(directory); }
    catch (error) {
      if (!hasCode(error, 'ENOENT') && !(acquired && hasCode(error, 'ENOTEMPTY', 'EEXIST'))) throw error;
    }
  }
}
