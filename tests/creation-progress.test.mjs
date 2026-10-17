import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialProgress, changeBuild, capabilityResult, completion, validateProgress } from '../src/creation-progress.mjs';

const build = 'a'.repeat(64);
const initial = () => initialProgress({ home: 'C:\\test', name: 'Example',
  publicOrigin: 'http://127.0.0.1:30000', gatewayOrigin: 'http://127.0.0.1:30002', workspaceId: 'owned' });
function usable() {
  let value = changeBuild(initial(), build);
  for (const id of ['data', 'data-access', 'services', 'application']) value = capabilityResult(value, id, 'verified', 'Response shape and identity verified');
  return value;
}
test('scaffold and command completion cannot create verified readiness', () => {
  assert.equal(completion(initial()).ready, false);
  assert.throws(() => capabilityResult(initial(), 'data', 'verified', 'command exited'), /evidence/i);
  assert.throws(() => capabilityResult(changeBuild(initial(), build), 'application', 'verified', 'app loaded'), /dependencies/i);
});
test('usable app requires current browser and design acceptance for Ready', () => {
  const value = usable();
  assert.deepEqual(completion(value), { usable: true, ready: false, blockers: ['browser-workflow', 'design-review'] });
  value.workflow = { kind: 'browser-workflow', build, observedAt: new Date().toISOString(), artifacts: ['docs/evidence/workflow.json'], digest: 'e'.repeat(64) };
  assert.equal(completion(value).ready, false);
  value.design = { ...value.workflow, kind: 'design-review' };
  assert.equal(completion(value).ready, true);
  assert.equal(completion(changeBuild(value, 'b'.repeat(64))).ready, false);
});
test('failed capability invalidates dependents while preserving healthy layers', () => {
  const value = capabilityResult(usable(), 'services', 'failed', null, 'CAPABILITY_PROBE_FAILED');
  assert.equal(value.capabilities[0].state, 'verified');
  assert.equal(value.capabilities[3].state, 'stale');
  assert.equal(completion(value).usable, false);
});
test('validation rejects unsupported fields, unsafe artifact paths, and unproved green state', () => {
  assert.throws(() => validateProgress({ ...initial(), token: 'secret' }), /fields/i);
  const value = usable();
  value.design = { kind: 'design-review', build, observedAt: new Date().toISOString(), artifacts: ['../private.json'], digest: 'e'.repeat(64) };
  assert.throws(() => validateProgress(value), /evidence/i);
  value.design = null;
  value.capabilities[0].proof = null;
  assert.throws(() => validateProgress(value), /evidence/i);
});
