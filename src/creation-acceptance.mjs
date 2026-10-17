import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectDesignAcceptance } from '../scripts/check-application.mjs';
import { readCreationJson } from './creation-session.mjs';
import { fingerprint } from './creation-progress.mjs';

function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid creation acceptance fields.');
}

async function artifactBytes(home, path) {
  if (typeof path !== 'string' || isAbsolute(path) || path.split(/[\\/]/).some(part => !part || part === '..' || part === '.') ||
      /[:?#]/.test(path)) throw new Error('Acceptance artifacts must be project-contained relative paths.');
  let target = home;
  for (const part of path.split(/[\\/]/)) {
    target = join(target, part);
    if ((await lstat(target)).isSymbolicLink()) throw new Error('Acceptance artifact paths must not contain symlinks.');
  }
  const local = relative(home, await realpath(target));
  const info = await lstat(target);
  if (local.startsWith(`..${sep}`) || isAbsolute(local) || !info.isFile() || info.size === 0 || info.size > 10 * 1024 * 1024) {
    throw new Error('Acceptance artifacts must be bounded nonempty project files.');
  }
  return readFile(target);
}

export async function acceptanceDigest(home, paths) {
  return fingerprint(await Promise.all(paths.map(async path => [path,
    createHash('sha256').update(await artifactBytes(home, path)).digest('hex')])));
}

export async function importCreationAcceptance(home, path, build, origin, sourceFingerprint) {
  const input = await readCreationJson(path);
  fields(input, ['version', 'build', 'origin', 'observedAt', 'workflow', 'design']);
  if (input.version !== 1 || input.build !== build || input.origin !== origin ||
      !Number.isFinite(Date.parse(input.observedAt))) throw new Error('Acceptance evidence must match the current build and origin.');
  fields(input.workflow, ['primaryAction', 'save', 'reload', 'failedSave']);
  if (typeof input.workflow.primaryAction !== 'string' || !input.workflow.primaryAction.trim() || input.workflow.primaryAction.length > 500) throw new Error('Name the verified primary browser action.');
  fields(input.workflow.save, ['persisted', 'artifact']);
  fields(input.workflow.reload, ['freshDocument', 'persisted', 'artifact']);
  fields(input.workflow.failedSave, ['visibleFeedback', 'artifact']);
  if (input.workflow.save.persisted !== true || input.workflow.reload.freshDocument !== true ||
      input.workflow.reload.persisted !== true || input.workflow.failedSave.visibleFeedback !== true) {
    throw new Error('Browser acceptance requires save, fresh-document persistence and visible failed-save feedback.');
  }
  fields(input.design, ['desktop', 'narrow']);
  for (const viewport of [input.design.desktop, input.design.narrow]) {
    fields(viewport, ['width', 'height', 'artifact']);
    if (!Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) ||
        viewport.height < 320 || viewport.height > 4000 || viewport.width < 240 || viewport.width > 4000) throw new Error('Record actual viewport dimensions.');
    const render = await artifactBytes(home, viewport.artifact);
    if (!String(viewport.artifact).endsWith('.png') || render.length < 33 ||
        !render.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        render.toString('ascii', 12, 16) !== 'IHDR' ||
        render.readUInt32BE(16) !== viewport.width || render.readUInt32BE(20) !== viewport.height) {
      throw new Error('Retain PNG renders at the recorded CSS viewport dimensions.');
    }
  }
  if (input.design.desktop.width < 1024 || input.design.narrow.width > 768) throw new Error('Acceptance needs distinct desktop and narrow renders.');
  const design = await inspectDesignAcceptance(home);
  if (!design.accepted || !design.review.includes(`- Origin: ${origin}`) ||
      !design.review.includes(`- Source/build: ${sourceFingerprint}`)) throw new Error('Current design coverage, critique and accepted quality verdict are required.');
  const report = relative(home, await realpath(path)).split(sep).join('/');
  const workflowPaths = [report, input.workflow.save.artifact, input.workflow.reload.artifact, input.workflow.failedSave.artifact];
  const designPaths = [report, 'docs/design-intent.md', 'docs/design-review.md', input.design.desktop.artifact, input.design.narrow.artifact];
  const record = async (kind, artifacts) => ({ kind, build, observedAt: input.observedAt, artifacts,
    digest: await acceptanceDigest(home, artifacts) });
  return { workflow: await record('browser-workflow', workflowPaths), design: await record('design-review', designPaths) };
}
