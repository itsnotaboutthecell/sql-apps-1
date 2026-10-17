import { createHash, randomUUID } from 'node:crypto';

export const capabilityIds = ['data', 'data-access', 'services', 'application'];
const states = ['pending', 'running', 'verified', 'blocked', 'failed', 'stale'];
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value);
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fields(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) throw new Error(`Invalid ${label} fields.`);
}

export function initialProgress({ home, name, publicOrigin, gatewayOrigin, workspaceId }) {
  return validateProgress({ version: 1, sessionId: randomUUID(), home, name, publicOrigin, gatewayOrigin, workspaceId,
    build: null, sequence: 0, capabilities: capabilityIds.map(id => ({ id, state: 'pending', checkedAt: null,
      build: null, proof: null, diagnostic: null })), workflow: null, design: null });
}

function origin(value) {
  return /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value) && Number(new URL(value).port) > 0;
}

function acceptance(value, kind) {
  fields(value, ['kind', 'build', 'observedAt', 'artifacts', 'digest'], 'acceptance');
  if (value.kind !== kind || !/^[a-f0-9]{64}$/.test(value.build) || !/^[a-f0-9]{64}$/.test(value.digest) || !time(value.observedAt) ||
      !Array.isArray(value.artifacts) || value.artifacts.length < 1 || value.artifacts.length > 24 ||
      !value.artifacts.every(path => text(path) && !/^[\\/]|[:?#]/.test(path) &&
        path.split(/[\\/]/).every(part => part && part !== '..' && part !== '.'))) throw new Error('Invalid acceptance evidence.');
}

export function validateProgress(value) {
  fields(value, ['version', 'sessionId', 'home', 'name', 'publicOrigin', 'gatewayOrigin', 'workspaceId',
    'build', 'sequence', 'capabilities', 'workflow', 'design'], 'progress');
  if (value.version !== 1 || !text(value.sessionId) || typeof value.home !== 'string' || value.home.length > 4096 ||
      !text(value.name) || !text(value.workspaceId) || !origin(value.publicOrigin) || !origin(value.gatewayOrigin) ||
      value.publicOrigin === value.gatewayOrigin || !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      value.build !== null && !/^[a-f0-9]{64}$/.test(value.build) ||
      !Array.isArray(value.capabilities) || value.capabilities.length !== capabilityIds.length) throw new Error('Invalid progress.');
  for (const [index, item] of value.capabilities.entries()) {
    fields(item, ['id', 'state', 'checkedAt', 'build', 'proof', 'diagnostic'], 'capability');
    if (item.id !== capabilityIds[index] || !states.includes(item.state) ||
        item.checkedAt !== null && !time(item.checkedAt) || item.build !== null && !/^[a-f0-9]{64}$/.test(item.build) ||
        item.proof !== null && !text(item.proof) || item.diagnostic !== null && !/^[A-Z][A-Z0-9_]{0,63}$/.test(item.diagnostic)) {
      throw new Error('Invalid capability.');
    }
    if (item.state === 'verified' && (!item.proof || !item.checkedAt || !value.build || item.build !== value.build)) {
      throw new Error('Verified capability requires current probe evidence.');
    }
    if (item.state === 'verified' && value.capabilities.slice(0, index).some(dependency => dependency.state !== 'verified')) {
      throw new Error('Verified capability dependencies are not current.');
    }
    if (['failed', 'blocked'].includes(item.state) && item.diagnostic === null) throw new Error('Failed capability needs a diagnostic.');
  }
  if (value.workflow !== null) acceptance(value.workflow, 'browser-workflow');
  if (value.design !== null) acceptance(value.design, 'design-review');
  return structuredClone(value);
}

export function completion(value) {
  const snapshot = validateProgress(value);
  const blockers = snapshot.capabilities.filter(item => item.state !== 'verified').map(item => item.id);
  const usable = blockers.length === 0 && snapshot.build !== null;
  if (!snapshot.workflow || snapshot.workflow.build !== snapshot.build) blockers.push('browser-workflow');
  if (!snapshot.design || snapshot.design.build !== snapshot.build) blockers.push('design-review');
  return { usable, ready: usable && blockers.length === 0, blockers };
}

export function changeBuild(value, build) {
  const next = validateProgress(value);
  if (next.build === build) return next;
  next.build = build;
  next.sequence++;
  next.workflow = null;
  next.design = null;
  for (const item of next.capabilities) {
    if (item.state === 'verified') item.state = 'stale';
  }
  return validateProgress(next);
}

export function capabilityResult(value, id, state, proof = null, diagnostic = null) {
  const next = validateProgress(value);
  const index = capabilityIds.indexOf(id);
  if (index < 0 || !states.includes(state)) throw new Error('Unknown capability result.');
  if (state === 'verified' && next.capabilities.slice(0, index).some(item => item.state !== 'verified')) {
    throw new Error('Capability dependencies have not verified.');
  }
  next.capabilities[index] = { id, state, proof, diagnostic, checkedAt: new Date().toISOString(), build: next.build };
  if (state !== 'verified') {
    for (const item of next.capabilities.slice(index + 1)) if (item.state === 'verified') item.state = 'stale';
  }
  next.sequence++;
  return validateProgress(next);
}
